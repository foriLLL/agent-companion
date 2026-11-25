import { AgentCompanionService } from "../agent-companion-service.mjs";
import { CodexInjector } from "../injector.mjs";
import { createInjectionArtifact } from "../injection.mjs";
import { CompanionConfig } from "../companion-config.mjs";
import { DEFAULT_CODEX_EXECUTABLE, detectCodexProxy } from "../launcher.mjs";

// 卡片目录 → 这个宿主的注入产物：平台 + 宿主里全部卡片的 manifest 与界面代码。
export function cardsArtifact(cards, host = "codex") {
  const manifests = cards.manifests(host);
  return createInjectionArtifact({ manifests, renderers: manifests.map(({ id }) => cards.renderer(id)).filter(Boolean) });
}

// cards：卡片目录（platform/cards/catalog.mjs 的 CardCatalog），常驻 agent 与一次性命令都传入；
// 不传时只有平台、没有卡片（测试）。
export async function createEmbyRuntime(port, {
  InjectorClass = CodexInjector,
  loadRuntimeSource = async () => "",
  configStore = new CompanionConfig(),
  executable = DEFAULT_CODEX_EXECUTABLE,
  platform,
  // 宿主：codex 或 antigravity，决定注入哪些页面、卡片区怎么摆、任务看板读哪里的会话。
  host = "codex",
  cards = null,
  serviceFactory = ({ logger, configStore, platform, host, cards }) => new AgentCompanionService({
    logger, configStore, platform, host, ...(cards ? { cards } : { modules: {} }),
    inspectCodexProxy: () => detectCodexProxy({ executable, cdpPort: port })
  }),
  loadConfig = () => configStore.loadV2(),
  logger = console,
  onEvent
} = {}) {
  const [runtimePrelude, config] = await Promise.all([loadRuntimeSource(), loadConfig()]);
  const service = serviceFactory({ logger, configStore, platform, host, cards });
  await service.syncCards?.(config);
  const injector = new InjectorClass(port, {
    rpcHandler: service,
    runtimePrelude,
    ...(host === "codex" ? {} : { host }),
    ...(cards ? { artifact: cardsArtifact(cards, host) } : {}),
    config,
    cards: config.cards,
    placement: config.placement,
    cardOrder: config.cardOrder,
    enabled: config.enabled,
    logger,
    ...(onEvent ? { onEvent } : {})
  });
  // 卡片目录变化（安装、卸载、更新）：先按新目录同步后台服务，再换注入产物，页面随后整体重新注入。
  const unsubscribeCards = cards?.subscribe?.(async () => {
    try { await service.syncCards?.(await loadConfig()); }
    catch (error) { logger.warn?.(`[agent-companion] 同步卡片服务失败：${error.message ?? error}`); }
    injector.setArtifact?.(cardsArtifact(cards, host));
  }) ?? (() => {});
  return { injector, service, embyService: service, runtimePrelude, config, unsubscribeCards };
}

export function createRuntimeShutdown({
  injector,
  embyService,
  logger = console,
  processRef = process
}) {
  let shutdownPromise = null;
  return function shutdown(signal = "shutdown") {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      let failure = null;
      try {
        await embyService.dispose();
      } catch (error) {
        failure = error;
      }

      try {
        injector.stop();
      } catch (error) {
        failure ??= error;
      }

      if (failure) {
        const code = typeof failure.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(failure.code)
          ? `（${failure.code}）`
          : "";
        logger.error(`[agent-companion] 停止媒体会话失败${code}`);
        processRef.exitCode = 1;
      } else if (signal) {
        logger.info(`[agent-companion] 已停止维护（${signal}）`);
      }
    })();
    return shutdownPromise;
  };
}

// 会话拥有 injector / service 的生命周期；配置监听与进程退出由调用方管理。
export function createCodexSession({
  port, configStore = new CompanionConfig(), executable = DEFAULT_CODEX_EXECUTABLE,
  logger = console, platform, initialConfig, runtimeFactory = createEmbyRuntime,
  processRef = process, ...runtimeOptions
} = {}) {
  const abort = new AbortController();
  let runtime;
  let latestConfig = initialConfig;
  let starting;
  let stopping;
  let stopped = false;
  let started = false;
  let applying = Promise.resolve();
  const shutdown = () => runtime && (runtime.shutdown ??= (runtime.unsubscribeCards?.(), createRuntimeShutdown({
    injector: runtime.injector, embyService: runtime.embyService ?? runtime.service, logger, processRef
  })));

  function applyConfig(next) {
    latestConfig = next;
    if (!runtime || stopped) return Promise.resolve();
    const operation = applying.then(async () => {
      if (stopped) return;
      try { await (runtime.service ?? runtime.embyService).applyConfig(next); }
      finally { if (!stopped) runtime.injector.setConfig({ config: next }); }
    });
    applying = operation.catch(() => {});
    return operation;
  }

  function start() {
    if (starting) return starting;
    if (stopped) return Promise.reject(new Error("会话已停止"));
    starting = (async () => {
      try {
        runtime = await runtimeFactory(port, {
          ...runtimeOptions, configStore, executable, logger, platform,
          ...(latestConfig ? { loadConfig: async () => latestConfig } : {})
        });
        abort.signal.throwIfAborted();
        if (latestConfig) await applyConfig(latestConfig);
        abort.signal.throwIfAborted();
        await runtime.injector.start({ signal: abort.signal });
        abort.signal.throwIfAborted();
        started = true;
      } catch (error) {
        await applying;
        await shutdown()?.(null);
        throw error;
      }
    })();
    return starting;
  }

  function stop(reason = "detach") {
    if (stopping) return stopping;
    stopped = true;
    abort.abort();
    // 启动中立刻关闭连接；start 的取消检查防止稍后恢复扫描定时器。
    if (runtime && !started) runtime.injector.stop();
    stopping = (async () => {
      await starting?.catch(() => {});
      await applying;
      await shutdown()?.(reason);
    })();
    return stopping;
  }

  // 会话还没注入好或已停止时视为没有播放。
  const isMediaPlaying = () => started && !stopped && runtime?.injector?.isMediaPlaying
    ? runtime.injector.isMediaPlaying() : Promise.resolve(false);

  return { start, stop, applyConfig, isMediaPlaying };
}
