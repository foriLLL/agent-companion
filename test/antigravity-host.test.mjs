import assert from "node:assert/strict";
import test from "node:test";
import { ANTIGRAVITY_NOTIFICATIONS, createAntigravityHost, createAntigravitySnapshot, isAntigravityDebugInstance, parseAntigravityDebugArgs, resolveAntigravityAppPath } from "../src/agent/antigravity-host.mjs";
import { openAntigravity } from "../src/agent/open-antigravity.mjs";
import { parseArgs, runCli } from "../src/cli.mjs";
import { app, clock, flush, nativeBridge, snapshot } from "./helpers/agent.mjs";

const EXE = "/Applications/Antigravity.app/Contents/MacOS/Antigravity";

test("调试参数：端口、地址与是否只监听本机", () => {
  assert.deepEqual(parseAntigravityDebugArgs(["--remote-debugging-port=9339", "--remote-debugging-address=127.0.0.1"]), { port: 9339, address: "127.0.0.1", loopback: true });
  assert.deepEqual(parseAntigravityDebugArgs(["--remote-debugging-port=9339"]), { port: 9339, address: null, loopback: true });
  assert.equal(parseAntigravityDebugArgs(["--remote-debugging-port=9339", "--remote-debugging-address=0.0.0.0"]).loopback, false);
  assert.equal(parseAntigravityDebugArgs(["--remote-debugging-port=70000"]).port, null);
  assert.equal(parseAntigravityDebugArgs([]).port, null);
});

test("进程快照只认主进程，不含 Helper 与语言服务器", async () => {
  const stdout = [
    `  101 ${EXE} --remote-debugging-port=9339 --remote-debugging-address=127.0.0.1`,
    `  102 /Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper.app/Contents/MacOS/Antigravity Helper --type=gpu-process`,
    `  103 /Applications/Antigravity.app/Contents/Resources/bin/language_server --standalone`,
    `  104 ${EXE}Other`
  ].join("\n");
  const snapshot = createAntigravitySnapshot({ execFileImpl: async () => ({ stdout }) });
  assert.deepEqual(await snapshot(), [{ pid: 101, port: 9339, address: "127.0.0.1", loopback: true }]);
});

function harness(initialApps) {
  let apps = initialApps;
  const sessions = [];
  const logs = [];
  const host = createAntigravityHost({
    snapshot: async () => apps,
    waitForTargets: async (port, { host: name }) => { assert.equal(name, "antigravity"); return [{ port }]; },
    sessionFactory: (options) => {
      const session = { options, started: 0, stopped: [], configs: [], async start() { this.started += 1; }, async stop(reason) { this.stopped.push(reason); }, async applyConfig(config) { this.configs.push(config); }, isMediaPlaying: async () => true };
      sessions.push(session);
      return session;
    },
    initialConfig: { revision: 1 }, logger: { info() {}, warn: (message) => logs.push(message) },
    setTimer: () => 0, clearTimer() {}, sleepImpl: async () => {}
  });
  return { host, sessions, logs, setApps: (next) => { apps = next; } };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("带本机调试端口的 Antigravity：接上、配置下发、换端口重接、退出断开", async () => {
  const { host, sessions, setApps } = harness([{ pid: 1, port: 9339, address: "127.0.0.1", loopback: true }]);
  await host.start();
  await settle();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].options.host, "antigravity");
  assert.equal(sessions[0].options.port, 9339);
  assert.deepEqual(sessions[0].options.initialConfig, { revision: 1 });
  assert.deepEqual(host.attachment, { pid: 1, port: 9339 });
  assert.equal(await host.isMediaPlaying(), true);
  await host.applyConfig({ revision: 2 });
  assert.deepEqual(sessions[0].configs, [{ revision: 2 }]);
  await host.poll();
  await settle();
  assert.equal(sessions.length, 1, "同一实例不重复接");

  setApps([{ pid: 2, port: 9440, address: null, loopback: true }]);
  await host.poll();
  await settle();
  assert.deepEqual(sessions[0].stopped, ["replaced"]);
  assert.equal(sessions[1].options.port, 9440);
  assert.deepEqual(sessions[1].options.initialConfig, { revision: 2 }, "新会话用最新配置");

  setApps([]);
  await host.poll();
  await settle();
  assert.deepEqual(sessions[1].stopped, ["app-exit"]);
  assert.equal(host.attachment, null);
  await host.stop();
});

test("没带调试端口不接；调试端口开在非本机地址时跳过并只提示一次", async () => {
  const { host, sessions, logs, setApps } = harness([{ pid: 1, port: null, address: null, loopback: true }]);
  await host.start();
  assert.equal(sessions.length, 0);
  setApps([{ pid: 3, port: 9339, address: "0.0.0.0", loopback: false }]);
  await host.poll();
  await host.poll();
  assert.equal(sessions.length, 0);
  assert.equal(logs.filter((line) => /0\.0\.0\.0/.test(line)).length, 1);
  await host.stop();
});

test("连接失败按退避重试，停止后不再重试", async () => {
  let attempts = 0;
  const sleeps = [];
  let host;
  host = createAntigravityHost({
    snapshot: async () => [{ pid: 1, port: 9339, address: null, loopback: true }],
    waitForTargets: async () => { attempts += 1; if (attempts < 3) throw new Error("页面还没好"); },
    sessionFactory: () => ({ async start() {}, async stop() {}, async applyConfig() {} }),
    logger: { info() {}, warn() {} }, setTimer: () => 0, clearTimer() {},
    retryMs: 10, sleepImpl: async (ms) => { sleeps.push(ms); }
  });
  await host.start();
  for (let index = 0; index < 5; index += 1) await settle();
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [10, 20]);
  assert.deepEqual(host.attachment, { pid: 1, port: 9339 });
  await host.stop();
});

test("打开 Antigravity：已就绪不动、运行中没端口要 --restart、正常退出后带本机端口重开", async () => {
  const calls = [];
  const execFileImpl = async (file, args) => { calls.push([file, ...args]); return { stdout: "" }; };
  const base = { execFileImpl, reservePort: async () => 9555, platform: "darwin", sleepImpl: async () => {} };
  assert.deepEqual(await openAntigravity({ ...base, snapshot: async () => [{ pid: 1, port: 9339, loopback: true }] }), { launched: false, reason: "already-running", pid: 1, port: 9339 });
  assert.deepEqual(await openAntigravity({ ...base, snapshot: async () => [{ pid: 1, port: null, loopback: true }] }), { launched: false, reason: "needs-restart", pid: 1 });
  assert.equal(calls.length, 0, "没有 --restart 时不退出用户的 Antigravity");

  let running = [{ pid: 1, port: null, loopback: true }];
  const result = await openAntigravity({ ...base, restart: true, snapshot: async () => {
    const now = running;
    if (calls.some(([file]) => file === "/usr/bin/osascript")) running = [];
    return now;
  } });
  assert.deepEqual(result, { launched: true, port: 9555, restarted: true });
  assert.deepEqual(calls[0], ["/usr/bin/osascript", "-e", "on run argv\ntell application (item 1 of argv) to quit\nend run", "/Applications/Antigravity.app"]);
  assert.deepEqual(calls.at(-1), ["/usr/bin/open", "-a", "/Applications/Antigravity.app", "--args", "--remote-debugging-port=9555", "--remote-debugging-address=127.0.0.1"]);

  await assert.rejects(openAntigravity({ ...base, restart: true, quitTimeoutMs: 0, snapshot: async () => [{ pid: 1, port: null, loopback: true }] }), (error) => error.code === "QUIT_TIMEOUT");
  await assert.rejects(openAntigravity({ ...base, platform: "linux" }), (error) => error.code === "UNSUPPORTED");
});

test("命令行：antigravity [--restart]", async () => {
  assert.equal(parseArgs(["antigravity"]).command, "antigravity");
  assert.equal(parseArgs(["antigravity", "--restart"]).restart, true);
  assert.throws(() => parseArgs(["launch", "--restart"]), /未知参数/);
  const seen = [];
  const original = console.log;
  console.log = () => {};
  try {
    await runCli(["antigravity", "--restart"], { openAntigravityImpl: async (options) => { seen.push(options); return { launched: true, port: 1 }; } });
  } finally { console.log = original; }
  assert.deepEqual(seen, [{ restart: true }]);
});

test("原生助手模式：刚打开且未带调试参数的 Antigravity 自动退出并以本机端口重开并注入", async () => {
  const timer = clock();
  const bridge = nativeBridge(snapshot([], timer.now()));
  bridge.quit = async (options) => {
    bridge.calls.push(["quit", options]);
    bridge.value = snapshot([], timer.now() + 200);
    return { accepted: true };
  };
  const sessions = [];
  const host = createAntigravityHost({
    nativeBridge: bridge,
    reservePort: async () => 9555,
    waitForTargets: async (port, { host: name }) => { assert.equal(name, "antigravity"); return [{ port }]; },
    sessionFactory: (options) => {
      const session = { options, started: 0, stopped: [], configs: [], async start() { this.started += 1; }, async stop(reason) { this.stopped.push(reason); }, async applyConfig(config) { this.configs.push(config); } };
      sessions.push(session);
      return session;
    },
    initialConfig: { revision: 1, agent: { autoRelaunch: true } },
    logger: { info() {}, warn() {} },
    notifyImpl: async () => {},
    now: timer.now, setTimer: timer.setTimeoutImpl, clearTimer: timer.clearTimeoutImpl,
    sleepImpl: async () => {}
  });
  await host.start();
  // 先送入空基线，模拟后台常驻时 Antigravity 尚未运行。
  bridge.watches[0].onSnapshot(snapshot([], timer.now()));
  await flush();

  // Antigravity 刚打开（含自动更新重启）：30 秒内、无调试参数。
  const fresh = app(42, timer.now(), []);
  bridge.value = snapshot([fresh], timer.now());
  bridge.watches[0].onSnapshot(bridge.value);
  await flush();
  assert.equal(bridge.calls.filter(([name]) => name === "quit").length, 1);
  assert.equal(bridge.calls.find(([name]) => name === "quit")[1].mode, "fresh");

  await timer.advance(200);
  await timer.advance(250);
  const launchCall = bridge.calls.find(([name]) => name === "launch");
  assert.ok(launchCall, "应自动重开 Antigravity");
  assert.deepEqual(launchCall[1].args, ["--remote-debugging-port=9555", "--remote-debugging-address=127.0.0.1"]);
  assert.equal(launchCall[1].hidden, true);
  assert.equal(launchCall[1].env, undefined, "不传 Codex 代理环境变量");
  assert.equal(bridge.calls.filter(([name]) => name === "show").length, 1);
  assert.equal(host.lastEvent?.event, "reopened");

  // 重开后的实例带本机调试端口上线，自动接上会话。
  const reopened = app(101, timer.now(), ["--remote-debugging-port=9555", "--remote-debugging-address=127.0.0.1"]);
  bridge.watches[0].onSnapshot(snapshot([reopened], timer.now()));
  await flush();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].options.host, "antigravity");
  assert.equal(sessions[0].options.port, 9555);
  assert.deepEqual(host.attachment, { pid: 101, port: 9555 });

  await host.stop();
  assert.equal(bridge.watches[0].closed, true);
  assert.deepEqual(sessions[0].stopped, ["agent-stop"]);
  assert.deepEqual(timer.delays(), []);
});

test("原生助手模式：已在运行的基线旧实例只提醒不退出；刚启动的后台实例在后台重开；关闭 autoRelaunch 不重开；省略地址的本机调试端口可接上，0.0.0.0 跳过", async () => {
  const timer = clock();
  const stale = app(11, timer.now() - 60_000, []);
  const bridge = nativeBridge({ ...snapshot([stale], timer.now()), frontmostPid: 99 });
  const handled = [];
  bridge.quit = async (options) => {
    bridge.calls.push(["quit", options]);
    bridge.value = snapshot([], timer.now() + 200);
    return { accepted: true };
  };
  const notices = [];
  const sessions = [];
  const host = createAntigravityHost({
    nativeBridge: bridge,
    reservePort: async () => 9556,
    waitForTargets: async () => [{ port: 9444 }],
    sessionFactory: (options) => {
      const session = { options, async start() {}, async stop() {}, async applyConfig() {} };
      sessions.push(session);
      return session;
    },
    initialConfig: { revision: 1, agent: { autoRelaunch: true } },
    logger: { info() {}, warn() {} },
    notifyImpl: async (title, message) => notices.push({ title, message }),
    onHandledKey: (key) => handled.push(key),
    now: timer.now, setTimer: timer.setTimeoutImpl, clearTimer: timer.clearTimeoutImpl,
    sleepImpl: async () => {}
  });
  await host.start();
  await flush();
  assert.equal(bridge.calls.filter(([name]) => name === "quit").length, 0, "启动前已在运行的旧实例绝不退出");
  assert.equal(notices.length, 1);
  assert.equal(notices[0].message, ANTIGRAVITY_NOTIFICATIONS["needs-restart"]);
  assert.deepEqual(handled, [stale.key], "受保护的基线实例 key 落盘防重启重复提醒");

  // 刚启动的后台无端口实例（例如自动更新重启）在后台重开，不抢前台焦点。
  const freshBg = app(15, timer.now(), []);
  bridge.watches[0].onSnapshot({ ...snapshot([freshBg], timer.now() + 1), frontmostPid: 99 });
  await flush();
  assert.equal(bridge.calls.filter(([name]) => name === "quit").length, 1, "刚启动的后台实例应自动重开");
  await timer.advance(200);
  await timer.advance(250);
  const bgLaunch = bridge.calls.find(([name]) => name === "launch");
  assert.equal(bgLaunch[1].background, true, "后台重开不抢前台焦点");
  assert.equal(bridge.calls.filter(([name]) => name === "show").length, 0);

  // 关闭 autoRelaunch 后新开的普通实例不自动重开。
  await host.applyConfig({ revision: 2, agent: { autoRelaunch: false } });
  bridge.watches[0].onSnapshot(snapshot([app(22, timer.now(), [])], timer.now() + 10));
  await flush();
  assert.equal(bridge.calls.filter(([name]) => name === "quit").length, 1);
  assert.equal(host.lastEvent?.event, "skipped-disabled");

  // 监听 0.0.0.0 的调试实例既不退出也不接管。
  bridge.watches[0].onSnapshot(snapshot([app(33, timer.now(), ["--remote-debugging-port=9339", "--remote-debugging-address=0.0.0.0"])], timer.now() + 11));
  await flush();
  assert.equal(sessions.length, 0);
  assert.equal(host.lastEvent?.event, "foreign-debug");

  // 省略 --remote-debugging-address 时 Chromium 默认只监听 127.0.0.1，直接接上。
  bridge.watches[0].onSnapshot(snapshot([app(44, timer.now(), ["--remote-debugging-port=9444"])], timer.now() + 12));
  await flush();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].options.port, 9444);
  assert.deepEqual(host.attachment, { pid: 44, port: 9444 });

  // watch 异常退出后退避重试，stop 彻底清理。
  bridge.watches[0].onExit(new Error("watch failed"));
  assert.ok(timer.delays().includes(1000));
  await timer.advance(1000);
  assert.equal(bridge.watches.length, 2);
  await host.stop();
  assert.deepEqual(timer.delays(), []);

  assert.equal(isAntigravityDebugInstance({ known: true, debugPort: 9339, debugAddress: null }), true);
  assert.equal(isAntigravityDebugInstance({ known: true, debugPort: 9339, debugAddress: "0.0.0.0" }), false);
  assert.equal(resolveAntigravityAppPath({ env: { AGENT_COMPANION_ANTIGRAVITY_APP: "/test/AGY.app" }, platform: "darwin" }), "/test/AGY.app");
  assert.ok(ANTIGRAVITY_NOTIFICATIONS["needs-restart"]);
  assert.ok(ANTIGRAVITY_NOTIFICATIONS.cooldown);
});
