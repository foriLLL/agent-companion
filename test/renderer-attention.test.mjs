import assert from "node:assert/strict";
import test from "node:test";
import { createAttentionLayer } from "../src/renderer/shell/attention-layer.mjs";

// 只实现提醒层用到的 DOM；popover、定位与全屏另由 scripts/smoke-attention.mjs 在 Chromium 里验证。
class Node extends EventTarget {
  constructor(tag) {
    super();
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.style = { setProperty() {}, removeProperty() {} };
    this.hidden = false;
    this.textContent = "";
    this.className = "";
    this.isConnected = true;
    this.offsetHeight = 0;
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute() {}
  remove() { this.isConnected = false; }
}

function makeDocument() {
  const win = { innerWidth: 1280, innerHeight: 800, setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {} };
  const doc = {
    defaultView: win, fullscreenElement: null, documentElement: { append() {} },
    addEventListener() {}, removeEventListener() {},
    createElement(tag) {
      const node = new Node(tag);
      node.attachShadow = () => {
        // 面板结构是写死的 innerHTML：按选择器预先建好节点。
        const parts = { ".panel": new Node("section"), ul: new Node("ul"), ".more": new Node("p"), ".state": new Node("span"), ".resume": new Node("button"), ".close": new Node("button") };
        const panel = parts[".panel"];
        let open = false;
        panel.matches = (selector) => selector === ":popover-open" && open;
        panel.showPopover = () => { open = true; };
        panel.hidePopover = () => { open = false; };
        panel.querySelector = (selector) => parts[selector] ?? null;
        return { set innerHTML(_html) {}, querySelector: (selector) => parts[selector] ?? null };
      };
      return node;
    }
  };
  return doc;
}

function makeVideo() {
  return {
    paused: false, ended: false, isConnected: true,
    pause() { this.paused = true; },
    play() { this.paused = false; return Promise.resolve(); },
    getBoundingClientRect: () => ({ left: 600, top: 100, right: 920, bottom: 280, width: 320, height: 180 })
  };
}

function makeRoot(media) {
  const root = new EventTarget();
  root.querySelectorAll = () => media;
  return root;
}

test("同一轮里先到的提醒暂停了视频，后到的提醒仍然显示", () => {
  const video = makeVideo();
  const layer = createAttentionLayer({ document: makeDocument(), autoDismissMs: 60_000 });
  layer.observe(makeRoot([video]));
  const api = layer.forCard("tasks");
  try {
    // 任务看板在一个循环里连发多条：第一条 pause 档同步暂停了视频。
    assert.equal(api.notify({ key: "a", title: "A", pause: true }), true);
    assert.equal(video.paused, true);
    assert.equal(api.notify({ key: "b", title: "B", pause: true }), true, "被平台暂停的视频仍算在看");
    assert.equal(api.notify({ key: "c", title: "C", sticky: false }), true, "非暂停档同样不被丢掉");
    assert.equal(api.pending(), 3);
    const { items, open, paused } = layer.diagnostics();
    assert.deepEqual({ items, open, paused }, { items: 3, open: true, paused: 1 });
  } finally {
    layer.dispose();
  }
});

test("平台已不再托管暂停的视频（用户关掉了面板）时，默认仍只在播放时提醒", () => {
  const video = makeVideo();
  const layer = createAttentionLayer({ document: makeDocument(), autoDismissMs: 60_000 });
  layer.observe(makeRoot([video]));
  const api = layer.forCard("tasks");
  try {
    assert.equal(api.notify({ key: "a", title: "A", pause: true }), true);
    api.dismiss("a");
    assert.equal(api.pending(), 0);
    assert.equal(video.paused, true);
    assert.equal(api.notify({ key: "b", title: "B" }), false, "视频是暂停的、也没有平台托管的暂停");
    assert.equal(api.notify({ key: "c", title: "C", whilePlaying: false }), true);
    // 用户自己暂停的视频不算在看。
    const other = makeVideo();
    other.paused = true;
    const idle = createAttentionLayer({ document: makeDocument(), autoDismissMs: 60_000 });
    idle.observe(makeRoot([other]));
    assert.equal(idle.forCard("tasks").notify({ key: "d", title: "D" }), false);
    idle.dispose();
  } finally {
    layer.dispose();
  }
});
