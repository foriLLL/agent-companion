import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { abortStalledProcess, startMainThreadWatchdog, watchMainThread, WATCHDOG_INTERVAL_MS, WATCHDOG_STALL_MS } from "../src/agent/watchdog.mjs";
import { posixOnlyTest } from "./helpers/platform.mjs";
import { temporary } from "./helpers/agent.mjs";

const STALL_MESSAGE = /\[ERROR\] \[codex-companion\] agent 主线程已 \d+ 秒无响应/;

// 手动驱动 worker 里的检查：tick(ms) 让单调时钟前进 ms 后执行一次检查。
function harness({ stallMs = 30_000, intervalMs = 5_000, suspendGapMs } = {}) {
  const view = new Int32Array(new SharedArrayBuffer(8));
  let time = 1_000;
  let check;
  let cleared = false;
  const stalls = [];
  watchMainThread({ view, stallMs, intervalMs, suspendGapMs, now: () => time,
    setIntervalImpl: (fn, ms) => { assert.equal(ms, intervalMs); check = fn; return 7; },
    clearIntervalImpl: timer => { assert.equal(timer, 7); cleared = true; },
    onStall: stalledMs => stalls.push(stalledMs) });
  return {
    view, stalls, cleared: () => cleared,
    beat: () => Atomics.add(view, 0, 1),
    tick(ms = intervalMs) { time += ms; if (!cleared) check(); }
  };
}

test("主线程持续心跳时从不判定卡死", () => {
  const h = harness();
  for (let index = 0; index < 100; index += 1) { h.beat(); h.tick(); }
  assert.deepEqual(h.stalls, []);
  assert.equal(h.cleared(), false);
});

test("心跳停止达到 stallMs 时只触发一次并停止检查", () => {
  const h = harness();
  h.beat(); h.tick();
  for (let index = 0; index < 5; index += 1) h.tick();
  assert.deepEqual(h.stalls, [], "25 秒还未到阈值");
  h.tick();
  assert.deepEqual(h.stalls, [30_000]);
  assert.equal(h.cleared(), true);
  h.tick(); h.tick();
  assert.equal(h.stalls.length, 1);
});

test("看门狗自己的检查略有延迟（未超过挂起判定）仍计入卡死时长", () => {
  const h = harness();
  for (let index = 0; index < 4; index += 1) h.tick(7_000);
  assert.deepEqual(h.stalls, []);
  h.tick(7_000);
  assert.deepEqual(h.stalls, [35_000]);
});

test("看门狗自己也被耽搁（整机睡眠或整进程挂起）时只重置基线，不杀进程", () => {
  const h = harness();
  h.tick(); h.tick(); h.tick();
  // 睡眠 10 分钟：检查间隔远超 3 个周期，期间主线程没有机会跳动。
  h.tick(10 * 60_000);
  assert.deepEqual(h.stalls, []);
  // 醒来后主线程恢复心跳：不判定卡死。
  for (let index = 0; index < 20; index += 1) { h.beat(); h.tick(); }
  assert.deepEqual(h.stalls, []);
  // 再次被挂起后主线程确实卡住：从恢复那一刻重新计时，满 stallMs 才判定。
  h.tick(60_000);
  for (let index = 0; index < 5; index += 1) h.tick();
  assert.deepEqual(h.stalls, []);
  h.tick();
  assert.deepEqual(h.stalls, [30_000]);
});

test("挂起判定阈值可注入，默认是 3 个检查周期", () => {
  const byDefault = harness({ stallMs: 1_000, intervalMs: 100 });
  byDefault.tick(301);
  assert.deepEqual(byDefault.stalls, [], "超过 3 个周期视为挂起");
  const custom = harness({ stallMs: 1_000, intervalMs: 100, suspendGapMs: 2_000 });
  custom.tick(1_500);
  assert.deepEqual(custom.stalls, [1_500]);
});

test("停止标记置位后不再判定，并清掉自己的定时器", () => {
  const h = harness();
  h.tick();
  Atomics.store(h.view, 1, 1);
  h.tick();
  assert.equal(h.cleared(), true);
  for (let index = 0; index < 20; index += 1) h.tick();
  assert.deepEqual(h.stalls, []);
});

test("卡死后同步写 stderr 与 agent.log 各一行，先 SIGABRT，稍后补 SIGKILL", () => {
  const writes = [];
  const appends = [];
  const kills = [];
  const timers = [];
  abortStalledProcess(31_200, { pid: 4321, logPath: "/logs/agent.log", now: () => Date.parse("2026-11-17T00:00:00.000Z"),
    writeSync: (fd, text) => writes.push([fd, text]), appendFileSync: (path, text, options) => appends.push([path, text, options]),
    kill: (pid, signal) => kills.push([pid, signal]), setTimeoutImpl: (fn, ms) => timers.push([fn, ms]) });
  const line = "2026-11-17T00:00:00.000Z [ERROR] [codex-companion] agent 主线程已 31 秒无响应，以 SIGABRT 退出，等待后台服务重启\n";
  assert.deepEqual(writes, [[2, line]]);
  assert.deepEqual(appends, [["/logs/agent.log", line, { mode: 0o600 }]]);
  assert.deepEqual(kills, [[4321, "SIGABRT"]]);
  assert.equal(timers.length, 1);
  assert.equal(timers[0][1], 2_000);
  timers[0][0]();
  assert.deepEqual(kills, [[4321, "SIGABRT"], [4321, "SIGKILL"]]);
});

test("写日志失败或没有日志文件时照样终止进程", () => {
  const kills = [];
  const fail = () => { throw new Error("EIO"); };
  abortStalledProcess(30_000, { pid: 1, logPath: "/logs/agent.log", now: Date.now, writeSync: fail, appendFileSync: fail,
    kill: (_pid, signal) => kills.push(signal), setTimeoutImpl: fn => fn() });
  assert.deepEqual(kills, ["SIGABRT", "SIGKILL"]);
  let appended = false;
  abortStalledProcess(30_000, { pid: 1, logPath: null, now: Date.now, writeSync() {}, appendFileSync: () => { appended = true; },
    kill() {}, setTimeoutImpl() {} });
  assert.equal(appended, false);
});

test("主线程侧：eval Worker 只看本进程，心跳递增共享计数，stop 置位停止标记并终止线程", () => {
  const workers = [];
  class FakeWorker extends EventEmitter {
    constructor(source, options) {
      super();
      Object.assign(this, { source, options, unrefs: 0, terminations: 0 });
      workers.push(this);
    }
    unref() { this.unrefs += 1; }
    terminate() { this.terminations += 1; return Promise.resolve(0); }
  }
  let heartbeat;
  let cleared = null;
  const errors = [];
  const watchdog = startMainThreadWatchdog({ logPath: "/logs/agent.log", WorkerImpl: FakeWorker, onError: error => errors.push(error.message),
    setIntervalImpl: (fn, ms) => { heartbeat = { fn, ms }; return 9; }, clearIntervalImpl: timer => { cleared = timer; } });
  const [worker] = workers;
  assert.equal(worker.options.eval, true);
  assert.match(worker.source, /import\("node:worker_threads"\)/);
  const { view, ...data } = worker.options.workerData;
  assert.deepEqual(data, { stallMs: WATCHDOG_STALL_MS, intervalMs: WATCHDOG_INTERVAL_MS, pid: process.pid,
    logPath: "/logs/agent.log", signal: "SIGABRT" });
  assert.deepEqual([WATCHDOG_INTERVAL_MS, WATCHDOG_STALL_MS], [5_000, 30_000]);
  assert.equal(worker.unrefs, 1);
  assert.equal(heartbeat.ms, WATCHDOG_INTERVAL_MS);
  heartbeat.fn(); heartbeat.fn();
  assert.equal(Atomics.load(view, 0), 2);
  worker.emit("error", new Error("worker boom"));
  assert.deepEqual(errors, ["worker boom"]);
  watchdog.stop();
  watchdog.stop();
  assert.equal(Atomics.load(view, 1), 1);
  assert.equal(cleared, 9);
  assert.equal(worker.terminations, 1);
  worker.emit("error", new Error("after stop"));
  assert.deepEqual(errors, ["worker boom"]);
});

// 真实进程：子进程启动看门狗（缩短阈值）后按 mode 运行。卡死场景用 SIGKILL 代替默认的 SIGABRT，
// 免得每次跑测试都在 macOS 留下崩溃报告；判定、日志与发信号的路径与线上一致。
const watchdogUrl = new URL("../src/agent/watchdog.mjs", import.meta.url).href;
function runChild(mode, logPath) {
  const code = `
    import { startMainThreadWatchdog } from ${JSON.stringify(watchdogUrl)};
    const watchdog = startMainThreadWatchdog({ stallMs: 1_500, intervalMs: 250, signal: "SIGKILL", logPath: ${JSON.stringify(logPath)},
      onError: error => { console.error("watchdog error", error); process.exitCode = 3; } });
    const busy = ms => { const end = Date.now() + ms; while (Date.now() < end) {} };
    const mode = ${JSON.stringify(mode)};
    if (mode === "stuck") setTimeout(() => busy(15_000), 100);
    else if (mode === "stopped") setTimeout(() => { watchdog.stop(); busy(3_000); }, 100);
    else setTimeout(() => {}, 3_000);
  `;
  const startedAt = performance.now();
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal, stderr, elapsedMs: performance.now() - startedAt }));
  });
}

posixOnlyTest("真实进程：主线程卡死时被看门狗异常终止并留下日志；保持响应或已 stop 的进程正常退出", async t => {
  const directory = await temporary(t);
  const logPaths = Object.fromEntries(["stuck", "responsive", "stopped"].map(mode => [mode, join(directory, `${mode}.log`)]));
  const [stuck, responsive, stopped] = await Promise.all(Object.entries(logPaths).map(([mode, path]) => runChild(mode, path)));

  assert.equal(stuck.signal, "SIGKILL", `应被信号终止：${JSON.stringify(stuck)}`);
  assert.ok(stuck.elapsedMs < 8_000, `应在卡死后很快终止，实际 ${Math.round(stuck.elapsedMs)}ms`);
  assert.match(stuck.stderr, STALL_MESSAGE);
  assert.match(await readFile(logPaths.stuck, "utf8"), STALL_MESSAGE);

  for (const [name, result] of [["responsive", responsive], ["stopped", stopped]]) {
    assert.deepEqual([result.exitCode, result.signal], [0, null], `${name}：${JSON.stringify(result)}`);
    assert.doesNotMatch(result.stderr, STALL_MESSAGE);
    await assert.rejects(readFile(logPaths[name], "utf8"), { code: "ENOENT" });
  }
});
