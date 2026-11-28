import { completeCardOrder } from "../../platform/config/runtime-config.mjs";
import { PLAN_HINT_BODY, PLAN_TOOL_SNIPPET } from "../../codex-plan-hint-text.mjs";

// agent 拒绝重启时返回机器原因码，这里只展示对用户有意义的说明。
const RESTART_REFUSALS = {
  busy: "后台正在处理其他操作，请稍后再试",
  "rate-limited": "操作过于频繁，请稍后再试",
  "not-running": "Codex 未运行",
  "multiple-instances": "检测到多个 Codex 实例",
  "foreign-debug": "当前 Codex 由其他工具以调试模式启动",
  unknown: "无法确认当前 Codex 进程",
  stopped: "后台服务正在停止",
  error: "后台服务出错",
  "native-helper-missing": "缺少原生助手，请手动退出并重新打开 Codex"
};

// 宿主集成的说明文字，供卡片设置展示：「长任务先列计划」写进 Codex 的规则全文与 config.toml 片段，
// 与后台 createPlanHint 写入的内容同源。
const CODEX_INFO = Object.freeze({ planHint: Object.freeze({ body: PLAN_HINT_BODY, toolSnippet: PLAN_TOOL_SNIPPET }) });

const DISCONNECTED_MESSAGE = "后台连接已断开，正在自动恢复…";
// 这些错误表示请求根本没有得到后台回音，可能是连接断了。
const NO_REPLY_CODES = new Set(["BRIDGE_UNAVAILABLE", "RPC_TIMEOUT", "TIMEOUT"]);

// 图标沿用 Codex 顶栏的 16px 线框规格，颜色全部继承 currentColor。
const ICONS = {
  close: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7"/></svg>',
  grip: '<svg viewBox="0 0 16 16" aria-hidden="true"><g class="dots"><circle cx="6" cy="4" r="1.05"/><circle cx="10" cy="4" r="1.05"/><circle cx="6" cy="8" r="1.05"/><circle cx="10" cy="8" r="1.05"/><circle cx="6" cy="12" r="1.05"/><circle cx="10" cy="12" r="1.05"/></g></svg>',
  refresh: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.46-3.54M13 3v2.5h-2.5"/></svg>'
};

// 平台设置只读写 RPC；运行时配置仍由 watcher 推送，不能在这里直接改卡片。
// platform 缺省取页面 navigator，测试显式传入。
// connection 来自 rpc-client：断开时说明正在自动恢复，恢复后自动重新读取，不用手动点重试。
// cardSettings：[{ id, title, settings }]，settings 是卡片 renderer 导出的 settings(kit)，见 cardSection。
export function createSettingsPanel({ document: doc, call, connection, onClose = () => {}, onUpdateStatus = () => {}, platform, cardSettings = [] }) {
  const nav = doc.defaultView?.navigator;
  const mac = /mac|darwin/i.test(String(platform ?? nav?.userAgentData?.platform ?? nav?.platform ?? ""));
  const element = doc.createElement("section");
  element.className = "cc-settings";
  element.hidden = true;
  element.setAttribute("role", "region");
  element.setAttribute("aria-label", "Companion 设置");
  let config = null;
  let catalog = [];
  let busy = false;
  let destroyed = false;
  let confirming = false;
  // 卡片设置里正开着的确认框（同一时间只有一个）。
  let activeConfirmation = null;
  // Linux 由应用菜单入口加载卡片，不能自动重开或重启 Codex。
  let menuReopen = false;
  // 宿主（codex / antigravity）由后台在 settings.get 里告知；只对 Codex 有意义的设置在别的宿主里隐藏。
  let host = "codex";
  const hostName = () => (host === "antigravity" ? "Antigravity" : "Codex");
  let busyFocus = null;
  // 恢复连接时如果还有请求在途，等它结束后再重新读取。
  let reloadPending = false;
  let autoReloaded = false;
  let updateStatus = null;
  let updatePoll = null;
  const listeners = [];
  const controls = [];
  const rows = new Map();

  function node(tag, text, className) {
    const value = doc.createElement(tag);
    if (text) value.textContent = text;
    if (className) value.className = className;
    return value;
  }
  function listen(target, type, callback) {
    target.addEventListener(type, callback);
    listeners.push(() => target.removeEventListener(type, callback));
  }
  function control(value, disabled = () => false) {
    controls.push({ value, disabled });
    return value;
  }
  function button(text, callback, label, className) {
    const value = node("button", text, className);
    value.type = "button";
    if (label) value.setAttribute("aria-label", label);
    listen(value, "click", callback);
    return value;
  }
  function section(title) {
    const value = node("fieldset");
    const group = node("div", null, "cc-group");
    value.append(node("legend", title), group);
    element.append(value);
    return group;
  }
  // 原生 checkbox 保留键盘与表单语义，外观按 Codex 开关绘制。hint 可以是文字或现成的 small 节点。
  function checkbox(parent, title, key, patch, hint, disabled) {
    const label = node("label", null, "cc-settings-row");
    const input = control(node("input"), disabled);
    input.type = "checkbox";
    input.className = "cc-switch";
    input.setAttribute("role", "switch");
    input.dataset.setting = key;
    const text = node("span", title);
    if (hint) text.append(typeof hint === "string" ? node("small", hint) : hint);
    label.append(text, input);
    parent.append(label);
    listen(input, "change", () => { const value = patch(input.checked); if (value) void save(value); });
    return input;
  }

  // 几档单选，外观同「显示方式」的分段控件；原生 radio 保留键盘与表单语义。返回 值 → input，.row 是整行。
  function choice(parent, title, hint, key, options, patch, disabled) {
    const row = node("div", null, "cc-settings-row");
    const text = node("span", title);
    if (hint) text.append(typeof hint === "string" ? node("small", hint) : hint);
    const group = node("div", null, "cc-seg cc-seg-inline");
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", title);
    const inputs = new Map();
    for (const [value, label] of options) {
      const wrap = node("label");
      const input = control(node("input"), disabled);
      input.type = "radio";
      input.name = `companion-${key}`;
      input.value = value;
      input.dataset.setting = key;
      wrap.append(input, node("span", label));
      group.append(wrap);
      inputs.set(value, input);
      listen(input, "change", () => {
        if (!input.checked) return;
        const next = patch(value);
        if (next) void save(next);
      });
    }
    row.append(text, group);
    parent.append(row);
    inputs.row = row;
    return inputs;
  }

  // 需要用户确认才能保存的改动（例如改写宿主的全局文件）用的确认框。同一时间只开一个：
  // 打开时收起其它确认框；Esc、关闭面板、任何一次保存或配置刷新都会取消它。
  function confirmationBox({ label, className, onCancel = () => {} } = {}) {
    const box = node("div", null, className ? `cc-settings-confirm ${className}` : "cc-settings-confirm");
    box.hidden = true;
    box.setAttribute("role", "group");
    if (label) box.setAttribute("aria-label", label);
    const handle = Object.freeze({
      element: box,
      isOpen: () => !box.hidden,
      open(focusTarget) {
        if (destroyed || element.hidden) return;
        if (confirming) cancelConfirmation();
        if (activeConfirmation && activeConfirmation !== handle) activeConfirmation.cancel(false);
        activeConfirmation = handle;
        box.hidden = false;
        focusTarget?.focus();
      },
      cancel(restoreFocus = true) {
        if (activeConfirmation === handle) activeConfirmation = null;
        box.hidden = true;
        onCancel(restoreFocus && !element.hidden && !destroyed);
      }
    });
    return handle;
  }

  // 卡片自己的设置：renderer 导出 settings(kit) 的卡片各占一节，标题取 manifest，卡片不在目录里时整节隐藏。
  // kit 只提供与面板一致的控件、本卡设置的读写（一律写进 cards.<id>.settings）和宿主信息；
  // 控件的 data-setting 自动加上「<id>-」前缀；卡片未启用时由各控件的 disabled 判断禁用。
  // settings(kit) 返回 { render() }，每次读到或保存配置后调用。卡片代码出错只影响它自己这一节。
  function cardSection({ id, title, settings: contribute }) {
    const group = section(title);
    const fieldset = group.parentNode;
    fieldset.dataset.cardSettings = id;
    const firstControl = controls.length;
    const failure = node("p", null, "cc-settings-note cc-settings-error");
    failure.hidden = true;
    const fail = (error) => {
      failure.textContent = `设置加载失败：${error?.message || String(error)}`;
      failure.hidden = false;
      group.append(failure);
    };
    const ready = () => !busy && Boolean(config) && !destroyed && !element.hidden;
    const scoped = (patch) => (patch ? { cards: { [id]: { settings: patch } } } : null);
    // 先确认面板可写再让卡片算补丁：卡片可能借这一步弹确认框。
    const guarded = (patch) => (value) => (busy || !config || destroyed ? null : scoped(patch(value)));
    const kit = Object.freeze({
      id, group, mac, node, codex: CODEX_INFO,
      host: () => host,
      hostName,
      settings: () => config?.cards?.[id]?.settings ?? {},
      enabled: () => Boolean(config) && (config.cards?.[id]?.enabled ?? catalog.find(card => card.id === id)?.defaultEnabled) !== false,
      isOpen: () => !destroyed && !element.hidden,
      ready,
      save: (patch) => (ready() && patch ? save(scoped(patch)) : Promise.resolve()),
      checkbox: (parent, label, key, patch, hint, disabled) => checkbox(parent, label, `${id}-${key}`, guarded(patch), hint, disabled),
      choice: (parent, label, hint, key, options, patch, disabled) => choice(parent, label, hint, `${id}-${key}`, options, guarded(patch), disabled),
      button: (text, callback, { label, className, disabled } = {}) => control(button(text, callback, label, className), disabled),
      control,
      confirmation: confirmationBox
    });
    let contribution = null;
    try { contribution = contribute(kit) ?? null; } catch (error) { fail(error); }
    const owned = controls.slice(firstControl);
    return {
      fieldset,
      render() {
        fieldset.hidden = !config || !catalog.some(card => card.id === id);
        if (fieldset.hidden || !contribution?.render) return;
        try { contribution.render(); } catch (error) { fail(error); }
      },
      remove() {
        fieldset.remove();
        for (const item of owned) controls.splice(controls.indexOf(item), 1);
      }
    };
  }
  function addCard(entry) {
    if (destroyed || typeof entry?.settings !== "function") return;
    if (activeConfirmation && cardSections.get(entry.id)?.fieldset.contains(activeConfirmation.element)) activeConfirmation.cancel(false);
    cardSections.get(entry.id)?.remove();
    const item = cardSection(entry);
    element.insertBefore(item.fieldset, proxySection.parentNode);
    cardSections.set(entry.id, item);
    item.render();
    for (const owned of controls) owned.value.disabled = busy || !config || owned.disabled();
  }

  const style = node("style");
  // 颜色优先取 Codex 设计变量（随宿主明暗切换），缺失时回退到 currentColor 混色。
  // Codex 的开关选中色和焦点色是黑白的，「更新」提醒要醒目，单独用 Codex 调色板里的蓝 / 绿。
  style.textContent = `
    .cc-settings { --fg:var(--cc-card-fg,var(--color-token-text-primary,currentColor));
      --fg2:var(--color-token-text-secondary,color-mix(in srgb,currentColor 65%,transparent));
      --fg3:var(--cc-card-fg-muted,var(--color-token-text-tertiary,color-mix(in srgb,currentColor 50%,transparent)));
      --line:var(--color-token-border,var(--cc-card-border,color-mix(in srgb,currentColor 9%,transparent)));
      --line2:var(--color-token-border-heavy,var(--cc-card-border,color-mix(in srgb,currentColor 14%,transparent)));
      --hover:var(--cc-card-hover,var(--color-token-list-hover-background,color-mix(in srgb,currentColor 6%,transparent)));
      --surface:var(--color-token-main-surface-primary,var(--cc-card-bg,Canvas));
      --accent:var(--cc-card-accent,var(--switch-track-color-checked,#3a83f7));
      --focus:var(--cc-card-focus,var(--color-token-focus-border,#3a83f7));
      --ease:var(--cubic-move,cubic-bezier(.65,0,.35,1));
      box-sizing:border-box;min-width:0;width:100%;margin:0 0 var(--cc-card-gap,12px);padding:14px 14px 12px;
      border:0;border-radius:var(--cc-card-radius,var(--hg-panel-radius,20px));
      background:var(--cc-card-surface,var(--hg-card-bg,var(--cc-card-bg,var(--surface))));color:var(--cc-card-fg,var(--fg));
      font:13px/1.45 var(--cc-card-font,var(--hg-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif));overflow-wrap:anywhere;
      box-shadow:var(--cc-card-shadow,var(--hg-panel-shadow,var(--elevation-prominent,0 0 0 .5px var(--line2),0 3px 7.5px #0000000a,0 0 20px #0000000d))); }
    .cc-settings *, .cc-settings *::before, .cc-settings *::after { box-sizing:border-box; }
    .cc-settings [hidden], .cc-settings[hidden] { display:none !important; }
    .cc-settings svg { width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:1.15;
      stroke-linecap:round;stroke-linejoin:round; }
    .cc-settings svg .dots { fill:currentColor;stroke:none; }
    .cc-settings header { display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 2px 2px; }
    .cc-settings h2 { margin:0;font-size:var(--cc-section-title-size,13px);font-weight:var(--cc-section-title-weight,600);
      color:var(--cc-section-title-color,var(--fg));letter-spacing:-.01em; }
    .cc-settings fieldset { min-width:0;margin:12px 0 0;padding:0;border:0; }
    .cc-settings legend { float:left;width:100%;padding:0 2px;margin:0 0 5px;font-size:11.5px;font-weight:500;color:var(--fg3); }
    .cc-settings legend + * { clear:both; }
    .cc-group { border:1px solid var(--line);border-radius:10px;background:var(--surface);overflow:hidden; }
    .cc-group > * + *, .cc-list > * + * { border-top:1px solid var(--line); }
    .cc-settings-row { display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:38px;
      padding:7px 11px;min-width:0; }
    .cc-settings-row > span { flex:1;min-width:0; }
    .cc-settings-row small { display:block;margin-top:1px;font-size:11.5px;color:var(--fg3); }
    .cc-switch { appearance:none;-webkit-appearance:none;position:relative;flex:none;margin:0;cursor:pointer;
      width:var(--switch-track-width,30px);height:var(--switch-track-height,17px);border-radius:999px;
      background:var(--switch-track-color,color-mix(in srgb,currentColor 30%,transparent));
      transition:background-color .15s ease; }
    .cc-switch::before { content:"";position:absolute;top:2px;left:2px;
      width:calc(var(--switch-track-height,17px) - 4px);height:calc(var(--switch-track-height,17px) - 4px);border-radius:50%;
      background:var(--switch-thumb-color,var(--surface));
      box-shadow:var(--switch-thumb-shadow,0 1px 2px rgba(0,0,0,.22),0 0 0 .5px color-mix(in srgb,currentColor 18%,transparent));
      transition:transform .2s var(--ease); }
    .cc-switch:checked { background:var(--switch-track-color-checked,var(--fg)); }
    .cc-switch:checked::before { transform:translateX(calc(var(--switch-track-width,30px) - var(--switch-track-height,17px))); }
    .cc-list[data-off] .cc-settings-card { opacity:.45; }
    .cc-settings-card { position:relative;display:flex;align-items:center;min-width:0;background:var(--surface);
      transition:transform .2s var(--ease),opacity .15s linear; }
    .cc-settings-card .cc-settings-row { flex:1;padding-left:2px; }
    .cc-settings-card[data-dragging] { z-index:1;transition:none;border-radius:10px;
      box-shadow:0 8px 24px rgba(0,0,0,.14),0 0 0 1px var(--line2); }
    .cc-list[data-sorting] .cc-settings-card { border-top-color:transparent; }
    .cc-list[data-settling] .cc-settings-card { transition:none; }
    .cc-list[data-sorting] { user-select:none; }
    .cc-handle { display:flex;align-items:center;justify-content:center;flex:none;width:28px;height:40px;margin-left:4px;
      padding:0;border:0;border-radius:8px;background:transparent;color:var(--fg3);cursor:grab;touch-action:none; }
    .cc-handle:hover:not(:disabled) { color:var(--fg2);background:transparent; }
    .cc-list[data-sorting] .cc-handle { cursor:grabbing; }
    .cc-seg { display:grid;grid-template-columns:1fr 1fr;gap:2px;padding:2px;margin:0;border-radius:10px;
      background:var(--color-background-segmented-form-track,color-mix(in srgb,currentColor 7%,transparent)); }
    .cc-fieldset-seg .cc-group { border:0;background:transparent;border-radius:0; }
    .cc-seg label { position:relative;display:flex;align-items:center;justify-content:center;min-height:28px;
      padding:4px 8px;border-radius:8px;color:var(--fg2);cursor:pointer;transition:background-color .15s,color .15s; }
    .cc-seg label:hover { color:var(--fg); }
    .cc-seg label:has(input:checked) { color:var(--fg);font-weight:500;
      background:var(--color-background-segmented-form-selected,var(--surface));
      box-shadow:var(--shadow-mode-toggle-selected,0 2px 4px -1px #00000014),0 0 0 .5px var(--line); }
    .cc-seg label:has(input:focus-visible) { outline:2px solid var(--focus);outline-offset:1px; }
    .cc-seg input { position:absolute;inset:0;margin:0;opacity:0;cursor:pointer; }
    .cc-seg-inline { flex:none;grid-template-columns:repeat(3,auto); }
    .cc-seg-inline label { min-height:24px;padding:2px 10px;font-size:12px; }
    .cc-seg-inline label:has(input:disabled) { cursor:default;opacity:.5; }
    .cc-settings input[type="text"] { width:72px;height:28px;padding:0 8px;border:1px solid var(--color-token-input-border,var(--line2));
      border-radius:8px;color:inherit;background:transparent;font:inherit;text-align:center;font-variant-numeric:tabular-nums; }
    .cc-settings input[type="text"]:focus { outline:none;border-color:var(--focus);box-shadow:0 0 0 3px color-mix(in srgb,var(--focus) 22%,transparent); }
    .cc-settings input[aria-invalid="true"] { border-color:#e5484d; }
    .cc-settings button { display:inline-flex;align-items:center;justify-content:center;gap:6px;flex:none;height:28px;
      padding:0 10px;border:1px solid var(--line2);border-radius:8px;background:var(--surface);color:inherit;
      font:inherit;font-size:12px;font-weight:500;cursor:pointer;transition:background-color .15s; }
    .cc-settings button:hover:not(:disabled) { background:var(--hover); }
    .cc-settings button.cc-ghost { width:28px;padding:0;border-color:transparent;background:transparent;color:var(--fg3); }
    .cc-settings button.cc-ghost:hover:not(:disabled) { color:var(--fg); }
    .cc-settings button.cc-primary { border-color:transparent;background:var(--cc-card-fg,var(--color-token-text-primary,CanvasText));color:var(--surface); }
    .cc-settings button.cc-primary:hover:not(:disabled) { background:var(--cc-card-fg,var(--color-token-text-primary,CanvasText));opacity:.86; }
    .cc-settings button.cc-handle { width:28px;height:40px;padding:0;border:0;background:transparent;color:var(--fg3); }
    .cc-settings button.cc-handle:hover:not(:disabled) { background:transparent;color:var(--fg2); }
    .cc-settings :disabled { opacity:.5;cursor:default; }
    .cc-settings .cc-switch:disabled { opacity:.6; }
    .cc-settings :focus-visible { outline:2px solid var(--focus);outline-offset:2px; }
    .cc-settings p { margin:0;font-size:12px;color:var(--fg2); }
    .cc-settings-inline { display:flex;align-items:center;gap:6px; }
    .cc-settings .cc-settings-note { padding:8px 12px;color:var(--fg3); }
    .cc-settings-actions { display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:6px;padding:8px 12px; }
    .cc-settings-actions p { margin-right:auto; }
    .cc-settings-error { padding:0 12px 8px;color:#e5484d !important; }
    .cc-settings-message { min-height:18px;margin:10px 2px 0 !important;color:var(--fg3) !important; }
    .cc-settings-message[role="alert"] { color:#e5484d !important; }
    .cc-retry { margin:6px 2px 0; }
    .cc-settings-confirm { margin:0 12px 10px;padding:10px 12px;border-radius:10px;
      background:color-mix(in srgb,#f5a623 10%,transparent);border:1px solid color-mix(in srgb,#f5a623 30%,transparent); }
    .cc-settings-confirm p { color:var(--fg); }
    .cc-settings-confirm .cc-settings-actions { padding:8px 0 0; }
    .cc-settings-confirm p + p { margin-top:8px; }
    .cc-settings-confirm details { margin-top:8px; }
    .cc-settings-confirm summary { cursor:pointer;font-size:12px; }
    .cc-settings-confirm pre { margin:8px 0 0;padding:10px;border-radius:8px;background:var(--surface);
      white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace; }
    .cc-plugin-row { min-height:36px;padding:7px 12px;gap:10px; }
    .cc-plugin-row > span { display:flex;flex-direction:column;min-width:0; }
    .cc-plugin-row > span > span { font-size:13px;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
    .cc-plugin-row small { margin-top:1px;font-size:11px;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
    .cc-plugin-row button { height:24px;padding:0 9px;border-radius:7px;font-size:12px;color:var(--fg2); }
    .cc-plugin-row button[data-danger]:hover:not(:disabled) { color:#cf222e;border-color:color-mix(in srgb,#cf222e 32%,transparent);
      background:color-mix(in srgb,#cf222e 7%,transparent); }
    .cc-plugin-row[data-confirming] button { opacity:0;pointer-events:none; }
    .cc-plugin-confirm { margin:0;padding:8px 12px 9px;border:0;border-top:1px solid var(--line);border-radius:0;
      background:color-mix(in srgb,currentColor 3%,transparent); }
    .cc-plugin-confirm p { font-size:12px;line-height:1.45;color:var(--fg2); }
    .cc-plugin-confirm-bar { display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px 8px;margin-top:7px; }
    .cc-plugin-confirm-actions { display:flex;align-items:center;gap:6px;margin-left:auto; }
    .cc-plugin-confirm button { height:24px;padding:0 9px;border-radius:7px;font-size:12px; }
    .cc-plugin-confirm button.cc-primary[data-danger] { background:#cf222e;color:#fff; }
    .cc-plugin-confirm button.cc-primary[data-danger]:hover:not(:disabled) { background:#cf222e;opacity:.88; }
    .cc-settings-purge { display:inline-flex;align-items:center;gap:5px;margin:0;font-size:11.5px;color:var(--fg3);cursor:pointer;user-select:none; }
    .cc-settings-purge:hover { color:var(--fg2); }
    .cc-settings-purge input { appearance:none;-webkit-appearance:none;position:relative;flex:none;width:13px;height:13px;margin:0;
      border:1px solid var(--line2);border-radius:3.5px;background:var(--surface);cursor:pointer;transition:background-color .12s,border-color .12s; }
    .cc-settings-purge input:checked { background:var(--fg);border-color:var(--fg); }
    .cc-settings-purge input:checked::after { content:"";position:absolute;left:3.5px;top:1px;width:3.5px;height:6.5px;
      border:solid var(--surface);border-width:0 1.5px 1.5px 0;transform:rotate(45deg); }
    .cc-status { display:flex;align-items:center;gap:8px;padding:8px 8px 8px 12px;min-height:40px; }
    .cc-status p { flex:1;color:var(--fg);font-size:13px; }
    .cc-status p::before { content:"";display:inline-block;width:6px;height:6px;margin:0 7px 1px 0;border-radius:50%;
      background:var(--fg3);vertical-align:middle; }
    .cc-status[data-state="ok"] p::before { background:var(--cc-ok,#238559); }
    .cc-status[data-state="bad"] p::before { background:var(--cc-danger,#c42b25); }
    .cc-settings dl { display:grid;grid-template-columns:auto minmax(0,1fr);gap:6px 12px;margin:0;padding:10px 12px;font-size:12px; }
    .cc-settings dl:empty { display:none; }
    .cc-settings dt { color:var(--fg3); } .cc-settings dd { margin:0;text-align:right;overflow-wrap:anywhere;font-variant-numeric:tabular-nums; }
    .cc-status[data-state="new"] p::before { background:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 18%,transparent); }
    .cc-update-notes summary { padding:8px 12px;font-size:12px;color:var(--fg2);cursor:pointer; }
    .cc-update-notes pre, .cc-update-command { margin:0;padding:0 12px 10px;max-height:200px;overflow:auto;white-space:pre-wrap;
      overflow-wrap:anywhere;font:12px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--fg2); }
    .cc-update-command { padding-top:8px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;user-select:text; }
    .cc-settings fieldset[data-attention] { --attn:var(--color-blue-400,#0285ff); }
    .cc-settings fieldset[data-attention="updated"] { --attn:var(--color-green-500,#00a240); }
    .cc-settings fieldset[data-attention] legend { color:color-mix(in srgb,var(--attn) 75%,var(--fg));font-weight:600; }
    .cc-settings fieldset[data-attention] .cc-status[data-state="new"] p::before { background:var(--attn);
      box-shadow:0 0 0 3px color-mix(in srgb,var(--attn) 22%,transparent); }
    .cc-settings fieldset[data-attention] .cc-group { border-color:color-mix(in srgb,var(--attn) 40%,transparent);
      background:color-mix(in srgb,var(--attn) 9%,var(--surface)); }
    .cc-settings fieldset[data-attention] .cc-group > * + * { border-top-color:color-mix(in srgb,var(--attn) 20%,transparent); }
    .cc-settings fieldset[data-attention] .cc-status p { font-weight:600; }
    .cc-settings fieldset[data-attention] button.cc-primary,
    .cc-settings fieldset[data-attention] button.cc-primary:hover:not(:disabled) { background:color-mix(in srgb,var(--attn) 78%,#000);color:#fff; }
    @media (prefers-reduced-motion:reduce) { .cc-settings *, .cc-settings *::before, .cc-settings *::after { transition:none !important; animation:none !important; } }
  `;
  const header = node("header");
  const closeButton = button("", close, "关闭 Companion 设置", "cc-ghost");
  closeButton.innerHTML = ICONS.close;
  closeButton.title = "关闭";
  header.append(node("h2", "Companion 设置"), closeButton);
  element.append(style, header);

  const general = section("卡片");
  const enabled = checkbox(general, "启用卡片", "enabled", value => ({ enabled: value }));
  const cardList = node("div", null, "cc-list");
  general.append(cardList);
  // 自己安装的插件：显示来源，可以卸载（内置卡片只能关闭）。没有装插件时整节隐藏。
  const pluginSection = section("插件");
  const pluginList = node("div", null, "cc-list");
  pluginSection.append(pluginList);
  const pluginRows = new Map();
  let removalTarget = null;
  const removal = confirmationBox({ label: "确认卸载插件", className: "cc-plugin-confirm", onCancel(restoreFocus) {
    const target = removalTarget;
    removalTarget = null;
    if (target) pluginRows.get(target.id)?.element.removeAttribute("data-confirming");
    if (restoreFocus) pluginRows.get(target?.id)?.button.focus();
  } });
  const removalText = node("p");
  const purgeLabel = node("label", null, "cc-settings-purge");
  const purgeInput = control(node("input"));
  purgeInput.type = "checkbox";
  purgeInput.dataset.setting = "plugin-purge";
  purgeLabel.append(purgeInput, node("span", "同时删除数据"));
  const cancelRemoval = control(button("取消", () => removal.cancel()));
  const confirmRemoval = control(button("卸载", () => { void uninstall(); }, null, "cc-primary"));
  const removalBar = node("div", null, "cc-plugin-confirm-bar");
  const removalActions = node("div", null, "cc-plugin-confirm-actions");
  removalActions.append(cancelRemoval, confirmRemoval);
  removalBar.append(purgeLabel, removalActions);
  removal.element.append(removalText, removalBar);
  pluginSection.append(removal.element);
  const placementSection = section("显示方式");
  placementSection.parentNode.className = "cc-fieldset-seg";
  placementSection.className = "cc-seg";
  const placements = new Map();
  for (const [value, title] of [["standalone-button", "独立按钮"], ["inline-in-summary", "摘要下方"]]) {
    const label = node("label");
    const input = control(node("input"));
    input.type = "radio";
    input.name = "companion-placement";
    input.value = value;
    input.dataset.setting = "placement";
    label.append(input, node("span", title));
    placementSection.append(label);
    placements.set(value, input);
    listen(input, "change", () => { if (input.checked) void save({ placement: value }); });
  }
  // id → 卡片设置节；之后送到页面的卡片经 addCard 补进来，位置固定在「启动」之前。
  const cardSections = new Map();
  for (const entry of cardSettings) cardSections.set(entry.id, cardSection(entry));
  const proxySection = section("启动");
  const proxyEnabled = checkbox(proxySection, "通过代理启动", "proxy-enabled", value => ({ launch: { proxy: { enabled: value } } }));
  const portForm = node("form", null, "cc-settings-row");
  const portLabel = node("label", null, "cc-settings-inline");
  const portInput = control(node("input"));
  // 文本输入保留原始内容，避免 number 输入把小数/指数悄悄规范化为合法端口。
  portInput.type = "text";
  portInput.inputMode = "numeric";
  portInput.dataset.setting = "proxy-port";
  portInput.setAttribute("aria-describedby", "companion-port-error");
  portLabel.append(portInput);
  const savePort = control(node("button", "保存端口"));
  savePort.type = "submit";
  portForm.append(node("span", "代理端口"), portLabel, savePort);
  const portError = node("p", null, "cc-settings-error");
  portError.id = "companion-port-error";
  portError.setAttribute("role", "alert");
  portError.hidden = true;
  listen(portInput, "input", () => {
    portError.hidden = true;
    portInput.removeAttribute("aria-invalid");
  });
  listen(portForm, "submit", event => {
    event.preventDefault();
    if (busy || !config || destroyed) return;
    const raw = portInput.value.trim();
    const port = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isInteger(port) || port < 1 || port > 65535) {
      portError.textContent = "端口须为 1–65535 的整数";
      portError.hidden = false;
      portInput.setAttribute("aria-invalid", "true");
      portInput.focus();
      return;
    }
    void save({ launch: { proxy: { port } } });
  });
  const restartButton = control(button("立即重启 Codex", () => {
    if (busy || !config || destroyed) return;
    activeConfirmation?.cancel(false);
    if (menuReopen) {
      showMessage("请退出 ChatGPT 后从应用菜单重新打开，新的代理设置即可生效");
      return;
    }
    confirming = true;
    confirmation.hidden = false;
    cancelRestart.focus();
  }));
  const confirmation = node("div", null, "cc-settings-confirm");
  confirmation.hidden = true;
  confirmation.setAttribute("role", "group");
  confirmation.setAttribute("aria-label", "确认重启 Codex");
  const confirmRestart = control(button("确认重启", () => { void restart(); }, null, "cc-primary"));
  const cancelRestart = control(button("取消", cancelConfirmation));
  const restartActions = node("div", null, "cc-settings-actions");
  restartActions.append(cancelRestart, confirmRestart);
  confirmation.append(node("p", "将正常退出并重新打开 Codex，未保存的输入可能丢失"), restartActions);
  const restartRow = node("div", null, "cc-settings-actions");
  restartRow.append(node("p", "修改代理后需重启 Codex 生效"), restartButton);
  proxySection.append(portForm, portError, restartRow, confirmation);
  const autoSection = section("自动加载");
  const autoRelaunchHint = node("small", "刚打开的 Codex 会自动重开一次以加载卡片");
  const autoRelaunch = checkbox(autoSection, "打开应用时自动加载", "auto-relaunch", value => ({ agent: { autoRelaunch: value } }),
    autoRelaunchHint);
  // 更新：Homebrew 安装可以自动或一键更新；源码与其它安装方式只提醒，给出命令或 Release 地址。
  const updateSection = section("更新");
  const updateRow = node("div", null, "cc-status");
  const updateText = node("p");
  const checkUpdateButton = control(button("检查更新", () => { void checkForUpdates(); }),
    () => ["checking", "updating", "waiting-restart", "restarting"].includes(updateStatus?.phase));
  updateRow.append(updateText, checkUpdateButton);
  updateSection.append(updateRow);
  const autoUpdate = checkbox(updateSection, "自动更新", "auto-update", value => ({ updates: { auto: value } }),
    "有新版本时自动安装并重启后台服务，不会重启 Codex；视频播放中会等播完再生效");
  const updateActions = node("div", null, "cc-settings-actions");
  const updateHint = node("p");
  const applyUpdateButton = control(button("立即更新", () => { void startUpdate(); }, null, "cc-primary"),
    () => !updateStatus?.canApply || !updateStatus.available || updateStatus.phase !== "idle" || Boolean(updateStatus.pending));
  updateActions.append(updateHint, applyUpdateButton);
  const updateCommand = node("pre", null, "cc-update-command");
  const updateNotes = node("details", null, "cc-update-notes");
  const updateNotesBody = node("pre");
  updateNotes.append(node("summary", "更新内容"), updateNotesBody);
  updateSection.append(updateActions, updateCommand, updateNotes);
  const statusSection = section("状态");
  const statusRow = node("div", null, "cc-status");
  const statusText = node("p");
  const statusDetails = node("dl");
  const refresh = control(button("", () => { void refreshStatus(); }, "刷新状态", "cc-ghost"));
  refresh.innerHTML = ICONS.refresh;
  refresh.title = "刷新状态";
  statusRow.append(statusText, refresh);
  statusSection.append(statusRow, statusDetails);
  const message = node("p", null, "cc-settings-message");
  message.setAttribute("role", "status");
  message.setAttribute("aria-live", "polite");
  const retry = button("重试", () => { void load(); }, null, "cc-retry");
  retry.hidden = true;
  element.append(message, retry);

  function showMessage(text = "", error = false) {
    message.textContent = text;
    message.setAttribute("role", error ? "alert" : "status");
    retry.hidden = !error;
  }
  function setBusy(value) {
    if (value && !busy) {
      const focused = element.getRootNode().activeElement;
      busyFocus = element.contains(focused) ? focused : null;
    }
    busy = value;
    element.setAttribute("aria-busy", String(value));
    for (const item of controls) item.value.disabled = value || !config || item.disabled();
    retry.disabled = value;
    if (!value && reloadPending && !destroyed && !element.hidden) {
      reloadPending = false;
      Promise.resolve().then(load);
    }
    if (!value) {
      const focused = element.getRootNode().activeElement;
      // 禁用原生输入会让浏览器失焦；仅当用户未移到其他控件时恢复。
      if (!element.hidden && busyFocus?.isConnected && (!focused || focused === doc.body || focused === busyFocus)) {
        busyFocus.focus({ preventScroll: true });
      }
      busyFocus = null;
    }
  }
  function knownOrder() {
    return completeCardOrder(config.order, catalog, Object.keys(config.cards ?? {}));
  }
  // 只重排可见卡片，未知卡片保留原槽位，避免旧版本配置被打乱。
  function moveCardTo(id, target) {
    if (busy || !config || destroyed) return;
    const order = knownOrder();
    const visible = order.filter(key => rows.has(key));
    const from = visible.indexOf(id);
    if (from < 0 || target < 0 || target >= visible.length || target === from) return;
    visible.splice(from, 1);
    visible.splice(target, 0, id);
    let next = 0;
    void save({ order: order.map(key => rows.has(key) ? visible[next++] : key) });
  }
  let drag = null;
  function endDrag(commit) {
    if (!drag) return;
    const { id, row, list, rects, from, dy } = drag;
    const target = commit ? drag.target : from;
    drag = null;
    // 先无动画地落到新 DOM 位置，再让被拖行从松手处滑入槽位，避免等待保存时闪回原位。
    cardList.setAttribute("data-settling", "");
    if (target !== from) cardList.insertBefore(row.element, list[target + (target > from ? 1 : 0)]?.element ?? null);
    for (const item of list) item.element.style.transform = "";
    row.element.removeAttribute("data-dragging");
    cardList.removeAttribute("data-sorting");
    const residual = rects[from].top + dy - row.element.getBoundingClientRect().top;
    row.element.style.transform = `translateY(${residual}px)`;
    void row.element.offsetHeight;
    cardList.removeAttribute("data-settling");
    row.element.style.transform = "";
    if (target !== from) moveCardTo(id, target);
  }
  // 指针拖动只做视觉位移；松手后一次性保存，失败时由 renderConfig 还原顺序。
  function startDrag(id, event) {
    if (busy || !config || destroyed || drag || event.button !== 0) return;
    const row = rows.get(id);
    const list = [...rows.values()].sort((a, b) => a.index - b.index);
    const rects = list.map(item => item.element.getBoundingClientRect());
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag = { id, row, list, rects, from: row.index, target: row.index, startY: event.clientY, dy: 0 };
    row.element.setAttribute("data-dragging", "");
    cardList.setAttribute("data-sorting", "");
  }
  function moveDrag(event) {
    if (!drag) return;
    const { row, list, rects, from } = drag;
    const top = rects[0].top, bottom = rects.at(-1).bottom, own = rects[from];
    const dy = Math.max(top - own.top, Math.min(bottom - own.bottom, event.clientY - drag.startY));
    const center = own.top + own.height / 2 + dy;
    let target = from;
    while (target < list.length - 1 && center > rects[target + 1].top + rects[target + 1].height / 2) target++;
    while (target > 0 && center < rects[target - 1].top + rects[target - 1].height / 2) target--;
    drag.target = target;
    drag.dy = dy;
    row.element.style.transform = `translateY(${dy}px)`;
    for (const [index, item] of list.entries()) {
      if (item === row) continue;
      const shift = index > from && index <= target ? -own.height : index < from && index >= target ? own.height : 0;
      item.element.style.transform = shift ? `translateY(${shift}px)` : "";
    }
  }
  function renderConfig(resetPort = true) {
    activeConfirmation?.cancel(false);
    enabled.checked = config.enabled;
    if (config.enabled) cardList.removeAttribute("data-off");
    else cardList.setAttribute("data-off", "");
    for (const [value, input] of placements) input.checked = value === config.placement;
    proxyEnabled.checked = config.launch?.proxy?.enabled ?? false;
    // 显示方式、启动代理、自动加载都只作用于 Codex。
    const codexHost = host === "codex";
    placementSection.parentNode.hidden = !codexHost;
    proxySection.parentNode.hidden = !codexHost;
    autoSection.parentElement.hidden = menuReopen;
    autoRelaunchHint.textContent = `刚打开的 ${hostName()} 会自动重开一次以加载卡片`;
    for (const item of cardSections.values()) item.render();
    autoRelaunch.checked = config.agent?.autoRelaunch ?? true;
    autoUpdate.checked = config.updates?.auto !== false;
    if (resetPort) {
      portInput.value = String(config.launch?.proxy?.port ?? 7890);
      portError.hidden = true;
      portInput.removeAttribute("aria-invalid");
    }
    // 更新复用行节点，避免每次保存后丢失键盘焦点；catalog 标题只作为文本插入。
    endDrag(false);
    for (const [id, row] of rows) {
      if (catalog.some(card => card.id === id)) continue;
      row.element.remove();
      rows.delete(id);
      for (const input of row.controls) controls.splice(controls.findIndex(item => item.value === input), 1);
    }
    const order = knownOrder().filter(id => catalog.some(card => card.id === id));
    for (const [index, id] of order.entries()) {
      const card = catalog.find(item => item.id === id);
      let row = rows.get(id);
      if (!row) {
        const outer = node("div", null, "cc-settings-card");
        outer.dataset.cardSetting = id;
        const handle = control(button("", () => {}, null, "cc-handle"));
        handle.innerHTML = ICONS.grip;
        handle.title = "拖动调整顺序（也可用 ↑ ↓ 键）";
        listen(handle, "pointerdown", event => startDrag(id, event));
        listen(handle, "pointermove", moveDrag);
        listen(handle, "pointerup", () => endDrag(true));
        listen(handle, "pointercancel", () => endDrag(false));
        listen(handle, "keydown", event => {
          const delta = { ArrowUp: -1, ArrowDown: 1 }[event.key];
          if (!delta) return;
          event.preventDefault();
          moveCardTo(id, rows.get(id).index + delta);
        });
        outer.append(handle);
        const input = checkbox(outer, card.title, `card-${id}`, value => ({ cards: { [id]: { enabled: value } } }));
        row = { element: outer, input, handle, title: input.parentNode.children[0], controls: [handle, input] };
        rows.set(id, row);
      }
      row.index = index;
      row.input.checked = config.cards?.[id]?.enabled ?? card.defaultEnabled;
      row.title.textContent = card.title;
      row.handle.setAttribute("aria-label", `调整 ${card.title} 的顺序`);
      if (cardList.children[index] !== row.element) {
        const focused = element.getRootNode().activeElement;
        cardList.insertBefore(row.element, cardList.children[index] ?? null);
        if (!element.hidden && row.element.contains(focused)) focused.focus({ preventScroll: true });
      }
    }
    renderPlugins();
  }
  // 深层本机路径只保留最后两段，悬停 title 看完整来源，避免窄面板里折成多行。
  function compactOriginPath(from) {
    if (!from || (!from.startsWith("/") && !from.startsWith("~/"))) return from;
    const parts = from.split("/").filter(Boolean);
    if (parts.length <= 3) return from;
    return `…/${parts.slice(-2).join("/")}`;
  }
  function pluginOrigin(plugin = {}, { compact = false } = {}) {
    const raw = typeof plugin.from === "string" && plugin.from ? plugin.from : "";
    const from = compact ? compactOriginPath(raw) : raw;
    const text = plugin.kind === "link" ? `开发链接 → ${from}` : from ? `安装自 ${from}` : "手动放进卡片目录";
    return plugin.overridesBuiltin ? `${text} · 覆盖内置版本` : text;
  }
  // 行节点按 id 复用，保存其它设置后不丢焦点；来源与标题只作为文本插入。
  function renderPlugins() {
    const plugins = catalog.filter(card => card.source === "user");
    pluginSection.parentNode.hidden = plugins.length === 0;
    for (const [id, row] of pluginRows) {
      if (plugins.some(card => card.id === id)) continue;
      row.element.remove();
      pluginRows.delete(id);
      controls.splice(controls.findIndex(item => item.value === row.button), 1);
    }
    for (const [index, card] of plugins.entries()) {
      let row = pluginRows.get(card.id);
      if (!row) {
        const rowElement = node("div", null, "cc-settings-row cc-plugin-row");
        rowElement.dataset.plugin = card.id;
        const text = node("span");
        const name = node("span");
        const origin = node("small");
        text.append(name, origin);
        const action = control(button("", () => askRemoval(card.id)));
        rowElement.append(text, action);
        row = { element: rowElement, name, origin, button: action };
        pluginRows.set(card.id, row);
      }
      const restores = card.plugin?.overridesBuiltin === true;
      const fullOrigin = pluginOrigin(card.plugin);
      row.name.textContent = card.title;
      row.origin.textContent = pluginOrigin(card.plugin, { compact: true });
      row.origin.title = fullOrigin;
      row.button.textContent = restores ? "恢复内置版本" : "卸载";
      row.button.setAttribute("aria-label", `${restores ? "恢复内置版本" : "卸载"} ${card.title}`);
      if (restores) row.button.removeAttribute("data-danger");
      else row.button.setAttribute("data-danger", "");
      if (pluginList.children[index] !== row.element) pluginList.insertBefore(row.element, pluginList.children[index] ?? null);
    }
  }
  function askRemoval(id) {
    if (busy || !config || destroyed) return;
    const card = catalog.find(item => item.id === id && item.source === "user");
    if (!card) return;
    if (removalTarget) pluginRows.get(removalTarget.id)?.element.removeAttribute("data-confirming");
    removalTarget = card;
    const restores = card.plugin?.overridesBuiltin === true;
    const linked = card.plugin?.kind === "link";
    removalText.textContent = restores ? `删除你安装的「${card.title}」，恢复使用内置版本？`
      : linked ? `删除「${card.title}」的开发链接？源码目录不会被删除。`
        : `卸载「${card.title}」？会删除它的插件目录。`;
    confirmRemoval.textContent = restores ? "恢复内置版本" : linked ? "删除链接" : "卸载";
    if (restores) confirmRemoval.removeAttribute("data-danger");
    else confirmRemoval.setAttribute("data-danger", "");
    purgeInput.checked = false;
    pluginRows.get(card.id)?.element.setAttribute("data-confirming", "");
    removal.open(cancelRemoval);
  }
  // 卸载后重新读取设置；后台随即换上不含这张卡片的页面，抽屉与设置页保持打开。
  async function uninstall() {
    const card = removalTarget;
    if (!card || !removal.isOpen() || busy || !config || destroyed) return;
    const purgeData = purgeInput.checked;
    setBusy(true);
    showMessage(`正在卸载 ${card.title}…`);
    try {
      const result = await call("companion.cards.remove", { id: card.id, purgeData });
      if (destroyed) return;
      removal.cancel(false);
      await readSettings(result?.restoresBuiltin ? `已恢复内置的 ${card.title}` : `已卸载 ${card.title}`);
    } catch (error) {
      if (destroyed) return;
      showMessage(errorMessage(error), true);
      await recoverAfter(error);
    } finally { if (!destroyed) setBusy(false); }
  }
  function renderStatus(agent) {
    statusDetails.replaceChildren();
    menuReopen = agent?.reopen === "menu";
    autoSection.parentElement.hidden = menuReopen;
    if (agent?.available !== true) {
      statusText.textContent = "后台服务未运行";
      statusRow.dataset.state = "bad";
      return;
    }
    statusText.textContent = "后台服务运行中";
    statusRow.dataset.state = "ok";
    if (host === "antigravity") {
      const antigravity = agent.antigravity ?? {};
      const details = [
        ["版本", agent.version],
        ["Antigravity", antigravity.attached ? "已连接" : "未连接"],
        ["调试端口", antigravity.port],
        ["原生助手", agent.nativeHelper ? (agent.nativeHelper === "ok" ? "正常" : "缺失") : null],
        ["最近事件", antigravity.lastEvent ? `${antigravity.lastEvent.event} · ${new Date(antigravity.lastEvent.at).toLocaleTimeString()}` : null]
      ];
      for (const [label, value] of details) {
        if (value !== null && value !== undefined) statusDetails.append(node("dt", label), node("dd", String(value)));
      }
      return;
    }
    const codex = agent.codex ?? {};
    const details = [
      ["版本", agent.version],
      ["Codex", codex.attached ? "已连接" : codex.running ? "等待连接" : "未运行"],
      ["调试端口", codex.port],
      ["代理端口", codex.proxyPort],
      ["原生助手", menuReopen ? null : agent.nativeHelper === "ok" ? "正常" : "缺失"],
      ["最近事件", agent.lastEvent ? `${agent.lastEvent.event} · ${new Date(agent.lastEvent.at).toLocaleTimeString()}` : "无"]
    ];
    for (const [label, value] of details) {
      if (value === null || value === undefined) continue;
      statusDetails.append(node("dt", label), node("dd", String(value)));
    }
  }
  const UPDATE_BUSY = ["checking", "updating", "waiting-restart", "restarting"];
  // 有新版本、正在更新或刚更新完时，「更新」整组提到面板最上面并换成强调色；平时留在「状态」上方。
  // 移动节点会让组内按钮失焦（比如点「检查更新」后整组上移），移完把焦点还回去。
  function placeUpdate(attention) {
    const fieldset = updateSection.parentNode;
    if (attention) fieldset.dataset.attention = attention; else delete fieldset.dataset.attention;
    const anchor = attention ? general.parentNode : statusSection.parentNode;
    if (fieldset.nextSibling === anchor) return;
    const focused = element.getRootNode?.().activeElement;
    const refocus = focused && fieldset.contains(focused) ? focused : null;
    element.insertBefore(fieldset, anchor);
    refocus?.focus({ preventScroll: true });
  }
  function renderUpdate(status) {
    updateStatus = status && status.supported !== false && typeof status.current === "string" ? status : null;
    updateSection.parentElement.hidden = !updateStatus;
    onUpdateStatus(updateStatus);
    if (!updateStatus) { placeUpdate(""); return; }
    const { current, latest, notice, pending, phase, error, canApply, available, command, releasesUrl, lastCheckAt } = updateStatus;
    const installing = Boolean(pending) || (phase !== "checking" && UPDATE_BUSY.includes(phase));
    placeUpdate(notice ? "updated" : available || installing ? "new" : "");
    let text = `已是最新版本 ${current}`;
    let state = "ok";
    if (notice) text = `已更新到 ${notice.to}`;
    else if (phase === "restarting") { text = "正在重启后台服务…"; state = "new"; }
    else if (pending) { text = `${pending.version} 已装好，卡片里的视频播放结束后自动生效`; state = "new"; }
    else if (phase === "updating") { text = `正在更新到 ${latest?.version ?? "新版本"}…`; state = "new"; }
    else if (phase === "checking") { text = "正在检查更新…"; state = ""; }
    else if (available) { text = `发现新版本 ${latest.version}`; state = "new"; }
    else if (error) { text = error.message; state = "bad"; }
    else if (!lastCheckAt) { text = `当前版本 ${current}`; state = ""; }
    if (error && (available || notice)) text += `（${error.message}）`;
    updateText.textContent = text;
    if (state) updateRow.dataset.state = state; else delete updateRow.dataset.state;
    autoUpdate.parentNode.hidden = !canApply;
    autoUpdate.checked = config?.updates?.auto !== false;
    const checked = lastCheckAt ? `上次检查 ${new Date(lastCheckAt).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : "";
    const showApply = canApply && available && phase === "idle" && !pending;
    applyUpdateButton.hidden = !showApply;
    updateHint.textContent = [canApply ? "通过 Homebrew 更新" : available ? "这种安装方式需要手动更新" : "", checked].filter(Boolean).join(" · ");
    updateActions.hidden = !updateHint.textContent && !showApply;
    const manual = !canApply && available ? (command ? `在终端执行：\n${command}` : `到 Release 页面下载：\n${releasesUrl}`) : "";
    updateCommand.textContent = manual;
    updateCommand.hidden = !manual;
    const notes = (notice?.notes || (available ? latest?.notes : "") || "").trim();
    updateNotesBody.textContent = notes;
    updateNotes.hidden = !notes;
    if (notice && notes) updateNotes.open = true;
    for (const item of controls) item.value.disabled = busy || !config || item.disabled();
    // 正在检查、升级或等待重启时轮询，直到状态落定；后台重启后整个面板会随新注入重建。
    clearTimeout(updatePoll);
    updatePoll = UPDATE_BUSY.includes(phase) || pending ? setTimeout(() => { void pollUpdate(); }, 3000) : null;
  }
  async function pollUpdate() {
    updatePoll = null;
    if (destroyed || element.hidden) return;
    try { renderUpdate(await call("companion.update.status", {})); } catch {
      if (!destroyed && !element.hidden) updatePoll = setTimeout(() => { void pollUpdate(); }, 3000);
    }
  }
  async function checkForUpdates() {
    if (busy || destroyed) return;
    setBusy(true);
    showMessage("正在检查更新…");
    try {
      const status = await call("companion.update.check", {});
      if (destroyed) return;
      renderUpdate(status);
      showMessage(status.error ? "" : status.available ? `发现新版本 ${status.latest.version}` : "已是最新版本");
    } catch (error) { if (!destroyed) showMessage(errorMessage(error), true); }
    finally { if (!destroyed) setBusy(false); }
  }
  async function startUpdate() {
    if (busy || destroyed || !updateStatus?.canApply) return;
    setBusy(true);
    try {
      const status = await call("companion.update.apply", {});
      if (destroyed) return;
      renderUpdate(status);
      showMessage("正在后台更新，完成后自动重启后台服务");
    } catch (error) { if (!destroyed) showMessage(errorMessage(error), true); }
    finally { if (!destroyed) setBusy(false); }
  }
  function acceptConfig(value) {
    if (!Number.isSafeInteger(value?.revision) || value.revision < 0) throw new Error("设置响应缺少有效版本，请重试");
    config = value;
  }
  function errorMessage(error) {
    if (connection?.isConnected() === false && NO_REPLY_CODES.has(error?.code)) return DISCONNECTED_MESSAGE;
    if (error?.code === "BRIDGE_UNAVAILABLE") return "后台连接不可用，请重试";
    if (["RPC_TIMEOUT", "TIMEOUT"].includes(error?.code)) return "请求超时，请重试";
    return error?.message || "请求失败，请重试";
  }
  async function readSettings(notice = "") {
    const [settings, status, update] = await Promise.allSettled([
      call("companion.settings.get", {}), call("companion.agent.status", {}), call("companion.update.status", {})
    ]);
    if (destroyed) return;
    if (settings.status === "fulfilled") {
      acceptConfig(settings.value.config);
      catalog = settings.value.catalog;
      host = settings.value.host === "antigravity" ? "antigravity" : "codex";
      renderConfig();
    } else config = null;
    renderUpdate(update.status === "fulfilled" ? update.value : null);
    // 打开设置即算看过「已更新」提示；本次面板里仍然显示，下次不再标红点。
    if (updateStatus?.notice) void call("companion.update.acknowledge", {}).then(next => { if (!destroyed) onUpdateStatus(next); }, () => {});
    if (status.status === "fulfilled") renderStatus(status.value);
    else { statusText.textContent = "状态读取失败"; statusRow.dataset.state = "bad"; statusDetails.replaceChildren(); }
    if (settings.status === "rejected") throw settings.reason;
    if (status.status === "rejected") {
      showMessage([notice, errorMessage(status.reason)].filter(Boolean).join("；"), true);
      return;
    }
    showMessage(notice);
  }
  // 请求没有回音时先确认链路：后台已经恢复（请求是在断开期间发出、丢在了旧连接上）就自动再读一次；
  // 仍然断开就提示正在恢复，等连接恢复事件再读。自动重读只做一次，读成功后才重置，避免慢服务下反复重试。
  async function recoverAfter(error) {
    if (!connection || !NO_REPLY_CODES.has(error?.code)) return;
    const alive = await connection.check();
    if (destroyed || element.hidden) return;
    if (!alive) { showMessage(DISCONNECTED_MESSAGE, true); return; }
    if (autoReloaded) return;
    autoReloaded = true;
    reloadPending = true;
  }
  async function load(notice = "") {
    if (busy || destroyed) return;
    setBusy(true);
    showMessage("正在读取…");
    try {
      await readSettings(typeof notice === "string" ? notice : "");
      autoReloaded = false;
    } catch (error) {
      if (destroyed) return;
      showMessage(errorMessage(error), true);
      await recoverAfter(error);
    } finally { if (!destroyed) setBusy(false); }
  }
  async function refreshStatus() {
    if (busy || destroyed) return;
    setBusy(true);
    showMessage("正在读取…");
    try {
      const status = await call("companion.agent.status", {});
      if (!destroyed) { renderStatus(status); showMessage(); }
    } catch (error) {
      if (!destroyed) {
        statusText.textContent = "状态读取失败";
        statusRow.dataset.state = "bad";
        statusDetails.replaceChildren();
        showMessage(errorMessage(error), true);
      }
    } finally { if (!destroyed) setBusy(false); }
  }
  async function save(patch) {
    if (busy || !config || destroyed) return;
    activeConfirmation?.cancel(false);
    setBusy(true);
    showMessage("正在保存…");
    try {
      const result = await call("companion.settings.patch", { expectedRevision: config.revision, patch });
      if (destroyed) return;
      acceptConfig(result.config);
      renderConfig(patch.launch?.proxy?.port !== undefined);
      showMessage("已保存");
    } catch (error) {
      if (destroyed) return;
      if (error?.code === "CONFIG_CONFLICT") {
        config = null;
        try { await readSettings("配置已在别处修改，已刷新"); }
        catch (refreshError) { if (!destroyed) showMessage(errorMessage(refreshError), true); }
      } else {
        renderConfig(false);
        // 超时可能已写成功；重试先读取，不重放修改。
        config = null;
        showMessage(errorMessage(error), true);
        await recoverAfter(error);
      }
    } finally { if (!destroyed) setBusy(false); }
  }
  function cancelConfirmation() {
    confirming = false;
    confirmation.hidden = true;
    if (!element.hidden && !destroyed) restartButton.focus();
  }
  async function restart() {
    if (!confirming || busy || !config || destroyed) return;
    setBusy(true);
    showMessage("正在请求重启…");
    try {
      const result = await call("companion.codex.restart", { reason: "settings" });
      if (destroyed) return;
      if (!result.accepted) throw new Error(`无法重启 Codex：${RESTART_REFUSALS[result.reason] ?? "请求未接受"}`);
      showMessage("已请求重启 Codex");
    } catch (error) { if (!destroyed) showMessage(errorMessage(error), true); }
    finally {
      if (!destroyed) {
        setBusy(false);
        cancelConfirmation();
      }
    }
  }
  function close() {
    if (destroyed || element.hidden) return;
    element.hidden = true;
    clearTimeout(updatePoll);
    updatePoll = null;
    activeConfirmation?.cancel(false);
    confirming = false;
    confirmation.hidden = true;
    onClose();
  }
  listen(element, "keydown", event => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    if (drag) endDrag(false);
    else if (activeConfirmation && !busy) activeConfirmation.cancel();
    else if (confirming && !busy) cancelConfirmation();
    else close();
  });
  if (connection) {
    const unsubscribe = connection.subscribe((connected) => {
      if (destroyed || element.hidden) return;
      if (!connected) {
        if (!busy) showMessage(DISCONNECTED_MESSAGE, true);
        return;
      }
      if (busy) reloadPending = true;
      else void load();
    });
    listeners.push(unsubscribe);
  }
  setBusy(false);
  return {
    element,
    // notice：打开后显示的提示，例如页面因卸载插件重建后接着显示「已卸载 …」。
    open({ notice = "" } = {}) {
      if (destroyed || !element.hidden) return;
      element.hidden = false;
      closeButton.focus({ preventScroll: true });
      return load(notice);
    },
    close,
    addCard,
    // 当前的提示文字（错误与进行中的提示不算），页面重建时带给新面板。
    notice: () => (busy || message.getAttribute("role") !== "status" ? "" : message.textContent),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(updatePoll);
      for (const cleanup of listeners) cleanup();
      element.remove();
    }
  };
}
