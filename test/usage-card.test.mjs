import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { codexCliCandidates, normalizeCodexRateLimits, readCodexRateLimits, resolveCodexCli } from "../src/codex-usage.mjs";
import { createService, resolveProxyPort } from "../src/cards/usage/service.mjs";
import { antigravityGroupLabel, antigravityWindowLabel, remainingTone, resetText, shortResetText, shouldUseRings, windowLabel } from "../src/cards/usage/renderer.mjs";
import { createAntigravityHostApi } from "../src/renderer/adapters/antigravity-host-api.mjs";

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

test("Antigravity 额度：窗口与分组名称", () => {
  assert.equal(antigravityWindowLabel("5h"), "5 小时");
  assert.equal(antigravityWindowLabel("weekly"), "每周");
  assert.equal(antigravityWindowLabel("daily"), "每天");
  assert.equal(antigravityWindowLabel("30m"), "30 分钟");
  assert.equal(antigravityWindowLabel("monthly", "每月额度"), "每月额度");
  assert.equal(antigravityGroupLabel({ name: "Gemini Models", buckets: [{ id: "gemini-weekly" }] }), "Gemini 模型");
  assert.equal(antigravityGroupLabel({ name: "Claude and GPT models", buckets: [{ id: "3p-5h" }] }), "Claude / GPT 模型");
  assert.equal(antigravityGroupLabel({ name: "Other", buckets: [{ id: "x" }] }), "Other");
});

function fakeHubDocument(service) {
  // React 根节点 → 子 fiber 的 props 里带着 Hub 的客户端
  const fiber = { memoizedProps: {}, child: { memoizedProps: { children: null }, sibling: { memoizedProps: { agentService: service } } } };
  const root = { __reactContainer$abc: fiber };
  return { getElementById: (id) => (id === "root" ? root : null), body: null };
}

test("Antigravity 宿主接口：经 Hub 自己的客户端读额度并整理成普通 JSON", async () => {
  const calls = [];
  const service = {
    async retrieveUserQuotaSummary(force) {
      calls.push(force);
      return { response: { description: "", groups: [{ displayName: "Gemini Models", buckets: [
        { bucketId: "gemini-5h", window: "5h", displayName: "5 hour", remaining: { case: "remainingFraction", value: 0.95 }, resetTime: { seconds: 1_800_000_000n, nanos: 0 }, disabled: false },
        { bucketId: "gemini-weekly", window: "weekly", remaining: { case: undefined }, resetTime: undefined }
      ] }] } };
    }
  };
  const api = createAntigravityHostApi({ document: fakeHubDocument(service) });
  assert.equal(api.id, "antigravity");
  const quota = await api.quota({ force: true });
  assert.deepEqual(calls, [true]);
  assert.deepEqual(quota.groups[0].buckets, [
    { id: "gemini-5h", window: "5h", name: "5 hour", remaining: 0.95, resetsAt: 1_800_000_000, description: "", disabled: false },
    { id: "gemini-weekly", window: "weekly", name: "", remaining: null, resetsAt: null, description: "", disabled: false }
  ]);
  JSON.stringify(quota);
  await api.quota();
  assert.deepEqual(calls, [true, false]);
});

test("Antigravity 宿主接口：找不到客户端时报 HOST_API_MISSING", async () => {
  const api = createAntigravityHostApi({ document: { getElementById: () => ({}), body: null } });
  await assert.rejects(api.quota(), (error) => error.code === "HOST_API_MISSING");
});

test("圆环下的重置时间用短写法", () => {
  const now = new Date(2026, 10, 24, 10, 0).getTime();
  const at = (minutes) => (now + minutes * 60_000) / 1000;
  assert.equal(shortResetText(at(0.2), now), "即将重置");
  assert.equal(shortResetText(at(45), now), "45m 后");
  assert.equal(shortResetText(at(108), now), "1h48m 后");
  assert.equal(shortResetText(at(120), now), "2h 后");
  assert.equal(shortResetText(new Date(2026, 11, 1, 4, 8).getTime() / 1000, now), "12/1 04:08");
  assert.equal(shortResetText(undefined, now), "");
});

test("额度展示方式：无分组且不超过两个窗口用进度条，多分组或多窗口用圆环", () => {
  assert.equal(shouldUseRings([{ title: "", items: [{}] }]), false);
  assert.equal(shouldUseRings([{ title: "", items: [{}, {}] }]), false);
  assert.equal(shouldUseRings([{ title: "", items: [{}, {}, {}] }]), true);
  assert.equal(shouldUseRings([{ title: "Gemini 模型", items: [{}, {}] }, { title: "Claude / GPT 模型", items: [{}, {}] }]), true);
});
