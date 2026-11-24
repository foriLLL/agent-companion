import { CompanionConfig } from "./companion-config.mjs";
import { CARD_MANIFESTS } from "./card-registry.mjs";
import { rpcError } from "./platform/services/errors.mjs";
import { ServiceRegistry } from "./platform/services/registry.mjs";

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

// 保留旧构造注入边界，具体引擎与方法清单由各卡片 service entry 拥有。
export class AgentCompanionService {
  constructor({ configStore = new CompanionConfig(), inspectCodexProxy, logger = console, embyService, hongguoService, modules, manifests = CARD_MANIFESTS, platform = {} } = {}) {
    this.configStore = configStore;
    this.platform = platform;
    this.catalog = manifests.map(({ id, title, defaultEnabled, defaultOrder }) => ({ id, title, defaultEnabled, defaultOrder }));
    this.embyService = embyService;
    this.hongguoService = hongguoService;
    const loadConfig = () => typeof configStore.loadV2 === "function" ? configStore.loadV2() : configStore.load();
    this.loadConfig = loadConfig;
    this.registry = new ServiceRegistry({
      modules, manifests, loadConfig, logger,
      dependencies: { embyService, hongguoService, inspectCodexProxy, logger, loadConfig }
    });
  }

  async handleRpc(method, params = {}, context = {}) {
    if (!method.startsWith("companion.")) return this.registry.handleRpc(method, params, context);
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
        return { config, catalog: this.catalog, agent };
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
  applyConfig(config) { return this.registry.applyConfig(config); }
  disposeContext(targetId, executionContextId) { return this.registry.disposeContext(targetId, executionContextId); }
  disposeTarget(targetId) { return this.registry.disposeTarget(targetId); }
  dispose() { return this.registry.dispose(); }
}
