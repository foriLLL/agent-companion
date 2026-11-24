import { buildCodexLaunchEnvironment, detectCodexProxy } from "../../launcher.mjs";
import { normalizeCodexRateLimits, readCodexRateLimits, resolveCodexCli } from "../../codex-usage.mjs";

// 额度变化不快，上游请求按需发起：缓存 5 分钟，手动刷新至少间隔 1 分钟。
export const CACHE_MS = 5 * 60_000;
export const MIN_REFRESH_MS = 60_000;

// app-server 的请求和 Codex 走同一个出口：优先跟随正在运行的 Codex 的启动代理，
// 其次用设置里「通过代理启动」的端口，都没有时继承后台服务自己的环境。
export async function resolveProxyPort({ inspectCodexProxy, loadConfig }) {
  try {
    const { proxyPort } = await inspectCodexProxy();
    if (proxyPort) return proxyPort;
  } catch {}
  try {
    const proxy = (await loadConfig?.())?.launch?.proxy;
    if (proxy?.enabled && proxy.port) return proxy.port;
  } catch {}
  return null;
}

export function createService({
  inspectCodexProxy = () => detectCodexProxy(),
  loadConfig,
  readImpl = readCodexRateLimits,
  resolveCliImpl = resolveCodexCli,
  env = process.env,
  now = Date.now,
  cacheMs = CACHE_MS,
  minRefreshMs = MIN_REFRESH_MS
} = {}) {
  let snapshot = null; // { ok, fetchedAt, ... }
  let inflight = null;

  async function fetchSnapshot() {
    const startedAt = now();
    try {
      const codexBin = resolveCliImpl({ env });
      if (!codexBin) return { ok: false, fetchedAt: startedAt, code: "CODEX_CLI_NOT_FOUND", error: "没有找到 Codex 命令行，请先安装 Codex 桌面端" };
      const proxyPort = await resolveProxyPort({ inspectCodexProxy, loadConfig });
      const childEnv = proxyPort ? buildCodexLaunchEnvironment(proxyPort, env) : { ...env };
      const result = await readImpl({ codexBin, env: childEnv });
      return { ok: true, fetchedAt: now(), proxyPort, ...normalizeCodexRateLimits(result) };
    } catch (error) {
      return { ok: false, fetchedAt: now(), code: error?.code ?? "CODEX_USAGE_FAILED", error: error?.message ?? String(error) };
    }
  }

  // 同一时刻只跑一个 app-server；多张卡片实例共享结果。某个调用方取消不影响这次读取。
  function refresh() {
    inflight ??= fetchSnapshot().then((next) => {
      // 读取失败时保留上一次成功的数据，界面同时显示错误。
      snapshot = next.ok || !snapshot?.ok ? next : { ...snapshot, stale: true, error: next.error, code: next.code, failedAt: next.fetchedAt };
      return snapshot;
    }).finally(() => { inflight = null; });
    return inflight;
  }

  return {
    methods: {
      async status(params, context) {
        if (params !== undefined && (params === null || typeof params !== "object" || Array.isArray(params))) {
          throw new TypeError("参数必须是对象");
        }
        const force = params?.force === true;
        const age = snapshot ? now() - (snapshot.failedAt ?? snapshot.fetchedAt) : Infinity;
        const due = !snapshot || age >= cacheMs || (force && age >= minRefreshMs);
        const result = due ? await refresh() : snapshot;
        if (context.signal?.aborted) throw context.signal.reason;
        return { ...result, nextRefreshAt: (result.failedAt ?? result.fetchedAt) + minRefreshMs };
      }
    }
  };
}
