import assert from "node:assert/strict";
import test from "node:test";
import { createSettingsPanel } from "../src/renderer/shell/settings-panel.mjs";
import { createCardShell } from "../src/renderer/shell/card-shell.mjs";
import { createCardRuntime } from "../src/renderer/runtime/card-runtime.mjs";
import { createRpcClient } from "../src/renderer/platform/rpc-client.mjs";
import { PLAN_HINT_BODY, PLAN_TOOL_SNIPPET } from "../src/codex-plan-hint-text.mjs";
import { settings as tasksSettings } from "../cards/tasks/settings.mjs";

// 只实现面板用到的 DOM；布局、原生输入行为与 Shadow DOM 另由 Chromium 冒烟验证。
class Element extends EventTarget {
  constructor(tag, document) {
    super();
    this.tagName = tag;
    this.ownerDocument = document;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.text = "";
  }
  set textContent(value) { this.text = value; this.replaceChildren(); }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(""); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...children) { for (const child of children) this.insertBefore(child, null); }
  insertBefore(child, anchor) {
    child.remove();
    const index = anchor ? this.children.indexOf(anchor) : this.children.length;
    this.children.splice(index, 0, child);
    child.parentNode = this;
    return child;
  }
  replaceChildren(...children) {
    for (const child of [...this.children]) child.remove();
    this.append(...children);
  }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = null;
  }
  get parentElement() { return this.parentNode; }
  get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] ?? null; }
  get isConnected() { return this === this.ownerDocument.body || Boolean(this.parentNode?.isConnected || this.host?.isConnected); }
  contains(other) { return this === other || this.children.some(child => child.contains(other)); }
  querySelector(tag) { return descendants(this).find(child => child.tagName === tag) ?? null; }
  getRootNode() { return this.ownerDocument; }
  focus() { if (!this.disabled) this.ownerDocument.activeElement = this; }
  click() { if (!this.disabled) this.dispatchEvent(new Event("click")); }
  attachShadow() { this.shadowRoot = new Element("#shadow-root", this.ownerDocument); this.shadowRoot.host = this; return this.shadowRoot; }
}
function makeDocument() {
  const document = { createElement(tag) { return new Element(tag, this); } };
  document.body = document.createElement("body");
  document.activeElement = document.body;
  return document;
}
const descendants = root => root.children.flatMap(child => [child, ...descendants(child)]);
const bySetting = (root, key) => descendants(root).find(child => child.dataset.setting === key);
const byLabel = (root, label) => descendants(root).find(child => child.getAttribute("aria-label") === label);
const byText = (root, text, tag = "button") => descendants(root).find(child => child.tagName === tag && child.textContent === text);
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const catalog = [
  { id: "alpha", title: "甲卡片", defaultEnabled: true, defaultOrder: 0 },
  { id: "beta", title: "乙卡片", defaultEnabled: false, defaultOrder: 1 }
];
const initialConfig = () => ({
  version: 2, revision: 4, enabled: true, order: ["alpha", "future", "beta"], placement: "standalone-button",
  cards: { alpha: { enabled: true, settings: { keep: true } }, beta: { enabled: false, settings: {} }, future: { enabled: true, settings: { unknown: true } } },
  launch: { proxy: { enabled: false, port: 7890 } }, agent: { autoRelaunch: true }
});
// 任务看板的设置由卡片自己提供；面板只按 catalog 决定显示与否。
const TASK_SETTINGS = [{ id: "tasks", title: "任务看板", settings: tasksSettings }];
// 更新相关 RPC 单独记录：默认回「不支持」，各用例的 calls 只含设置与状态读写。
function fixture(handler, { updates, ...options } = {}) {
  const document = makeDocument();
  const calls = [];
  const updateCalls = [];
  let closed = 0;
  const call = async (method, params) => {
    if (method.startsWith("companion.update.")) {
      updateCalls.push({ method, params });
      return updates ? updates(method, params) : { supported: false };
    }
    calls.push({ method, params });
    if (handler) return handler(method, params, calls);
    if (method === "companion.settings.get") return { config: initialConfig(), catalog, agent: null };
    if (method === "companion.agent.status") return { available: false };
    throw Error(`unexpected ${method}`);
  };
  const panel = createSettingsPanel({ document, call, onClose: () => { closed++; }, cardSettings: TASK_SETTINGS, ...options });
  document.body.append(panel.element);
  return { document, panel, calls, updateCalls, get closed() { return closed; } };
}
function taskFixture({ settings = {}, onPatch } = {}) {
  const base = initialConfig();
  const withTasks = [...catalog, { id: "tasks", title: "任务看板", defaultEnabled: true, defaultOrder: 5 }];
  let config = { ...base, cards: { ...base.cards, tasks: { enabled: true, settings } } };
  return fixture(async (method, params) => {
    if (method === "companion.settings.get") return { config, catalog: withTasks };
    if (method === "companion.agent.status") return { available: false };
    assert.equal(method, "companion.settings.patch");
    await onPatch?.(params);
    const patch = params.patch.cards?.tasks ?? {};
    const tasks = { ...config.cards.tasks, ...patch, settings: { ...config.cards.tasks.settings, ...patch.settings } };
    config = { ...config, ...params.patch, revision: config.revision + 1, cards: { ...config.cards, ...params.patch.cards, tasks } };
    return { config };
  }, { platform: "MacIntel" });
}
function change(input, value) {
  if (input.type === "checkbox" || input.type === "radio") input.checked = value;
  else input.value = value;
  input.dispatchEvent(new Event("change"));
}
function submitPort(root, value) {
  const input = bySetting(root, "proxy-port");
  input.value = value;
  input.dispatchEvent(new Event("input"));
  input.parentNode.parentNode.dispatchEvent(new Event("submit", { cancelable: true }));
}
function arrow(element, key) {
  const event = new Event("keydown", { cancelable: true });
  Object.defineProperty(event, "key", { value: key });
  element.dispatchEvent(event);
}
function escape(element) {
  const event = new Event("keydown", { cancelable: true });
  Object.defineProperty(event, "key", { value: "Escape" });
  element.dispatchEvent(event);
  return event;
}

test("设置页首次打开才读取，渲染全部区块与 catalog 标题，状态只认 status RPC", async () => {
  const f = fixture();
  assert.equal(f.panel.element.hidden, true);
  assert.equal(f.calls.length, 0);
  await f.panel.open();
  const root = f.panel.element;
  assert.deepEqual(f.calls.map(item => item.method), ["companion.settings.get", "companion.agent.status"]);
  assert.deepEqual(descendants(root).filter(item => item.tagName === "legend").map(item => item.textContent), ["卡片", "插件", "显示方式", "任务看板", "启动", "自动加载", "更新", "状态"]);
  assert.equal(descendants(root).find(item => item.tagName === "legend" && item.textContent === "插件").parentNode.hidden, true, "没装插件时隐藏");
  assert.ok(bySetting(root, "enabled").checked);
  assert.ok(bySetting(root, "card-alpha").parentNode.textContent.includes("甲卡片"));
  assert.equal(bySetting(root, "card-beta").checked, false);
  assert.equal(bySetting(root, "proxy-port").value, "7890");
  assert.ok(root.textContent.includes("后台服务未运行"));
  assert.equal(f.document.activeElement, byLabel(root, "关闭 Companion 设置"));
  await f.panel.open();
  assert.equal(f.calls.length, 2, "重复 open 幂等");
  f.panel.destroy();
});

test("每次 patch 带当前 revision，保存期间禁止并发编辑，结果只更新表单", async () => {
  let config = initialConfig();
  const gate = deferred();
  const f = fixture(async (method, params) => {
    if (method === "companion.settings.get") return { config, catalog };
    if (method === "companion.agent.status") return { available: false };
    assert.equal(params.expectedRevision, config.revision);
    if (params.patch.enabled === false) await gate.promise;
    config = { ...config, ...params.patch, revision: config.revision + 1 };
    return { config };
  });
  await f.panel.open();
  const root = f.panel.element;
  change(bySetting(root, "enabled"), false);
  for (const input of descendants(root).filter(item => item.tagName === "input")) assert.ok(input.disabled);
  assert.equal(byLabel(root, "关闭 Companion 设置").disabled, false);
  byText(root, "立即重启 Codex").click();
  change(bySetting(root, "auto-relaunch"), false);
  assert.equal(f.calls.filter(item => item.method.endsWith("patch")).length, 1);
  gate.resolve();
  await turn();
  assert.equal(bySetting(root, "enabled").disabled, false);
  change(bySetting(root, "auto-relaunch"), false);
  await turn();
  const patches = f.calls.filter(item => item.method.endsWith("patch"));
  assert.deepEqual(patches.map(item => item.params), [
    { expectedRevision: 4, patch: { enabled: false } },
    { expectedRevision: 5, patch: { agent: { autoRelaunch: false } } }
  ]);
  assert.equal(f.calls.some(item => item.method.endsWith("restart")), false);
  f.panel.destroy();
});

test("刷新状态只请求 status，不丢弃尚未保存的端口", async () => {
  const f = fixture();
  await f.panel.open();
  bySetting(f.panel.element, "proxy-port").value = "9000";
  byLabel(f.panel.element, "刷新状态").click();
  await turn();
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls.at(-1).method, "companion.agent.status");
  assert.equal(bySetting(f.panel.element, "proxy-port").value, "9000");
  f.panel.destroy();
});

test("卡片开关、排序、placement 和代理开关只发送最小补丁，保留未知卡片的顺序", async () => {
  const config = initialConfig();
  const f = fixture((method, params) => {
    if (method === "companion.settings.get") return { config, catalog };
    if (method === "companion.agent.status") return { available: false };
    return { config: { ...config, ...(params.patch.order ? { order: params.patch.order } : {}), revision: 5 } };
  });
  await f.panel.open();
  const root = f.panel.element;
  const callCount = f.calls.length;
  arrow(byLabel(root, "调整 甲卡片 的顺序"), "ArrowUp");
  arrow(byLabel(root, "调整 乙卡片 的顺序"), "ArrowDown");
  await turn();
  assert.equal(f.calls.length, callCount, "首尾越界不保存");
  arrow(byLabel(root, "调整 甲卡片 的顺序"), "ArrowDown");
  await turn();
  assert.deepEqual(f.calls.at(-1).params.patch, { order: ["beta", "future", "alpha"] });
  change(bySetting(root, "card-beta"), true);
  await turn();
  assert.deepEqual(f.calls.at(-1).params.patch, { cards: { beta: { enabled: true } } });
  const inline = descendants(root).find(item => item.type === "radio" && item.value === "inline-in-summary");
  change(inline, true);
  await turn();
  assert.deepEqual(f.calls.at(-1).params.patch, { placement: "inline-in-summary" });
  change(bySetting(root, "proxy-enabled"), true);
  await turn();
  assert.deepEqual(f.calls.at(-1).params.patch, { launch: { proxy: { enabled: true } } });
  assert.deepEqual(config, initialConfig(), "不能修改 RPC 返回的原始配置对象");
  f.panel.destroy();
});

test("任务看板设置：Option+Tab 只在 macOS 显示、缺省开启；长任务先列计划缺省关闭；都写入卡片 settings，卡片关闭时禁用", async () => {
  const withTasks = [...catalog, { id: "tasks", title: "任务看板", defaultEnabled: true, defaultOrder: 5 }];
  const base = initialConfig();
  let config = { ...base, cards: { ...base.cards, tasks: { enabled: true, settings: { keep: 1 } } } };
  const f = fixture((method, params) => {
    if (method === "companion.settings.get") return { config, catalog: withTasks };
    if (method === "companion.agent.status") return { available: false };
    const patch = params.patch.cards.tasks;
    const tasks = { ...config.cards.tasks, ...patch, settings: { ...config.cards.tasks.settings, ...patch.settings } };
    config = { ...config, revision: config.revision + 1, cards: { ...config.cards, tasks } };
    return { config };
  }, { platform: "MacIntel" });
  await f.panel.open();
  const root = f.panel.element;
  const group = () => descendants(root).find(item => item.tagName === "legend" && item.textContent === "任务看板").parentNode;
  assert.equal(group().hidden, false);
  const hint = bySetting(root, "tasks-plan-hint");
  assert.equal(hint.checked, false, "长任务先列计划缺省关闭");
  assert.ok(hint.parentNode.textContent.includes("AGENTS.md"));
  change(hint, true);
  await turn();
  assert.equal(hint.checked, false, "确认前不显示已开启");
  assert.equal(f.calls.filter(item => item.method.endsWith("patch")).length, 0, "确认前不保存配置");
  byText(root, "同意修改并开启").click();
  await turn();
  assert.deepEqual(f.calls.at(-1).params, { expectedRevision: 4, patch: { cards: { tasks: { settings: { planHint: true } } } } });
  assert.equal(hint.checked, true);
  const input = bySetting(root, "tasks-switcher");
  assert.equal(input.parentNode.hidden, false);
  assert.equal(input.checked, true, "没写过设置时缺省开启");
  assert.equal(input.disabled, false);
  assert.ok(input.parentNode.textContent.includes("快捷键切换看板会话"));
  assert.ok(input.parentNode.textContent.includes("按住 Option 连按 Tab 选择"));
  assert.ok(input.parentNode.textContent.includes("⌥J 跳到需要你处理的会话"));
  change(input, false);
  await turn();
  assert.deepEqual(f.calls.at(-1).params, { expectedRevision: 5, patch: { cards: { tasks: { settings: { switcher: false } } } } });
  assert.equal(input.checked, false);
  assert.deepEqual(config.cards.tasks.settings, { keep: 1, planHint: true, switcher: false }, "只改这一项，保留卡片其它设置");
  change(bySetting(root, "card-tasks"), false);
  await turn();
  assert.equal(input.disabled, true, "任务看板关闭时开关不可用");
  assert.equal(hint.disabled, true);
  assert.ok(input.parentNode.textContent.includes("需先启用任务看板"));
  f.panel.destroy();

  const linux = fixture(method => method === "companion.settings.get" ? { config: initialConfig(), catalog: withTasks } : { available: false }, { platform: "Linux x86_64" });
  await linux.panel.open();
  const legend = (panel) => descendants(panel.element).find(item => item.tagName === "legend" && item.textContent === "任务看板").parentNode;
  assert.equal(legend(linux.panel).hidden, false, "Linux 也能开关长任务先列计划");
  assert.equal(bySetting(linux.panel.element, "tasks-switcher").parentNode.hidden, true, "Linux 不显示快捷键");
  assert.equal(bySetting(linux.panel.element, "tasks-switcherKey").parentNode.parentNode.parentNode.hidden, true, "Linux 不显示切换键");
  assert.equal(bySetting(linux.panel.element, "tasks-switcher-all").parentNode.hidden, true);
  assert.equal(bySetting(linux.panel.element, "tasks-auto-add").parentNode.hidden, false, "新会话自动加入各平台都有");
  linux.panel.destroy();
  const noTasks = fixture(null, { platform: "MacIntel" });
  await noTasks.panel.open();
  assert.equal(legend(noTasks.panel).hidden, true, "没有任务看板卡片时隐藏");
  noTasks.panel.destroy();
});

test("计划提示开启前告知全局影响与实际规则；取消、Esc、关闭和销毁均不保存", async () => {
  const settingsFixture = taskFixture();
  await settingsFixture.panel.open();
  const root = settingsFixture.panel.element;
  const input = bySetting(root, "tasks-plan-hint");
  const confirmation = byLabel(root, "确认修改 Codex 全局指令");
  const confirm = byText(root, "同意修改并开启");
  assert.equal(confirmation.hidden, true);
  change(input, true);
  assert.equal(input.checked, false);
  assert.equal(confirmation.hidden, false);
  assert.ok(confirmation.textContent.includes("规则会进入模型上下文，两处都影响所有新会话"));
  assert.ok(confirmation.textContent.includes("config.toml 里开启它自带的 update_plan 计划工具"));
  assert.ok(confirmation.textContent.includes("你在 config.toml 里自己设置过 update_plan 的，以你的设置为准"));
  assert.ok(confirmation.textContent.includes("AGENTS.override.md"));
  assert.ok(confirmation.textContent.includes("已加载规则的会话不会自动撤回"));
  assert.ok(confirmation.textContent.includes("不保证任务完成正确"));
  assert.deepEqual(descendants(confirmation).filter(child => child.tagName === "pre").map(pre => pre.textContent), [PLAN_HINT_BODY, PLAN_TOOL_SNIPPET]);
  assert.equal(settingsFixture.document.activeElement, byText(root, "暂不开启"));
  byText(root, "暂不开启").click();
  assert.equal(confirmation.hidden, true);
  assert.equal(settingsFixture.document.activeElement, input);
  confirm.click();
  change(input, true);
  assert.equal(escape(root).defaultPrevented, true);
  assert.equal(confirmation.hidden, true);
  assert.equal(root.hidden, false);
  change(input, true);
  settingsFixture.panel.close();
  assert.equal(confirmation.hidden, true);
  confirm.click();
  await settingsFixture.panel.open();
  assert.equal(confirmation.hidden, true);
  assert.equal(input.checked, false);
  change(input, true);
  settingsFixture.panel.destroy();
  confirm.click();
  assert.equal(settingsFixture.calls.filter(item => item.method.endsWith("patch")).length, 0);
});

test("确认开启只保存一次最小补丁；关闭无需确认，再次开启必须重新确认", async () => {
  const gate = deferred();
  const settingsFixture = taskFixture({ settings: { keep: 1 }, onPatch: () => gate.promise });
  await settingsFixture.panel.open();
  const root = settingsFixture.panel.element;
  const input = bySetting(root, "tasks-plan-hint");
  const confirmation = byLabel(root, "确认修改 Codex 全局指令");
  change(input, true);
  const confirm = byText(root, "同意修改并开启");
  confirm.click();
  confirm.click();
  const patches = () => settingsFixture.calls.filter(item => item.method.endsWith("patch"));
  assert.equal(patches().length, 1);
  assert.deepEqual(patches()[0].params, { expectedRevision: 4, patch: { cards: { tasks: { settings: { planHint: true } } } } });
  assert.equal(input.disabled, true);
  assert.equal(confirmation.hidden, true);
  gate.resolve();
  await turn();
  assert.equal(input.checked, true);
  assert.equal(settingsFixture.document.activeElement, input);
  change(input, false);
  await turn();
  assert.equal(confirmation.hidden, true);
  assert.deepEqual(patches()[1].params, { expectedRevision: 5, patch: { cards: { tasks: { settings: { planHint: false } } } } });
  change(input, true);
  assert.equal(confirmation.hidden, false);
  assert.equal(patches().length, 2);
  byText(root, "暂不开启").click();
  settingsFixture.panel.destroy();
});

test("开启保存失败或冲突不自动重放；恢复配置后必须重新确认", async () => {
  for (const code of ["RPC_TIMEOUT", "CONFIG_CONFLICT"]) {
    let patches = 0;
    const settingsFixture = taskFixture({ onPatch: () => {
      if (++patches === 1) throw Object.assign(Error("保存失败"), { code });
    } });
    await settingsFixture.panel.open();
    const root = settingsFixture.panel.element;
    const input = bySetting(root, "tasks-plan-hint");
    change(input, true);
    byText(root, "同意修改并开启").click();
    await turn();
    assert.equal(input.checked, false);
    assert.equal(byLabel(root, "确认修改 Codex 全局指令").hidden, true);
    if (code === "RPC_TIMEOUT") {
      byText(root, "重试").click();
      await turn();
    }
    assert.equal(patches, 1);
    change(input, true);
    assert.equal(patches, 1);
    assert.equal(byLabel(root, "确认修改 Codex 全局指令").hidden, false);
    byText(root, "同意修改并开启").click();
    await turn();
    assert.equal(patches, 2);
    assert.equal(input.checked, true);
    settingsFixture.panel.destroy();
  }
});

test("待确认时停用任务看板撤销确认；已保存的开启配置不触发额外写入", async () => {
  const settingsFixture = taskFixture();
  await settingsFixture.panel.open();
  const root = settingsFixture.panel.element;
  change(bySetting(root, "tasks-plan-hint"), true);
  change(bySetting(root, "card-tasks"), false);
  await turn();
  assert.equal(byLabel(root, "确认修改 Codex 全局指令").hidden, true);
  byText(root, "同意修改并开启").click();
  const patches = settingsFixture.calls.filter(item => item.method.endsWith("patch"));
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0].params.patch, { cards: { tasks: { enabled: false } } });
  settingsFixture.panel.destroy();

  const enabledFixture = taskFixture({ settings: { planHint: true } });
  await enabledFixture.panel.open();
  assert.equal(bySetting(enabledFixture.panel.element, "tasks-plan-hint").checked, true);
  assert.equal(byLabel(enabledFixture.panel.element, "确认修改 Codex 全局指令").hidden, true);
  assert.equal(enabledFixture.calls.filter(item => item.method.endsWith("patch")).length, 0);
  enabledFixture.panel.destroy();
});

test("CONFIG_CONFLICT 重新读取，不重放旧 patch，下一次编辑使用刷新后的 revision", async () => {
  let reads = 0, patches = 0;
  const f = fixture((method, params) => {
    if (method === "companion.settings.get") return { config: { ...initialConfig(), revision: ++reads === 1 ? 4 : 9, enabled: reads === 1 }, catalog };
    if (method === "companion.agent.status") return { available: false };
    if (++patches === 1) throw Object.assign(Error("conflict"), { code: "CONFIG_CONFLICT", revision: 9 });
    return { config: { ...initialConfig(), revision: 10, enabled: params.patch.enabled } };
  });
  await f.panel.open();
  change(bySetting(f.panel.element, "enabled"), false);
  await turn();
  assert.equal(reads, 2);
  assert.equal(patches, 1);
  assert.ok(f.panel.element.textContent.includes("配置已在别处修改，已刷新"));
  assert.equal(bySetting(f.panel.element, "enabled").checked, false);
  change(bySetting(f.panel.element, "enabled"), true);
  await turn();
  assert.equal(f.calls.at(-1).params.expectedRevision, 9);
  f.panel.destroy();
});

test("CONFIG_CONFLICT 后重读失败时不能继续用旧 revision，重试重新读取", async () => {
  let reads = 0;
  const f = fixture(method => {
    if (method === "companion.settings.get") {
      if (++reads === 2) throw Object.assign(Error("offline"), { code: "BRIDGE_UNAVAILABLE" });
      return { config: initialConfig(), catalog };
    }
    if (method === "companion.agent.status") return { available: false };
    throw Object.assign(Error("conflict"), { code: "CONFIG_CONFLICT" });
  });
  await f.panel.open();
  change(bySetting(f.panel.element, "enabled"), false);
  await turn();
  assert.equal(bySetting(f.panel.element, "enabled").disabled, true);
  byText(f.panel.element, "重试").click();
  await turn();
  assert.equal(reads, 3);
  assert.equal(bySetting(f.panel.element, "enabled").disabled, false);
  f.panel.destroy();
});

test("冲突刷新配置成功但状态读取失败，仍提示冲突刷新并保留可编辑配置", async () => {
  let reads = 0;
  const f = fixture(method => {
    if (method === "companion.settings.get") return { config: { ...initialConfig(), revision: ++reads + 4 }, catalog };
    if (method === "companion.agent.status") {
      if (reads > 1) throw Object.assign(Error("timeout"), { code: "RPC_TIMEOUT" });
      return { available: false };
    }
    throw Object.assign(Error("conflict"), { code: "CONFIG_CONFLICT" });
  });
  await f.panel.open();
  change(bySetting(f.panel.element, "enabled"), false);
  await turn();
  assert.ok(f.panel.element.textContent.includes("配置已在别处修改，已刷新"));
  assert.ok(f.panel.element.textContent.includes("请求超时"));
  assert.equal(bySetting(f.panel.element, "enabled").disabled, false);
  f.panel.destroy();
});

for (const code of ["BRIDGE_UNAVAILABLE", "RPC_TIMEOUT"]) {
  test(`${code} 显示错误和重试，失败写入的重试只读取`, async () => {
    let failRead = true;
    const f = fixture(method => {
      if (method === "companion.settings.get" && !failRead) return { config: initialConfig(), catalog };
      if (method === "companion.agent.status") return { available: false };
      throw Object.assign(Error("backend failure"), { code });
    });
    await f.panel.open();
    assert.equal(byText(f.panel.element, "重试").hidden, false);
    assert.ok(f.panel.element.textContent.includes(code === "RPC_TIMEOUT" ? "请求超时" : "后台连接不可用"));
    failRead = false;
    byText(f.panel.element, "重试").click();
    await turn();
    change(bySetting(f.panel.element, "enabled"), false);
    await turn();
    assert.equal(bySetting(f.panel.element, "enabled").disabled, true);
    byText(f.panel.element, "重试").click();
    await turn();
    assert.equal(f.calls.filter(item => item.method.endsWith("patch")).length, 1);
    assert.equal(bySetting(f.panel.element, "enabled").disabled, false);
    f.panel.destroy();
  });
}

test("端口只接受 1–65535 的十进制整数，边界有效且保存带 revision", async () => {
  const f = fixture((method, params) => {
    if (method === "companion.settings.get") return { config: initialConfig(), catalog };
    if (method === "companion.agent.status") return { available: false };
    return { config: { ...initialConfig(), launch: { proxy: { enabled: false, port: params.patch.launch.proxy.port } }, revision: 5 } };
  });
  await f.panel.open();
  for (const invalid of ["", " ", "0", "65536", "-1", "1.5", "1e3", "abc", "+80", "0x50"]) {
    submitPort(f.panel.element, invalid);
    assert.equal(bySetting(f.panel.element, "proxy-port").getAttribute("aria-invalid"), "true", invalid);
  }
  assert.equal(f.calls.length, 2);
  for (const port of [1, 65535]) {
    submitPort(f.panel.element, String(port));
    await turn();
    assert.deepEqual(f.calls.at(-1).params.patch, { launch: { proxy: { port } } });
    assert.equal(bySetting(f.panel.element, "proxy-port").getAttribute("aria-invalid"), null);
  }
  assert.equal(f.calls.at(-1).params.expectedRevision, 5);
  f.panel.destroy();
});

test("重启必须面板内确认，取消不调用，确认期间禁用，失败重试不重放重启", async () => {
  const gate = deferred();
  const f = fixture(method => {
    if (method === "companion.settings.get") return { config: initialConfig(), catalog };
    if (method === "companion.agent.status") return { available: false };
    return gate.promise;
  });
  await f.panel.open();
  const root = f.panel.element;
  byText(root, "立即重启 Codex").click();
  assert.equal(byLabel(root, "确认重启 Codex").hidden, false);
  assert.ok(root.textContent.includes("将正常退出并重新打开 Codex，未保存的输入可能丢失"));
  assert.equal(f.document.activeElement, byText(byLabel(root, "确认重启 Codex"), "取消"));
  byText(byLabel(root, "确认重启 Codex"), "取消").click();
  assert.equal(f.calls.length, 2);
  byText(root, "立即重启 Codex").click();
  byText(root, "确认重启").click();
  byText(root, "确认重启").click();
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.calls.at(-1), { method: "companion.codex.restart", params: { reason: "settings" } });
  assert.equal(byText(root, "确认重启").disabled, true);
  gate.reject(Object.assign(Error("timeout"), { code: "RPC_TIMEOUT" }));
  await turn();
  assert.equal(byLabel(root, "确认重启 Codex").hidden, true);
  byText(root, "重试").click();
  await turn();
  assert.equal(f.calls.filter(item => item.method.endsWith("restart")).length, 1);
  f.panel.destroy();
});

test("重启被拒与接受分别显示结果，不把 accepted:false 当成功", async () => {
  for (const accepted of [false, true]) {
    const f = fixture(method => {
      if (method === "companion.settings.get") return { config: initialConfig(), catalog };
      if (method === "companion.agent.status") return { available: true, version: "1.2.3", codex: { attached: true, port: 51234, proxyPort: 7890 }, nativeHelper: "ok", lastEvent: null };
      return { accepted, reason: "busy" };
    });
    await f.panel.open();
    assert.ok(f.panel.element.textContent.includes("后台服务运行中"));
    assert.ok(f.panel.element.textContent.includes("51234"));
    byText(f.panel.element, "立即重启 Codex").click();
    byText(f.panel.element, "确认重启").click();
    await turn();
    assert.ok(f.panel.element.textContent.includes(accepted ? "已请求重启 Codex" : "无法重启 Codex：后台正在处理其他操作，请稍后再试"));
    f.panel.destroy();
  }
});

test("Linux（reopen: menu）隐藏自动加载与原生助手，重启只提示从应用菜单重开", async () => {
  const f = fixture(method => {
    if (method === "companion.settings.get") return { config: initialConfig(), catalog };
    if (method === "companion.agent.status") return { available: true, version: "1.2.3", codex: { attached: true, port: 51234 }, nativeHelper: "missing", lastEvent: null, reopen: "menu" };
    throw new Error(`不应调用 ${method}`);
  });
  await f.panel.open();
  const text = f.panel.element.textContent;
  assert.ok(!text.includes("原生助手"));
  const legend = descendants(f.panel.element).find(item => item.tagName === "legend" && item.textContent === "自动加载");
  assert.equal((legend.parentElement ?? legend.parentNode).hidden, true);
  byText(f.panel.element, "立即重启 Codex").click();
  assert.equal(byLabel(f.panel.element, "确认重启 Codex").hidden, true);
  assert.ok(f.panel.element.textContent.includes("从应用菜单重新打开"));
  assert.equal(f.calls.filter(item => item.method.endsWith("restart")).length, 0);
  f.panel.destroy();
});

test("Esc 先取消重启确认再关闭；关闭重开会重新读取，销毁后迟到响应无效", async () => {
  const f = fixture();
  await f.panel.open();
  byText(f.panel.element, "立即重启 Codex").click();
  assert.equal(escape(f.panel.element).defaultPrevented, true);
  assert.equal(f.panel.element.hidden, false);
  escape(f.panel.element);
  assert.equal(f.closed, 1);
  assert.equal(f.panel.element.hidden, true);
  await f.panel.open();
  assert.equal(f.calls.length, 4);
  f.panel.destroy();
  f.panel.destroy();
  byText(f.panel.element, "立即重启 Codex").click();
  assert.equal(f.panel.element.isConnected, false);
  const gate = deferred();
  const late = fixture(() => gate.promise);
  const reading = late.panel.open();
  late.panel.destroy();
  gate.resolve({ config: initialConfig(), catalog });
  await reading;
  assert.equal(bySetting(late.panel.element, "proxy-port").value, "");
});

test("runtime 的平台 RPC 独立于业务卡片，总开关关闭仍保留外框、齿轮和待处理设置读取", async () => {
  const document = makeDocument();
  const sent = [];
  const client = createRpcClient({ binding: () => raw => {
    const request = JSON.parse(raw); sent.push(request);
    if (request.method.endsWith("lifecycle.dispose")) return {};
  } });
  const shell = createCardShell({ document });
  const backend = { getItem: () => null, setItem() {} };
  const manifest = { ...catalog[0], layout: { minHeight: 0 }, state: { scope: "target", version: 1 }, lifecycle: { start: "immediate", hidden: "retain" }, capabilities: ["rpc"] };
  let disposed = 0, settingsAvailable;
  const runtime = createCardRuntime({
    manifests: [manifest], renderers: { alpha: { mount: () => ({ dispose() { disposed++; } }) } },
    config: initialConfig(), shellFactory: () => shell, rpcClient: client, localStorage: backend, sessionStorage: backend,
    adapterFactory: ({ host, hasSettings }) => {
      settingsAvailable = hasSettings;
      document.body.append(host);
      return { setPlacement() {}, setHasCards() {}, dispose() {}, getDiagnostics: () => ({ mode: "fixture" }) };
    }
  });
  await turn();
  const gear = byLabel(shell.root, "Companion 设置");
  gear.click();
  const platform = sent.filter(item => item.cardId === "companion");
  assert.equal(settingsAvailable, true);
  // 外框挂载时读一次更新状态决定红点，打开设置再读设置、状态与更新。
  assert.deepEqual(platform.map(item => item.method), ["companion.update.status", "companion.settings.get", "companion.agent.status", "companion.update.status"]);
  assert.ok(platform.every(item => Number.isInteger(item.generation) && item.generation === platform[0].generation));
  await runtime.applyConfig({ ...initialConfig(), enabled: false, revision: 5 });
  assert.equal(disposed, 1);
  assert.equal(runtime.getDiagnostics().shell.count, 0);
  assert.equal(shell.host.isConnected, true);
  assert.equal(byLabel(shell.root, "Companion 设置"), gear);
  assert.ok(byText(shell.root, "卡片已关闭", "p"));
  assert.equal(client.diagnostics().pending, 4, "业务停用不能取消平台请求");
  const results = { "companion.settings.get": { config: { ...initialConfig(), enabled: false }, catalog },
    "companion.agent.status": { available: false }, "companion.update.status": { supported: false } };
  for (const request of platform) client.receiveRpc({ id: request.id, result: results[request.method] });
  await turn();
  assert.equal(bySetting(shell.root, "enabled").checked, false);
  byLabel(shell.root, "关闭 Companion 设置").click();
  assert.equal(document.activeElement, gear);
  gear.click();
  assert.equal(client.diagnostics().pending, 3);
  await runtime.dispose();
  assert.equal(client.diagnostics().pending, 0);
  assert.equal(shell.host.isConnected, false);
  assert.equal(sent.some(item => item.method === "companion.lifecycle.dispose"), false);
});

test("播放提醒：两项各有关 / 提醒 / 暂停三档，缺省需要你时暂停、完成时提醒；只写卡片 settings，任务看板关闭时禁用", async () => {
  const f = taskFixture({ settings: { keep: 1, alertDone: "bogus" } });
  await f.panel.open();
  const root = f.panel.element;
  const radios = key => descendants(root).filter(item => item.dataset.setting === key);
  const checked = key => radios(key).find(item => item.checked)?.value;
  for (const key of ["tasks-alertAttention", "tasks-alertDone"]) {
    assert.deepEqual(radios(key).map(item => [item.type, item.value]), [["radio", "off"], ["radio", "notify"], ["radio", "pause"]]);
    assert.equal(radios(key)[0].parentNode.parentNode.getAttribute("role"), "radiogroup");
  }
  assert.equal(checked("tasks-alertAttention"), "pause", "没写过设置时需要你就暂停");
  assert.equal(checked("tasks-alertDone"), "notify", "非法值回到缺省的只提醒");
  assert.ok(root.textContent.includes("任务需要你时") && root.textContent.includes("提问、中断或长时间没有动静"));
  change(radios("tasks-alertAttention").find(item => item.value === "notify"), true);
  await turn();
  assert.deepEqual(f.calls.at(-1).params, { expectedRevision: 4, patch: { cards: { tasks: { settings: { alertAttention: "notify" } } } } });
  assert.equal(checked("tasks-alertAttention"), "notify");
  change(radios("tasks-alertDone").find(item => item.value === "off"), true);
  await turn();
  assert.deepEqual(f.calls.at(-1).params.patch, { cards: { tasks: { settings: { alertDone: "off" } } } });
  assert.equal(checked("tasks-alertDone"), "off");
  const patches = f.calls.filter(item => item.method.endsWith("patch")).length;
  const unchecked = radios("tasks-alertDone").find(item => item.value === "pause");
  unchecked.checked = false;
  unchecked.dispatchEvent(new Event("change"));
  await turn();
  assert.equal(f.calls.filter(item => item.method.endsWith("patch")).length, patches, "取消选中的那一项不保存");
  change(bySetting(root, "card-tasks"), false);
  await turn();
  assert.ok([...radios("tasks-alertAttention"), ...radios("tasks-alertDone")].every(item => item.disabled), "任务看板关闭时不可用");
  assert.ok(root.textContent.includes("需先启用任务看板"));
  f.panel.destroy();
});

test("新会话自动加入缺省关闭；快捷键可换成 Control，可列出看板外的会话；快捷键关闭时这两项不可用", async () => {
  const f = taskFixture({ settings: { keep: 1 } });
  await f.panel.open();
  const root = f.panel.element;
  const radios = key => descendants(root).filter(item => item.dataset.setting === key);
  const checked = key => radios(key).find(item => item.checked)?.value;
  const autoAdd = bySetting(root, "tasks-auto-add");
  assert.equal(autoAdd.checked, false, "缺省关闭");
  assert.ok(autoAdd.parentNode.textContent.includes("新会话自动加入看板"));
  assert.ok(autoAdd.parentNode.textContent.includes("终端里的 Codex 和子代理不算"));
  change(autoAdd, true);
  await turn();
  assert.deepEqual(f.calls.at(-1).params.patch, { cards: { tasks: { settings: { autoAdd: true } } } });
  assert.equal(autoAdd.checked, true);

  assert.deepEqual(radios("tasks-switcherKey").map(item => [item.type, item.value]), [["radio", "alt"], ["radio", "ctrl"]]);
  assert.equal(checked("tasks-switcherKey"), "alt", "缺省按住 Option");
  assert.ok(root.textContent.includes("⌃Tab 会盖掉 Codex 的切换标签页"));
  change(radios("tasks-switcherKey").find(item => item.value === "ctrl"), true);
  await turn();
  assert.deepEqual(f.calls.at(-1).params.patch, { cards: { tasks: { settings: { switcherKey: "ctrl" } } } });
  assert.equal(checked("tasks-switcherKey"), "ctrl");
  const switcher = bySetting(root, "tasks-switcher");
  assert.ok(switcher.parentNode.textContent.includes("按住 Control 连按 Tab 选择"), "提示跟着切换键变");
  assert.ok(switcher.parentNode.textContent.includes("⌃J 跳到需要你处理的会话"));

  const all = bySetting(root, "tasks-switcher-all");
  assert.equal(all.checked, false, "缺省只列看板上的会话");
  change(all, true);
  await turn();
  assert.deepEqual(f.calls.at(-1).params.patch, { cards: { tasks: { settings: { switcherAll: true } } } });
  assert.equal(all.checked, true);

  change(switcher, false);
  await turn();
  assert.ok(all.disabled && radios("tasks-switcherKey").every(item => item.disabled), "快捷键关闭时切换键和看板外会话不可用");
  assert.equal(autoAdd.disabled, false, "自动加入不受快捷键开关影响");
  change(bySetting(root, "card-tasks"), false);
  await turn();
  assert.equal(autoAdd.disabled, true, "任务看板关闭时不可用");
  assert.ok(autoAdd.parentNode.textContent.includes("需先启用任务看板"));
  f.panel.destroy();
});

function fakeConnection(initial = true) {
  let connected = initial;
  const listeners = new Set();
  return {
    isConnected: () => connected,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    set(value) { connected = value; for (const listener of [...listeners]) listener(value); },
    checks: 0,
    async check() { this.checks += 1; return connected; },
    get listeners() { return listeners.size; }
  };
}
const messageOf = root => descendants(root).find(child => child.className === "cc-settings-message");

test("后台断开时提示正在自动恢复；恢复后自动重新读取，不用点重试", async () => {
  const connection = fakeConnection();
  let offline = false;
  const f = fixture(method => {
    if (offline) throw Object.assign(Error("companion.settings.get 请求超时"), { code: "RPC_TIMEOUT" });
    if (method === "companion.settings.get") return { config: initialConfig(), catalog };
    if (method === "companion.agent.status") return { available: false };
    throw Error(`unexpected ${method}`);
  }, { connection });
  offline = true;
  connection.set(false);
  await f.panel.open();
  const root = f.panel.element;
  assert.equal(messageOf(root).textContent, "后台连接已断开，正在自动恢复…");
  assert.equal(bySetting(root, "enabled").disabled, true);
  offline = false;
  const before = f.calls.length;
  connection.set(true);
  await turn();
  await turn();
  assert.deepEqual(f.calls.slice(before).map(item => item.method), ["companion.settings.get", "companion.agent.status"]);
  assert.equal(bySetting(root, "enabled").disabled, false);
  assert.equal(messageOf(root).textContent, "");
  connection.set(false);
  assert.equal(messageOf(root).textContent, "后台连接已断开，正在自动恢复…", "已打开的面板断开时立即提示");
  f.panel.destroy();
  assert.equal(connection.listeners, 0, "销毁后取消订阅");
});

test("恢复时还有请求在途，等它结束后再重新读取；面板关闭时不读取", async () => {
  const connection = fakeConnection();
  const gate = deferred();
  let gated = true;
  const f = fixture(async method => {
    if (method === "companion.settings.get" && gated) { gated = false; await gate.promise; }
    if (method === "companion.settings.get") return { config: initialConfig(), catalog };
    if (method === "companion.agent.status") return { available: false };
    throw Error(`unexpected ${method}`);
  }, { connection });
  const opening = f.panel.open();
  await turn();
  connection.set(false);
  connection.set(true);
  assert.equal(f.calls.filter(item => item.method === "companion.settings.get").length, 1, "在途时不并发读取");
  gate.reject(Object.assign(Error("timeout"), { code: "RPC_TIMEOUT" }));
  await opening;
  await turn();
  await turn();
  assert.equal(f.calls.filter(item => item.method === "companion.settings.get").length, 2, "在途请求结束后补读一次");
  assert.equal(bySetting(f.panel.element, "enabled").disabled, false);
  f.panel.close();
  connection.set(false);
  connection.set(true);
  await turn();
  assert.equal(f.calls.filter(item => item.method === "companion.settings.get").length, 2, "关闭的面板不读取，下次打开自然会读");
  f.panel.destroy();
});

test("runtime 把 rpc-client 的连接状态交给设置页", async () => {
  const document = makeDocument();
  const client = createRpcClient({ binding: () => () => undefined });
  const shell = createCardShell({ document });
  const configure = shell.configureSettings;
  let options;
  shell.configureSettings = received => { options = received; return configure(received); };
  const backend = { getItem: () => null, setItem() {} };
  const runtime = createCardRuntime({
    manifests: [], renderers: {}, config: initialConfig(), shellFactory: () => shell, rpcClient: client,
    localStorage: backend, sessionStorage: backend,
    adapterFactory: ({ host }) => {
      document.body.append(host);
      return { setPlacement() {}, setHasCards() {}, dispose() {}, getDiagnostics: () => ({ mode: "fixture" }) };
    }
  });
  assert.equal(options.connection, client.connection);
  await runtime.dispose();
});

test("请求丢在已断开的旧连接上、确认时链路已恢复：自动重读一次，仍失败不再无限重试", async () => {
  const connection = fakeConnection();
  let failures = 2;
  const f = fixture(method => {
    if (method === "companion.settings.get" && failures > 0) { failures -= 1; throw Object.assign(Error("companion.settings.get 请求超时"), { code: "RPC_TIMEOUT" }); }
    if (method === "companion.settings.get") return { config: initialConfig(), catalog };
    if (method === "companion.agent.status") return { available: false };
    throw Error(`unexpected ${method}`);
  }, { connection });
  await f.panel.open();
  await turn();
  await turn();
  const reads = () => f.calls.filter(item => item.method === "companion.settings.get").length;
  assert.equal(reads(), 2, "首次失败后确认链路正常，自动重读一次");
  assert.equal(connection.checks, 2);
  await turn();
  assert.equal(reads(), 2, "自动重读也失败时停下，留给用户点重试");
  assert.equal(messageOf(f.panel.element).textContent, "请求超时，请重试");
  byText(f.panel.element, "重试").click();
  await turn();
  await turn();
  assert.equal(reads(), 3);
  assert.equal(bySetting(f.panel.element, "enabled").disabled, false);
  failures = 1;
  f.panel.close();
  await f.panel.open();
  await turn();
  await turn();
  assert.equal(reads(), 5, "读成功后重置，下次失败仍会自动重读一次");
  assert.equal(bySetting(f.panel.element, "enabled").disabled, false);
  f.panel.destroy();
});

test("保存超时后不重放修改：链路正常时自动重新读取配置", async () => {
  const connection = fakeConnection();
  const f = fixture(method => {
    if (method === "companion.settings.get") return { config: initialConfig(), catalog };
    if (method === "companion.agent.status") return { available: false };
    throw Object.assign(Error("companion.settings.patch 请求超时"), { code: "RPC_TIMEOUT" });
  }, { connection });
  await f.panel.open();
  change(bySetting(f.panel.element, "enabled"), false);
  await turn();
  await turn();
  await turn();
  assert.deepEqual(f.calls.map(item => item.method), ["companion.settings.get", "companion.agent.status", "companion.settings.patch",
    "companion.settings.get", "companion.agent.status"]);
  assert.equal(bySetting(f.panel.element, "enabled").disabled, false);
  assert.equal(bySetting(f.panel.element, "enabled").checked, true, "以后台读回的配置为准");
  f.panel.destroy();
});

const updateStatus = (extra = {}) => ({
  current: "0.2.0", channel: "homebrew", canApply: true, auto: false, phase: "idle", available: true,
  latest: { version: "0.2.1", notes: "- 修复看板提醒", url: "https://github.com/foriLLL/agent-companion/releases/tag/v0.2.1" },
  lastCheckAt: 1_800_000_000_000, error: null, pending: null, notice: null, command: "brew upgrade agent-companion",
  releasesUrl: "https://github.com/foriLLL/agent-companion/releases", ...extra
});
const updateFieldset = root => descendants(root).find(item => item.tagName === "legend" && item.textContent === "更新").parentNode;

test("更新：Homebrew 有新版本时可一键更新并显示进度，自动更新开关只写 updates.auto", async () => {
  let config = initialConfig();
  let status = updateStatus();
  const f = fixture((method, params) => {
    if (method === "companion.settings.get") return { config, catalog };
    if (method === "companion.agent.status") return { available: false };
    config = { ...config, ...params.patch, revision: config.revision + 1 };
    return { config };
  }, { updates: method => {
    if (method === "companion.update.apply") status = updateStatus({ phase: "updating" });
    return status;
  } });
  await f.panel.open();
  const root = f.panel.element;
  const section = updateFieldset(root);
  assert.equal(section.hidden, false);
  assert.ok(section.textContent.includes("发现新版本 0.2.1"));
  assert.ok(section.textContent.includes("- 修复看板提醒"));
  const apply = byText(root, "立即更新");
  assert.equal(apply.hidden, false);
  assert.equal(apply.disabled, false);
  assert.equal(bySetting(root, "auto-update").parentNode.hidden, false);
  assert.equal(bySetting(root, "auto-update").checked, true, "开关跟随配置，缺省开启");
  apply.click();
  await turn();
  assert.deepEqual(f.updateCalls.map(item => item.method), ["companion.update.status", "companion.update.apply"]);
  assert.ok(section.textContent.includes("正在更新到 0.2.1…"));
  assert.equal(byText(root, "立即更新").hidden, true);
  change(bySetting(root, "auto-update"), false);
  await turn();
  assert.deepEqual(f.calls.at(-1).params, { expectedRevision: 4, patch: { updates: { auto: false } } });
  f.panel.destroy();
});

test("更新：源码安装只给命令；刚更新完打开即确认提示；不支持时整组隐藏", async () => {
  const source = fixture(null, { updates: () => updateStatus({ channel: "source", canApply: false,
    command: 'cd "/Users/me/agent-companion" && git pull && npm ci && npm start' }) });
  await source.panel.open();
  const root = source.panel.element;
  assert.ok(root.textContent.includes("在终端执行：\ncd \"/Users/me/agent-companion\" && git pull && npm ci && npm start"));
  assert.equal(byText(root, "立即更新").hidden, true);
  assert.equal(bySetting(root, "auto-update").parentNode.hidden, true);
  source.panel.destroy();

  const seen = [];
  const updated = fixture(null, { onUpdateStatus: status => seen.push(status?.notice ?? null), updates: method =>
    method === "companion.update.acknowledge" ? updateStatus({ available: false, latest: null, notice: null })
      : updateStatus({ available: false, latest: null, current: "0.2.1", notice: { from: "0.2.0", to: "0.2.1", notes: "- 新增自动更新" } }) });
  await updated.panel.open();
  await turn();
  assert.ok(updateFieldset(updated.panel.element).textContent.includes("已更新到 0.2.1"));
  assert.ok(updated.panel.element.textContent.includes("- 新增自动更新"));
  assert.deepEqual(updated.updateCalls.map(item => item.method), ["companion.update.status", "companion.update.acknowledge"]);
  assert.deepEqual(seen, [{ from: "0.2.0", to: "0.2.1", notes: "- 新增自动更新" }, null], "确认后通知外框去掉红点");
  updated.panel.destroy();

  const unsupported = fixture();
  await unsupported.panel.open();
  assert.equal(updateFieldset(unsupported.panel.element).hidden, true);
  unsupported.panel.destroy();
});

test("更新：有新版本或刚更新完时整组提到最上面并换强调色，已是最新时回到「状态」上方", async () => {
  const legends = root => descendants(root).filter(item => item.tagName === "legend").map(item => item.textContent);
  const usual = ["卡片", "插件", "显示方式", "任务看板", "启动", "自动加载", "更新", "状态"];
  let status = updateStatus();
  const f = fixture(null, { updates: method => {
    if (method === "companion.update.check") status = updateStatus({ available: false, latest: null, current: "0.2.1" });
    return status;
  } });
  await f.panel.open();
  const root = f.panel.element;
  assert.deepEqual(legends(root), ["更新", ...usual.filter(title => title !== "更新")]);
  assert.equal(updateFieldset(root).dataset.attention, "new");

  // 回到最新：整组移回原位，点过的「检查更新」仍保持焦点。
  const check = byText(root, "检查更新");
  check.focus();
  check.click();
  await turn();
  assert.deepEqual(legends(root), usual);
  assert.equal(updateFieldset(root).dataset.attention, undefined);
  assert.equal(f.document.activeElement, check);
  f.panel.destroy();

  for (const [extra, attention] of [
    [{ available: false, latest: null, notice: { from: "0.2.0", to: "0.2.1", notes: "" } }, "updated"],
    [{ available: false, pending: { version: "0.2.1" } }, "new"],
    [{ available: false, latest: null, error: { message: "检查更新失败：网络", at: 1 } }, undefined]
  ]) {
    const g = fixture(null, { updates: () => updateStatus(extra) });
    await g.panel.open();
    assert.equal(updateFieldset(g.panel.element).dataset.attention, attention, JSON.stringify(extra));
    assert.equal(legends(g.panel.element)[0] === "更新", Boolean(attention));
    g.panel.destroy();
  }
});

test("「卡片配置」红点：需要手动处理的新版本或未看过的更新说明才标，自动更新进行中不标", async () => {
  for (const [status, expected, title] of [
    [updateStatus(), "available", "Companion 有新版本 0.2.1"],
    [updateStatus({ auto: true }), undefined, "Companion 设置"],
    [updateStatus({ auto: true, error: { message: "更新失败：x", at: 1 } }), "available", "Companion 有新版本 0.2.1"],
    [updateStatus({ canApply: false, auto: true }), "available", "Companion 有新版本 0.2.1"],
    [updateStatus({ pending: { version: "0.2.1" } }), undefined, "Companion 设置"],
    [updateStatus({ available: false, latest: null, notice: { from: "0.2.0", to: "0.2.1", notes: "" } }), "updated", "Companion 已更新到 0.2.1"],
    [{ supported: false }, undefined, "Companion 设置"]
  ]) {
    const document = makeDocument();
    const shell = createCardShell({ document });
    shell.configureSettings({ call: async method => {
      assert.equal(method, "companion.update.status");
      return status;
    } });
    await turn();
    const gear = byLabel(shell.root, "Companion 设置");
    assert.equal(gear.dataset.update, expected, JSON.stringify(status));
    assert.equal(gear.title, title);
    shell.dispose();
  }
});

test("「卡片配置」红点：每 5 分钟和 Codex 窗口回到前台时同步，后台刚发现的新版本不用等半小时", async () => {
  const intervals = [];
  const view = Object.assign(new EventTarget(), {
    setInterval: (callback, delay) => { intervals.push({ callback, delay }); return intervals.length; },
    clearInterval: id => { if (intervals[id - 1]) intervals[id - 1].cleared = true; }
  });
  const document = makeDocument();
  const events = new EventTarget();
  for (const key of ["addEventListener", "removeEventListener", "dispatchEvent"]) document[key] = events[key].bind(events);
  document.defaultView = view;
  document.visibilityState = "visible";
  let status = updateStatus({ available: false, latest: null });
  let reads = 0;
  const shell = createCardShell({ document });
  shell.configureSettings({ call: async () => { reads++; return status; } });
  await turn();
  const gear = byLabel(shell.root, "Companion 设置");
  assert.equal(gear.dataset.update, undefined);
  assert.deepEqual(intervals.map(item => item.delay), [5 * 60_000]);

  status = updateStatus();
  view.dispatchEvent(new Event("focus"));
  await turn();
  assert.equal(gear.dataset.update, "available");

  // 窗口在后台时不读；切回可见再读。
  document.visibilityState = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  await turn();
  assert.equal(reads, 2);
  document.visibilityState = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  intervals[0].callback();
  await turn();
  assert.equal(reads, 4);

  shell.dispose();
  assert.equal(intervals[0].cleared, true);
  view.dispatchEvent(new Event("focus"));
  document.dispatchEvent(new Event("visibilitychange"));
  await turn();
  assert.equal(reads, 4, "卸载后不再同步");
});

test("卡片首次打开存档时复制改名前 codex-companion.card.* 下的记录，旧记录保留", async () => {
  const document = makeDocument();
  const client = createRpcClient({ binding: () => () => ({}) });
  const shell = createCardShell({ document });
  const items = new Map([["companion.platform.scopeId", "window-1"]]);
  const backend = { getItem: key => items.get(key) ?? null, setItem: (key, value) => { items.set(key, value); } };
  const legacyKey = "codex-companion.card.alpha.state::window-1";
  items.set(legacyKey, JSON.stringify({ version: 1, revision: 3, value: { watched: ["ep1"] } }));
  const manifest = { ...catalog[0], layout: { minHeight: 0 }, state: { scope: "target", version: 1 },
    lifecycle: { start: "immediate", hidden: "retain" }, capabilities: ["storage"] };
  let read;
  const runtime = createCardRuntime({
    manifests: [manifest], renderers: { alpha: { mount: ctx => { read = ctx.storage.namespace().read(null); return {}; } } },
    config: initialConfig(), shellFactory: () => shell, rpcClient: client, localStorage: backend, sessionStorage: backend,
    adapterFactory: ({ host }) => {
      document.body.append(host);
      return { setPlacement() {}, setHasCards() {}, dispose() {}, getDiagnostics: () => ({ mode: "fixture" }) };
    }
  });
  await turn();
  assert.deepEqual(read, { ok: true, value: { watched: ["ep1"] }, revision: 3, error: null });
  assert.ok(items.has("agent-companion.card.alpha.state::window-1"));
  assert.ok(items.has(legacyKey), "旧记录原样保留，回退到老版本仍可用");
  await runtime.dispose();
});

test("Antigravity 宿主：隐藏只作用于 Codex 的设置，状态显示 Antigravity 连接", async () => {
  const agent = { available: true, version: "0.4.0", nativeHelper: "ok", codex: { attached: false }, antigravity: { attached: true, port: 9339, lastEvent: { event: "reopened", at: 1795421974560 } } };
  const withTasks = [...catalog, { id: "tasks", title: "任务看板", defaultEnabled: true, defaultOrder: 5 }];
  const f = fixture(method => method === "companion.settings.get" ? { config: initialConfig(), catalog: withTasks, host: "antigravity" } : agent, { platform: "MacIntel" });
  await f.panel.open();
  const root = f.panel.element;
  const fieldset = (title) => descendants(root).find(item => item.tagName === "legend" && item.textContent === title)?.parentNode;
  assert.equal(fieldset("显示方式").hidden, true);
  assert.equal(fieldset("启动").hidden, true);
  assert.equal(fieldset("自动加载").hidden, false);
  assert.ok(bySetting(root, "auto-relaunch").parentNode.textContent.includes("刚打开的 Antigravity"));
  assert.equal(bySetting(root, "tasks-plan-hint").parentNode.hidden, true, "计划提示改的是 Codex 的指令文件");
  assert.equal(bySetting(root, "tasks-auto-add").parentNode.hidden, false);
  assert.ok(bySetting(root, "tasks-auto-add").parentNode.textContent.includes("在 Antigravity 里新开的会话"));
  assert.ok(root.textContent.includes("后台服务运行中"));
  assert.ok(root.textContent.includes("已连接"));
  assert.ok(root.textContent.includes("9339"));
  assert.ok(root.textContent.includes("原生助手"));
  assert.ok(root.textContent.includes("reopened"));
  f.panel.destroy();
});

test("卡片设置：控件只写本卡 settings、自动加 id 前缀；卡片代码出错只影响自己那一节", async () => {
  const extra = [
    { id: "alpha", title: "甲卡片", settings(kit) {
      const input = kit.checkbox(kit.group, "甲开关", "flag", value => ({ flag: value }), "说明", () => !kit.enabled());
      return { render() { input.checked = kit.settings().flag === true; } };
    } },
    { id: "beta", title: "乙卡片", settings() { throw new Error("坏了"); } }
  ];
  const f = fixture((method, params) => {
    if (method === "companion.settings.get") return { config: initialConfig(), catalog };
    if (method === "companion.agent.status") return { available: false };
    return { config: { ...initialConfig(), revision: 5, cards: { ...initialConfig().cards, alpha: { enabled: true, settings: { keep: true, flag: true } } } } };
  }, { cardSettings: extra });
  await f.panel.open();
  const root = f.panel.element;
  const flag = bySetting(root, "alpha-flag");
  assert.equal(flag.checked, false);
  change(flag, true);
  await turn();
  assert.deepEqual(f.calls.at(-1).params, { expectedRevision: 4, patch: { cards: { alpha: { settings: { flag: true } } } } });
  assert.equal(flag.checked, true);
  const beta = descendants(root).find(item => item.dataset.cardSettings === "beta");
  assert.ok(beta.textContent.includes("设置加载失败：坏了"));
  assert.equal(bySetting(root, "enabled").disabled, false, "其余设置照常可用");
  f.panel.destroy();
});

test("runtime：启用时还没送到的卡片不占位，defineCard 送到后按配置挂载，并补上它的设置节", async () => {
  const document = makeDocument();
  const client = createRpcClient({ binding: () => () => {} });
  const shell = createCardShell({ document });
  const backend = { getItem: () => null, setItem() {} };
  const base = { layout: { minHeight: 0 }, state: { scope: "target", version: 1 }, lifecycle: { start: "immediate", hidden: "retain" }, capabilities: [] };
  const manifests = [{ ...catalog[0], ...base }, { ...catalog[1], ...base }];
  const mounted = [];
  const runtime = createCardRuntime({
    manifests, renderers: { alpha: { mount: () => { mounted.push("alpha"); return {}; } } }, rendererHashes: { alpha: "a1" },
    config: { ...initialConfig(), cards: { alpha: { enabled: true, settings: {} }, beta: { enabled: true, settings: {} } } },
    shellFactory: () => shell, rpcClient: client, localStorage: backend, sessionStorage: backend,
    adapterFactory: ({ host }) => {
      document.body.append(host);
      return { setPlacement() {}, setHasCards() {}, dispose() {}, getDiagnostics: () => ({ mode: "fixture" }) };
    }
  });
  await turn();
  assert.deepEqual(runtime.getDiagnostics().shell.ids, ["alpha"], "没送到的 beta 不占位");
  assert.deepEqual(runtime.getDefinedCards(), { alpha: "a1" });
  let settingsBuilt = 0;
  const beta = { mount: () => { mounted.push("beta"); return {}; }, settings(kit) { settingsBuilt++; kit.checkbox(kit.group, "乙开关", "flag", value => ({ flag: value })); return { render() {} }; } };
  assert.equal(runtime.defineCard("beta", beta, "b1"), true);
  await turn();
  assert.deepEqual(mounted, ["alpha", "beta"]);
  assert.deepEqual(runtime.getDiagnostics().shell.ids.sort(), ["alpha", "beta"]);
  assert.equal(settingsBuilt, 1, "设置面板补上乙卡片的一节");
  assert.ok(bySetting(shell.root, "beta-flag"));
  assert.equal(runtime.defineCard("beta", beta, "b1"), false, "同一份代码不重复挂载");
  assert.equal(runtime.defineCard("ghost", beta, "g1"), false, "目录里没有的卡片不接收");
  assert.equal(runtime.defineCard("beta", { mount: () => { mounted.push("beta2"); return {}; } }, "b2"), true);
  await turn();
  assert.deepEqual(mounted, ["alpha", "beta", "beta2"], "换了代码的卡片重建实例");
  await runtime.dispose();
});

// 自己安装的插件：settings.get 的 catalog 里 source 为 user，plugin 给出来源。
const pluginCatalog = () => [
  ...catalog,
  { id: "gamma", title: "丙插件", defaultEnabled: false, defaultOrder: 10, source: "user", plugin: { kind: "git", from: "someone/agent-companion-card-gamma@v1.0.0", overridesBuiltin: false } },
  { id: "delta", title: "丁插件", defaultEnabled: false, defaultOrder: 11, source: "user", plugin: { kind: "link", from: "~/dev/delta", overridesBuiltin: false } },
  { id: "alpha2", title: "改过的甲", defaultEnabled: false, defaultOrder: 12, source: "user", plugin: { kind: "manual", from: null, overridesBuiltin: true } }
];
const pluginRow = (root, id) => descendants(root).find(child => child.dataset.plugin === id);
const message = root => descendants(root).find(child => child.className === "cc-settings-message");

test("插件：只列自己安装的卡片与来源；卸载要在面板内确认，带上是否删除数据，成功后重新读取并提示", async () => {
  let entries = pluginCatalog();
  const gate = deferred();
  const f = fixture(method => {
    if (method === "companion.settings.get") return { config: initialConfig(), catalog: entries };
    if (method === "companion.agent.status") return { available: false };
    assert.equal(method, "companion.cards.remove");
    return gate.promise;
  });
  await f.panel.open();
  const root = f.panel.element;
  const legend = descendants(root).find(item => item.tagName === "legend" && item.textContent === "插件");
  assert.equal(legend.parentNode.hidden, false);
  assert.equal(pluginRow(root, "alpha"), undefined, "内置卡片不能卸载，不出现在这一节");
  assert.ok(pluginRow(root, "gamma").textContent.includes("安装自 someone/agent-companion-card-gamma@v1.0.0"));
  assert.ok(pluginRow(root, "delta").textContent.includes("开发链接 → ~/dev/delta"));
  assert.ok(pluginRow(root, "alpha2").textContent.includes("手动放进卡片目录 · 覆盖内置版本"));
  assert.ok(byLabel(root, "恢复内置版本 改过的甲"));
  const confirmBox = byLabel(root, "确认卸载插件");
  assert.equal(confirmBox.hidden, true);

  byLabel(root, "卸载 丙插件").click();
  assert.equal(confirmBox.hidden, false);
  assert.ok(confirmBox.textContent.includes("卸载「丙插件」？会删除它的插件目录"));
  assert.equal(f.document.activeElement, byText(confirmBox, "取消"));
  assert.equal(escape(root).defaultPrevented, true);
  assert.equal(confirmBox.hidden, true, "Esc 先取消确认");
  assert.equal(f.document.activeElement, byLabel(root, "卸载 丙插件"));
  assert.equal(f.panel.element.hidden, false);

  byLabel(root, "卸载 丁插件").click();
  assert.ok(confirmBox.textContent.includes("删除「丁插件」的开发链接？源码目录不会被删除"));
  assert.ok(byText(confirmBox, "删除链接"));
  byText(confirmBox, "取消").click();
  assert.equal(f.calls.some(item => item.method === "companion.cards.remove"), false, "取消不调用");

  byLabel(root, "卸载 丙插件").click();
  bySetting(root, "plugin-purge").checked = true;
  byText(confirmBox, "卸载").click();
  byText(confirmBox, "卸载").click();
  assert.deepEqual(f.calls.filter(item => item.method === "companion.cards.remove"), [{ method: "companion.cards.remove", params: { id: "gamma", purgeData: true } }]);
  assert.equal(byText(confirmBox, "卸载").disabled, true, "卸载期间禁用");
  assert.equal(message(root).textContent, "正在卸载 丙插件…");
  entries = entries.filter(entry => entry.id !== "gamma");
  gate.resolve({ id: "gamma", restoresBuiltin: false });
  await turn(); await turn();
  assert.equal(confirmBox.hidden, true);
  assert.equal(pluginRow(root, "gamma"), undefined);
  assert.equal(bySetting(root, "card-gamma"), undefined, "卡片列表也随之去掉");
  assert.equal(message(root).textContent, "已卸载 丙插件");
  assert.equal(f.panel.notice(), "已卸载 丙插件");

  // 再次打开确认框时「同时删除数据」恢复为不勾选。
  byLabel(root, "恢复内置版本 改过的甲").click();
  assert.equal(bySetting(root, "plugin-purge").checked, false);
  assert.ok(confirmBox.textContent.includes("删除你安装的「改过的甲」，恢复使用内置版本？"));
  f.panel.destroy();
});

test("插件：卸载失败显示原因，确认框保留可以取消；没有插件时整节隐藏", async () => {
  let fail = true;
  const f = fixture(method => {
    if (method === "companion.settings.get") return { config: initialConfig(), catalog: fail ? pluginCatalog() : catalog };
    if (method === "companion.agent.status") return { available: false };
    throw Object.assign(new Error("没有安装这张卡片，可能已经卸载"), { code: "NOT_INSTALLED" });
  });
  await f.panel.open();
  const root = f.panel.element;
  const confirmBox = byLabel(root, "确认卸载插件");
  byLabel(root, "卸载 丙插件").click();
  byText(confirmBox, "卸载").click();
  await turn();
  assert.equal(message(root).textContent, "没有安装这张卡片，可能已经卸载");
  assert.equal(message(root).getAttribute("role"), "alert");
  assert.equal(f.panel.notice(), "", "错误不带到重建后的面板");
  assert.equal(confirmBox.hidden, false);
  byText(confirmBox, "取消").click();
  assert.equal(confirmBox.hidden, true);
  fail = false;
  byText(root, "重试").click();
  await turn();
  const legend = descendants(root).find(item => item.tagName === "legend" && item.textContent === "插件");
  assert.equal(legend.parentNode.hidden, true);
  assert.equal(pluginRow(root, "gamma"), undefined);
  f.panel.destroy();
});

test("页面整体重建（换注入产物）：新运行时接着打开抽屉与设置，并显示原来的提示", async () => {
  const document = makeDocument();
  const backend = { getItem: () => null, setItem() {} };
  const results = { "companion.settings.get": { config: initialConfig(), catalog }, "companion.agent.status": { available: false },
    "companion.update.status": { supported: false }, "companion.settings.patch": { config: { ...initialConfig(), revision: 5 } } };
  const opened = [];
  function make(restoreUi) {
    const sent = [];
    const client = createRpcClient({ binding: () => raw => { sent.push(JSON.parse(raw)); } });
    const shell = createCardShell({ document });
    const runtime = createCardRuntime({
      manifests: [], config: initialConfig(), shellFactory: () => shell, rpcClient: client, localStorage: backend, sessionStorage: backend, restoreUi,
      adapterFactory: ({ host }) => {
        document.body.append(host);
        let open = false;
        return { setPlacement() {}, setHasCards() {}, dispose() {}, getDiagnostics: () => ({ mode: "fixture" }),
          setOpen(value) { open = value; opened.push(value); }, isOpen: () => open };
      }
    });
    const answer = async () => {
      for (const request of sent.splice(0)) client.receiveRpc({ id: request.id, result: results[request.method] });
      await turn();
    };
    return { shell, runtime, answer };
  }
  const first = make(null);
  assert.deepEqual(first.runtime.getUiState(), { open: false, settings: null });
  assert.deepEqual(opened, [], "没有可恢复的状态时不打开");
  first.runtime.setOpen(true);
  byLabel(first.shell.root, "Companion 设置").click();
  await first.answer();
  change(bySetting(first.shell.root, "card-alpha"), false);
  await first.answer();
  assert.deepEqual(first.runtime.getUiState(), { open: true, settings: { open: true, notice: "已保存" } });
  const state = first.runtime.getUiState();
  await first.runtime.dispose();
  assert.equal(first.runtime.getUiState(), null);

  const second = make(state);
  assert.deepEqual(opened, [true, true]);
  assert.equal(second.shell.isSettingsOpen(), true);
  await second.answer();
  assert.equal(message(second.shell.root).textContent, "已保存");
  await second.runtime.dispose();
});
