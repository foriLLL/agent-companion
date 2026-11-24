import { setTimeout as sleep } from "node:timers/promises";

const REQUEST_TIMEOUT_MS = 2_000;

export async function listCdpTargets(port, { fetchImpl = fetch, signal } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError(`无效 CDP 端口：${port}`);
  }

  const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`CDP target 查询失败：HTTP ${response.status}`);

  const targets = await response.json();
  if (!Array.isArray(targets)) throw new Error("CDP target 响应不是数组");
  return targets;
}

export function isCodexAppTarget(target) {
  if (target?.type !== "page" || typeof target.webSocketDebuggerUrl !== "string") return false;
  if (typeof target.url !== "string") return false;
  try {
    const url = new URL(target.url);
    return url.protocol === "app:" && url.hostname === "-";
  } catch {
    return false;
  }
}

export function filterCodexTargets(targets) {
  return targets.filter((target) => {
    if (!isCodexAppTarget(target)) return false;
    try {
      const url = new URL(target.url);
      return url.pathname === "/index.html"
        && url.searchParams.get("initialRoute") !== "/avatar-overlay";
    } catch {
      return false;
    }
  });
}

// Antigravity 的界面（Hub）是 language_server 在本机随机端口上提供的网页（https），由 Electron 窗口加载；
// sidecar 面板是 iframe 类型的目标，不在这里。
export function isAntigravityHubTarget(target) {
  if (target?.type !== "page" || typeof target.webSocketDebuggerUrl !== "string") return false;
  if (typeof target.url !== "string") return false;
  try {
    const url = new URL(target.url);
    return (url.protocol === "https:" || url.protocol === "http:")
      && (url.hostname === "127.0.0.1" || url.hostname === "localhost")
      && url.port !== "";
  } catch {
    return false;
  }
}

export function filterAntigravityTargets(targets) {
  return targets.filter(isAntigravityHubTarget);
}

// 每种宿主怎么认出要注入的页面。isAppTarget 是宿主自己的全部页面（含辅助窗口），filterTargets 是要挂卡片区的主页面。
export const HOST_TARGETS = Object.freeze({
  codex: Object.freeze({ id: "codex", name: "Codex", isAppTarget: isCodexAppTarget, filterTargets: filterCodexTargets }),
  antigravity: Object.freeze({ id: "antigravity", name: "Antigravity", isAppTarget: isAntigravityHubTarget, filterTargets: filterAntigravityTargets })
});

export function hostTargets(host = "codex") {
  const entry = HOST_TARGETS[host];
  if (!entry) throw new TypeError(`未知宿主：${host}`);
  return entry;
}

export async function waitForCodexTargets(port, { timeoutMs = 30_000, intervalMs = 300, signal, listTargets = listCdpTargets, host = "codex" } = {}) {
  const { filterTargets, name } = hostTargets(host);
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      const targets = filterTargets(await listTargets(port, { signal }));
      signal?.throwIfAborted();
      if (targets.length > 0) return targets;
    } catch (error) {
      signal?.throwIfAborted();
      lastError = error;
    }
    await sleep(intervalMs, undefined, { signal });
  }

  const suffix = lastError ? `；最后错误：${lastError.message}` : "";
  throw new Error(`等待 ${name} renderer 超时（端口 ${port}）${suffix}`);
}
