import { CdpConnection } from "./cdp-connection.mjs";
import { buildInjectionSource, buildConfigUpdateSource, cardDefineSource, enabledRenderers, BRIDGE_KEY, PLATFORM_ARTIFACT } from "./injection.mjs";
import { attachMediaIntercept } from "./platform/media/media-intercept.mjs";
import { normalizeRuntimeConfig } from "./platform/config/runtime-config.mjs";
import { CdpRpcBridge, DEFAULT_RPC_TIMEOUT_MS } from "./rpc-bridge.mjs";
import { hostTargets, listCdpTargets, waitForCodexTargets } from "./targets.mjs";

// 会话自愈：WebSocket 仍是 OPEN 不代表 RPC 还通（binding 失效、回包投递失败、连接半开）。
// 定期从页面发一次 rpc.ping 走完整条链路；连续失败就拆掉会话，下一轮扫描重新连接、注册 binding 并挂载。
// 超时取 5 秒：页面主线程偶尔卡几秒不该触发重连，连续两次都卡满才算真的断了。
const HEALTH_TIMEOUT_MS = 5_000;
const PROBE_INTERVAL_MS = 5_000;
const PROBE_TIMEOUT_MS = 3_000;
const MAX_SESSION_FAILURES = 2;
const RESET_BACKOFF_BASE_MS = 1_000;
const RESET_BACKOFF_MAX_MS = 30_000;

const MEDIA_PLAYING_SOURCE = `(() => {
  const playing = globalThis.__AGENT_COMPANION__?.runtime?.getDiagnostics?.()?.attention?.playing;
  if (typeof playing === "boolean") return playing;
  const scan = root => [...root.querySelectorAll("video,audio")].some(media => !media.paused && !media.ended)
    || [...root.querySelectorAll("*")].some(element => element.shadowRoot && scan(element.shadowRoot));
  return [...document.querySelectorAll('[id^="agent-companion"]')].some(host => host.shadowRoot && scan(host.shadowRoot));
})()`;

export class CodexInjector {
  #port;
  #host;
  #sessions = new Map();
  #scanTimer = null;
  #cleanedAuxiliaryTargets = new Set();
  #newDocumentScripts = new Map();
  #logger;
  #rpcHandler;
  #rpcTimeoutMs;
  #runtimePrelude;
  #scanning = null;
  #stopped = false;
  #config;
  #artifact;
  #now;
  #onEvent;
  #healthTimeoutMs;
  #probeIntervalMs;
  #probeTimeoutMs;
  #maxFailures;
  // targetId → { attempts, notBefore }：会话被拆后重连的退避，探活成功才清零。
  #resets = new Map();

  constructor(port, {
    logger = console,
    rpcHandler,
    embyService,
    rpcTimeoutMs = DEFAULT_RPC_TIMEOUT_MS,
    runtimePrelude = "",
    cards,
    placement,
    cardOrder,
    order,
    revision,
    config,
    enabled,
    now = Date.now,
    onEvent = () => {},
    healthTimeoutMs = HEALTH_TIMEOUT_MS,
    probeIntervalMs = PROBE_INTERVAL_MS,
    probeTimeoutMs = PROBE_TIMEOUT_MS,
    maxSessionFailures = MAX_SESSION_FAILURES,
    host = "codex",
    // 注入产物（平台 + 卡片目录），见 injection.mjs 的 createInjectionArtifact；卡片目录变化时经 setArtifact 换新。
    artifact = PLATFORM_ARTIFACT
  } = {}) {
    if (rpcHandler !== undefined && embyService !== undefined && rpcHandler !== embyService) {
      throw new TypeError("rpcHandler 和 embyService 不能同时配置");
    }
    this.#port = port;
    this.#host = hostTargets(host);
    this.#logger = logger;
    this.#rpcHandler = rpcHandler ?? embyService;
    this.#rpcTimeoutMs = rpcTimeoutMs;
    if (typeof runtimePrelude !== "string") {
      throw new TypeError("runtimePrelude 必须是字符串");
    }
    this.#runtimePrelude = runtimePrelude;
    this.#now = now;
    this.#onEvent = onEvent;
    this.#healthTimeoutMs = healthTimeoutMs;
    this.#probeIntervalMs = probeIntervalMs;
    this.#probeTimeoutMs = probeTimeoutMs;
    this.#maxFailures = maxSessionFailures;
    this.#artifact = artifact;
    this.#config = normalizeRuntimeConfig(config ?? { cards, placement, cardOrder, order, revision, enabled }, artifact.manifests);
  }

  get artifact() {
    return this.#artifact;
  }

  // 卡片目录变化（安装、卸载、更新）后换上新产物；下一轮扫描发现页面里的身份不同，整体重新注入。
  setArtifact(artifact) {
    this.#artifact = artifact;
    this.#config = normalizeRuntimeConfig(this.#config, artifact.manifests);
  }

  get enabled() {
    return this.#config.enabled;
  }

  get cards() {
    return Object.fromEntries(Object.entries(this.#config.cards).map(([id, value]) => [id, value.enabled]));
  }

  get placement() {
    return this.#config.placement;
  }

  get host() {
    return this.#host.id;
  }

  get cardOrder() {
    return [...this.#config.order];
  }

  get config() {
    return normalizeRuntimeConfig(this.#config, this.#artifact.manifests);
  }

  // 配置身份与构建身份独立：下一次扫描仅对当前 runtime 调用 applyConfig。
  setConfig({ config, cards, placement, cardOrder, order, revision, enabled } = {}) {
    const mergedCards = Object.assign(Object.create(null), this.#config.cards);
    if (cards && typeof cards === "object" && !Array.isArray(cards)) {
      for (const [id, value] of Object.entries(cards)) {
        mergedCards[id] = typeof value === "boolean"
          ? { ...mergedCards[id], enabled: value }
          : { ...mergedCards[id], ...value };
      }
    }
    const next = normalizeRuntimeConfig(config ?? {
      cards: mergedCards,
      placement: placement ?? this.#config.placement,
      order: order ?? cardOrder ?? this.#config.order,
      revision: revision ?? this.#config.revision,
      enabled: enabled ?? this.#config.enabled,
    }, this.#artifact.manifests);
    if (next.revision !== null && this.#config.revision !== null && next.revision < this.#config.revision) return false;
    this.#config = next;
    return true;
  }

  #buildMountSource(config = this.#config) {
    const source = buildInjectionSource("mount", { config, host: this.#host.id, artifact: this.#artifact });
    return this.#runtimePrelude ? `${this.#runtimePrelude}\n;${source}` : source;
  }

  async #registerNewDocument(connection, target, config, force = false) {
    // 导航脚本里带着平台、启用卡片的界面代码和配置，任何一项变化都要重新登记。
    const configKey = JSON.stringify([this.#artifact.hash, config]);
    const previous = this.#newDocumentScripts.get(target.id);
    if (!force && previous?.configKey === configKey) return;
    if (previous?.identifier) {
      // CDP 重连后旧注册可能已被浏览器撤销，允许此时重新登记。
      await connection.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: previous.identifier }).catch(() => {});
      this.#newDocumentScripts.delete(target.id);
    }
    // 仅替换导航脚本注册；当前文档不会执行 bundle。
    const registered = await connection.send("Page.addScriptToEvaluateOnNewDocument", { source: this.#buildMountSource(config) });
    if (registered?.identifier) this.#newDocumentScripts.set(target.id, { identifier: registered.identifier, configKey });
  }

  async #evaluate(connection, expression, options) {
    const evaluation = await connection.send("Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true, userGesture: false,
    }, options);
    if (evaluation.exceptionDetails) {
      throw new Error(evaluation.exceptionDetails.exception?.description ?? evaluation.exceptionDetails.text ?? "未知 JavaScript 异常");
    }
    return evaluation;
  }

  // 卡片里是否有媒体在播（自动更新要等播放结束再重启后台服务）。优先读平台 attention 层的状态，
  // 没有时扫描 Companion 自己宿主下的 <video>/<audio>；读不到的页面当作没有播放。
  async isMediaPlaying() {
    for (const { connection } of [...this.#sessions.values()]) {
      if (!connection.isOpen) continue;
      try {
        const evaluation = await this.#evaluate(connection, MEDIA_PLAYING_SOURCE);
        if (evaluation.result?.value === true) return true;
      } catch {}
    }
    return false;
  }

  async injectOnce(action = "mount") {
    const targets = await waitForCodexTargets(this.#port, { host: this.#host.id });
    await this.#cleanupAuxiliaryTargets(await listCdpTargets(this.#port));
    const results = [];

    for (const target of targets) {
      const connection = new CdpConnection(target.webSocketDebuggerUrl);
      let rpcBridge;
      try {
        await connection.connect();
        const applied = await this.#apply(connection, target, action, false);
        rpcBridge = applied.rpcBridge;
        results.push(applied.result);
      } finally {
        rpcBridge?.detach();
        connection.close();
      }
    }
    return results;
  }

  async start({ signal } = {}) {
    signal?.throwIfAborted();
    this.#stopped = false;
    await waitForCodexTargets(this.#port, { signal, host: this.#host.id });
    signal?.throwIfAborted();
    if (this.#stopped) return;
    await this.#runScan();
    signal?.throwIfAborted();
    if (this.#stopped) return;
    // 注意：不要 unref 这个定时器——它是常驻进程保持事件循环存活的关键。
    this.#scanTimer = setInterval(() => {
      this.#runScan().catch((error) => this.#logger.warn(`[agent-companion] 扫描失败：${error.message}`));
    }, 1_500);
  }

  stop() {
    this.#stopped = true;
    if (this.#scanTimer) clearInterval(this.#scanTimer);
    this.#scanTimer = null;
    for (const { connection, rpcBridge } of this.#sessions.values()) {
      rpcBridge?.detach();
      connection.close();
    }
    this.#sessions.clear();
    this.#resets.clear();
    this.#cleanedAuxiliaryTargets.clear();
    this.#newDocumentScripts.clear();
  }

  // 串行化扫描：单次扫描可能因为多次 CDP 往返而超过 1.5s 的间隔，
  // 若不加锁，重叠扫描会重复注入并泄漏 WebSocket 连接与 RPC bridge。
  #runScan() {
    if (this.#scanning) return this.#scanning;
    this.#scanning = (async () => {
      if (this.#stopped) return;
      await this.#scan();
    })().finally(() => {
      this.#scanning = null;
    });
    return this.#scanning;
  }

  // 立即触发一次（串行化的）扫描，主要用于测试与手动强制刷新。
  scanNow() {
    return this.#runScan();
  }

  async #scan() {
    const allTargets = await listCdpTargets(this.#port);
    await this.#cleanupAuxiliaryTargets(allTargets);
    const targets = this.#host.filterTargets(allTargets);
    const liveIds = new Set(targets.map((target) => target.id));

    for (const targetId of this.#resets.keys()) {
      if (!liveIds.has(targetId)) this.#resets.delete(targetId);
    }
    for (const [targetId, session] of this.#sessions) {
      if (!liveIds.has(targetId) || !session.connection.isOpen) {
        session.rpcBridge?.detach();
        session.connection.close();
        this.#sessions.delete(targetId);
        if (!liveIds.has(targetId)) this.#newDocumentScripts.delete(targetId);
        continue;
      }
      try {
        const config = this.#config;
        const check = await this.#evaluate(session.connection, `(() => {
          const bridge = globalThis[${JSON.stringify(BRIDGE_KEY)}];
          return { artifactHash: bridge?.artifactHash ?? null,
            mounted: bridge?.runtime?.isMounted?.() === true,
            config: bridge?.runtime?.getConfig?.() ?? null,
            cards: bridge?.runtime?.getDefinedCards?.() ?? null };
        })()`, { timeoutMs: this.#healthTimeoutMs });
        if (this.#stopped) return;
        await this.#registerNewDocument(session.connection, session.target, config);
        if (this.#stopped) return;
        const health = check.result?.value;
        if (health?.artifactHash === this.#artifact.hash && health?.mounted === true) {
          // 新启用的卡片界面还没送到页面：先补送，再推配置，运行时收到后按配置挂载。
          await this.#defineMissingCards(session.connection, config, health.cards);
          if (this.#stopped) return;
          // 页面可能刚执行了旧导航脚本；不能仅相信 Node 侧上次推送的配置。
          if (JSON.stringify(health.config) !== JSON.stringify(config)) {
            await this.#evaluate(session.connection, buildConfigUpdateSource(config));
          }
          // 上次失败后每轮都复查，尽快确认是偶发还是真的断了。
          if (session.failures > 0 || this.#now() - session.probedAt >= this.#probeIntervalMs) {
            session.probedAt = this.#now();
            await this.#probe(session.connection);
            if (this.#stopped) return;
            session.failures = 0;
            this.#resets.delete(targetId);
          }
        } else {
          this.#logger.info(`[agent-companion] 重新注入页面：${targetId}`);
          await this.#evaluate(session.connection, this.#buildMountSource(config));
          session.probedAt = this.#now();
        }
      } catch (error) {
        if (this.#stopped) return;
        session.failures += 1;
        this.#logger.warn(`[agent-companion] 会话健康检查失败 ${targetId}（连续 ${session.failures} 次）：${error.message}`);
        if (session.failures >= this.#maxFailures) this.#resetSession(targetId, session, error);
      }
    }

    for (const target of targets) {
      // 总开关只控制业务卡片；新页面仍需挂载平台设置入口，供用户重新启用。
      if (this.#sessions.has(target.id)) continue;
      if (this.#now() < (this.#resets.get(target.id)?.notBefore ?? 0)) continue;

      const connection = new CdpConnection(target.webSocketDebuggerUrl);
      try {
        await connection.connect();
        // stop() 可能在本次 connect() 期间被调用；此时不要把新会话登记进来，
        // 否则会泄漏一个永不关闭的 WebSocket 并让进程无法退出。
        if (this.#stopped || this.#sessions.has(target.id)) {
          connection.close();
          continue;
        }
        const { result, rpcBridge } = await this.#apply(connection, target, "mount", true);
        if (this.#stopped) {
          rpcBridge?.detach();
          connection.close();
          return;
        }
        this.#sessions.set(target.id, { connection, target, rpcBridge, failures: 0, probedAt: this.#now() });
        this.#logger.info(`[agent-companion] 已注入 ${target.title || target.url}：${result.status}`);
      } catch (error) {
        connection.close();
        this.#logger.warn(`[agent-companion] 注入 target ${target.id} 失败：${error.message}`);
      }
    }
  }

  async #defineMissingCards(connection, config, defined) {
    if (!defined || typeof defined !== "object") return;
    for (const renderer of enabledRenderers(this.#artifact, config)) {
      if (defined[renderer.id] === renderer.hash) continue;
      const evaluation = await this.#evaluate(connection, cardDefineSource(renderer));
      const status = evaluation.result?.value?.status;
      if (status !== "defined") this.#logger.warn(`[agent-companion] 卡片 ${renderer.id} 界面送达失败：${status ?? "无结果"}`);
      else this.#logger.info(`[agent-companion] 已加载卡片界面：${renderer.id}`);
    }
  }

  // 在页面里经 rpc-client 发 rpc.ping，等后台回包；不通时抛错，由调用方计入失败次数。
  async #probe(connection) {
    const evaluation = await this.#evaluate(connection, `(() => {
      const runtime = globalThis[${JSON.stringify(BRIDGE_KEY)}]?.runtime;
      return typeof runtime?.probeRpc === "function" ? runtime.probeRpc(${this.#probeTimeoutMs}) : { ok: true, unsupported: true };
    })()`, { timeoutMs: this.#probeTimeoutMs + 2_000 });
    const result = evaluation.result?.value;
    if (result?.ok !== true) throw new Error(`RPC 自检失败：${result?.reason ?? "无结果"}`);
  }

  // 拆掉无响应的会话；下一轮扫描（受退避限制）重新连接、注册 binding 与导航脚本并挂载。
  #resetSession(targetId, session, error) {
    const attempts = (this.#resets.get(targetId)?.attempts ?? 0) + 1;
    const delay = Math.min(RESET_BACKOFF_BASE_MS * 2 ** (attempts - 1), RESET_BACKOFF_MAX_MS);
    this.#resets.set(targetId, { attempts, notBefore: this.#now() + delay });
    this.#sessions.delete(targetId);
    session.rpcBridge?.detach();
    session.connection.close();
    this.#logger.warn(`[agent-companion] 会话 ${targetId} 无响应，已断开，${delay}ms 后重连（第 ${attempts} 次）`);
    try {
      Promise.resolve(this.#onEvent("session-reset", { targetId, attempts, reason: error.message })).catch(() => {});
    } catch {}
  }

  async #cleanupAuxiliaryTargets(allTargets) {
    const mainIds = new Set(this.#host.filterTargets(allTargets).map((target) => target.id));
    const liveIds = new Set(allTargets.map((target) => target.id));
    for (const targetId of this.#cleanedAuxiliaryTargets) {
      if (!liveIds.has(targetId)) this.#cleanedAuxiliaryTargets.delete(targetId);
    }

    const auxiliaryTargets = allTargets.filter((target) => {
      return this.#host.isAppTarget(target)
        && !mainIds.has(target.id)
        && !this.#cleanedAuxiliaryTargets.has(target.id);
    });

    for (const target of auxiliaryTargets) {
      const connection = new CdpConnection(target.webSocketDebuggerUrl);
      try {
        await connection.connect();
        await connection.send("Runtime.evaluate", {
          expression: buildInjectionSource("unmount"),
          returnByValue: false
        });
        this.#cleanedAuxiliaryTargets.add(target.id);
      } catch (error) {
        this.#logger.warn(`[agent-companion] 清理辅助 renderer ${target.id} 失败：${error.message}`);
      } finally {
        connection.close();
      }
    }
  }

  async #apply(connection, target, action, installOnNewDocument) {
    const config = this.#config;
    const expression = action === "mount" ? this.#buildMountSource(config) : buildInjectionSource(action);
    await connection.send("Page.enable");
    await connection.send("Runtime.enable");

    let rpcBridge;
    let mediaIntercept = null;
    if (action === "mount") {
      // 常驻会话才启用媒体拦截：一次性注入随即关闭连接，拦截也随之失效。
      if (installOnNewDocument) mediaIntercept = await attachMediaIntercept(connection, { logger: this.#logger });
      rpcBridge = new CdpRpcBridge(connection, {
        handler: this.#rpcHandler,
        targetId: target.id,
        mediaTransport: mediaIntercept?.active ? "intercept" : undefined,
        logger: this.#logger,
        timeoutMs: this.#rpcTimeoutMs
      });
      await rpcBridge.attach();
    }

    try {
      if (installOnNewDocument && action === "mount") {
        await this.#registerNewDocument(connection, target, config, true);
      }
      const evaluation = await this.#evaluate(connection, expression);

      return {
        rpcBridge,
        result: {
          targetId: target.id,
          title: target.title,
          url: target.url,
          ...(evaluation.result?.value ?? { status: action })
        }
      };
    } catch (error) {
      rpcBridge?.detach();
      mediaIntercept?.detach();
      throw error;
    }
  }

}
