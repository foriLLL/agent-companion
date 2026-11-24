import assert from "node:assert/strict";
import test from "node:test";
import { createAntigravityHost, createAntigravitySnapshot, parseAntigravityDebugArgs } from "../src/agent/antigravity-host.mjs";
import { openAntigravity } from "../src/agent/open-antigravity.mjs";
import { parseArgs, runCli } from "../src/cli.mjs";

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
  assert.deepEqual(calls[0], ["/usr/bin/osascript", "-e", 'tell application "/Applications/Antigravity.app" to quit']);
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
