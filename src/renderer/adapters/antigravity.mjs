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
  // 与 Codex 共用同一枚 16px 线框图标，线宽对齐顶栏原生图标。
  const ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<rect x="2.25" y="2.25" width="4.75" height="4.75" rx="1.4"/><rect x="2.25" y="9" width="4.75" height="4.75" rx="1.4"/><rect x="9" y="9" width="4.75" height="4.75" rx="1.4"/>'
    + '<path d="M11.4 1.9c.2 1.55.8 2.15 2.35 2.35-1.55.2-2.15.8-2.35 2.35-.2-1.55-.8-2.15-2.35-2.35 1.55-.2 2.15-.8 2.35-2.35Z"/></svg>';
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

  // ---------- 弹层与羽化毛玻璃背板 ----------
  // 背板作为独立兄弟层放在弹层下方，用渐变遮罩把左/上下边缘平滑羽化，避免毛玻璃切出一条生硬的竖线。
  const backdrop = document.createElement("div");
  backdrop.id = `${RAIL_ID}-backdrop`;
  backdrop.hidden = true;
  backdrop.setAttribute("aria-hidden", "true");
  backdrop.style.cssText = [
    "position:fixed", "z-index:2147483644", "pointer-events:none", "box-sizing:border-box",
    "background:var(--hg-rail-bg, rgba(255,255,255,.48))",
    "backdrop-filter:blur(14px) saturate(1.4)", "-webkit-backdrop-filter:blur(14px) saturate(1.4)",
    "mask-image:linear-gradient(to right, transparent 0px, rgba(0,0,0,.4) 22px, #000 50px), linear-gradient(to bottom, transparent 0px, #000 18px, #000 calc(100% - 18px), transparent 100%)",
    "-webkit-mask-image:linear-gradient(to right, transparent 0px, rgba(0,0,0,.4) 22px, #000 50px), linear-gradient(to bottom, transparent 0px, #000 18px, #000 calc(100% - 18px), transparent 100%)",
    "mask-composite:intersect", "-webkit-mask-composite:source-in"
  ].join(";");
  document.documentElement.append(backdrop);

  const rail = document.createElement("div");
  rail.id = RAIL_ID;
  rail.hidden = true;
  rail.setAttribute("role", "dialog");
  rail.setAttribute("aria-label", "Agent Companion");
  rail.style.cssText = [
    "position:fixed", "z-index:2147483646", "top:48px", "right:12px", "box-sizing:border-box",
    `width:min(${PANEL_WIDTH}px, calc(100vw - 16px))`, "max-height:calc(100vh - 64px)", "overflow:auto",
    "overscroll-behavior:contain", "scrollbar-width:none", "padding:6px 10px 12px", "background:transparent",
    "color:var(--hg-panel-color, #1f1f1f)", "-webkit-app-region:no-drag"
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
    const surface = token("--background") || bg;
    const fg = token("--foreground") || (dark ? "#e8e8ea" : "#1f1f1f");
    const border = token("--border") || (dark ? "rgba(255,255,255,.12)" : "rgba(0,0,0,.1)");
    setHostVariable("--hg-panel-bg", bg);
    setHostVariable("--hg-panel-color", fg);
    setHostVariable("--hg-panel-radius", "14px");
    // 毛玻璃底板上的卡片只要一圈细边，避免多层投影显得脏。
    setHostVariable("--hg-panel-shadow", `0 0 0 1px ${border}`);
    // 卡片区顶部「卡片配置」直接落在毛玻璃底板上，本身保持透明。
    setHostVariable("--hg-header-bg", "transparent");
    setHostVariable("--hg-header-color", token("--muted-foreground") || (dark ? "#9aa0a6" : "#80868b"));
    setHostVariable("--hg-divider", border);
    setHostVariable("--hg-font-family", window.getComputedStyle(document.body).fontFamily || "system-ui, -apple-system, sans-serif");
    setHostVariable("--hg-font-weight", "400");
    setHostVariable("--cc-card-bg", bg);
    setHostVariable("--hg-card-bg", `color-mix(in srgb, ${bg} ${dark ? "82%" : "82%"}, transparent)`);
    setHostVariable("--cc-card-fg", fg);
    setHostVariable("--cc-card-border", border);
    // 弹层与羽化背板的外观跟着主题变化（它们在 host 外面，读不到 host 上的变量）。
    backdrop.style.setProperty("--hg-rail-bg", `color-mix(in srgb, ${surface} ${dark ? "54%" : "48%"}, transparent)`);
    for (const name of ["--hg-panel-bg", "--hg-panel-color", "--hg-panel-radius", "--hg-panel-shadow"]) {
      rail.style.setProperty(name, host.style.getPropertyValue(name));
      floating.style.setProperty(name, host.style.getPropertyValue(name));
    }
    syncEntryColors();
  };

  // ---------- 标题栏入口 ----------
  const entries = () => [...document.querySelectorAll(`[${ENTRY_MARK}]`)];
  // 图标颜色与透明度照抄同栏未选中的官方图标，避免比旁边按钮更深。
  const readNativeIconStyle = (button) => {
    const parent = button.parentElement;
    const siblings = parent ? [...parent.querySelectorAll("button")].filter((node) => !node.hasAttribute(ENTRY_MARK) && node.querySelector("svg")) : [];
    const unselected = siblings.find((node) => !node.classList.contains("bg-secondary")
      && node.getAttribute("aria-expanded") !== "true" && node.getAttribute("aria-pressed") !== "true");
    const target = unselected ?? siblings[0];
    if (!target) return { color: "", opacity: "" };
    const icon = target.querySelector("svg");
    const shape = icon?.querySelector("path,rect,circle,line,polyline,polygon");
    const buttonStyle = window.getComputedStyle(target);
    const iconStyle = icon ? window.getComputedStyle(icon) : buttonStyle;
    const shapeStyle = shape ? window.getComputedStyle(shape) : iconStyle;
    const explicitFill = shape?.getAttribute("fill") || icon?.getAttribute("fill");
    const color = [
      shapeStyle.stroke,
      explicitFill && explicitFill !== "none" ? shapeStyle.fill : "",
      iconStyle.color,
      buttonStyle.color
    ].find((value) => value && value !== "none" && value !== "transparent" && value !== "rgba(0, 0, 0, 0)") ?? "";
    const alpha = [buttonStyle.opacity, iconStyle.opacity, shapeStyle.opacity]
      .map((value) => Number.parseFloat(value))
      .filter((value) => Number.isFinite(value))
      .reduce((product, value) => product * value, 1);
    return { color, opacity: alpha < 0.999 ? String(Math.max(0.1, Number(alpha.toFixed(3)))) : "" };
  };
  const syncEntryColors = () => {
    for (const button of entries()) {
      const svg = button.querySelector("svg");
      if (open) {
        button.style.removeProperty("color");
        svg?.style.removeProperty("opacity");
        continue;
      }
      const { color, opacity } = readNativeIconStyle(button);
      if (color) button.style.color = color;
      else button.style.removeProperty("color");
      if (svg) {
        if (opacity) svg.style.opacity = opacity;
        else svg.style.removeProperty("opacity");
      }
    }
  };
  const setEntriesExpanded = () => {
    for (const button of entries()) {
      button.classList.remove(...(open ? NORMAL_CLASSES : SELECTED_CLASSES));
      button.classList.add(...(open ? SELECTED_CLASSES : NORMAL_CLASSES));
      button.setAttribute("aria-expanded", String(open));
    }
    syncEntryColors();
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

  const syncBackdrop = () => {
    backdrop.hidden = disposed || rail.hidden;
    if (backdrop.hidden) return;
    const rect = rail.getBoundingClientRect();
    if (!rect.width || !rect.height) { backdrop.hidden = true; return; }
    const left = Math.max(0, rect.left - 38);
    const top = Math.max(0, rect.top - 14);
    const right = Math.min(window.innerWidth, rect.right + 8);
    const bottom = Math.min(window.innerHeight, rect.bottom + 14);
    backdrop.style.left = `${left}px`;
    backdrop.style.top = `${top}px`;
    backdrop.style.width = `${Math.max(0, right - left)}px`;
    backdrop.style.height = `${Math.max(0, bottom - top)}px`;
  };

  const position = () => {
    if (rail.hidden) { syncBackdrop(); return; }
    const target = anchor?.isConnected ? anchor : entries()[0] ?? null;
    const width = Math.min(PANEL_WIDTH, window.innerWidth - 16);
    if (target) {
      const rect = target.getBoundingClientRect();
      // 卡片右边贴着对话区的右边框留 16px（rail 自身右内边距 10px，再让 6px），而不是跟着标题栏按钮：
      // 按钮离对话区右边框还有一段，跟着它右边会空出一大块。对话区取正文的对话容器（带 data-cascade-id、
      // 不在侧栏条目里）；没有会话页时退到窗口右边。
      const pane = [...document.querySelectorAll("[data-cascade-id]")].find((node) => !node.closest("[data-sidebar-row-id]"));
      const paneRight = pane?.getBoundingClientRect().right;
      const edge = Number.isFinite(paneRight) && paneRight > width ? Math.min(paneRight, window.innerWidth) : Math.max(rect.right, window.innerWidth - 8);
      rail.style.left = `${Math.max(8, Math.min(edge - 6 - width, window.innerWidth - width - 8))}px`;
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
    syncBackdrop();
  };

  const render = () => {
    if (disposed) return;
    const available = hasCards || hasSettings;
    const visible = open && available;
    rail.hidden = !visible;
    if (visible) { syncStyles(); position(); }
    else syncBackdrop();
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

  // 卡片是叠在对话旁的浮层，点对话、点输入框都不收起；只由入口按钮、⌥⌘J 开关。
  // Esc 只在焦点落在卡片里时收起：输入框里的 Esc 是 Antigravity 自己的（例如停止生成）。
  const ownsEvent = (event) => event.composedPath().some((node) => node === rail || node === floating
    || node?.hasAttribute?.(ENTRY_MARK) || (typeof node?.id === "string" && node.id.startsWith("agent-companion")));
  const onKeyDown = (event) => {
    if (event.code === "KeyJ" && event.metaKey && event.altKey && !event.shiftKey && !event.ctrlKey) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(!open);
    } else if (event.key === "Escape" && open && !document.fullscreenElement && ownsEvent(event)) {
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
  const resizeObserver = window.ResizeObserver ? new window.ResizeObserver(syncBackdrop) : null;
  resizeObserver?.observe(rail);
  const themeObserver = new MutationObserver(onThemeChange);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
  const colorScheme = window.matchMedia?.("(prefers-color-scheme: dark)");
  colorScheme?.addEventListener?.("change", onThemeChange);
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
      resizeObserver?.disconnect();
      themeObserver.disconnect();
      colorScheme?.removeEventListener?.("change", onThemeChange);
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
      backdrop.remove();
      floating.remove();
      notifyVisibility(false, "disposed");
    }
  });
}
