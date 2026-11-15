import assert from "node:assert/strict";
import test from "node:test";
import { waitForMediaSourceOpen } from "../src/renderer/media/source-open.mjs";

function harness({ hidden = false, readyState = "closed" } = {}) {
  const document = new EventTarget();
  document.hidden = hidden;
  const source = new EventTarget();
  source.readyState = readyState;
  const timers = new Set();
  const listeners = new Set();
  let now = 0;
  const scope = {
    listen(target, name, callback, options) {
      listeners.add(callback);
      target.addEventListener(name, callback, options);
    },
    unlisten(target, name, callback) {
      listeners.delete(callback);
      target.removeEventListener(name, callback);
    },
    setTimeout(callback, delay) {
      const timer = { callback, deadline: now + delay };
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) { timers.delete(timer); }
  };
  return {
    source, document, scope, timers, listeners,
    now: () => now,
    tick(milliseconds) {
      now += milliseconds;
      for (const timer of [...timers]) {
        if (timer.deadline > now) continue;
        timers.delete(timer);
        timer.callback();
      }
    },
    hide(value) { document.hidden = value; document.dispatchEvent(new Event("visibilitychange")); },
    open() { source.readyState = "open"; source.dispatchEvent(new Event("sourceopen")); }
  };
}

function wait(state, signal) {
  return waitForMediaSourceOpen(state.source, state.scope, { documentImpl: state.document, nowImpl: state.now, signal });
}

test("窗口隐藏时不计启动超时，回到可见后可正常打开 MediaSource", async () => {
  const state = harness({ hidden: true });
  const pending = wait(state);
  state.tick(30_000);
  assert.equal(state.timers.size, 0);
  state.hide(false);
  assert.equal(state.timers.size, 1);
  state.open();
  await pending;
  assert.equal(state.timers.size, 0);
  assert.equal(state.listeners.size, 0);
});

test("启动超时只累计可见时间，隐藏再返回不会重置剩余预算", async () => {
  const state = harness();
  const failure = assert.rejects(wait(state), { code: "MSE_OPEN_TIMEOUT" });
  state.tick(3_000);
  state.hide(true);
  state.tick(30_000);
  assert.equal(state.timers.size, 0);
  state.hide(false);
  state.tick(6_000);
  assert.equal(state.timers.size, 1);
  state.tick(1_000);
  await failure;
  assert.equal(state.timers.size, 0);
  assert.equal(state.listeners.size, 0);
});

test("窗口隐藏时取消播放也立即结束等待并释放监听器", async () => {
  const state = harness({ hidden: true });
  const controller = new AbortController();
  const failure = assert.rejects(wait(state, controller.signal), { code: "ABORTED" });
  controller.abort();
  await failure;
  state.hide(false);
  state.open();
  assert.equal(state.timers.size, 0);
  assert.equal(state.listeners.size, 0);
});

test("源关闭或请求已取消时不留下启动定时器", async () => {
  const state = harness();
  const failure = assert.rejects(wait(state), { code: "MSE_CLOSED" });
  state.source.dispatchEvent(new Event("sourceclose"));
  await failure;
  assert.equal(state.timers.size, 0);
  assert.equal(state.listeners.size, 0);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(wait(state, controller.signal), { code: "ABORTED" });
});

test("已经打开的 MediaSource 不重复等待或创建定时器", async () => {
  const state = harness({ readyState: "open" });
  await wait(state);
  assert.equal(state.timers.size, 0);
  assert.equal(state.listeners.size, 0);
});
