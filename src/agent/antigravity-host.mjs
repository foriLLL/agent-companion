import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { waitForCodexTargets } from "../targets.mjs";
import { createCodexSession } from "./session.mjs";

// Antigravity 宿主：后台服务定期看一眼 Antigravity 主进程，带着本机调试端口启动的就接上，
// 退出或换端口就断开。不重开、不改 Antigravity 的启动方式：调试端口由用户用 `agent-companion antigravity` 启动时带上。
// 与 Codex 的会话互不影响：各自一个 injector + 服务注册表，看板文件也分开。

const execFileAsync = promisify(execFile);
export const DEFAULT_ANTIGRAVITY_EXECUTABLE = "/Applications/Antigravity.app/Contents/MacOS/Antigravity";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

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
  snapshot = createAntigravitySnapshot(), sessionFactory = createCodexSession, waitForTargets = waitForCodexTargets,
  configStore, initialConfig, logger = console, platform, intervalMs = 3000, retryMs = 1000, maxRetryMs = 30_000,
  setTimer = setTimeout, clearTimer = clearTimeout, sleepImpl = (ms, signal) => sleep(ms, undefined, { signal })
} = {}) {
  let config = initialConfig;
  let current = null;
  let timer = null;
  let running = false;
  let polling = null;
  let work = Promise.resolve();
  const warned = new Set();
  const log = (message) => logger.warn?.(`[agent-companion] Antigravity：${message}`);

  async function connect(entry) {
    let delay = retryMs;
    const { signal } = entry.abort;
    while (!signal.aborted) {
      try {
        await waitForTargets(entry.port, { timeoutMs: 5000, signal, host: "antigravity" });
        signal.throwIfAborted();
        entry.session = sessionFactory({ port: entry.port, host: "antigravity", configStore, logger, platform, initialConfig: config, processRef: {} });
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

  function detach(reason) {
    if (!current) return work;
    const entry = current;
    current = null;
    entry.abort.abort();
    work = work.then(() => entry.session?.stop(reason)).catch((error) => log(`断开失败：${error?.message ?? error}`));
    return work;
  }

  function attach(app) {
    const key = `${app.pid}:${app.port}`;
    if (current?.key === key) return;
    void detach("replaced");
    const entry = { key, pid: app.pid, port: app.port, abort: new AbortController(), session: null, ready: false };
    current = entry;
    work = work.then(() => (entry.abort.signal.aborted ? null : connect(entry))).catch((error) => log(error?.message ?? error));
  }

  async function pollOnce() {
    const apps = await snapshot();
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
    if (!running || timer) return;
    timer = setTimer(() => {
      timer = null;
      void poll().finally(schedule);
    }, intervalMs);
    timer?.unref?.();
  }

  function poll() {
    polling ??= pollOnce().catch((error) => log(`查看进程失败：${error?.message ?? error}`)).finally(() => { polling = null; });
    return polling;
  }

  return {
    get attachment() { return current?.ready ? { pid: current.pid, port: current.port } : null; },
    async start() {
      if (running) return;
      running = true;
      await poll();
      schedule();
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
      clearTimer(timer);
      timer = null;
      await polling;
      await detach("agent-stop");
      await work;
    }
  };
}
