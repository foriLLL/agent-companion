import { createSettingsPanel } from "./settings-panel.mjs";

// 外框属于平台；业务只能在内层 ShadowRoot 内渲染。
export function createCardShell({ document: doc = document, hostId = "agent-companion-root" } = {}) {
  const host = doc.createElement("div");
  host.id = hostId;
  host.setAttribute("aria-label", "Companion 卡片");
  host.style.cssText = "display:block;width:100%;min-width:0;flex:none;color-scheme:light dark;pointer-events:auto";
  const root = host.attachShadow({ mode: "open" });
  const style = doc.createElement("style");
  style.textContent = `
    :host { font-family:var(--cc-card-font,var(--hg-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif));
      -webkit-font-smoothing:antialiased;letter-spacing:-.006em; }
    .shell { display:block;min-width:0; }
    .stack { display:flex;flex-direction:column;gap:var(--cc-card-gap,24px);min-width:0;reading-flow:flex-visual; }
    .slot { display:block;flex:none;min-width:0;width:100%;box-sizing:border-box;
      border:0;border-radius:var(--cc-card-radius,var(--hg-panel-radius,20px));
      background:var(--cc-card-surface,var(--hg-card-bg,var(--cc-card-bg,Canvas)));color:var(--cc-card-fg,CanvasText);
      box-shadow:var(--cc-card-shadow,var(--hg-panel-shadow,var(--elevation-prominent,0 0 0 .5px rgba(26,28,31,.117),0 3px 7.5px #0000000a,0 0 20px #0000000d)));
      overflow:clip;contain:layout style; }
    .slot[hidden] { display:none; }
    .content { display:block;min-width:0; }
    .error { padding:24px 16px;min-height:140px;box-sizing:border-box; }
    .error[hidden],.content[hidden] { display:none; }
    .error p { font-size:12.5px;line-height:1.6;overflow-wrap:anywhere;color:var(--cc-card-fg-muted,inherit); }
    .error button { font:inherit;font-size:12px;font-weight:500;cursor:pointer;padding:6px 12px;
      border:1px solid var(--cc-card-border,color-mix(in srgb,currentColor 14%,transparent));
      border-radius:8px;background:transparent;color:inherit; }
    .error button:hover { background:var(--cc-card-hover,color-mix(in srgb,currentColor 7%,transparent)); }
    .platform-bar { display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-bottom:8px;
      min-width:0;color:var(--cc-card-fg,CanvasText); }
    .platform-bar[hidden], .platform-bar [hidden] { display:none; }
    .platform-bar .brand { display:none;align-items:center;gap:6px;margin-right:auto;min-width:0;
      font-size:12px;font-weight:600;color:var(--cc-card-fg,CanvasText); }
    .platform-bar .brand svg { flex:none;width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.2;
      stroke-linecap:round;stroke-linejoin:round;opacity:.75; }
    .platform-bar p { margin:0 auto 0 0;font-size:12px;color:var(--cc-card-fg-muted,currentColor); }
    .settings-entry { position:relative;display:flex;align-items:center;justify-content:center;gap:4px;height:26px;padding:0 6px 0 8px;
      border:0;border-radius:8px;cursor:pointer;background:transparent;font:inherit;font-size:11.5px;line-height:1;white-space:nowrap;
      color:var(--cc-card-fg-muted,var(--hg-header-color,var(--color-token-text-tertiary,color-mix(in srgb,currentColor 50%,transparent))));
      transition:background-color .14s,color .14s; }
    .settings-entry:hover, .settings-entry[aria-expanded="true"] {
      background:var(--cc-card-hover,var(--color-token-list-hover-background,color-mix(in srgb,currentColor 7%,transparent)));
      color:var(--cc-card-fg,var(--color-token-text-primary,currentColor)); }
    .settings-entry:focus-visible { outline:2px solid var(--cc-card-focus,var(--color-token-focus-border,#3a83f7));outline-offset:2px; }
    .settings-entry[data-update]::after { content:"";position:absolute;top:4px;right:3px;width:6px;height:6px;border-radius:50%;
      background:#e5484d;box-shadow:0 0 0 1.5px var(--cc-card-bg,Canvas); }
    .settings-entry svg { flex:none;width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.15;stroke-linecap:round; }
    /* 统一面板模式（如 Antigravity）：所有启用卡片收拢进一张细边大面板，由各区块自身 border-top 分隔，
       与 CSS order / DOM 顺序解耦，且空态或仅开设置页时底边不叠双线。 */
    :host([data-surface="unified"]) .shell {
      border-radius:var(--cc-card-radius,var(--hg-panel-radius,14px));
      background:var(--cc-card-surface,var(--cc-card-bg,Canvas));
      color:var(--cc-card-fg,CanvasText);
      box-shadow:var(--cc-card-shadow,0 0 0 1px var(--cc-card-border,rgba(17,24,39,.09)));
      overflow:clip;
    }
    :host([data-surface="unified"]) .shell:not(:has(> .platform-bar:not([hidden]), > #companion-settings:not([hidden]), > .stack > .slot:not([hidden]))) {
      background:transparent;box-shadow:none;
    }
    :host([data-surface="unified"]) .platform-bar {
      margin:0;padding:7px 8px 7px 12px;
      background:color-mix(in srgb,var(--cc-card-fg,currentColor) 2.5%,transparent);
    }
    :host([data-surface="unified"]) .platform-bar .brand { display:inline-flex; }
    :host([data-surface="unified"]) .platform-bar p { margin:0;font-size:11.5px; }
    :host([data-surface="unified"]) .settings-entry { width:24px;height:24px;padding:0;border-radius:6px; }
    :host([data-surface="unified"]) .settings-entry span { display:none; }
    :host([data-surface="unified"]) .stack { gap:0; }
    :host([data-surface="unified"]) .platform-bar[hidden] + .stack,
    :host([data-surface="unified"]) .platform-bar[hidden] + #companion-settings[hidden] + .stack { margin-top:-1px; }
    :host([data-surface="unified"]) .slot {
      border-radius:0;background:transparent;box-shadow:none;
      border-top:1px solid var(--cc-card-border,rgba(17,24,39,.09));
    }
    :host([data-surface="unified"]) #companion-settings {
      margin:0;border-radius:0;box-shadow:none;background:transparent;
      border-top:1px solid var(--cc-card-border,rgba(17,24,39,.09));
    }
    :host([data-surface="unified"]) .platform-bar[hidden] ~ #companion-settings { border-top:0; }
  `;
  const shell = doc.createElement("div");
  shell.className = "shell";
  const platformBar = doc.createElement("div");
  platformBar.className = "platform-bar";
  platformBar.hidden = true;
  const brand = doc.createElement("span");
  brand.className = "brand";
  brand.setAttribute("aria-hidden", "true");
  brand.innerHTML = '<svg viewBox="0 0 16 16"><rect x="2.25" y="2.25" width="4.75" height="4.75" rx="1.4"/><rect x="2.25" y="9" width="4.75" height="4.75" rx="1.4"/><rect x="9" y="9" width="4.75" height="4.75" rx="1.4"/><path d="M11.4 1.9c.2 1.55.8 2.15 2.35 2.35-1.55.2-2.15.8-2.35 2.35-.2-1.55-.8-2.15-2.35-2.35 1.55-.2 2.15-.8 2.35-2.35Z"/></svg><span>Companion</span>';
  const empty = doc.createElement("p");
  empty.hidden = true;
  const settingsButton = doc.createElement("button");
  settingsButton.className = "settings-entry";
  settingsButton.type = "button";
  settingsButton.setAttribute("aria-label", "Companion 设置");
  settingsButton.setAttribute("aria-expanded", "false");
  settingsButton.setAttribute("aria-controls", "companion-settings");
  settingsButton.title = "Companion 设置";
  settingsButton.innerHTML = '<span>卡片配置</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 5h5.25m3.5 0h2.25M2.5 11h2.25m3.5 0h5.25"/><circle cx="9.5" cy="5" r="1.75"/><circle cx="6.5" cy="11" r="1.75"/></svg>';
  platformBar.append(brand, empty, settingsButton);
  const stack = doc.createElement("div");
  stack.className = "stack";
  shell.append(platformBar, stack);
  root.append(style, shell);
  const slots = new Map();
  let settings;
  let updateTimer = null;
  let stopUpdateRefresh = () => {};
  const win = doc.defaultView ?? globalThis;
  // 有新版本要手动处理，或刚自动更新完还没看过说明时，在「卡片配置」上标红点。
  function markUpdate(status) {
    const manual = status?.available && (!status.canApply || !status.auto || status.error) && !status.pending;
    const kind = status?.notice ? "updated" : manual ? "available" : "";
    if (kind) settingsButton.dataset.update = kind; else delete settingsButton.dataset.update;
    settingsButton.title = kind === "updated" ? `Companion 已更新到 ${status.notice.to}` : kind === "available"
      ? `Companion 有新版本 ${status.latest.version}` : "Companion 设置";
  }
  const toggleSettings = () => {
    if (!settings) return;
    if (!settings.element.hidden) settings.close();
    else {
      settingsButton.setAttribute("aria-expanded", "true");
      void settings.open();
    }
  };
  settingsButton.addEventListener("click", toggleSettings);

  function add(manifest, retry) {
    const outer = doc.createElement("section");
    outer.className = "slot";
    outer.dataset.card = manifest.id;
    outer.setAttribute("aria-label", manifest.title);
    const content = doc.createElement("div");
    content.className = "content";
    content.style.minHeight = `${manifest.layout.minHeight}px`;
    content.style.overflowY = manifest.layout.scroll === "inner" ? "auto" : "visible";
    if (manifest.layout.height === "viewport") {
      content.style.height = "var(--cc-card-height, min(640px, 70vh))";
    }
    const cardRoot = content.attachShadow({ mode: "open" });
    const errorBox = doc.createElement("div");
    errorBox.className = "error";
    errorBox.hidden = true;
    errorBox.setAttribute("role", "alert");
    const title = doc.createElement("strong");
    title.textContent = `${manifest.title} 暂时不可用`;
    const message = doc.createElement("p");
    const button = doc.createElement("button");
    button.type = "button";
    button.textContent = "重试";
    button.addEventListener("click", retry);
    errorBox.append(title, message, button);
    outer.append(content, errorBox);
    stack.append(outer);
    const slot = {
      outer, root: cardRoot,
      showError(error) {
        content.hidden = true;
        errorBox.hidden = false;
        message.textContent = error?.message || "卡片加载失败，请重试";
      },
      clearError() { content.hidden = false; errorBox.hidden = true; },
      remove() { button.removeEventListener("click", retry); outer.remove(); slots.delete(manifest.id); }
    };
    slots.set(manifest.id, slot);
    return slot;
  }

  function reorder(order) {
    // moveBefore 在保留 iframe/视频状态的同时同步辅助技术阅读顺序。
    // 旧 Chromium 使用视觉顺序兜底，不采用会重置 iframe 的 appendChild。
    let anchor = null;
    for (let index = order.length - 1; index >= 0; index--) {
      const slot = slots.get(order[index]);
      if (!slot) continue;
      slot.outer.style.order = String(index);
      if (typeof stack.moveBefore === "function" && slot.outer.nextSibling !== anchor) {
        try { stack.moveBefore(slot.outer, anchor); } catch { /* 断开状态采用 CSS 顺序。 */ }
      }
      anchor = slot.outer;
    }
  }

  return {
    host, root, add, reorder,
    configureSettings({ call, connection, cardSettings }) {
      if (settings) return;
      settings = createSettingsPanel({ document: doc, call, connection, cardSettings, onUpdateStatus: markUpdate, onClose() {
        settingsButton.setAttribute("aria-expanded", "false");
        settingsButton.focus({ preventScroll: true });
      } });
      // 更新状态只读后台本地记录，不访问网络。后台每 6 小时检查一次，结果不会推给页面：
      // 红点在挂载时、每 5 分钟、Codex 窗口回到前台时各同步一次，后台刚发现新版本也能很快标上。
      const refreshUpdate = () => {
        if (!settings || !settings.element.hidden) return;
        Promise.resolve().then(() => call("companion.update.status", {})).then(markUpdate, () => {});
      };
      const refreshVisible = () => { if (doc.visibilityState !== "hidden") refreshUpdate(); };
      refreshUpdate();
      updateTimer = win.setInterval(refreshUpdate, 5 * 60_000);
      updateTimer?.unref?.();
      win.addEventListener?.("focus", refreshVisible);
      doc.addEventListener?.("visibilitychange", refreshVisible);
      stopUpdateRefresh = () => {
        win.clearInterval(updateTimer);
        win.removeEventListener?.("focus", refreshVisible);
        doc.removeEventListener?.("visibilitychange", refreshVisible);
      };
      settings.element.id = "companion-settings";
      shell.insertBefore(settings.element, stack);
      platformBar.hidden = false;
    },
    // 后送来的卡片带着自己的设置时，在设置面板里补上它那一节。
    addCardSettings(entry) { settings?.addCard(entry); },
    setEmptyState({ enabled, count }) {
      empty.hidden = count > 0;
      empty.textContent = enabled ? "暂无启用的卡片" : "卡片已关闭";
    },
    isSettingsOpen: () => Boolean(settings && !settings.element.hidden),
    // 页面整体重新注入（例如卸载插件后卡片目录变化）时，新外框接着打开设置并显示原来的提示。
    settingsState: () => (settings && !settings.element.hidden ? { open: true, notice: settings.notice?.() ?? "" } : null),
    openSettings(notice = "") {
      if (!settings || !settings.element.hidden) return;
      settingsButton.setAttribute("aria-expanded", "true");
      void settings.open({ notice });
    },
    get: (id) => slots.get(id),
    diagnostics: () => ({ count: slots.size, ids: [...slots.keys()] }),
    dispose() {
      settingsButton.removeEventListener("click", toggleSettings);
      stopUpdateRefresh();
      settings?.destroy();
      for (const slot of [...slots.values()]) slot.remove();
      host.remove();
    }
  };
}
