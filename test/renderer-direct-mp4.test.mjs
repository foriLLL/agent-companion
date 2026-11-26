import assert from "node:assert/strict";
import test from "node:test";
import { createDirectMp4Stream } from "../src/renderer/media/direct-mp4.mjs";

// MSE 的最小替身：只模拟管线依赖的状态机。分片字节的第一位约定为「写完后解析器是否停在媒体段中途」
// （1 = 大分片拆开写入的前半段），第二位是分片编号，便于断言写入顺序。
const invalidState = () => Object.assign(new Error("InvalidStateError"), { name: "InvalidStateError" });
class FakeSourceBuffer extends EventTarget {
  constructor(source) {
    super();
    this.source = source;
    this.updating = false;
    this.midSegment = false;
    this.quotaFull = false;
    this.offset = 0;
    this.log = [];
  }
  get timestampOffset() { return this.offset; }
  set timestampOffset(value) {
    // 规范：updating 或解析器停在媒体段中途时改 timestampOffset 抛 InvalidStateError。
    if (this.updating || this.midSegment) throw invalidState();
    this.offset = value;
    this.log.push(["offset", value]);
  }
  appendBuffer(bytes) {
    if (this.updating) throw invalidState();
    if (this.quotaFull) {
      this.quotaFull = false;
      throw Object.assign(new Error("QuotaExceededError"), { name: "QuotaExceededError" });
    }
    this.log.push(["append", bytes[1] ?? null, this.midSegment]);
    this.midSegment = bytes[0] === 1;
    this.finishLater();
  }
  remove(start, end) {
    if (this.updating) throw invalidState();
    this.log.push(["remove", start, end]);
    this.finishLater();
  }
  abort() {
    if (this.source.readyState !== "open") throw invalidState();
    this.log.push(["abort"]);
    this.midSegment = false;
  }
  finishLater() {
    this.updating = true;
    setTimeout(() => { this.updating = false; this.dispatchEvent(new Event("updateend")); }, 1);
  }
}
class FakeMediaSource extends EventTarget {
  static isTypeSupported() { return true; }
  constructor() {
    super();
    this.readyState = "open";
    this.duration = NaN;
    this.buffers = [];
  }
  addSourceBuffer() {
    const buffer = new FakeSourceBuffer(this);
    this.buffers.push(buffer);
    return buffer;
  }
  endOfStream() { this.readyState = "ended"; }
}
function makeVideo() {
  const video = new EventTarget();
  Object.assign(video, {
    currentTime: 0, paused: false, volume: 1, muted: false, src: "",
    ranges: [],
    removeAttribute(name) { if (name === "src") this.src = ""; }
  });
  video.buffered = {
    get length() { return video.ranges.length; },
    start: (index) => video.ranges[index][0],
    end: (index) => video.ranges[index][1]
  };
  return video;
}

const until = async (check, label) => {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

function setup() {
  const originals = { MediaSource: globalThis.MediaSource, window: globalThis.window };
  globalThis.MediaSource = FakeMediaSource;
  globalThis.window = new EventTarget();
  const calls = [];
  const rpc = (method, params, { signal } = {}) => new Promise((resolve, reject) => {
    const call = { method, params, resolve, reject, taken: false, aborted: false };
    calls.push(call);
    signal?.addEventListener("abort", () => {
      call.aborted = true;
      reject(Object.assign(new Error("请求已取消"), { code: "ABORTED" }));
    }, { once: true });
  });
  const take = async (method) => {
    let call;
    await until(() => (call = calls.find((entry) => entry.method === method && !entry.taken && !entry.aborted)), method);
    call.taken = true;
    return call;
  };
  const scope = {
    rpc,
    listen: (target, type, fn, options) => target.addEventListener(type, fn, options),
    unlisten: (target, type, fn, options) => target.removeEventListener(type, fn, options),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    createObjectURL: () => "blob:fake",
    revokeObjectURL: () => {},
    isDisposed: () => false
  };
  const rpcError = (code, message, retryable = false) => Object.assign(new Error(message), { code, retryable });
  const ui = {
    rpcError,
    toRpcError: (value) => (value?.code ? value : rpcError("RPC_ERROR", String(value?.message ?? value))),
    decodeBase64: (data) => Uint8Array.from(data)
  };
  const video = makeVideo();
  const failures = [];
  let player = null;
  const configure = createDirectMp4Stream(scope, ui);
  const start = async () => {
    const configured = configure(video, { playbackId: "p1" }, {
      rpcPrefix: "fixture.mse",
      setActivePlayer: (value) => { player = value; },
      clearActivePlayer: () => {},
      isStopping: () => false,
      onFailure: (error) => failures.push(error)
    });
    (await take("fixture.mse.init")).resolve({ tracks: [{ id: 1, mime: "video/mp4", initData: [0, 0] }], durationSeconds: 100 });
    await configured;
    return player.sourceBuffers.get(1);
  };
  const seekTo = (time) => {
    video.currentTime = time;
    video.dispatchEvent(new Event("seeking"));
  };
  const restore = () => {
    player?.destroy();
    globalThis.MediaSource = originals.MediaSource;
    if (originals.window === undefined) delete globalThis.window;
    else globalThis.window = originals.window;
  };
  return { video, failures, take, start, seekTo, restore, player: () => player };
}

test("seek 落在大分片两次写入之间：先 abort 重置解析器再改 timestampOffset，新位置从完整分片开始写", async () => {
  const fixture = setup();
  try {
    const buffer = await fixture.start();
    // 一个大分片拆成两次 RPC：前半段写完后解析器停在媒体段中途。
    (await fixture.take("fixture.mse.next")).resolve({ segments: [{ trackId: 1, data: [1, 0xa1], segmentEnd: false }] });
    await until(() => buffer.log.some(([kind, id]) => kind === "append" && id === 0xa1) && !buffer.updating, "前半段写入");
    await fixture.take("fixture.mse.next");
    assert.equal(buffer.midSegment, true, "夹具：解析器停在媒体段中途");

    fixture.seekTo(50);
    (await fixture.take("fixture.mse.seek")).resolve({ timestampOffsetSeconds: 50 });
    await until(() => fixture.failures.length > 0 || buffer.log.some(([kind]) => kind === "offset"), "seek 处理完");
    assert.deepEqual(fixture.failures.map((error) => error.message), [], "seek 不能因解析器状态失败");
    (await fixture.take("fixture.mse.next")).resolve({ segments: [{ trackId: 1, data: [0, 0xb1] }] });
    await until(() => buffer.log.some(([kind, id]) => kind === "append" && id === 0xb1), "新位置写入");

    const offsetAt = buffer.log.findIndex(([kind, value]) => kind === "offset" && value === 50);
    assert.deepEqual(buffer.log[offsetAt - 1], ["abort"], "改 timestampOffset 之前先 abort");
    assert.deepEqual(buffer.log.find(([kind, id]) => kind === "append" && id === 0xb1), ["append", 0xb1, false], "新位置的分片从段边界开始解析");
  } finally {
    fixture.restore();
  }
});

test("配额重试等待期间 seek：旧位置的分片丢弃，不在 seek 之后再写进 SourceBuffer", async () => {
  const fixture = setup();
  try {
    const buffer = await fixture.start();
    fixture.video.ranges = [[0, 10]];
    buffer.quotaFull = true;
    // 第一次写入命中配额；缓冲还有 10 秒，进入重试等待。
    (await fixture.take("fixture.mse.next")).resolve({ segments: [{ trackId: 1, data: [0, 0xa1] }] });
    await until(() => fixture.player().quotaRetries === 1, "命中配额");

    // 拖到缓冲之外：seeking 先唤醒重试循环，后端 seek 在防抖之后才提交。
    fixture.seekTo(50);
    (await fixture.take("fixture.mse.seek")).resolve({ timestampOffsetSeconds: 50 });
    (await fixture.take("fixture.mse.next")).resolve({ segments: [{ trackId: 1, data: [0, 0xb1] }] });
    await until(() => buffer.log.some(([kind, id]) => kind === "append" && id === 0xb1), "新位置写入");
    // 唤醒还在等待的旧重试，让它走完。
    fixture.video.dispatchEvent(new Event("timeupdate"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(fixture.failures, []);
    const appended = buffer.log.filter(([kind]) => kind === "append").map(([, id]) => id);
    assert.deepEqual(appended, [0, 0xb1], "旧位置的分片 0xa1 不能在 seek 之后补写");
  } finally {
    fixture.restore();
  }
});
