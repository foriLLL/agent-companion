import { homedir } from "node:os";
import { dirname } from "node:path";
import { CompanionConfig } from "./companion-config.mjs";
import { CARD_MANIFESTS } from "./card-registry.mjs";
import { readInstallRecords, removeCard } from "./platform/cards/manage.mjs";
import { companionDataDir } from "./platform/paths.mjs";
import { rpcError } from "./platform/services/errors.mjs";
import { createCardApi, createHostApi } from "./platform/services/card-api.mjs";
import { ServiceRegistry } from "./platform/services/registry.mjs";

const CARD_ID = /^[a-z][a-z0-9-]*$/;

// 设置页显示的插件来源：GitHub 仓库缩成 owner/repo，本机路径把主目录缩成 ~。
function shortPath(path, home = homedir()) {
  return home && (path === home || path.startsWith(`${home}/`) || path.startsWith(`${home}\\`)) ? `~${path.slice(home.length)}` : path;
}
function pluginOrigin(card, record) {
  const overridesBuiltin = card.overrides === "builtin";
  if (card.linked) return { kind: "link", from: shortPath(card.linked), overridesBuiltin };
  if (record?.kind === "path" && typeof record.source === "string") return { kind: "path", from: shortPath(record.source), overridesBuiltin };
  if (record?.kind === "git" && typeof record.source === "string") {
    const github = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(record.source);
    const name = github ? `${github[1]}/${github[2]}` : record.source;
    return { kind: "git", from: typeof record.ref === "string" ? `${name}@${record.ref}` : name, overridesBuiltin };
  }
  return { kind: "manual", from: null, overridesBuiltin };
}

function isRecord(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateParams(params, allowed) {
  if (!isRecord(params) || Object.keys(params).some(key => !allowed.includes(key))) {
    throw rpcError("RPC_INVALID_PARAMS", "平台 RPC 参数必须是对象，且不能包含多余字段");
  }
}

// 平台 RPC（companion.*）与卡片服务注册表。平台不认识具体卡片：每张卡片的后台服务拿到
// createCardApi 构造的运行时接口；dependencies 只用于测试替换卡片内部引擎。
//
// 卡片从哪来：
// - cards（platform/cards/catalog.mjs 的 CardCatalog）：常驻 agent 用。内置卡片的服务随启动加载；用户安装的卡片
//   只在启用后才 import 它的 service.mjs（关闭的插件不运行任何代码），之后保持加载，换代码或卸载时撤下。
// - modules + manifests：测试与一次性命令直接给出模块，构造时全部登记。
export class AgentCompanionService {
  constructor({
    configStore = new CompanionConfig(), inspectCodexProxy, logger = console, modules, manifests = CARD_MANIFESTS,
    cards = null, platform = {}, host = "codex", hostApi = createHostApi({ host, inspectCodexProxy }), packageDirs = {}, dependencies = {},
    dataRoot = null
  } = {}) {
    this.host = host;
    this.configStore = configStore;
    this.platform = platform;
    this.logger = logger;
    this.cards = cards;
    // 卡片数据目录的上一级（<dataRoot>/card-data/<id>）；卸载时选了「同时删除数据」才用到。
    this.dataRoot = dataRoot;
    this.manifests = cards ? cards.manifests(host) : manifests.filter(({ hosts }) => !hosts || hosts.includes(host));
    const loadConfig = () => typeof configStore.loadV2 === "function" ? configStore.loadV2() : configStore.load();
    this.loadConfig = loadConfig;
    // id → { key, loading }：已登记的卡片服务对应哪份代码；key 变化（更新、换目录）时重新登记。
    this.loaded = new Map();
    // 正在撤下的卡片服务（id → Promise）；之后的加载先等它完成，免得迟到的撤下把新登记的服务抹掉。
    this.unloading = new Map();
    this.registry = new ServiceRegistry({
      modules: cards ? {} : modules ?? {}, manifests: cards ? [] : this.manifests, loadConfig, logger,
      cardApi: (manifest) => createCardApi({
        manifest, packageDir: cards?.get(manifest.id)?.dir ?? packageDirs[manifest.id] ?? null, hostApi, logger, loadConfig, extras: dependencies,
        ...(dataRoot ? { dataRoot } : {})
      })
    });
  }

  // 设置页只列这个宿主里会出现的卡片（manifest 的 hosts），带上来源供界面区分内置与自己安装的卡片。
  get catalog() {
    return this.manifests.map(({ id, title, defaultEnabled, defaultOrder, description }) => ({
      id, title, defaultEnabled, defaultOrder,
      ...(description ? { description } : {}),
      ...(this.cards ? { source: this.cards.get(id)?.source ?? "builtin" } : {})
    }));
  }

  // 设置页用的目录：自己安装的卡片另带来源（开发链接 / 仓库 / 本地目录），供「插件」一节显示与卸载。
  async #settingsCatalog() {
    const entries = this.catalog;
    if (!this.cards || !entries.some(entry => entry.source === "user")) return entries;
    const records = new Map();
    const recordsOf = (dir) => {
      if (!records.has(dir)) records.set(dir, readInstallRecords(dir).catch(() => ({})));
      return records.get(dir);
    };
    return Promise.all(entries.map(async (entry) => {
      const card = entry.source === "user" ? this.cards.get(entry.id) : null;
      if (!card) return entry;
      return { ...entry, plugin: pluginOrigin(card, (await recordsOf(dirname(card.dir)))[entry.id]) };
    }));
  }

  // 卸载用户安装的卡片：删除插件目录（开发链接只删链接），可选同时删除 card-data/<id>。
  // 卸载后把它的开关关掉，以后重新安装仍然缺省关闭；覆盖内置版本的卡片卸载后开关属于内置卡片，不动。
  // 最后立即刷新卡片目录：后台服务随之撤下，页面换成不含它的注入产物。
  async #removeCard(id, purgeData) {
    await this.cards.refresh();
    const card = this.cards.get(id);
    if (!card) throw rpcError("NOT_INSTALLED", "没有安装这张卡片，可能已经卸载");
    if (card.source !== "user") throw rpcError("BUILTIN", "内置卡片不能卸载，可以在设置里关闭它");
    const restoresBuiltin = card.overrides === "builtin";
    const result = await removeCard({
      id, userDir: dirname(card.dir), dataRoot: this.dataRoot ?? companionDataDir(), purgeData, builtinIds: restoresBuiltin ? [id] : []
    });
    if (!restoresBuiltin) {
      try { await this.#disableCard(id); } catch (error) {
        this.logger.warn?.(`[agent-companion] 卸载 ${id} 后关闭开关失败：${error?.message ?? error}`);
      }
    }
    await this.cards.refresh();
    // 常驻 agent 里目录订阅也会同步一次；这里直接同步，保证返回时它的服务已经撤下。
    await this.syncCards(await this.loadConfig());
    return { id, title: card.manifest.title, linked: result.linked, restoresBuiltin, purged: purgeData };
  }

  async #disableCard(id) {
    if (typeof this.configStore.patch !== "function") return;
    for (let attempt = 0; ; attempt++) {
      const config = await this.loadConfig();
      const raw = config?.cards?.[id];
      if ((typeof raw === "boolean" ? raw : raw?.enabled) !== true || !Number.isSafeInteger(config.revision)) return;
      try {
        await this.configStore.patch({ cards: { [id]: { enabled: false } } }, { expectedRevision: config.revision });
        return;
      } catch (error) {
        if (error?.code !== "CONFIG_CONFLICT" || attempt >= 2) throw error;
      }
    }
  }

  #cardKey(id) {
    const card = this.cards.get(id);
    return card ? JSON.stringify([card.dir, card.manifest, card.service?.path ?? null, card.service?.mtimeMs ?? null]) : null;
  }

  #wanted(id, config) {
    if (this.cards.isBuiltin(id)) return true;
    const raw = config?.cards?.[id];
    const enabled = typeof raw === "boolean" ? raw : raw?.enabled;
    return config?.enabled !== false && enabled === true;
  }

  // 登记一张卡片的服务（并发调用只加载一次）。加载失败只影响这张卡片，调用时返回 CARD_SERVICE_UNAVAILABLE。
  #load(id) {
    const key = this.#cardKey(id);
    const current = this.loaded.get(id);
    if (current?.key === key) return current.loading;
    const loading = (async () => {
      await current?.loading.catch(() => {});
      await this.unloading.get(id);
      if (this.registry.closed) return;
      await this.registry.unregister(id);
      const manifest = this.cards.get(id)?.manifest;
      if (!manifest) return;
      let module = null;
      try { module = await this.cards.importService(id); } catch (error) {
        this.logger.warn?.(`[agent-companion] 卡片 ${id} 后台服务加载失败：${error?.message ?? error}`);
        module = { createService() { throw error; } };
      }
      if (this.loaded.get(id)?.loading !== loading || this.registry.closed) return;
      this.registry.register(manifest, module);
    })();
    this.loaded.set(id, { key, loading });
    return loading;
  }

  /**
   * 按卡片目录与配置同步已登记的服务：撤下已卸载或换了代码的卡片，登记内置卡片和已启用的用户卡片。
   * 卡片目录变化（setCards 之后）、配置变化与启动时调用。
   */
  async syncCards(config) {
    if (!this.cards || this.registry.closed) return;
    this.manifests = this.cards.manifests(this.host);
    const ids = new Set(this.manifests.map(({ id }) => id));
    const jobs = [];
    for (const [id, current] of this.loaded) {
      if (ids.has(id) && current.key === this.#cardKey(id)) continue;
      this.loaded.delete(id);
      const previous = this.unloading.get(id);
      const unloading = Promise.all([previous, current.loading.catch(() => {})])
        .then(() => this.registry.unregister(id))
        .catch(() => {})
        .finally(() => { if (this.unloading.get(id) === unloading) this.unloading.delete(id); });
      this.unloading.set(id, unloading);
      jobs.push(unloading);
    }
    await Promise.allSettled(jobs);
    await Promise.allSettled(this.manifests.filter(({ id }) => this.#wanted(id, config)).map(({ id }) => this.#load(id)));
  }

  async handleRpc(method, params = {}, context = {}) {
    if (!method.startsWith("companion.")) {
      // 刚启用的用户卡片可能还没来得及登记：按需加载一次再路由。
      const id = method.split(".")[0];
      if (this.cards?.has(id) && !this.loaded.has(id) && this.manifests.some((manifest) => manifest.id === id)) {
        const config = await this.loadConfig();
        if (this.#wanted(id, config)) await this.#load(id);
      } else if (this.loaded.has(id)) await this.loaded.get(id).loading;
      return this.registry.handleRpc(method, params, context);
    }
    if (context.cardId !== undefined && context.cardId !== "companion") {
      throw rpcError("RPC_INVALID_REQUEST", "RPC 方法与平台命名空间不匹配");
    }
    if (this.registry.closed) throw rpcError("RPC_UNAVAILABLE", "平台服务已关闭");
    context.signal?.throwIfAborted();

    switch (method) {
      case "companion.settings.get": {
        validateParams(params, []);
        const config = await this.loadConfig();
        context.signal?.throwIfAborted();
        const agent = typeof this.platform.getAgentStatus === "function" ? await this.platform.getAgentStatus() : null;
        return { config, catalog: await this.#settingsCatalog(), agent, host: this.host };
      }
      case "companion.cards.remove": {
        validateParams(params, ["id", "purgeData"]);
        if (typeof params.id !== "string" || !CARD_ID.test(params.id)) throw rpcError("RPC_INVALID_PARAMS", "id 必须是卡片 id");
        if (Object.hasOwn(params, "purgeData") && typeof params.purgeData !== "boolean") {
          throw rpcError("RPC_INVALID_PARAMS", "purgeData 必须是布尔值");
        }
        if (!this.cards) throw rpcError("AGENT_UNAVAILABLE", "后台服务没有加载卡片目录");
        return this.#removeCard(params.id, params.purgeData === true);
      }
      case "companion.settings.patch": {
        validateParams(params, ["expectedRevision", "patch"]);
        if (!Number.isSafeInteger(params.expectedRevision) || params.expectedRevision < 0 || !isRecord(params.patch)) {
          throw rpcError("RPC_INVALID_PARAMS", "expectedRevision 必须是非负安全整数，patch 必须是对象");
        }
        // 配置字段的语义、合并及冲突检查均由配置存储负责。
        const config = await this.configStore.patch(params.patch, { expectedRevision: params.expectedRevision });
        return { config };
      }
      case "companion.codex.restart":
        validateParams(params, ["reason"]);
        if (Object.hasOwn(params, "reason") && (typeof params.reason !== "string" || params.reason.length > 64)) {
          throw rpcError("RPC_INVALID_PARAMS", "reason 必须是不超过 64 字符的字符串");
        }
        if (typeof this.platform.requestCodexRestart !== "function") {
          throw rpcError("AGENT_UNAVAILABLE", "后台服务未运行");
        }
        return this.platform.requestCodexRestart(params);
      case "companion.agent.status":
        validateParams(params, []);
        return typeof this.platform.getAgentStatus === "function" ? this.platform.getAgentStatus() : { available: false };
      // 更新：status 只读本地状态；check 访问 GitHub；apply 启动升级后立即返回，界面轮询 status。
      case "companion.update.status":
      case "companion.update.check":
      case "companion.update.apply":
      case "companion.update.acknowledge": {
        validateParams(params, []);
        const action = { "companion.update.status": "getUpdateStatus", "companion.update.check": "checkForUpdates",
          "companion.update.apply": "applyUpdate", "companion.update.acknowledge": "acknowledgeUpdate" }[method];
        const result = typeof this.platform[action] === "function" ? await this.platform[action]() : null;
        if (result) return result;
        if (method === "companion.update.status") return { supported: false };
        throw rpcError("AGENT_UNAVAILABLE", "更新服务未运行");
      }
      default:
        throw rpcError("RPC_METHOD_NOT_FOUND", "未知平台 RPC 方法");
    }
  }
  async applyConfig(config) {
    await this.syncCards(config);
    return this.registry.applyConfig(config);
  }
  disposeContext(targetId, executionContextId) { return this.registry.disposeContext(targetId, executionContextId); }
  disposeTarget(targetId) { return this.registry.disposeTarget(targetId); }
  dispose() { return this.registry.dispose(); }
}
