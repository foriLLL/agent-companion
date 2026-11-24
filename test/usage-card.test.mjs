import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { codexCliCandidates, normalizeCodexRateLimits, readCodexRateLimits, resolveCodexCli } from "../src/codex-usage.mjs";
import { createService, resolveProxyPort } from "../src/cards/usage/service.mjs";
import { remainingTone, resetText, windowLabel } from "../src/cards/usage/renderer.mjs";

// 假的 `codex app-server`：按行读 JSON-RPC 请求，按脚本回包，记录收到的方法。
function fakeAppServer({ result, error, exitEarly = false } = {}) {
  const calls = [];
  const spawnImpl = (bin, args, options) => {
    calls.push({ bin, args, env: options.env });
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => { child.killed = true; };
    let buffer = "";
    child.stdin.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        calls.push({ method: message.method, params: message.params });
        if (exitEarly) { setImmediate(() => child.emit("exit", 1)); return; }
        if (message.method === "initialize") child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
        if (message.method === "account/rateLimits/read") {
          child.stdout.write(`${JSON.stringify({ method: "some/notification", params: {} })}\n`);
          child.stdout.write(`${JSON.stringify(error ? { id: message.id, error } : { id: message.id, result })}\n`);
        }
      }
    });
    calls.child = child;
    return child;
  };
  return { spawnImpl, calls };
}

const SAMPLE = {
  rateLimits: {
    limitId: "codex", planType: "pro",
    primary: { usedPercent: 28, windowDurationMins: 300, resetsAt: 1_800_000_000 },
    secondary: { usedPercent: 61.5, windowDurationMins: 10_080, resetsAt: 1_800_300_000 }
  }
};

test("app-server 只调 initialize 和 account/rateLimits/read，拿到结果就结束子进程", async () => {
  const { spawnImpl, calls } = fakeAppServer({ result: SAMPLE });
  const result = await readCodexRateLimits({ codexBin: "/x/codex", env: { HTTPS_PROXY: "http://127.0.0.1:7890" }, spawnImpl });
  assert.deepEqual(result, SAMPLE);
  assert.deepEqual(calls[0].args, ["app-server"]);
  assert.equal(calls[0].env.HTTPS_PROXY, "http://127.0.0.1:7890");
  assert.deepEqual(calls.slice(1).map((call) => call.method), ["initialize", "initialized", "account/rateLimits/read"]);
  assert.ok(!calls.some((call) => call.method === "account/read"), "不读取带邮箱的账号信息");
  assert.equal(calls.child.killed, true);
});

test("app-server 报错、提前退出或找不到命令行时给出可读的错误", async () => {
  await assert.rejects(readCodexRateLimits({ codexBin: "/x/codex", spawnImpl: fakeAppServer({ error: { message: "not logged in" } }).spawnImpl }),
    /account\/rateLimits\/read 失败：not logged in/);
  await assert.rejects(readCodexRateLimits({ codexBin: "/x/codex", spawnImpl: fakeAppServer({ exitEarly: true }).spawnImpl }), /提前退出/);
  await assert.rejects(readCodexRateLimits({ codexBin: null }), { code: "CODEX_CLI_NOT_FOUND" });
});

test("命令行按环境变量、桌面端自带、PATH、Homebrew 的顺序查找", () => {
  const candidates = codexCliCandidates({ env: { AGENT_COMPANION_CODEX_CLI: "/custom/codex", PATH: "/a:/b" }, platform: "darwin" });
  assert.equal(candidates[0], "/custom/codex");
  assert.equal(candidates[1], "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex");
  assert.ok(candidates.indexOf("/a/codex") < candidates.indexOf("/opt/homebrew/bin/codex"));
  assert.equal(resolveCodexCli({ env: { PATH: "/a:/b" }, platform: "darwin", exists: (file) => file === "/b/codex" }), "/b/codex");
  assert.equal(resolveCodexCli({ env: {}, platform: "linux", exists: () => false }), null);
});

test("额度整理：主额度在前、窗口从短到长，附带套餐、积分与是否用完", () => {
  const normalized = normalizeCodexRateLimits({
    rateLimitsByLimitId: {
      spark: { limitId: "spark", limitName: "Spark", primary: { usedPercent: 120, windowDurationMins: 300, resetsAt: 5 } },
      codex: { ...SAMPLE.rateLimits, credits: { hasCredits: true, unlimited: false, balance: "12.5" }, rateLimitReachedType: null }
    }
  });
  assert.equal(normalized.plan, "Pro");
  assert.equal(normalized.credits, 12.5);
  assert.equal(normalized.limitReached, false);
  assert.deepEqual(normalized.limits.map((limit) => [limit.id, limit.scope, limit.windowMinutes, limit.usedPercent]), [
    ["codex:primary", null, 300, 28],
    ["codex:secondary", null, 10_080, 61.5],
    ["spark:primary", "Spark", 300, 100]
  ]);
  assert.equal(normalizeCodexRateLimits({ rateLimits: { primary: null }, ordinaryUsageAllowed: false }).limitReached, true);
  assert.deepEqual(normalizeCodexRateLimits(null).limits, []);
});

test("代理跟随运行中的 Codex，其次是设置里开着的启动代理，都没有就不设", async () => {
  assert.equal(await resolveProxyPort({ inspectCodexProxy: async () => ({ proxyPort: 7891 }), loadConfig: async () => ({ launch: { proxy: { enabled: true, port: 7890 } } }) }), 7891);
  assert.equal(await resolveProxyPort({ inspectCodexProxy: async () => ({ proxyPort: null }), loadConfig: async () => ({ launch: { proxy: { enabled: true, port: 7890 } } }) }), 7890);
  assert.equal(await resolveProxyPort({ inspectCodexProxy: async () => { throw new Error("ps"); }, loadConfig: async () => ({ launch: { proxy: { enabled: false, port: 7890 } } }) }), null);
});

test("服务缓存 5 分钟、手动刷新至少隔 1 分钟，并发请求只起一个 app-server", async () => {
  let clock = 1_000_000;
  let reads = 0;
  const envs = [];
  const service = createService({
    inspectCodexProxy: async () => ({ proxyPort: null }),
    loadConfig: async () => ({ launch: { proxy: { enabled: true, port: 7890 } } }),
    resolveCliImpl: () => "/x/codex",
    readImpl: async ({ env }) => { reads += 1; envs.push(env); return SAMPLE; },
    env: { PATH: "/usr/bin" },
    now: () => clock
  });
  const status = (params) => service.methods.status(params, { signal: new AbortController().signal });

  const [first, second] = await Promise.all([status({}), status({})]);
  assert.equal(reads, 1);
  assert.deepEqual(first, second);
  assert.equal(first.ok, true);
  assert.equal(first.plan, "Pro");
  assert.equal(first.proxyPort, 7890);
  assert.equal(envs[0].HTTPS_PROXY, "http://127.0.0.1:7890");

  clock += 30_000;
  await status({ force: true });
  assert.equal(reads, 1, "1 分钟内的手动刷新直接用缓存");
  clock += 31_000;
  await status({ force: true });
  assert.equal(reads, 2);
  clock += 4 * 60_000;
  await status({});
  assert.equal(reads, 2, "5 分钟缓存内的自动轮询不发请求");
  clock += 61_000;
  await status({});
  assert.equal(reads, 3);
  await assert.rejects(status([]), TypeError);
});

test("读取失败时保留上次成功的数据并标记 stale；从没成功过时返回错误", async () => {
  let clock = 0;
  let fail = true;
  const service = createService({
    inspectCodexProxy: async () => ({ proxyPort: null }),
    resolveCliImpl: () => "/x/codex",
    readImpl: async () => { if (fail) throw new Error("network down"); return SAMPLE; },
    now: () => clock
  });
  const status = (params) => service.methods.status(params, { signal: new AbortController().signal });
  const failed = await status({});
  assert.equal(failed.ok, false);
  assert.match(failed.error, /network down/);

  fail = false;
  clock += 61_000;
  assert.equal((await status({ force: true })).ok, true);
  fail = true;
  clock += 6 * 60_000;
  const stale = await status({});
  assert.equal(stale.ok, true);
  assert.equal(stale.stale, true);
  assert.match(stale.error, /network down/);
  assert.equal(stale.limits.length, 2);

  const missing = createService({ resolveCliImpl: () => null, inspectCodexProxy: async () => ({}) });
  assert.equal((await missing.methods.status({}, { signal: new AbortController().signal })).code, "CODEX_CLI_NOT_FOUND");
});

test("界面文案：窗口名称、重置时间与剩余额度配色", () => {
  assert.equal(windowLabel(300), "5 小时");
  assert.equal(windowLabel(10_080), "每周");
  assert.equal(windowLabel(43_200), "每月");
  assert.equal(windowLabel(2880), "2 天");
  assert.equal(windowLabel(120), "2 小时");
  assert.equal(windowLabel(null), "额度");

  const now = Date.UTC(2026, 10, 24, 8, 0) ;
  assert.equal(resetText(now / 1000 + 20, now), "即将重置");
  assert.equal(resetText(now / 1000 + 45 * 60, now), "45 分钟后重置");
  assert.equal(resetText(now / 1000 + 3 * 3600 + 12 * 60, now), "3 小时 12 分后重置");
  assert.equal(resetText(now / 1000 + 2 * 3600, now), "2 小时后重置");
  assert.match(resetText(now / 1000 + 3 * 86400, now), /^11\/27 周[日一二三四五六] \d\d:\d\d 重置$/);
  assert.equal(resetText(null, now), "");

  assert.deepEqual([80, 51, 50, 21, 20, 0, null].map(remainingTone), ["ok", "ok", "warn", "warn", "bad", "bad", "off"]);
});
