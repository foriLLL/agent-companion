/**
 * Antigravity 布局适配器：卡片区做成和原生 Overview 一样的标题栏弹层。
 *
 * 入口按稳定程度分三级：
 * 1. 会话页标题栏里 Overview 开关（`data-testid="toggle-overview-panel"`）左侧插一个同款按钮，样式抄它的 class；
 * 2. 找不到 Overview 开关（新建会话、首页等）时，退到右上角标题栏最右侧的原生图标按钮（如 `⋮`）左侧；
 * 3. 标题栏完全无锚点时，右上角显示自有的悬浮按钮（避开右下角发送按钮与输入框）。
 * 各级都能用 ⌥⌘J 开关。原生节点只在它旁边插入自己的按钮，不改原生节点的属性和样式。
 */
export function createAntigravityAdapter({ host, placement = "standalone-button", onVisibilityChange, onError, hasCards = true, hasSettings = false } = {}) {
  if (!host?.shadowRoot) throw new TypeError("Antigravity adapter requires a host with an open ShadowRoot");
  // 常量放在函数内：冒烟测试用 toString 注入函数本体。
  const RAIL_ID = "agent-companion-rail";
  const ENTRY_MARK = "data-agent-companion-entry";
  const OVERVIEW_SELECTOR = '[data-testid="toggle-overview-panel"]';
  const ROUTE_ID = /\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i;
  const CLIP_OVERFLOW = new Set(["hidden", "clip", "scroll", "auto"]);
  const REPLACED_TAGS = new Set(["IFRAME", "WEBVIEW", "CANVAS", "VIDEO", "IMG", "OBJECT", "EMBED"]);
  const LAYOUT_TRANSITIONS = new Set([
    "width", "min-width", "max-width", "height", "min-height", "max-height",
    "flex", "flex-basis", "flex-grow", "flex-shrink", "grid-template-columns", "grid-template-rows",
    "left", "right", "top", "bottom", "inset", "margin-left", "margin-right", "padding-left", "padding-right",
    "transform", "translate", "opacity", "visibility", "clip-path"
  ]);
  const OPEN_MUTATION_OPTIONS = { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden", "data-state", "aria-hidden"] };
  // 弹层关闭时无需监听全页属性变化，避免流式输出期间频繁触发重检。
  const IDLE_MUTATION_OPTIONS = { childList: true, subtree: true };
  const IDLE_CHECK_MS = 120;
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
  let throttleTimer = 0;
  let lastEntryCheck = 0;
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

  // ---------- 悬浮入口（找不到标题栏锚点时，放在右上角避开底部输入框与发送按钮） ----------
  const floating = document.createElement("div");
  floating.id = "agent-companion-entry";
  floating.hidden = true;
  floating.style.cssText = "position:fixed;z-index:2147483645;top:52px;right:16px;-webkit-app-region:no-drag";
  const floatingRoot = floating.attachShadow({ mode: "open" });
  floatingRoot.innerHTML = `<style>
    button{all:unset;box-sizing:border-box;width:34px;height:34px;border-radius:10px;display:grid;place-items:center;cursor:pointer;
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
    const colorToken = (name) => {
      const value = token(name);
      return value && (!window.CSS?.supports || window.CSS.supports("color", value)) ? value : "";
    };
    const html = document.documentElement;
    const themeAttr = (html.getAttribute("data-theme") || html.dataset?.theme || "").toLowerCase();
    const dark = html.classList.contains("dark") || themeAttr === "dark" || root.colorScheme === "dark"
      ? true
      : html.classList.contains("light") || themeAttr === "light" || root.colorScheme === "light"
        ? false
        : Boolean(window.matchMedia?.("(prefers-color-scheme: dark)").matches);
    const bg = colorToken("--card") || colorToken("--popover") || colorToken("--background") || (dark ? "#1e1f22" : "#fff");
    const surface = colorToken("--background") || bg;
    const fg = colorToken("--card-foreground") || colorToken("--foreground") || (dark ? "#e8e8ea" : "#1f1f1f");
    const muted = colorToken("--muted-foreground") || (dark ? "#9aa0a6" : "#656c76");
    const border = colorToken("--border") || (dark ? "rgba(255,255,255,.12)" : "rgba(17,24,39,.09)");
    const borderStrong = `color-mix(in srgb, ${fg} ${dark ? "16%" : "15%"}, transparent)`;
    const inputBg = `color-mix(in srgb, ${fg} ${dark ? "4.5%" : "3.5%"}, transparent)`;
    const focus = colorToken("--ring") || "#3a83f7";
    const hover = `color-mix(in srgb, ${fg} ${dark ? "6%" : "4.5%"}, transparent)`;
    const active = `color-mix(in srgb, ${fg} ${dark ? "10%" : "8%"}, transparent)`;
    const barTrack = `color-mix(in srgb, ${fg} ${dark ? "11%" : "8%"}, transparent)`;
    const barFill = dark ? "#d4d8e1" : "#2c313a";
    const accent = dark ? "#60a5fa" : "#2563eb";
    const warn = dark ? "#f09c42" : "#9f4f0c";
    const danger = dark ? "#f06d67" : "#c42b25";
    const ok = dark ? "#46b984" : "#238559";
    const font = window.getComputedStyle(document.body).fontFamily || "system-ui, -apple-system, sans-serif";
    const radius = "14px";
    const shadow = `0 0 0 1px ${border}`;
    const cardSurface = `color-mix(in srgb, ${bg} ${dark ? "94%" : "92%"}, transparent)`;
    host.dataset.surface = "unified";
    setHostVariable("--hg-panel-bg", bg);
    setHostVariable("--hg-panel-color", fg);
    setHostVariable("--hg-panel-radius", radius);
    // 毛玻璃底板上的统一容器只要一圈细边，避免多层投影显得脏。
    setHostVariable("--hg-panel-shadow", shadow);
    setHostVariable("--hg-header-bg", "transparent");
    setHostVariable("--hg-header-color", muted);
    setHostVariable("--hg-divider", border);
    setHostVariable("--hg-font-family", font);
    setHostVariable("--hg-font-weight", "400");
    setHostVariable("--cc-card-bg", bg);
    setHostVariable("--cc-card-surface", cardSurface);
    setHostVariable("--hg-card-bg", cardSurface);
    setHostVariable("--cc-card-fg", fg);
    setHostVariable("--cc-card-fg-muted", muted);
    setHostVariable("--cc-card-border", border);
    setHostVariable("--cc-card-border-strong", borderStrong);
    setHostVariable("--cc-card-input-bg", inputBg);
    setHostVariable("--cc-card-radius", radius);
    setHostVariable("--cc-card-row-radius", "8px");
    setHostVariable("--cc-card-shadow", shadow);
    setHostVariable("--cc-card-font", font);
    setHostVariable("--cc-card-hover", hover);
    setHostVariable("--cc-card-active", active);
    setHostVariable("--cc-card-focus", focus);
    setHostVariable("--cc-card-accent", accent);
    setHostVariable("--cc-card-gap", "0px");
    setHostVariable("--cc-section-title-size", "11.5px");
    setHostVariable("--cc-section-title-weight", "500");
    setHostVariable("--cc-section-title-color", muted);
    setHostVariable("--cc-bar-track", barTrack);
    setHostVariable("--cc-bar-fill", barFill);
    setHostVariable("--cc-warn", warn);
    setHostVariable("--cc-danger", danger);
    setHostVariable("--cc-ok", ok);
    const scheme = dark ? "dark" : "light";
    setHostVariable("color-scheme", scheme);
    if (rail.style.colorScheme !== scheme) rail.style.colorScheme = scheme;
    if (floating.style.colorScheme !== scheme) floating.style.colorScheme = scheme;
    // 弹层与羽化背板的外观跟着主题变化（它们在 host 外面，读不到 host 上的变量）。
    backdrop.style.setProperty("--hg-rail-bg", `color-mix(in srgb, ${surface} ${dark ? "54%" : "48%"}, transparent)`);
    for (const name of ["--hg-panel-bg", "--hg-panel-color", "--hg-panel-radius", "--hg-panel-shadow"]) {
      rail.style.setProperty(name, host.style.getPropertyValue(name));
      floating.style.setProperty(name, host.style.getPropertyValue(name));
    }
    syncEntryColors();
  };

  const setStyle = (node, property, value) => {
    if (node.style[property] !== value) node.style[property] = value;
  };
  const isOwnNode = (node) => {
    if (!node) return false;
    if (node === rail || node === backdrop || node === floating) return true;
    const el = node.nodeType === 1 ? node : node.parentElement;
    if (!el) return false;
    return rail.contains(el) || floating.contains(el) || el.hasAttribute?.(ENTRY_MARK)
      || Boolean(el.closest?.(`[${ENTRY_MARK}]`))
      || (typeof el.id === "string" && el.id.startsWith("agent-companion"));
  };
  const colorAlpha = (value) => {
    if (!value || value === "transparent" || value === "none") return 0;
    const slash = /\/\s*([\d.]+)(%?)\s*\)$/.exec(value);
    if (slash) {
      const num = Number.parseFloat(slash[1]);
      return Number.isFinite(num) ? (slash[2] ? num / 100 : num) : 0;
    }
    const rgba = /^(?:rgba|hsla)\([^,]+,[^,]+,[^,]+,\s*([\d.]+)(%?)\s*\)$/i.exec(value);
    if (rgba) {
      const num = Number.parseFloat(rgba[1]);
      return Number.isFinite(num) ? (rgba[2] ? num / 100 : num) : 0;
    }
    return /^(?:rgb|hsl|hwb|lab|lch|oklab|oklch|color)\(/i.test(value) ? 1 : 0;
  };
  const isOpaqueCover = (el) => {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    if (!REPLACED_TAGS.has(el.tagName) && colorAlpha(style.backgroundColor) < 0.9) return false;
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      if (Number.parseFloat(window.getComputedStyle(node).opacity) < 0.9) return false;
    }
    return true;
  };
  // 计算节点经视口与祖先 overflow 裁剪后的可见矩形；隐藏、零尺寸、透明或被折叠容器裁没时返回 null。
  const visibleRect = (node) => {
    if (!node?.isConnected) return null;
    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number.parseFloat(style.opacity) <= 0.01) {
      return null;
    }
    const rect = node.getBoundingClientRect();
    let left = Math.max(0, rect.left);
    let top = Math.max(0, rect.top);
    let right = Math.min(window.innerWidth, rect.right);
    let bottom = Math.min(window.innerHeight, rect.bottom);
    if (right <= left || bottom <= top) return null;
    let fixed = style.position === "fixed";
    for (let parent = node.parentElement; parent && parent !== document.documentElement; parent = parent.parentElement) {
      const parentStyle = window.getComputedStyle(parent);
      if (parentStyle.display === "none" || Number.parseFloat(parentStyle.opacity) <= 0.01) return null;
      if (!fixed) {
        const clipX = CLIP_OVERFLOW.has(parentStyle.overflowX);
        const clipY = CLIP_OVERFLOW.has(parentStyle.overflowY);
        if (clipX || clipY) {
          const parentRect = parent.getBoundingClientRect();
          if (clipX) {
            left = Math.max(left, parentRect.left);
            right = Math.min(right, parentRect.right);
          }
          if (clipY) {
            top = Math.max(top, parentRect.top);
            bottom = Math.min(bottom, parentRect.bottom);
          }
          if (right <= left || bottom <= top) return null;
        }
        if (parentStyle.position === "fixed") fixed = true;
      }
    }
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  };
  const isPointExposed = (node, x, y, { allowDialogs = false } = {}) => {
    if (typeof document.elementsFromPoint !== "function") return true;
    const allowAncestor = window.getComputedStyle(node).pointerEvents === "none";
    const px = Math.min(Math.max(0, x), Math.max(0, window.innerWidth - 1));
    const py = Math.min(Math.max(0, y), Math.max(0, window.innerHeight - 1));
    for (const el of document.elementsFromPoint(px, py)) {
      if (el === node || node.contains(el) || (allowAncestor && el.contains(node))) return true;
      if (isOwnNode(el)) continue;
      if (el.closest?.('[role="tooltip"]')) continue;
      if (allowDialogs && el.closest?.('[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"]')) return true;
      if (isOpaqueCover(el)) return false;
    }
    return false;
  };
  const isAnchorVisible = (button) => {
    const rect = visibleRect(button);
    return Boolean(rect && rect.width >= 1 && rect.height >= 1
      && isPointExposed(button, rect.left + rect.width / 2, rect.top + rect.height / 2, { allowDialogs: true }));
  };
  // 找当前真正可见且未被全屏侧栏盖住的正文对话容器。
  const findVisiblePane = (minWidth) => {
    const currentId = ROUTE_ID.exec(window.location.pathname)?.[1]?.toLowerCase() ?? null;
    const candidates = [];
    for (const node of document.querySelectorAll("[data-cascade-id]")) {
      if (node.closest("[data-sidebar-row-id]")) continue;
      const rect = visibleRect(node);
      if (!rect || rect.width < minWidth || rect.height < 1) continue;
      const points = [
        [rect.left + rect.width * 0.2, rect.top + rect.height * 0.5],
        [rect.left + rect.width * 0.5, rect.top + rect.height * 0.5],
        [rect.left + rect.width * 0.8, rect.top + rect.height * 0.5],
        [rect.left + rect.width * 0.5, rect.top + rect.height * 0.2],
        [rect.left + rect.width * 0.5, rect.top + rect.height * 0.8]
      ];
      if (!points.some(([x, y]) => isPointExposed(node, x, y))) continue;
      const id = node.getAttribute("data-cascade-id")?.toLowerCase() ?? "";
      candidates.push({ node, rect, current: Boolean(currentId && id === currentId) });
    }
    if (!candidates.length) return null;
    const preferred = candidates.filter((item) => item.current);
    const pool = preferred.length ? preferred : candidates;
    pool.sort((a, b) => (b.rect.width - a.rect.width) || (b.rect.height - a.rect.height));
    return pool[0];
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
        if (button.style.color) button.style.removeProperty("color");
        if (svg?.style.opacity) svg.style.removeProperty("opacity");
        continue;
      }
      const { color, opacity } = readNativeIconStyle(button);
      if (color) setStyle(button, "color", color);
      else if (button.style.color) button.style.removeProperty("color");
      if (svg) {
        if (opacity) setStyle(svg, "opacity", opacity);
        else if (svg.style.opacity) svg.style.removeProperty("opacity");
      }
    }
  };
  const setEntriesExpanded = () => {
    const expanded = String(open);
    for (const button of entries()) {
      button.classList.remove(...(open ? NORMAL_CLASSES : SELECTED_CLASSES));
      button.classList.add(...(open ? SELECTED_CLASSES : NORMAL_CLASSES));
      if (button.getAttribute("aria-expanded") !== expanded) button.setAttribute("aria-expanded", expanded);
    }
    syncEntryColors();
    if (floatingButton.getAttribute("aria-expanded") !== expanded) floatingButton.setAttribute("aria-expanded", expanded);
  };
  const makeEntry = (reference, tier) => {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute(ENTRY_MARK, tier);
    button.setAttribute("aria-label", "Agent Companion");
    button.title = "Agent Companion  ⌥⌘J";
    // 尺寸、圆角、悬停色都来自原生按钮；它若正处于选中态，换回普通态的两个 class。
    button.className = reference.className;
    button.classList.remove(...SELECTED_CLASSES);
    button.classList.add(...NORMAL_CLASSES);
    button.style.cssText = "-webkit-app-region:no-drag";
    button.innerHTML = ICON;
    button.addEventListener("click", onEntryClick);
    return button;
  };
  // 第二级锚点：没有可见的 Overview 开关（新建会话、首页、全屏侧栏等）时，找右上角标题栏里最右侧的原生图标按钮（如 ⋮）。
  const findTrailingAnchor = () => {
    const candidates = [...document.querySelectorAll("button")].filter((button) => {
      if (button.hasAttribute(ENTRY_MARK) || !button.querySelector("svg") || button.textContent.trim()) return false;
      if (button.closest('[data-sidebar-row-id], [role="dialog"], [role="menu"]')) return false;
      const box = button.getBoundingClientRect();
      if (box.width < 1 || box.height < 1 || box.width > 48 || box.height > 48 || box.top < 0 || box.bottom > 64 || box.left < window.innerWidth / 2) return false;
      const rect = visibleRect(button);
      if (!rect || rect.width > 48 || rect.height > 48 || rect.top < 0 || rect.bottom > 64 || rect.left < window.innerWidth / 2) return false;
      return isPointExposed(button, rect.left + rect.width / 2, rect.top + rect.height / 2, { allowDialogs: true });
    });
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
    for (const button of candidates) {
      let slot = button;
      // 按钮被弹窗/提示触发器包了一层单子容器时，向上找到真正的横向 flex 标题栏。
      for (let depth = 0; depth < 2 && slot.parentElement; depth += 1) {
        const display = window.getComputedStyle(slot.parentElement).display;
        if (display === "flex" || display === "inline-flex") return { button, slot };
        if (slot.parentElement.children.length !== 1) break;
        slot = slot.parentElement;
      }
    }
    return null;
  };
  let entryTier = "floating";
  const ensureEntries = () => {
    const overviews = [...document.querySelectorAll(OVERVIEW_SELECTOR)].filter(isAnchorVisible);
    if (overviews.length > 0) {
      // Overview 开关被 React 移除、遮挡或切回会话页时，清理其它层级或孤立入口。
      for (const entry of entries()) {
        if (entry.getAttribute(ENTRY_MARK) !== "overview" || !overviews.includes(entry.nextElementSibling)) entry.remove();
      }
      for (const overview of overviews) {
        if (overview.previousElementSibling?.hasAttribute?.(ENTRY_MARK)) continue;
        overview.before(makeEntry(overview, "overview"));
      }
      entryTier = entries().length > 0 ? "overview-toggle" : "floating";
    } else {
      const trailing = findTrailingAnchor();
      for (const entry of entries()) {
        if (entry.getAttribute(ENTRY_MARK) !== "trailing" || !trailing || entry.nextElementSibling !== trailing.slot) entry.remove();
      }
      if (trailing && !trailing.slot.previousElementSibling?.hasAttribute?.(ENTRY_MARK)) {
        trailing.slot.before(makeEntry(trailing.button, "trailing"));
      }
      entryTier = entries().length > 0 ? "titlebar-trailing" : "floating";
    }
    const anchored = entries().length > 0;
    floating.hidden = disposed || anchored || !(hasCards || hasSettings);
    if (anchor && (!anchor.isConnected || !isAnchorVisible(anchor))) anchor = null;
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
    setStyle(backdrop, "left", `${left}px`);
    setStyle(backdrop, "top", `${top}px`);
    setStyle(backdrop, "width", `${Math.max(0, right - left)}px`);
    setStyle(backdrop, "height", `${Math.max(0, bottom - top)}px`);
  };

  let layoutObserved = [];
  let layoutResizeObserver = null;
  const syncLayoutObservation = (pane, target) => {
    if (!layoutResizeObserver) return;
    const next = [];
    const add = (node) => {
      if (!node || node === document.documentElement || isOwnNode(node) || next.includes(node)) return;
      next.push(node);
    };
    if (!disposed && !rail.hidden) {
      // 盯住对话容器、它的祖先链（含可能做 width:0 + overflow:hidden 折叠的外层）以及同级分栏，
      // 侧栏展开、拖拽、动画关闭或全屏切换期间每帧都能同步更新弹层位置。
      const trackedPanes = pane ? [pane] : [...document.querySelectorAll("[data-cascade-id]")].filter((node) => !node.closest("[data-sidebar-row-id]")).slice(0, 3);
      for (const node of trackedPanes) {
        add(node);
        let ancestor = node.parentElement;
        for (let depth = 0; ancestor && ancestor !== document.documentElement && depth < 12; depth += 1) {
          add(ancestor);
          if (depth < 2) {
            let siblings = 0;
            for (const child of ancestor.children) {
              if (siblings >= 8) break;
              if (!isOwnNode(child)) { add(child); siblings += 1; }
            }
          }
          ancestor = ancestor.parentElement;
        }
      }
      if (target?.isConnected) {
        add(target);
        add(target.parentElement);
      }
      add(document.body);
    }
    if (next.length === layoutObserved.length && next.every((el, index) => el === layoutObserved[index])) return;
    for (const el of layoutObserved) layoutResizeObserver.unobserve(el);
    layoutObserved = next;
    for (const el of layoutObserved) layoutResizeObserver.observe(el);
  };

  const position = () => {
    if (rail.hidden) { syncLayoutObservation(null, null); syncBackdrop(); return; }
    const target = (anchor?.isConnected && isAnchorVisible(anchor)) ? anchor : entries().find(isAnchorVisible) ?? null;
    const targetRect = target ? visibleRect(target) : null;
    const width = Math.min(PANEL_WIDTH, window.innerWidth - 16);
    // 卡片右边贴着对话区的右边框留 16px（rail 自身右内边距 10px，再让 6px），而不是跟着标题栏按钮：
    // 按钮离对话区右边框还有一段，跟着它右边会空出一大块。对话区取当前可见且未被全屏侧栏盖住的正文容器
    // （带 data-cascade-id、不在侧栏条目里）；没有可见对话区（如首页或侧栏全屏）时退到窗口右边。
    const pane = findVisiblePane(Math.min(200, Math.floor(width * 0.6)));
    syncLayoutObservation(pane?.node ?? null, target);
    if (targetRect) {
      const paneRight = pane?.rect.right;
      const edge = Number.isFinite(paneRight) && paneRight > width ? Math.min(paneRight, window.innerWidth) : Math.max(targetRect.right, window.innerWidth - 8);
      setStyle(rail, "left", `${Math.max(8, Math.min(edge - 6 - width, window.innerWidth - width - 8))}px`);
      setStyle(rail, "right", "auto");
      setStyle(rail, "top", `${Math.round(targetRect.bottom + 6)}px`);
      setStyle(rail, "bottom", "auto");
      setStyle(rail, "maxHeight", `calc(100vh - ${Math.round(targetRect.bottom + 18)}px)`);
    } else {
      setStyle(rail, "left", "auto");
      setStyle(rail, "right", "16px");
      setStyle(rail, "top", "94px");
      setStyle(rail, "bottom", "auto");
      setStyle(rail, "maxHeight", "calc(100vh - 110px)");
    }
    syncBackdrop();
  };

  let observer = null;
  const observeDom = () => {
    if (disposed || !observer) return;
    observer.takeRecords();
    observer.observe(document.documentElement, open ? OPEN_MUTATION_OPTIONS : IDLE_MUTATION_OPTIONS);
  };
  const withObserverPaused = (fn) => {
    observer?.disconnect();
    try { return fn(); }
    finally { observeDom(); }
  };

  const render = () => {
    if (disposed) return;
    if (throttleTimer) { window.clearTimeout(throttleTimer); throttleTimer = 0; }
    const available = hasCards || hasSettings;
    const visible = open && available;
    withObserverPaused(() => {
      rail.hidden = !visible;
      if (visible) { syncStyles(); ensureEntries(); lastEntryCheck = Date.now(); position(); }
      else { syncLayoutObservation(null, null); syncBackdrop(); }
      setEntriesExpanded();
    });
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
  const ownsEvent = (event) => event.composedPath().some((node) => isOwnNode(node));
  // ⌥⌘J 在 window 捕获阶段处理，先于页面里的任何快捷键。
  const onToggleKeyDown = (event) => {
    if (event.code !== "KeyJ" || !event.metaKey || !event.altKey || event.shiftKey || event.ctrlKey) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(!open);
  };
  // Esc 在冒泡阶段处理（同 Codex 适配器）：设置页的确认框、卡片里的播放器、重命名输入框自己消费 Esc 时会
  // preventDefault（或停止传播），这里不再连带收起整个弹层，一次 Esc 只做一件事。
  // 挂在根元素上：在卡片自己的处理之后、宿主挂在 document / window 上的快捷键之前。
  const keyRoot = document.documentElement;
  const onEscapeKeyDown = (event) => {
    if (event.key !== "Escape" || event.defaultPrevented || !open || document.fullscreenElement || !ownsEvent(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
  };
  const hasStableEntry = () => {
    const list = entries();
    return list.length > 0 && list.every((node) => node.isConnected && Boolean(node.nextElementSibling));
  };
  const flush = () => {
    frame = 0;
    if (disposed) return;
    lastEntryCheck = Date.now();
    try { withObserverPaused(() => { ensureEntries(); position(); }); } catch (error) { reportError(error); }
  };
  const schedule = ({ immediate = false } = {}) => {
    if (frame || disposed) return;
    if (!open && !immediate && hasStableEntry()) {
      const wait = IDLE_CHECK_MS - (Date.now() - lastEntryCheck);
      if (wait > 0) {
        if (!throttleTimer) {
          throttleTimer = window.setTimeout(() => {
            throttleTimer = 0;
            schedule({ immediate: true });
          }, wait);
        }
        return;
      }
    }
    if (throttleTimer) { window.clearTimeout(throttleTimer); throttleTimer = 0; }
    frame = window.requestAnimationFrame(flush);
  };
  const onResize = () => schedule({ immediate: true });
  const onThemeChange = () => { if (!disposed) withObserverPaused(syncStyles); };
  const onMotionEnd = (event) => {
    if (disposed || ownsEvent(event)) return;
    if (event.type !== "animationend" && event.propertyName && !LAYOUT_TRANSITIONS.has(event.propertyName)) return;
    schedule();
  };
  observer = new MutationObserver((records) => {
    if (records.some((record) => !isOwnNode(record.target))) schedule();
  });
  observeDom();
  layoutResizeObserver = window.ResizeObserver ? new window.ResizeObserver(() => schedule({ immediate: true })) : null;
  const resizeObserver = window.ResizeObserver ? new window.ResizeObserver(syncBackdrop) : null;
  resizeObserver?.observe(rail);
  const themeObserver = new MutationObserver(onThemeChange);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
  const colorScheme = window.matchMedia?.("(prefers-color-scheme: dark)");
  colorScheme?.addEventListener?.("change", onThemeChange);
  window.addEventListener("keydown", onToggleKeyDown, true);
  keyRoot.addEventListener("keydown", onEscapeKeyDown);
  window.addEventListener("resize", onResize);
  document.addEventListener("transitionend", onMotionEnd, true);
  document.addEventListener("transitioncancel", onMotionEnd, true);
  document.addEventListener("animationend", onMotionEnd, true);

  withObserverPaused(() => { syncStyles(); ensureEntries(); lastEntryCheck = Date.now(); });
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
      withObserverPaused(ensureEntries);
      render();
    },
    setOpen(value) { setOpen(value); },
    isOpen: () => !disposed && open && !rail.hidden,
    isPlaced: () => !disposed && (hasCards || hasSettings) && host.isConnected,
    getDiagnostics: () => ({
      placement, mode: !disposed && !rail.hidden ? "popover" : "hidden", visible: !disposed && !rail.hidden,
      hasCards, hasSettings, disposed, entry: entries().length > 0 ? entryTier : "floating",
      page: ROUTE_ID.test(window.location.pathname) ? "conversation" : "other"
    }),
    dispose() {
      if (disposed) return;
      disposed = true;
      if (frame) window.cancelAnimationFrame(frame);
      if (throttleTimer) window.clearTimeout(throttleTimer);
      throttleTimer = 0;
      observer.disconnect();
      layoutResizeObserver?.disconnect();
      layoutObserved = [];
      resizeObserver?.disconnect();
      themeObserver.disconnect();
      colorScheme?.removeEventListener?.("change", onThemeChange);
      window.removeEventListener("keydown", onToggleKeyDown, true);
      keyRoot.removeEventListener("keydown", onEscapeKeyDown);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("transitionend", onMotionEnd, true);
      document.removeEventListener("transitioncancel", onMotionEnd, true);
      document.removeEventListener("animationend", onMotionEnd, true);
      floatingButton.removeEventListener("click", onEntryClick);
      for (const entry of entries()) entry.remove();
      for (const [property, { value, priority }] of hostStyles) {
        if (value) host.style.setProperty(property, value, priority);
        else host.style.removeProperty(property);
      }
      delete host.dataset.surface;
      hostStyles.clear();
      host.remove();
      rail.remove();
      backdrop.remove();
      floating.remove();
      notifyVisibility(false, "disposed");
    }
  });
}
