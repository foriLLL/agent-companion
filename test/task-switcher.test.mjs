import assert from "node:assert/strict";
import test from "node:test";
import { SHOW_DELAY_MS, createSwitchController, isMac, mergeRecent, modifierOf, orderByRecent, touchRecent } from "../cards/tasks/switcher.mjs";
import { createOverlayLayer } from "../src/renderer/shell/overlay-layer.mjs";
import { createEffects } from "../src/renderer/platform/effects.mjs";

// 按键状态机不碰 DOM；真实按键、浮层与侧栏切换另由 scripts/smoke-task-board.mjs 在独立 Chromium 里验证。
const task = (n) => ({ threadId: `01a18216-3b02-7db0-b394-${String(n).padStart(12, "0")}`, n });
const down = (key, extra = {}) => ({ key, code: key, altKey: true, shiftKey: false, metaKey: false, ctrlKey: false, isComposing: false, ...extra });
const release = { key: "Alt", code: "AltLeft", altKey: false };

function fixture({ tasks = [task(1), task(2), task(3)], current, platform = "MacIntel", enabled = () => true, ...options } = {}) {
  const state = { tasks, current: current === undefined ? tasks[0]?.threadId ?? null : current };
  const picked = [];
  const timers = [];
  let prepared = 0;
  let changes = 0;
  const controller = createSwitchController({
    items: () => state.tasks, current: () => state.current, pick: (item) => picked.push(item.n),
    prepare: () => { prepared += 1; }, onChange: () => { changes += 1; }, enabled, platform, ...options,
    schedule: (fn, ms) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    }
  });
  const elapse = () => { for (const timer of timers.splice(0)) if (!timer.cancelled) timer.fn(); };
  const selected = () => controller.list.find((item) => item.threadId === controller.selected)?.n ?? null;
  return { controller, state, picked, timers, elapse, selected, get prepared() { return prepared; }, get changes() { return changes; } };
}

test("最近打开的在前，没打开过的按看板顺序；记录去重、限长，没变化时不换数组", () => {
  const [a, b, c, d] = [task(1), task(2), task(3), task(4)];
  assert.deepEqual(orderByRecent([a, b, c, d], [c.threadId, a.threadId]).map((item) => item.n), [3, 1, 2, 4]);
  assert.deepEqual(orderByRecent([a, b], []).map((item) => item.n), [1, 2]);
  const recent = touchRecent([], "x");
  assert.deepEqual(recent, ["x"]);
  assert.equal(touchRecent(recent, "x"), recent);
  assert.equal(touchRecent(recent, null), recent);
  assert.deepEqual(touchRecent(["x", "y", "z"], "z"), ["z", "x", "y"]);
  let long = [];
  for (let index = 0; index < 150; index += 1) long = touchRecent(long, `id-${index}`);
  assert.equal(long.length, 100);
  assert.equal(long[0], "id-149");
  assert.deepEqual(mergeRecent(["b", "x"], ["a", "b", "c", 3, null]), ["b", "x", "a", "c"], "本页新记的在前，后台存的接在后面，去重并丢掉非字符串");
  assert.equal(mergeRecent(long, ["extra"]).length, 100, "合并后同样限长");
  assert.deepEqual(["alt", "ctrl", "meta", undefined].map(modifierOf), ["alt", "ctrl", "alt", "alt"]);
  for (const value of ["MacIntel", "macOS", "darwin"]) assert.equal(isMac(value), true, value);
  for (const value of ["Linux x86_64", "Win32", "linux", undefined, null]) assert.equal(isMac(value), false, String(value));
});

test("快速点按 Option+Tab 直接回到上一个会话，不弹面板", () => {
  const f = fixture();
  assert.equal(f.controller.keydown(down("Tab")), true);
  assert.equal(f.controller.phase, "held");
  assert.equal(f.selected(), 2, "当前会话排第一，默认选中上一个");
  assert.equal(f.prepared, 1, "开始时请卡片刷新一次看板");
  assert.equal(f.timers[0].ms, SHOW_DELAY_MS);
  assert.equal(f.controller.keyup(down("Tab")), true, "松开 Tab 也拦下");
  assert.equal(f.controller.phase, "held");
  assert.equal(f.controller.keyup(release), true);
  assert.equal(f.controller.phase, "idle");
  assert.deepEqual(f.picked, [2]);
  assert.equal(f.timers[0].cancelled, true, "松开后不再弹出面板");
  assert.equal(f.controller.keyup(release), false, "空闲时的按键交还 Codex");
});

test("按住后弹出面板，Tab、Shift+Tab 与方向键循环选择，松开 Option 切到选中的", () => {
  const f = fixture();
  f.controller.keydown(down("Tab"));
  f.elapse();
  assert.equal(f.controller.phase, "open");
  f.controller.keydown(down("Tab"));
  assert.equal(f.selected(), 3);
  f.controller.keydown(down("Tab", { repeat: true }));
  assert.equal(f.selected(), 1, "到底后绕回第一个");
  f.controller.keydown(down("Tab", { shiftKey: true }));
  assert.equal(f.selected(), 3, "Shift+Tab 反向");
  f.controller.keydown(down("ArrowUp"));
  assert.equal(f.selected(), 2);
  f.controller.keydown(down("ArrowRight"));
  assert.equal(f.selected(), 3);
  assert.equal(f.controller.keydown(down("å", { code: "KeyA" })), true, "面板期间按 Option+字母也拦下，不打出特殊字符");
  assert.equal(f.selected(), 3);
  f.controller.keyup(release);
  assert.deepEqual(f.picked, [3]);
  assert.equal(f.controller.phase, "idle");
});

test("还没弹出就连按 Tab 立即弹出；Esc 取消、Enter 立即切换、cancel 用于窗口失焦", () => {
  const f = fixture();
  f.controller.keydown(down("Tab"));
  f.controller.keydown(down("Tab"));
  assert.equal(f.controller.phase, "open");
  assert.equal(f.timers[0].cancelled, true);
  assert.equal(f.selected(), 3);
  assert.equal(f.controller.keydown(down("Escape")), true);
  assert.equal(f.controller.phase, "idle");
  assert.equal(f.controller.keyup(release), false, "取消后松开 Option 不切换");
  assert.deepEqual(f.picked, []);
  f.controller.keydown(down("Tab"));
  f.controller.keydown(down("Enter"));
  assert.deepEqual(f.picked, [2]);
  f.controller.keydown(down("Tab"));
  f.controller.cancel();
  assert.equal(f.controller.phase, "idle");
  assert.deepEqual(f.picked, [2]);
});

test("当前会话不在看板里：正向从最近的一个开始，反向从最后一个开始", () => {
  const f = fixture({ current: null });
  f.controller.keydown(down("Tab"));
  assert.equal(f.selected(), 1);
  f.controller.cancel();
  f.controller.keydown(down("Tab", { shiftKey: true }));
  assert.equal(f.selected(), 3);
  f.controller.cancel();
  const inBoard = fixture();
  inBoard.controller.keydown(down("Tab", { shiftKey: true }));
  assert.equal(inBoard.selected(), 3, "当前会话在看板里时反向是最后一个");
  const single = fixture({ tasks: [task(9)] });
  single.controller.keydown(down("Tab"));
  assert.equal(single.selected(), 9, "只有一个时选中它自己");
});

test("非 macOS、开关关闭、看板为空、带 ⌘ / Ctrl、输入法组字或没按 Option 时不拦截", () => {
  assert.equal(fixture({ platform: "Linux x86_64" }).controller.keydown(down("Tab")), false);
  assert.equal(fixture({ enabled: () => false }).controller.keydown(down("Tab")), false);
  assert.equal(fixture({ tasks: [] }).controller.keydown(down("Tab")), false);
  const f = fixture();
  for (const event of [down("Tab", { metaKey: true }), down("Tab", { ctrlKey: true }), down("Tab", { isComposing: true }), down("Tab", { altKey: false }), down("a")]) {
    assert.equal(f.controller.keydown(event), false, JSON.stringify(event));
  }
  assert.equal(f.controller.phase, "idle");
  assert.equal(f.prepared, 0);
});

test("漏了 Option 的 keyup 时，下一次不带 Option 的按键补上切换", () => {
  const f = fixture();
  f.controller.keydown(down("Tab"));
  assert.equal(f.controller.keydown({ key: "Enter", code: "Enter", altKey: false }), true);
  assert.deepEqual(f.picked, [2]);
  assert.equal(f.controller.phase, "idle");
});

test("面板开着时看板更新：顺序不变、换成新数据，新加入的排最后，选中的被移出就顺延，全部移出就关闭", () => {
  const f = fixture({ tasks: [task(1), task(2), task(3)] });
  f.controller.keydown(down("Tab"));
  f.elapse();
  const before = f.controller.list;
  f.state.tasks = [task(3), task(4), task(1), task(2)];
  f.controller.refresh();
  assert.notEqual(f.controller.list, before);
  assert.deepEqual(f.controller.list.map((item) => item.n), [1, 2, 3, 4]);
  assert.equal(f.controller.list[0], f.state.tasks[2], "换成新数据");
  assert.equal(f.selected(), 2);
  f.state.tasks = [task(1), task(3), task(4)];
  f.controller.refresh();
  assert.deepEqual(f.controller.list.map((item) => item.n), [1, 3, 4]);
  assert.equal(f.selected(), 3, "选中的被移出时顺延到同一位置");
  f.state.tasks = [];
  f.controller.refresh();
  assert.equal(f.controller.phase, "idle");
  assert.deepEqual(f.picked, []);
  const idle = fixture();
  const changes = idle.changes;
  idle.controller.refresh();
  assert.equal(idle.changes, changes, "没弹出时不处理");
});

test("鼠标：面板弹出后悬停改选中、点击直接切换；还没弹出时悬停不算，未知条目忽略", () => {
  const f = fixture();
  const [first, , third] = f.state.tasks.map((item) => item.threadId);
  f.controller.keydown(down("Tab"));
  f.controller.hover(third);
  assert.equal(f.selected(), 2, "面板还没弹出");
  f.elapse();
  f.controller.hover(third);
  assert.equal(f.selected(), 3);
  f.controller.hover("missing");
  assert.equal(f.selected(), 3);
  f.controller.choose(first);
  assert.deepEqual(f.picked, [1]);
  assert.equal(f.controller.phase, "idle");
  f.controller.choose(first);
  assert.deepEqual(f.picked, [1], "空闲时点击无效");
});

test("顶层浮层第一次取 root 时才挂到文档根上，被移走后重建，卡片卸载时移除", () => {
  const documentElement = { children: [], append(node) { node.parent = this; this.children.push(node); } };
  const doc = {
    documentElement,
    createElement(tag) {
      return {
        tag, id: "", style: { cssText: "" }, parent: null,
        get isConnected() { return Boolean(this.parent); },
        remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; },
        attachShadow({ mode }) { this.shadowRoot = { mode, host: this }; return this.shadowRoot; }
      };
    }
  };
  const controller = new AbortController();
  const effects = createEffects({ signal: controller.signal });
  const layer = createOverlayLayer({ document: doc, cardId: "tasks", effects });
  assert.equal(documentElement.children.length, 0, "没用到时不建节点");
  const root = layer.root;
  assert.equal(layer.root, root);
  assert.equal(documentElement.children.length, 1);
  const [host] = documentElement.children;
  assert.equal(host.id, "agent-companion-overlay-tasks");
  assert.equal(root.mode, "open");
  assert.match(host.style.cssText, /pointer-events:none !important/);
  assert.match(host.style.cssText, /z-index:2147483647 !important/);
  host.remove();
  const again = layer.root;
  assert.notEqual(again, root, "被移走后重建");
  assert.equal(documentElement.children.length, 1);
  controller.abort();
  assert.equal(documentElement.children.length, 0, "卸载时移除");
  assert.throws(() => layer.root, { code: "STATE_DISPOSED" });
});

const ctrlDown = (key, extra = {}) => down(key, { altKey: false, ctrlKey: true, ...extra });
const ctrlRelease = { key: "Control", code: "ControlLeft", ctrlKey: false, altKey: false };

test("切换键改成 Control：⌃Tab 触发、松开 Control 才切换，⌥Tab 不再拦截；按住期间改设置不影响这一轮", () => {
  let modifier = "ctrl";
  const f = fixture({ modifier: () => modifier });
  assert.equal(f.controller.keydown(down("Tab")), false, "Option+Tab 交还 Codex");
  assert.equal(f.controller.keydown(down("Tab", { ctrlKey: true })), false, "同时按着两个修饰键不算");
  assert.equal(f.controller.modifier, "ctrl");
  assert.equal(f.controller.keydown(ctrlDown("Tab")), true);
  modifier = "alt";
  assert.equal(f.controller.modifier, "ctrl", "这一轮仍按 Control 判断松开");
  assert.equal(f.controller.keyup({ key: "Alt", code: "AltLeft", altKey: false, ctrlKey: true }), true);
  assert.equal(f.controller.phase, "held", "Control 还按着，不切换");
  f.controller.keydown(ctrlDown("Tab"));
  assert.equal(f.selected(), 3);
  f.controller.keyup(ctrlRelease);
  assert.deepEqual(f.picked, [3]);
  assert.equal(f.controller.modifier, "alt", "空闲时跟着设置走");
});

test("数字键直达：1–9 选中对应条目立即切换，没有这一项时只拦下", () => {
  const f = fixture({ tasks: [task(1), task(2), task(3), task(4)] });
  f.controller.keydown(down("Tab"));
  assert.equal(f.controller.keydown(down("¡", { code: "Digit3" })), true, "还没弹出面板也能直达");
  assert.deepEqual(f.picked, [3]);
  assert.equal(f.controller.phase, "idle");
  f.controller.keydown(down("Tab"));
  f.elapse();
  assert.equal(f.controller.keydown(down("ª", { code: "Digit9" })), true);
  assert.equal(f.controller.phase, "open", "超出列表的数字不切换");
  assert.equal(f.controller.keydown(down("º", { code: "Digit0" })), true, "0 不对应条目");
  f.controller.keydown(down("™", { code: "Digit1" }));
  assert.deepEqual(f.picked, [3, 1]);
  assert.equal(fixture().controller.keydown(down("¡", { code: "Digit1" })), false, "空闲时 Option+数字交还 Codex");
});

test("面板里 W 移出选中的会话、Z 撤销；还没弹出面板时不生效，自动重复不连删", () => {
  const removed = [];
  let undone = 0;
  const f = fixture({ remove: (item) => removed.push(item.n), undo: () => { undone += 1; } });
  f.controller.keydown(down("Tab"));
  assert.equal(f.controller.keydown(down("∑", { code: "KeyW" })), true);
  assert.deepEqual(removed, [], "看不见面板时不删");
  f.elapse();
  f.controller.keydown(down("∑", { code: "KeyW" }));
  f.controller.keydown(down("∑", { code: "KeyW", repeat: true }));
  assert.deepEqual(removed, [2]);
  assert.equal(f.controller.phase, "open", "移出后面板继续开着");
  f.controller.keydown(down("Ω", { code: "KeyZ" }));
  assert.equal(undone, 1);
  assert.deepEqual(f.picked, []);
  const plain = fixture();
  plain.controller.keydown(down("Tab"));
  plain.elapse();
  assert.equal(plain.controller.keydown(down("∑", { code: "KeyW" })), true, "没提供移出时照样拦下");
});

test("修饰键 + J 跳到需要你处理的会话：只在空闲时、按物理键位认，自动重复只拦下", () => {
  let jumps = 0;
  const jump = () => { jumps += 1; };
  const f = fixture({ jump });
  assert.equal(f.controller.keydown(down("∆", { code: "KeyJ" })), true);
  assert.equal(jumps, 1);
  assert.equal(f.controller.phase, "idle", "不弹面板");
  assert.equal(f.controller.keydown(down("∆", { code: "KeyJ", repeat: true })), true);
  assert.equal(jumps, 1, "按住不放不连跳");
  for (const event of [down("Ô", { code: "KeyJ", shiftKey: true }), down("∆", { code: "KeyJ", metaKey: true }), down("j", { code: "KeyJ", altKey: false }), down("∆", { code: "KeyJ", isComposing: true })]) {
    assert.equal(f.controller.keydown(event), false, JSON.stringify(event));
  }
  assert.equal(jumps, 1);
  assert.equal(fixture().controller.keydown(down("∆", { code: "KeyJ" })), false, "卡片没提供时交还 Codex");
  assert.equal(fixture({ jump, enabled: () => false }).controller.keydown(down("∆", { code: "KeyJ" })), false, "开关关闭时不拦截");
  assert.equal(fixture({ jump, platform: "Linux x86_64" }).controller.keydown(down("∆", { code: "KeyJ" })), false, "非 macOS 不拦截");
  const ctrl = fixture({ jump, modifier: () => "ctrl" });
  assert.equal(ctrl.controller.keydown(down("∆", { code: "KeyJ" })), false, "切换键是 Control 时 Option+J 交还 Codex");
  assert.equal(ctrl.controller.keydown(ctrlDown("j", { code: "KeyJ" })), true);
  assert.equal(jumps, 2);
  f.controller.keydown(down("Tab"));
  f.elapse();
  f.controller.keydown(down("∆", { code: "KeyJ" }));
  assert.equal(jumps, 2, "面板开着时 J 只拦下");
  assert.equal(f.controller.phase, "open");
});
