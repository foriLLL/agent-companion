import test from "node:test";
import assert from "node:assert/strict";
import { createService, inputCommand } from "../src/cards/chrono-divide/service.mjs";
import { gamePoint } from "../src/cards/chrono-divide/controls.mjs";
import { createFrameFeed } from "../src/cards/chrono-divide/frames.mjs";
import { resolveMediaInterceptUrl } from "../src/media-intercept.mjs";
import { fitBattlefield } from "../src/cards/chrono-divide/viewport.mjs";

test("卡片缩放、视频留白与最外像素映射到地图的四边四角", () => {
  const size = { width: 1024, height: 768 };
  const rect = { left: 10, top: 40, width: 320, height: 260 };
  for (const x of [0, 0.5, 1]) for (const y of [0, 0.5, 1]) {
    const point = gamePoint(10 + x * 319, 50 + y * 239, rect, 1024, 768);
    assert.deepEqual(point, { x, y });
    const [method, params] = inputCommand({ type: "mouseMoved", button: "none", ...point }, size);
    assert.equal(method, "Input.dispatchMouseEvent");
    assert.equal(params.x, Math.round(x * 1023));
    assert.equal(params.y, Math.round(y * 767));
  }
  assert.deepEqual(gamePoint(-10, 340, rect, 1024, 768), { x: 0, y: 1 });
  assert.throws(() => inputCommand({ type: "mousePressed", button: "left", x: NaN, y: 0 }, size));
  assert.throws(() => inputCommand({ type: "Runtime.evaluate" }, size));
});

test("卡片打开失败或启动中取消时只回收自己的后台，允许下次重试", async () => {
  let ready, launches = 0, closed = 0;
  const service = createService({ launchBrowser() {
    launches++;
    return new Promise(resolve => { ready = () => resolve({
      send: async () => { throw new Error("浏览器不可用"); }, close: async () => { closed++; }
    }); });
  } });
  const params = { width: 1024, height: 768, offer: { type: "offer", sdp: "fixture" } };
  const a = { targetId: "a", signal: new AbortController().signal };
  const pending = service.methods.open(params, a);
  await Promise.resolve();
  await assert.rejects(service.methods.open(params, { ...a, targetId: "b" }), /已有红警/);
  await service.disposeTarget("b");
  assert.equal(closed, 0);
  const stopping = service.disposeTarget("a");
  ready();
  await assert.rejects(pending);
  await stopping;
  assert.equal(closed, 1);
  const retry = service.methods.open(params, a);
  await Promise.resolve(); ready();
  await assert.rejects(retry, /浏览器不可用/);
  assert.equal(closed, 2);
  assert.equal(launches, 2);
});

test("战场按引擎支持的偶数视口适配，菜单换画布及窗口变化仍然生效", () => {
  let canvas = null, onMount, onCanvasResize, onWindowResize;
  const sizes = [];
  const root = { querySelector: () => canvas };
  const win = {
    innerWidth: 1512, innerHeight: 949,
    document: { getElementById: () => root },
    r: { set forcesize(value) { sizes.push(value); }, get forcesize() { return sizes.at(-1); } },
    addEventListener(type, cb) { assert.equal(type, "resize"); onWindowResize = cb; },
    MutationObserver: class { constructor(cb) { onMount = cb; } observe() {} },
    ResizeObserver: class { constructor(cb) { onCanvasResize = cb; } observe() {} disconnect() {} }
  };
  fitBattlefield(win);
  assert.equal(sizes.length, 0);
  canvas = { clientWidth: 1024, clientHeight: 768, style: {} };
  onMount();
  assert.equal(sizes.at(-1), "1512x948");
  assert.equal(canvas.style.borderRight, "");
  assert.equal(canvas.style.borderBottom, "1px solid transparent");
  canvas.clientWidth = 1512;
  canvas.clientHeight = 948;
  onCanvasResize();
  fitBattlefield(win);
  assert.equal(sizes.length, 1);
  win.innerWidth = 1201;
  win.innerHeight = 851;
  onWindowResize();
  assert.equal(sizes.at(-1), "1200x850");
  win.innerWidth = 763;
  onWindowResize();
  assert.equal(sizes.at(-1), "800x850");
});

test("本机画面只对持有会话地址的卡片开放，静止帧立即可见，断开恢复视频", async t => {
  let emit, removed = false;
  const commands = [], video = [];
  const paused = Promise.withResolvers(), resumed = Promise.withResolvers();
  const feed = await createFrameFeed({
    browser: { onFrame(id, fn) { assert.equal(id, "game"); emit = fn; return () => { removed = true; }; } },
    sessionId: "game", initialSize: { width: 608, height: 456 },
    send: async (method, params) => { commands.push([method, params]); },
    setVideoEnabled: async enabled => { video.push(enabled); (enabled ? resumed : paused).resolve(); }
  });
  t.after(() => feed.close());
  const url = resolveMediaInterceptUrl(feed.url);
  const denied = await fetch(url.replace("battle.mjpeg", "unknown"));
  assert.equal(denied.status, 404);
  assert.deepEqual(commands, []);
  const abort = new AbortController();
  const response = await fetch(url, { signal: abort.signal });
  const reader = response.body.getReader();
  assert.match(response.headers.get("content-type"), /^multipart\/x-mixed-replace/);
  await paused.promise;
  assert.equal(commands[0][1].maxWidth, 608);
  emit({ sessionId: 42, data: Buffer.from("test-image").toString("base64") });
  let body = "";
  while (!body.includes("test-image\r\n--")) body += Buffer.from((await reader.read()).value).toString();
  assert.deepEqual(commands.at(-1), ["Page.screencastFrameAck", { sessionId: 42 }]);
  await feed.resize({ width: 1280, height: 800 });
  assert.equal(commands.at(-2)[0], "Page.stopScreencast");
  assert.equal(commands.at(-1)[1].maxWidth, 1280);
  abort.abort();
  await resumed.promise;
  assert.equal(commands.at(-1)[0], "Page.stopScreencast");
  assert.equal(video.at(-1), true);
  await feed.close();
  assert.equal(removed, true);
  assert.equal(resolveMediaInterceptUrl(feed.url), null);
});
