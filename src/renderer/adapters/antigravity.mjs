/**
 * Antigravity 布局适配器：卡片区做成和原生 Overview 一样的标题栏弹层。
 *
 * 入口按稳定程度分两级：
 * 1. 会话页标题栏里 Overview 开关（`data-testid="toggle-overview-panel"`）左侧插一个同款按钮，样式抄它的 class；
 * 2. 找不到 Overview 开关（首页、新建会话、Antigravity 改版）时，右下角显示自有的悬浮按钮。
 * 两级都能用 ⌥⌘J 开关。原生节点只在它旁边插入自己的按钮，不改原生节点的属性和样式。
 */
export function createAntigravityAdapter({ host, placement = "standalone-button", onVisibilityChange, onError, hasCards = true, hasSettings = false } = {}) {
  if (!host?.shadowRoot) throw new TypeError("Antigravity adapter requires a host with an open ShadowRoot");
  // 常量放在函数内：冒烟测试用 toString 注入函数本体。
  const RAIL_ID = "agent-companion-rail";
  const ENTRY_MARK = "data-agent-companion-entry";
  const OVERVIEW_SELECTOR = '[data-testid="toggle-overview-panel"]';
  const PANEL_WIDTH = 380;
  // 标题栏按钮正常态与选中态的 class（Antigravity 的 HeaderButtonIcon：选中时换成 secondary 底色）。
  const NORMAL_CLASSES = ["bg-transparent", "text-secondary-foreground"];
  const SELECTED_CLASSES = ["bg-secondary", "text-foreground"];
  const ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<rect x="3.5" y="4" width="4.5" height="12" rx="1.2"/><rect x="9.75" y="4" width="4.5" height="16" rx="1.2"/><rect x="16" y="4" width="4.5" height="8" rx="1.2"/></svg>';
  const document = host.ownerDocument;
  const window = document.defaultView;
  const { MutationObserver } = window;
  const reportError = (error) => { try { onError?.(error); } catch {} };
  let disposed = false;
  let open = false;
  let anchor = null;
  let frame = 0;
  let lastVisibility = null;
  const hostStyles = new Map();

  const notifyVisibility = (visible, reason) => {
    if (lastVisibility?.visible === visible && lastVisibility?.reason === reason) return;
    lastVisibility = { visible, reason, placement };
    try { onVisibilityChange?.({ ...lastVisibility }); } catch (error) { reportError(error); }
  };

  // ---------- 弹层 ----------
  const rail = document.createElement("div");
  rail.id = RAIL_ID;
  rail.hidden = true;
  rail.setAttribute("role", "dialog");
  rail.setAttribute("aria-label", "Agent Companion");
  rail.style.cssText = [
    "position:fixed", "z-index:2147483646", "top:48px", "right:12px", "box-sizing:border-box",
    `width:min(${PANEL_WIDTH}px, calc(100vw - 16px))`, "max-height:calc(100vh - 64px)", "overflow:auto",
    "overscroll-behavior:contain", "border-radius:var(--hg-panel-radius, 14px)",
    "background:var(--hg-panel-bg, #fff)", "color:var(--hg-panel-color, #1f1f1f)",
    "box-shadow:var(--hg-panel-shadow)", "-webkit-app-region:no-drag"
  ].join(";");
  rail.append(host);
  document.documentElement.append(rail);

  // ---------- 悬浮入口（找不到标题栏锚点时） ----------
  const floating = document.createElement("div");
  floating.id = "agent-companion-entry";
  floating.hidden = true;
  floating.style.cssText = "position:fixed;z-index:2147483645;right:20px;bottom:20px;-webkit-app-region:no-drag";
  const floatingRoot = floating.attachShadow({ mode: "open" });
  floatingRoot.innerHTML = `<style>
    button{all:unset;box-sizing:border-box;width:40px;height:40px;border-radius:12px;display:grid;place-items:center;cursor:pointer;
      background:var(--hg-panel-bg,#fff);color:var(--hg-panel-color,#1f1f1f);box-shadow:var(--hg-panel-shadow)}
    button:hover{filter:brightness(.96)} button[aria-expanded=true]{outline:2px solid color-mix(in srgb,currentColor 30%,transparent)}
  </style><button type="button" aria-label="Agent Companion" title="Agent Companion  ⌥⌘J" aria-expanded="false">${ICON}</button>`;
  const floatingButton = floatingRoot.querySelector("button");
  document.documentElement.append(floating);

  // ---------- 主题：读 Antigravity 的设计变量 ----------
  const setHostVariable = (name, value) => {
    if (!value || host.style.getPropertyValue(name) === value) return;
    if (!hostStyles.has(name)) hostStyles.set(name, { value: host.style.getPropertyValue(name), priority: host.style.getPropertyPriority(name) });
    host.style.setProperty(name, value);
  };
  const syncStyles = () => {
    const root = window.getComputedStyle(document.documentElement);
    const token = (name) => root.getPropertyValue(name).trim();
    const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches
      || document.documentElement.classList.contains("dark");
    const bg = token("--card") || token("--background") || (dark ? "#1e1f22" : "#fff");
    const fg = token("--foreground") || (dark ? "#e8e8ea" : "#1f1f1f");
    const border = token("--border") || (dark ? "rgba(255,255,255,.12)" : "rgba(0,0,0,.1)");
    setHostVariable("--hg-panel-bg", bg);
    setHostVariable("--hg-panel-color", fg);
    setHostVariable("--hg-panel-radius", "14px");
    setHostVariable("--hg-panel-shadow", `0 0 0 1px ${border}, 0 8px 28px rgba(0,0,0,.12), 0 2px 6px rgba(0,0,0,.06)`);
    setHostVariable("--hg-header-bg", bg);
    setHostVariable("--hg-header-color", token("--muted-foreground") || (dark ? "#9aa0a6" : "#80868b"));
    setHostVariable("--hg-divider", border);
    setHostVariable("--hg-font-family", window.getComputedStyle(document.body).fontFamily || "system-ui, -apple-system, sans-serif");
    setHostVariable("--hg-font-weight", "400");
    setHostVariable("--cc-card-bg", bg);
    setHostVariable("--cc-card-fg", fg);
    setHostVariable("--cc-card-border", border);
    // 弹层自己的外观也跟着变（它在 host 外面，读不到 host 上的变量）。
    for (const name of ["--hg-panel-bg", "--hg-panel-color", "--hg-panel-radius", "--hg-panel-shadow"]) {
      rail.style.setProperty(name, host.style.getPropertyValue(name));
      floating.style.setProperty(name, host.style.getPropertyValue(name));
    }
  };

  // ---------- 标题栏入口 ----------
  const entries = () => [...document.querySelectorAll(`[${ENTRY_MARK}]`)];
  const setEntriesExpanded = () => {
    for (const button of entries()) {
      button.classList.remove(...(open ? NORMAL_CLASSES : SELECTED_CLASSES));
      button.classList.add(...(open ? SELECTED_CLASSES : NORMAL_CLASSES));
      button.setAttribute("aria-expanded", String(open));
    }
    floatingButton.setAttribute("aria-expanded", String(open));
  };
  const makeEntry = (overview) => {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute(ENTRY_MARK, "");
    button.setAttribute("aria-label", "Agent Companion");
    button.title = "Agent Companion  ⌥⌘J";
    // 尺寸、圆角、悬停色都来自原生按钮；它若正处于选中态，换回普通态的两个 class。
    button.className = overview.className;
    button.classList.remove(...SELECTED_CLASSES);
    button.classList.add(...NORMAL_CLASSES);
    button.style.cssText = "-webkit-app-region:no-drag";
    button.innerHTML = ICON;
    button.addEventListener("click", onEntryClick);
    return button;
  };
  const ensureEntries = () => {
    // Overview 开关被 React 移除时，插在它旁边的入口不会跟着消失，要自己清。
    for (const entry of entries()) {
      if (!entry.nextElementSibling?.matches?.(OVERVIEW_SELECTOR)) entry.remove();
    }
    for (const overview of document.querySelectorAll(OVERVIEW_SELECTOR)) {
      if (overview.previousElementSibling?.hasAttribute?.(ENTRY_MARK)) continue;
      overview.before(makeEntry(overview));
    }
    const anchored = entries().length > 0;
    floating.hidden = disposed || anchored || !(hasCards || hasSettings);
    if (anchor && !anchor.isConnected) anchor = null;
    setEntriesExpanded();
  };

  const position = () => {
    if (rail.hidden) return;
    const target = anchor?.isConnected ? anchor : entries()[0] ?? null;
    const width = Math.min(PANEL_WIDTH, window.innerWidth - 16);
    if (target) {
      const rect = target.getBoundingClientRect();
      rail.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`;
      rail.style.right = "auto";
      rail.style.top = `${Math.round(rect.bottom + 6)}px`;
      rail.style.bottom = "auto";
      rail.style.maxHeight = `calc(100vh - ${Math.round(rect.bottom + 18)}px)`;
    } else {
      rail.style.left = "auto";
      rail.style.right = "20px";
      rail.style.top = "auto";
      rail.style.bottom = "72px";
      rail.style.maxHeight = "calc(100vh - 96px)";
    }
  };

  const render = () => {
    if (disposed) return;
    const available = hasCards || hasSettings;
    const visible = open && available;
    rail.hidden = !visible;
    if (visible) { syncStyles(); position(); }
    setEntriesExpanded();
    notifyVisibility(visible, visible ? "popover" : available ? "closed" : "no-cards");
  };
  const setOpen = (value, source = null) => {
    if (disposed) return;
    if (source) anchor = source;
    open = Boolean(value);
    render();
  };

  function onEntryClick(event) {
    event.preventDefault();
    event.stopPropagation();
    setOpen(!open, event.currentTarget === floatingButton ? null : event.currentTarget);
  }
  floatingButton.addEventListener("click", onEntryClick);

  // 点弹层外关闭（和原生 Overview 一致）；点自己的入口、卡片浮层、提醒层不算。
  const ownsEvent = (event) => event.composedPath().some((node) => node === rail || node === floating
    || node?.hasAttribute?.(ENTRY_MARK) || (typeof node?.id === "string" && node.id.startsWith("agent-companion")));
  const onPointerDown = (event) => {
    if (!open || ownsEvent(event)) return;
    setOpen(false);
  };
  const onKeyDown = (event) => {
    if (event.code === "KeyJ" && event.metaKey && event.altKey && !event.shiftKey && !event.ctrlKey) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(!open);
    } else if (event.key === "Escape" && open && !document.fullscreenElement) {
      setOpen(false);
    }
  };
  const schedule = () => {
    if (frame || disposed) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      try { ensureEntries(); position(); } catch (error) { reportError(error); }
    });
  };
  const onThemeChange = () => { if (!rail.hidden) syncStyles(); };
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  const themeObserver = new MutationObserver(onThemeChange);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
  const colorScheme = window.matchMedia?.("(prefers-color-scheme: dark)");
  colorScheme?.addEventListener?.("change", onThemeChange);
  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("resize", schedule);

  syncStyles();
  ensureEntries();
  render();

  return Object.freeze({
    setPlacement(value) {
      if (!["standalone-button", "inline-in-summary"].includes(value)) throw new TypeError(`Unknown placement: ${value}`);
      // Antigravity 只有标题栏弹层一种摆法，两种设置都落在这里。
      placement = value;
    },
    setHasCards(value) {
      if (disposed || hasCards === Boolean(value)) return;
      hasCards = Boolean(value);
      ensureEntries();
      render();
    },
    setOpen(value) { setOpen(value); },
    isOpen: () => !disposed && open && !rail.hidden,
    isPlaced: () => !disposed && (hasCards || hasSettings) && host.isConnected,
    getDiagnostics: () => ({
      placement, mode: !disposed && !rail.hidden ? "popover" : "hidden", visible: !disposed && !rail.hidden,
      hasCards, hasSettings, disposed, entry: entries().length > 0 ? "overview-toggle" : "floating",
      page: /\/c\/[0-9a-f-]{36}/i.test(window.location.pathname) ? "conversation" : "other"
    }),
    dispose() {
      if (disposed) return;
      disposed = true;
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
      themeObserver.disconnect();
      colorScheme?.removeEventListener?.("change", onThemeChange);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", schedule);
      floatingButton.removeEventListener("click", onEntryClick);
      for (const entry of entries()) entry.remove();
      for (const [property, { value, priority }] of hostStyles) {
        if (value) host.style.setProperty(property, value, priority);
        else host.style.removeProperty(property);
      }
      hostStyles.clear();
      host.remove();
      rail.remove();
      floating.remove();
      notifyVisibility(false, "disposed");
    }
  });
}
