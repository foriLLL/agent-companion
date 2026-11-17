import { Worker } from "node:worker_threads";

// 常驻 agent 的主线程看门狗。launchd / systemd 只看进程在不在：主线程卡死（死循环、长时间同步计算）时
// 进程仍然存活，页面 RPC 却一直超时。看门狗跑在独立的 worker 线程里：主线程按固定间隔递增共享计数，
// worker 发现计数长时间不动，就同步写一行日志并以 SIGABRT 异常退出，交给 launchd（SuccessfulExit=false）
// 或 systemd（Restart=on-failure）拉起；重启后的 agent 会重新接管带调试参数的 Codex 并注入。
//
// 选 eval Worker 而不是子进程：同一进程内无需额外的 CLI 入口和心跳管道，Node 与 `bun build --compile`
// 产物都支持 eval Worker，线程不随主线程卡死，信号直接发给本进程。

export const WATCHDOG_INTERVAL_MS = 5_000;
export const WATCHDOG_STALL_MS = 30_000;
// 共享 Int32Array 的下标：主线程心跳计数、停止标记。
const BEAT = 0;
const STOPPED = 1;

// 判定逻辑，运行在 worker 线程。必须自包含（只用参数与全局对象，下标直接写字面量）：
// 主线程用 toString() 把它拼进 eval 源码，测试则直接调用并注入时钟与定时器。
// 看门狗自己两次检查的间隔远超 intervalMs，说明整机睡眠或整个进程被挂起过，主线程没机会跳动不算卡死，
// 只重置基线；时钟用单调时钟，不受系统时间调整影响。
export function watchMainThread({ view, stallMs, intervalMs, suspendGapMs = intervalMs * 3, now,
  setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, onStall }) {
  let lastBeat = Atomics.load(view, 0);
  let progressAt = now();
  let checkedAt = progressAt;
  const timer = setIntervalImpl(() => {
    if (Atomics.load(view, 1) !== 0) { clearIntervalImpl(timer); return; }
    const at = now();
    const gap = at - checkedAt;
    checkedAt = at;
    const beat = Atomics.load(view, 0);
    if (beat !== lastBeat) { lastBeat = beat; progressAt = at; return; }
    if (gap > suspendGapMs) { progressAt = at; return; }
    if (at - progressAt < stallMs) return;
    clearIntervalImpl(timer);
    onStall(at - progressAt);
  }, intervalMs);
  return timer;
}

// 卡死后的收尾，同样自包含、运行在 worker 线程。主线程已不可用，日志只能同步写：stderr 由 launchd / systemd
// 收集，另追加到 agent.log。SIGABRT 让服务管理器判为异常退出（macOS 还会留下带主线程调用栈的崩溃报告）；
// 万一信号被拦截，稍后补一个 SIGKILL。
export function abortStalledProcess(stalledMs, { pid, logPath, now, writeSync, appendFileSync, kill,
  signal = "SIGABRT", setTimeoutImpl = setTimeout, killDelayMs = 2_000 }) {
  const line = `${new Date(now()).toISOString()} [ERROR] [codex-companion] agent 主线程已 ${Math.round(stalledMs / 1000)} 秒无响应，`
    + `以 ${signal} 退出，等待后台服务重启\n`;
  try { writeSync(2, line); } catch {}
  if (logPath) { try { appendFileSync(logPath, line, { mode: 0o600 }); } catch {} }
  try { kill(pid, signal); } catch {}
  setTimeoutImpl(() => kill(pid, "SIGKILL"), killDelayMs);
}

// eval 源码按 CommonJS 还是 ES 模块解析取决于宿主参数（例如 --input-type=module 会被 Worker 继承），
// 只用两种模式下都合法的写法：内置模块经动态 import() 取得。
const WORKER_SOURCE = `"use strict";
const watchMainThread = (${watchMainThread});
const abortStalledProcess = (${abortStalledProcess});
Promise.all([import("node:worker_threads"), import("node:fs")]).then(([{ workerData }, { appendFileSync, writeSync }]) => {
  const { view, stallMs, intervalMs, pid, logPath, signal } = workerData;
  watchMainThread({ view, stallMs, intervalMs, now: () => performance.now(),
    onStall: stalledMs => abortStalledProcess(stalledMs, { pid, logPath, signal, now: Date.now, writeSync, appendFileSync,
      kill: (target, name) => process.kill(target, name) }) });
});
`;

// 只由常驻 agent 在拿到单实例锁后启动；stop() 后不会再触发，也不留下让事件循环继续存活的句柄。
export function startMainThreadWatchdog({ stallMs = WATCHDOG_STALL_MS, intervalMs = WATCHDOG_INTERVAL_MS, logPath = null,
  signal = "SIGABRT", onError = () => {}, WorkerImpl = Worker, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval } = {}) {
  const view = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2));
  // 目标进程固定为自身，测试里注入的假 pid 不会被误杀。
  const worker = new WorkerImpl(WORKER_SOURCE, { eval: true,
    workerData: { view, stallMs, intervalMs, pid: process.pid, logPath, signal } });
  let stopped = false;
  // 看门狗线程自身出错只记录，不影响 agent；未监听的 error 事件会让主进程崩溃。
  worker.on("error", error => { if (!stopped) onError(error); });
  worker.unref();
  const heartbeat = setIntervalImpl(() => Atomics.add(view, BEAT, 1), intervalMs);
  heartbeat?.unref?.();
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      Atomics.store(view, STOPPED, 1);
      clearIntervalImpl(heartbeat);
      void Promise.resolve(worker.terminate()).catch(() => {});
    }
  };
}
