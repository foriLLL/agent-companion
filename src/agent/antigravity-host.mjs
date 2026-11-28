import { execFile } from "node:child_process";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { notifyDesktop } from "../daemon.mjs";
import { reserveLoopbackPort } from "../launcher.mjs";
import { waitForCodexTargets } from "../targets.mjs";
import { AgentController } from "./controller.mjs";
import { createNativeBridge } from "./native-bridge.mjs";
import { createCodexSession } from "./session.mjs";

// Antigravity 宿主：在 macOS 有原生助手时监听 Antigravity，刚启动且未带调试端口的单实例（含后台启动
// 与自动更新重启）在启动完成后被正常退出、以本机随机调试端口重开并注入卡片；已在运行的基线旧实例只提醒不退出，绝不强杀。
// 原生助手缺失时退回定时轮询，只接上带本机调试端口启动的实例。
// 与 Codex 的会话互不影响：各自一个 injector + 服务注册表，看板文件也分开。

const execFileAsync = promisify(execFile);
export const DEFAULT_ANTIGRAVITY_APP = "/Applications/Antigravity.app";
export const DEFAULT_ANTIGRAVITY_EXECUTABLE = `${DEFAULT_ANTIGRAVITY_APP}/Contents/MacOS/Antigravity`;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
export const ANTIGRAVITY_NOTIFICATIONS = Object.freeze({
  "needs-restart": "Companion 未加载：退出并重新打开 Antigravity 即可显示卡片。",
  skipped: "本次未自动加载 Companion，下次打开 Antigravity 时生效。",
  cooldown: "Companion 刚刚尝试过自动重开，本次已跳过；请稍等两分钟后再重启 Antigravity 以加载卡片。",
  "relaunch-failed": "Antigravity 自动重开失败，请手动打开 Antigravity。"
});

export function resolveAntigravityAppPath({ env = process.env, platform = process.platform } = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  return paths.resolve(env.AGENT_COMPANION_ANTIGRAVITY_APP || DEFAULT_ANTIGRAVITY_APP);
}

/** 接受本机监听地址（含省略地址，Chromium 默认只监听 127.0.0.1）的调试实例。 */
export function isAntigravityDebugInstance(parsed) {
  return parsed?.known === true
    && Number.isInteger(parsed.debugPort) && parsed.debugPort >= 1 && parsed.debugPort <= 65_535
    && (parsed.debugAddress === null || LOOPBACK.has(parsed.debugAddress));
}

/** 从主进程参数里读调试端口与监听地址；没带端口为 null。地址缺省时 Chromium 只监听 127.0.0.1。 */
export function parseAntigravityDebugArgs(args = []) {
  let port = null;
  let address = null;
  for (const arg of args) {
    const portMatch = /^--remote-debugging-port=(\d{1,5})$/.exec(arg);
    if (portMatch) port = Number(portMatch[1]);
    const addressMatch = /^--remote-debugging-address=(\S+)$/.exec(arg);
    if (addressMatch) address = addressMatch[1];
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) port = null;
  return { port, address, loopback: address === null || LOOPBACK.has(address) };
}

/** 列出正在运行的 Antigravity 主进程（不含 Helper 子进程）。 */
export function createAntigravitySnapshot({ executable = DEFAULT_ANTIGRAVITY_EXECUTABLE, execFileImpl = execFileAsync } = {}) {
  return async () => {
    const { stdout } = await execFileImpl("/bin/ps", ["-axo", "pid=,command="], { timeout: 2000, encoding: "utf8" });
    const apps = [];
    for (const line of String(stdout).split("\n")) {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (!match) continue;
      const [, pid, command] = match;
      if (command !== executable && !command.startsWith(`${executable} `)) continue;
      apps.push({ pid: Number(pid), ...parseAntigravityDebugArgs(command.slice(executable.length).trim().split(/\s+/).filter(Boolean)) });
    }
    return apps;
  };
}

export function createAntigravityHost({
  snapshot, sessionFactory = createCodexSession, waitForTargets = waitForCodexTargets,
  configStore, initialConfig, logger = console, platform, cards = null,
  hostPlatform = process.platform, env = process.env,
  appPath = resolveAntigravityAppPath({ env, platform: hostPlatform }),
  helperPath = null, nativeBridge,
  execFileImpl, spawnImpl, reservePort = reserveLoopbackPort,
  notifyImpl = (title, message) => notifyDesktop(title, message, { platform: hostPlatform, execFileImpl }),
  now = Date.now,
  intervalMs = 3000, retryMs = 1000, maxRetryMs = 30_000,
  freshWindowMs, cooldownMs, stableAttachMs, quitTimeoutMs, seenKeys = [], onHandledKey = null,
  setTimer = setTimeout, clearTimer = clearTimeout, sleepImpl = (ms, signal) => sleep(ms, undefined, { signal })
} = {}) {
  const bridge = nativeBridge !== undefined ? nativeBridge
    : (!snapshot && hostPlatform === "darwin" && helperPath)
      ? createNativeBridge({ helperPath, appPath, execFileImpl, spawnImpl })
      : null;
  const fallbackSnapshot = snapshot ?? createAntigravitySnapshot({
    executable: `${appPath}/Contents/MacOS/Antigravity`, execFileImpl
  });

  let config = initialConfig;
  let current = null;
  let timer = null;
  let pendingTimer = null;
  let retryTimer = null;
  let watchRetryMs = 1000;
  let nativeWatch = null;
  let watchHealthy = false;
  let watchGeneration = 0;
  let latestSnapshot = null;
  let lastEvent = null;
  let running = false;
  let polling = null;
  let work = Promise.resolve();
  const warned = new Set();
  const notifications = new Map();
  const waits = new Map();
  const log = (message) => logger.warn?.(`[agent-companion] Antigravity：${message}`);

  async function connect(entry) {
    let delay = retryMs;
    const { signal } = entry.abort;
    while (!signal.aborted) {
      try {
        await waitForTargets(entry.port, { timeoutMs: 5000, signal, host: "antigravity" });
        signal.throwIfAborted();
        entry.session = sessionFactory({ port: entry.port, host: "antigravity", configStore, logger, platform, initialConfig: config, processRef: {},
          ...(cards ? { cards } : {}) });
        await entry.session.start();
        signal.throwIfAborted();
        entry.ready = true;
        logger.info?.(`[agent-companion] 已接上 Antigravity（pid ${entry.pid}，调试端口 ${entry.port}）`);
        return;
      } catch (error) {
        await entry.session?.stop("attach-retry").catch(() => {});
        entry.session = null;
        if (signal.aborted) return;
        log(`连接失败：${error?.message ?? error}`);
        try { await sleepImpl(delay, signal); } catch { return; }
        delay = Math.min(delay * 2, maxRetryMs);
      }
    }
  }

  function detach(reasonOrOptions) {
    const key = typeof reasonOrOptions === "object" ? reasonOrOptions?.key : undefined;
    const reason = typeof reasonOrOptions === "object" ? reasonOrOptions?.reason : reasonOrOptions;
    if (!current || (key && current.key !== key)) return work;
    const entry = current;
    current = null;
    entry.abort.abort();
    // 和 Codex 侧一致：正在连接（注入等目标页最长 30 秒）时立即停掉会话，不排在 connect() 之后。
    const stopping = entry.session
      ? Promise.resolve(entry.session.stop(reason)).catch((error) => log(`断开失败：${error?.message ?? error}`))
      : null;
    work = work.then(() => stopping ?? entry.session?.stop(reason)).catch((error) => log(`断开失败：${error?.message ?? error}`));
    return work;
  }

  function attach(app) {
    const key = app.key ?? `${app.pid}:${app.port}`;
    if (current?.key === key) return;
    void detach("replaced");
    const entry = { key, pid: app.pid, port: app.port, abort: new AbortController(), session: null, ready: false };
    current = entry;
    work = work.then(() => (entry.abort.signal.aborted ? null : connect(entry))).catch((error) => log(error?.message ?? error));
  }

  const pause = (ms) => new Promise((resolvePause) => {
    if (!running) return resolvePause();
    const handle = setTimer(() => { waits.delete(handle); resolvePause(); }, ms);
    waits.set(handle, resolvePause);
  });

  const controller = bridge ? new AgentController({
    adapter: {
      async snapshot() {
        const value = await bridge.snapshot();
        if (running && (!latestSnapshot || value.now >= latestSnapshot.now)) latestSnapshot = value;
        return value;
      },
      quit: (options) => bridge.quit(options),
      show: (options) => bridge.show(options),
      async launch(options = {}) {
        if (!running) return { launched: false, reason: "stopped" };
        const port = await reservePort();
        if (!running) return { launched: false, reason: "stopped" };
        return bridge.launch({ ...options, args: [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"] });
      },
      attach: ({ pid, key, port }) => { attach({ pid, key, port }); },
      detach: ({ key, reason } = {}) => detach({ key, reason }),
      async record(event, details = {}) {
        if (!running) return;
        lastEvent = { event, at: now() };
        const keys = [details.processKey, details.key, ...(Array.isArray(details.processKeys) ? details.processKeys : [])];
        for (const key of keys) {
          if (typeof key === "string" && key) await Promise.resolve(onHandledKey?.(key)).catch(() => {});
        }
        logger.info?.(`[agent-companion] Antigravity ${event} ${JSON.stringify(details)}`);
      },
      async notify(kind, details = {}) {
        if (running && typeof details?.processKey === "string" && details.processKey) {
          await Promise.resolve(onHandledKey?.(details.processKey)).catch(() => {});
        }
        const message = ANTIGRAVITY_NOTIFICATIONS[kind];
        const previous = notifications.get(kind);
        if (!running || !message || (previous !== undefined && now() - previous < 600_000)) return;
        notifications.set(kind, now());
        try { await notifyImpl("Agent Companion", message); }
        catch (error) { log(`通知失败：${error?.message ?? error}`); }
      }
    },
    now, sleep: pause, seenKeys,
    autoRelaunch: () => config?.agent?.autoRelaunch === true,
    isOurs: isAntigravityDebugInstance,
    ...(freshWindowMs !== undefined ? { freshWindowMs } : {}),
    ...(cooldownMs !== undefined ? { cooldownMs } : {}),
    ...(stableAttachMs !== undefined ? { stableAttachMs } : {}),
    ...(quitTimeoutMs !== undefined ? { quitTimeoutMs } : {})
  }) : null;

  async function acceptSnapshot(value) {
    if (!running || !controller) return;
    if (latestSnapshot && value.now < latestSnapshot.now) return;
    latestSnapshot = value;
    await controller.handleSnapshot(value);
    if (running && controller.pendingLaunch && !pendingTimer) {
      pendingTimer = setTimer(() => { pendingTimer = null; void poll(); }, 300);
    }
  }

  async function pollOnce() {
    if (bridge) {
      await acceptSnapshot(await bridge.snapshot());
      return;
    }
    const apps = await fallbackSnapshot();
    const app = apps.find((entry) => entry.port !== null && entry.loopback);
    // 调试端口开在非本机地址上：别的机器也能连进来，不接（也不替用户关）。
    for (const entry of apps) {
      if (entry.port === null || entry.loopback || warned.has(entry.pid)) continue;
      warned.add(entry.pid);
      log(`调试端口监听在 ${entry.address}，不是本机地址，已跳过`);
    }
    if (app) attach(app);
    else await detach("app-exit");
  }

  function schedule() {
    if (!running || timer || (bridge && watchHealthy)) return;
    timer = setTimer(() => {
      timer = null;
      void poll().finally(schedule);
    }, intervalMs);
    timer?.unref?.();
  }

  function startWatch() {
    if (!running || !bridge) return;
    const generation = ++watchGeneration;
    const startedAt = now();
    let ended = false;
    const onExit = (error) => {
      if (!running || generation !== watchGeneration || ended) return;
      ended = true;
      nativeWatch?.close();
      nativeWatch = null;
      watchHealthy = false;
      log(error?.message ?? "原生助手 watch 已退出");
      schedule();
      retryTimer = setTimer(() => { retryTimer = null; startWatch(); }, watchRetryMs);
      retryTimer?.unref?.();
      watchRetryMs = Math.min(watchRetryMs * 2, maxRetryMs);
    };
    try {
      const handle = bridge.watch({
        onSnapshot: (value) => {
          if (!running || ended || generation !== watchGeneration) return;
          if (now() - startedAt >= 30_000) watchRetryMs = 1000;
          watchHealthy = true;
          clearTimer(timer);
          timer = null;
          void acceptSnapshot(value).catch((error) => log(`处理快照失败：${error?.message ?? error}`));
        },
        onExit
      });
      if (ended) handle.close();
      else nativeWatch = handle;
    } catch (error) { onExit(error); }
  }

  function poll() {
    polling ??= pollOnce().catch((error) => log(`查看进程失败：${error?.message ?? error}`)).finally(() => { polling = null; });
    return polling;
  }

  return {
    get attachment() { return current?.ready ? { pid: current.pid, port: current.port } : null; },
    get lastEvent() { return lastEvent ? { ...lastEvent } : null; },
    get controller() { return controller; },
    async start() {
      if (running) return;
      running = true;
      if (bridge) {
        startWatch();
        if (!watchHealthy) { await poll(); schedule(); }
      } else {
        await poll();
        schedule();
      }
    },
    poll,
    async applyConfig(next) {
      config = next;
      await current?.session?.applyConfig(next);
    },
    isMediaPlaying() {
      const session = current?.ready ? current.session : null;
      return typeof session?.isMediaPlaying === "function" ? session.isMediaPlaying() : Promise.resolve(false);
    },
    async stop() {
      running = false;
      controller?.stop();
      nativeWatch?.close();
      nativeWatch = null;
      watchHealthy = false;
      for (const handle of [timer, pendingTimer, retryTimer]) clearTimer(handle);
      timer = null;
      pendingTimer = null;
      retryTimer = null;
      for (const [handle, resolvePause] of waits) { clearTimer(handle); resolvePause(); }
      waits.clear();
      await polling;
      await detach("agent-stop");
      await work;
    }
  };
}
