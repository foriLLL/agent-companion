// 通过官方 `codex app-server`（stdio JSON-RPC）读取本机 Codex 账号的用量额度（5 小时 / 每周窗口）。
// 凭证始终留在 Codex 自己的 CODEX_HOME 里，由 Codex 负责刷新令牌；这里只拿百分比与重置时间。
// 只调用 account/rateLimits/read，不调用会返回邮箱等身份信息的 account/read。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { searchPathCandidates } from "../../src/platform/paths.mjs";

const DEFAULT_TIMEOUT_MS = 45_000;

const PLAN_NAMES = {
  free: "Free", go: "Go", plus: "Plus", pro: "Pro", prolite: "Pro Lite",
  team: "Team", business: "Business", enterprise: "Enterprise", edu: "Edu"
};

// Codex 桌面端自带命令行；launchd 下 PATH 很短，按已知安装位置兜底。
export function codexCliCandidates({ env = process.env, platform = process.platform } = {}) {
  const candidates = [];
  if (env.AGENT_COMPANION_CODEX_CLI) candidates.push(env.AGENT_COMPANION_CODEX_CLI);
  if (platform === "darwin") {
    candidates.push(
      "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
      "/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex",
      "/Applications/Codex.app/Contents/Resources/codex"
    );
  } else if (platform === "linux") {
    candidates.push("/usr/lib/chatgpt/resources/codex-cli/bin/codex");
  }
  candidates.push(...searchPathCandidates([platform === "win32" ? "codex.exe" : "codex"], { platform, env }));
  if (platform !== "win32") candidates.push("/opt/homebrew/bin/codex", "/usr/local/bin/codex");
  return [...new Set(candidates)];
}

export function resolveCodexCli({ env = process.env, platform = process.platform, exists = existsSync } = {}) {
  return codexCliCandidates({ env, platform }).find((candidate) => exists(candidate)) ?? null;
}

// 启动一次 app-server：initialize → account/rateLimits/read，拿到结果即结束子进程。
export function readCodexRateLimits({ codexBin, env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS, spawnImpl = spawn } = {}) {
  if (!codexBin) return Promise.reject(Object.assign(new Error("没有找到 Codex 命令行"), { code: "CODEX_CLI_NOT_FOUND" }));
  const child = spawnImpl(codexBin, ["app-server"], { stdio: ["pipe", "pipe", "pipe"], env });

  return new Promise((resolve, reject) => {
    let stdoutBuffer = "";
    let stderrTail = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch {}
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(value);
    };
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const timer = setTimeout(() => finish(new Error(`codex app-server 超时${stderrHint(stderrTail)}`)), timeoutMs);

    child.on("error", (error) => finish(new Error(`无法启动 codex：${error.message}`)));
    child.on("exit", (code) => finish(new Error(`codex app-server 提前退出（code ${code}）${stderrHint(stderrTail)}`)));
    child.stdin.on("error", () => {});
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderrTail = (stderrTail + chunk).slice(-2000); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      let newline;
      while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === undefined || message.method) continue; // 通知与服务端请求
        if (message.error) {
          const step = message.id === 1 ? "initialize" : "account/rateLimits/read";
          finish(new Error(`codex ${step} 失败：${message.error.message ?? JSON.stringify(message.error)}`));
          return;
        }
        if (message.id === 1) {
          send({ method: "initialized" });
          send({ id: 2, method: "account/rateLimits/read", params: { excludeResetCreditDetails: true } });
        } else if (message.id === 2) {
          finish(null, message.result ?? {});
        }
      }
    });

    send({ id: 1, method: "initialize", params: { clientInfo: { name: "agent-companion", title: "Agent Companion", version: "1" } } });
  });
}

function stderrHint(stderr) {
  const line = stderr.split("\n")
    .map((text) => text.replace(/\u001b\[[0-9;]*m/g, "").trim())
    .filter((text) => text && !/unrecognized configuration|is ignored\.$/.test(text))
    .at(-1);
  return line ? `：${line.slice(0, 200)}` : "";
}

const toNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const clampPercent = (value) => {
  const number = toNumber(value);
  return number === null ? null : Math.min(100, Math.max(0, number));
};

export function planLabel(planType) {
  if (!planType) return null;
  return PLAN_NAMES[planType] ?? planType.charAt(0).toUpperCase() + planType.slice(1);
}

// 把 account/rateLimits/read 的结果整理成卡片用的结构；主额度在前，同一额度内按窗口从短到长。
export function normalizeCodexRateLimits(result) {
  const byId = result?.rateLimitsByLimitId;
  const buckets = byId && Object.keys(byId).length > 0
    ? Object.values(byId).filter(Boolean)
    : [result?.rateLimits].filter(Boolean);
  const main = buckets.find((bucket) => bucket.limitId === "codex") ?? buckets[0] ?? null;
  const limits = [];
  for (const bucket of buckets) {
    const scope = bucket.limitId && bucket.limitId !== "codex" ? (bucket.limitName ?? bucket.limitId) : null;
    for (const slot of ["primary", "secondary"]) {
      const window = bucket[slot];
      if (!window) continue;
      limits.push({
        id: `${bucket.limitId ?? "codex"}:${slot}`,
        scope,
        windowMinutes: toNumber(window.windowDurationMins),
        usedPercent: clampPercent(window.usedPercent),
        resetsAt: toNumber(window.resetsAt)
      });
    }
  }
  limits.sort((a, b) => Number(b.scope === null) - Number(a.scope === null)
    || (a.windowMinutes ?? Infinity) - (b.windowMinutes ?? Infinity));
  const credits = main?.credits;
  return {
    plan: planLabel(main?.planType),
    limitReached: buckets.some((bucket) => bucket.rateLimitReachedType) || result?.ordinaryUsageAllowed === false,
    limits,
    credits: credits?.hasCredits && !credits.unlimited ? toNumber(credits.balance) : null
  };
}
