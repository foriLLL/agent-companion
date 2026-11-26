/**
 * Codex 原生布局适配器。只拥有挂载轨道、入口和原生布局补偿，不拥有卡片生命周期。
 * DOM 发现逻辑提取自 injection.mjs；Shell 提供稳定的 host 和内部 ShadowRoot。
 */
export function createCodexAdapter({ host, placement = "standalone-button", onVisibilityChange, onError, hasCards = true, hasSettings = false } = {}) {
  if (!host?.shadowRoot) throw new TypeError("Codex adapter requires a host with an open ShadowRoot");
  const document = host.ownerDocument;
  const window = document.defaultView;
  const { MutationObserver, ResizeObserver, HTMLButtonElement, DOMMatrixReadOnly } = window;
  const getComputedStyle = window.getComputedStyle.bind(window);
  const matchMedia = window.matchMedia.bind(window);
  const hostId = "agent-companion-root";
  const railId = "agent-companion-rail";
  // 原生 Summary 面板的默认宽度；独立抽屉同宽，原生布局判定按它计算。
  const PANEL_WIDTH = 300;
  const hostStyles = new Map();
  const nativeAttributes = new Map();
  const markNative = (node, name, value) => {
    let originals = nativeAttributes.get(node);
    if (!originals) nativeAttributes.set(node, originals = new Map());
    if (!originals.has(name)) originals.set(name, node.getAttribute(name));
    node.setAttribute(name, value);
  };
  const restoreNativeAttribute = (node, name) => {
    const originals = nativeAttributes.get(node);
    if (!originals?.has(name)) return;
    const value = originals.get(name);
    if (value === null) node.removeAttribute(name);
    else node.setAttribute(name, value);
    originals.delete(name);
    if (!originals.size) nativeAttributes.delete(node);
  };
  let moveFallbacks = 0;
  let fallbackActive = false;
  let lastVisibility = null;
  const reportError = (error) => { try { onError?.(error); } catch {} };
  const notifyVisibility = (visible, reason) => {
    if (lastVisibility?.visible === visible && lastVisibility?.placement === placement) return;
    lastVisibility = { visible, reason, placement };
    try { onVisibilityChange?.({ ...lastVisibility }); } catch (error) { reportError(error); }
  };
  const validatePlacement = (value) => {
    if (!["standalone-button", "inline-in-summary"].includes(value)) throw new TypeError(`Unknown placement: ${value}`);
    return value;
  };
  validatePlacement(placement);
  let disposed = false;
  let placementMode = "pending";
  let placementQueued = false;
  let placementFrame = 0;
  // 诊断：流式输出等高频 DOM 变化下放置逻辑的实际执行次数与累计耗时。
  const placementStats = { runs: 0, totalMs: 0, maxMs: 0 };
  let managedPopoverPanel = null;
  let managedPopoverPanelHeight = 0;
  let managedPopoverPanelStyles = null;
  let managedAnimationColumn = null;
  let managedAnimationColumnPosition = null;
  let managedScrollRoot = null;
  let managedScrollRootStyles = null;
  let managedScrollRootTop = 0;

  const popoverPanelStyleProperties = ["height", "flex-basis", "flex-shrink"];
  const scrollRootStyleProperties = [
    "width", "min-width", "max-width", "height", "min-height", "max-height",
    "margin-left", "padding-left", "box-sizing", "overflow-x", "overflow-y",
    "overscroll-behavior", "pointer-events"
  ];

  const restorePopoverPanel = () => {
    if (managedPopoverPanel && managedPopoverPanelStyles) {
      for (const { property, value, priority } of managedPopoverPanelStyles) {
        if (value) managedPopoverPanel.style.setProperty(property, value, priority);
        else managedPopoverPanel.style.removeProperty(property);
      }
    }
    managedPopoverPanel = null;
    managedPopoverPanelHeight = 0;
    managedPopoverPanelStyles = null;
  };

  const preservePopoverPanel = (nativePanel) => {
    if (nativePanel === managedPopoverPanel) return managedPopoverPanelHeight;
    restorePopoverPanel();
    const height = Math.max(1, Math.round(nativePanel.getBoundingClientRect().height));
    managedPopoverPanel = nativePanel;
    managedPopoverPanelHeight = height;
    managedPopoverPanelStyles = popoverPanelStyleProperties.map((property) => ({
      property,
      value: nativePanel.style.getPropertyValue(property),
      priority: nativePanel.style.getPropertyPriority(property)
    }));
    nativePanel.style.setProperty("height", `${height}px`, "important");
    nativePanel.style.setProperty("flex-basis", `${height}px`, "important");
    nativePanel.style.setProperty("flex-shrink", "0", "important");
    return height;
  };

  const restoreAnimationColumn = () => {
    if (managedAnimationColumn && managedAnimationColumnPosition) {
      const { value, priority } = managedAnimationColumnPosition;
      if (value) managedAnimationColumn.style.setProperty("position", value, priority);
      else managedAnimationColumn.style.removeProperty("position");
      restoreNativeAttribute(managedAnimationColumn, "data-agent-companion-animation-column");
    }
    managedAnimationColumn = null;
    managedAnimationColumnPosition = null;
  };

  const configureAnimationColumn = (column) => {
    if (managedAnimationColumn !== column) {
      restoreAnimationColumn();
      managedAnimationColumn = column;
      managedAnimationColumnPosition = {
        value: column.style.getPropertyValue("position"),
        priority: column.style.getPropertyPriority("position")
      };
    }
    markNative(column, "data-agent-companion-animation-column", "true");
    // transform 动画本身也会建立 containing block。显式固定 position 后，
    // 动画结束移除 transform 时 rail 不会改用外层 containing block 而横跳 16px。
    column.style.setProperty("position", "relative", "important");
  };

  const restoreOuterScroller = () => {
    if (managedScrollRoot && managedScrollRootStyles) {
      for (const { property, value, priority } of managedScrollRootStyles) {
        if (value) managedScrollRoot.style.setProperty(property, value, priority);
        else managedScrollRoot.style.removeProperty(property);
      }
      managedScrollRoot.scrollTop = managedScrollRootTop;
      restoreNativeAttribute(managedScrollRoot, "data-agent-companion-scroll-root");
    }
    managedScrollRoot = null;
    managedScrollRootStyles = null;
    managedScrollRootTop = 0;
  };

  const configureOuterScroller = (summary) => {
    const scrollRoot = summary.mode === "animated-summary"
      ? summary.mountParent.parentElement
      : summary.mountParent;
    if (!scrollRoot) return null;
    if (managedScrollRoot !== scrollRoot) {
      restoreOuterScroller();
      managedScrollRoot = scrollRoot;
      managedScrollRootTop = scrollRoot.scrollTop;
      managedScrollRootStyles = scrollRootStyleProperties.map((property) => ({
        property,
        value: scrollRoot.style.getPropertyValue(property),
        priority: scrollRoot.style.getPropertyPriority(property)
      }));
    }
    markNative(scrollRoot, "data-agent-companion-scroll-root", summary.mode);
    scrollRoot.style.setProperty("width", "332px", "important");
    scrollRoot.style.setProperty("min-width", "332px", "important");
    scrollRoot.style.setProperty("max-width", "332px", "important");
    scrollRoot.style.setProperty("margin-left", "-16px", "important");
    scrollRoot.style.setProperty("padding-left", "16px", "important");
    scrollRoot.style.setProperty("box-sizing", "border-box", "important");
    scrollRoot.style.setProperty("overflow-x", "hidden", "important");
    scrollRoot.style.setProperty("overflow-y", "auto", "important");
    scrollRoot.style.setProperty("overscroll-behavior", "contain", "important");
    scrollRoot.style.setProperty("pointer-events", "auto", "important");
    if (summary.mode === "animated-summary") {
      const bounds = summary.floatingRoot.getBoundingClientRect();
      const availableHeight = Math.min(bounds.bottom, window.innerHeight) - Math.max(0, bounds.top);
      scrollRoot.style.setProperty("height", `${Math.max(1, Math.floor(availableHeight))}px`, "important");
      scrollRoot.style.setProperty("min-height", "0", "important");
      scrollRoot.style.setProperty("max-height", "none", "important");
    }
    return scrollRoot;
  };

  // 定位原生 summary 触发按钮。不再单靠英文 aria-label 字面量（界面切换语言会失效），
  // 而是多信号打分：多语言文案 + aria-controls 指向 dialog + 右上角工具栏内的图标按钮。
  // kind: "popover"（Side Panel 态，带 aria-controls→dialog）| "pinned"（浮层态，用 aria-pressed）。
  const SUMMARY_LABEL_HINTS = [
    "summary",          // en
    "摘要", "总结",      // zh-Hans
    "摘要面板",
    "サマリー", "要約",  // ja
    "요약",             // ko
    "resumen",          // es
    "résumé", "resume", // fr
    "zusammenfassung"   // de
  ];
  const labelText = (element) =>
    `${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""}`.toLowerCase();
  // Codex 给 Summary 开关打的自动化属性，不随界面语言和文案变化；有它就不必依赖文案。
  const SUMMARY_TOGGLE_ATTRIBUTE = "data-thread-summary-panel-toggle";
  const matchesSummaryLabel = (element) => {
    if (element.hasAttribute(SUMMARY_TOGGLE_ATTRIBUTE)) return true;
    const label = labelText(element);
    return SUMMARY_LABEL_HINTS.some((hint) => label.includes(hint));
  };
  const isPinnedLabel = (element) => labelText(element).includes("pinned")
    || labelText(element).includes("固定");

  const findSummaryToggle = (kind) => {
    const buttons = Array.from(document.querySelectorAll("button"));
    let best = null;
    let bestScore = 0;
    for (const button of buttons) {
      const controlledId = button.getAttribute("aria-controls");
      const controlled = controlledId ? document.getElementById(controlledId) : null;
      const controlsDialog = controlled?.getAttribute("role") === "dialog";
      const labelMatch = matchesSummaryLabel(button);
      // 位于顶部工具栏、只含一个 svg 的图标按钮（结构信号，语言无关）。
      const inHeader = !!button.closest("header");
      const iconOnly = button.querySelector("svg") && button.textContent.trim() === "";

      let score = 0;
      if (labelMatch) score += 4;
      if (kind === "popover" && controlsDialog) score += 4;
      if (inHeader) score += 1;
      if (iconOnly) score += 1;
      // pinned 态用 aria-pressed 反映开合；popover 态用 aria-controls。
      if (kind === "pinned" && button.hasAttribute("aria-pressed")) score += 2;
      if (kind === "popover" && controlsDialog && button.getAttribute("data-state") === "open") score += 2;
      // pinned 与 popover 的文案互斥：pinned 含 "pinned/固定"，popover 不含。
      if (kind === "pinned" && labelMatch && isPinnedLabel(button)) score += 2;
      if (kind === "popover" && labelMatch && isPinnedLabel(button)) score -= 2;

      // 至少要有一个强信号（文案或 dialog 结构），否则不认。
      const hasStrongSignal = labelMatch;
      if (hasStrongSignal && score > bestScore) {
        bestScore = score;
        best = button;
      }
    }
    return best;
  };

  // 背景 token 会随 Codex 主题系统改版；卡片边界由已确认的 Summary 容器内
  // 的视觉表面确定。旧版类名仅用作兼容信号，不要求具体背景类名。
  const findSummarySurface = (container) => Array.from(container.querySelectorAll("div")).find((element) => {
    if (element.id === railId || element.id === hostId || element.closest(`#${railId}`)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const rounded = Number.parseFloat(style.borderTopLeftRadius) >= 12 || element.classList.contains("rounded-3xl");
    const background = style.backgroundColor;
    return rounded && rect.width > 0 && rect.height > 0
      && ((background && background !== "transparent" && background !== "rgba(0, 0, 0, 0)")
        || element.classList.contains("bg-token-dropdown-background"));
  }) ?? null;

  const findSummaryPopover = () => {
    // Side Panel 打开时，Summary 会迁移到 aria-controls 指向的 Radix dialog。
    const trigger = findSummaryToggle("popover");
    if (!trigger || trigger.getAttribute("data-state") !== "open") return null;
    const controlledId = trigger.getAttribute("aria-controls");
    const popover = controlledId ? document.getElementById(controlledId) : null;
    if (!popover || popover.getAttribute("role") !== "dialog" || popover.getAttribute("data-state") !== "open") return null;
    const nativePanel = findSummarySurface(popover);
    const mountParent = nativePanel?.parentElement ?? null;
    if (!nativePanel || !mountParent) return null;
    return {
      mode: "summary-popover",
      mountParent,
      nativePanel,
      styleRoot: popover,
      trigger
    };
  };

  // 部分 Summary 变体（data-summary-panel-variant）没有 origin-top-right 动画列：
  // 面板经 display:contents 包装后直接放在 flex 纵列里，该纵列承担同样的挂载职责。
  const findVariantColumn = (floatingRoot, summaryIsOpen) => {
    if (!summaryIsOpen) return null;
    const panel = floatingRoot.querySelector("[data-summary-panel-variant]");
    let column = panel?.parentElement ?? null;
    while (column && column !== floatingRoot && getComputedStyle(column).display === "contents") column = column.parentElement;
    if (!column || column === floatingRoot) return null;
    const style = getComputedStyle(column);
    const bounds = column.getBoundingClientRect();
    return style.display === "flex" && style.flexDirection === "column" && style.visibility !== "hidden"
      && bounds.width > 0 && bounds.height > 0 ? column : null;
  };

  // 摘要面板所在的浮层根：面板往上第一个绝对 / 固定定位的祖先，它的上下边界就是面板可用的高度。
  // 26.1117 起浮层根的类名从 right-0 改成 inset-x-0，按类名找不到；面板自己的 data-summary-panel-variant 属性更稳定，
  // 从它出发按定位方式找，不看类名。
  const floatingRootOf = (panel) => {
    for (let node = panel.parentElement; node && node !== document.body; node = node.parentElement) {
      const position = getComputedStyle(node).position;
      if (position === "absolute" || position === "fixed") return node;
    }
    return null;
  };

  const findFloatingSummary = () => {
    const pinnedToggle = findSummaryToggle("pinned");
    const summaryIsOpen = pinnedToggle?.getAttribute("aria-pressed") === "true";
    // 多标签页时每个标签都有一份浮层根节点，后台标签的排在前面且不可见；
    // 逐个尝试，取第一个能定位到可见纵列的。先按旧版类名找，再从可见的摘要面板出发找（见 floatingRootOf）。
    const floatingRoots = Array.from(document.querySelectorAll("div")).filter((element) => {
      const className = typeof element.className === "string" ? element.className : "";
      return className.includes("thread-floating-content-top-inset") && className.includes("right-0");
    });
    for (const panel of document.querySelectorAll("[data-summary-panel-variant]")) {
      const bounds = panel.getBoundingClientRect();
      const root = bounds.width > 0 && bounds.height > 0 ? floatingRootOf(panel) : null;
      if (root && !floatingRoots.includes(root)) floatingRoots.push(root);
    }
    for (const floatingRoot of floatingRoots) {
      const nativeColumn = Array.from(floatingRoot.querySelectorAll("div")).find((element) => {
        const className = typeof element.className === "string" ? element.className : "";
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        return className.includes("origin-top-right")
          && style.display !== "none"
          && style.visibility !== "hidden"
          && (summaryIsOpen || Number.parseFloat(style.opacity) > 0)
          && bounds.width > 0
          && bounds.height > 0;
      }) ?? findVariantColumn(floatingRoot, summaryIsOpen);
      const nativePanel = nativeColumn ? findSummarySurface(nativeColumn) : null;
      if (nativePanel) {
        return {
          mode: "animated-summary",
          mountParent: nativeColumn,
          floatingRoot,
          nativePanel,
          styleRoot: nativeColumn,
          trigger: pinnedToggle
        };
      }
    }
    return null;
  };

  const setHostVariable = (name, value) => {
    if (!value || host.style.getPropertyValue(name) === value) return;
    if (!hostStyles.has(name)) hostStyles.set(name, { value: host.style.getPropertyValue(name), priority: host.style.getPropertyPriority(name) });
    host.style.setProperty(name, value);
  };

  const syncNativeStyles = (nativeColumn) => {
    const rootStyle = getComputedStyle(document.documentElement);
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    const nativePanel = nativeColumn ? findSummarySurface(nativeColumn) : null;
    const nativeHeader = nativePanel?.querySelector("header");
    const nativeSection = nativePanel?.querySelector("section");
    const panelStyle = nativePanel ? getComputedStyle(nativePanel) : null;
    const headerStyle = nativeHeader ? getComputedStyle(nativeHeader) : null;
    const dividerStyle = nativeSection ? getComputedStyle(nativeSection, "::after") : null;

    setHostVariable("--hg-panel-bg", panelStyle?.backgroundColor || rootStyle.getPropertyValue("--color-token-dropdown-background").trim() || (dark ? "#252525" : "#fff"));
    setHostVariable("--hg-panel-color", panelStyle?.color || rootStyle.getPropertyValue("--color-token-text-primary").trim() || (dark ? "#ececec" : "#1a1c1f"));
    setHostVariable("--hg-panel-radius", panelStyle?.borderRadius || "20px");
    // 独立模式没有原生面板可读，回退到 Codex 的 elevation token（随明暗主题切换）。
    setHostVariable("--hg-panel-shadow",
      panelStyle?.boxShadow && panelStyle.boxShadow !== "none"
        ? panelStyle.boxShadow
        : rootStyle.getPropertyValue("--elevation-prominent").trim()
          || "0 0 0 .5px var(--color-token-border-heavy, rgba(26, 28, 31, .117)), 0 3px 7.5px rgba(0, 0, 0, .04), 0 0 20px rgba(0, 0, 0, .05)");
    setHostVariable("--hg-header-bg", headerStyle?.backgroundColor || rootStyle.getPropertyValue("--color-token-dropdown-background").trim() || (dark ? "#252525" : "#fff"));
    setHostVariable("--hg-header-color", headerStyle?.color || rootStyle.getPropertyValue("--color-token-text-tertiary").trim() || (dark ? "#aaa" : "#666"));
    setHostVariable("--hg-divider", dividerStyle?.backgroundColor || rootStyle.getPropertyValue("--color-token-border-default").trim());
    setHostVariable("--hg-font-family", panelStyle?.fontFamily || "-apple-system, system-ui, \"Segoe UI\", sans-serif");
    setHostVariable("--hg-font-weight", panelStyle?.fontWeight || "445");
    // 通用 Shell token 与迁移期媒体 token 共用同一原生视觉来源。
    setHostVariable("--cc-card-bg", host.style.getPropertyValue("--hg-panel-bg"));
    setHostVariable("--cc-card-fg", host.style.getPropertyValue("--hg-panel-color"));
    setHostVariable("--cc-card-border", rootStyle.getPropertyValue("--color-token-border-default").trim()
      || (dark ? "rgba(255,255,255,.12)" : "rgba(26,28,31,.117)"));
  };

  const createRail = (summary) => {
    const rail = document.createElement("div");
    rail.id = railId;
    rail.dataset.mode = summary.mode;
    rail.setAttribute("aria-label", "Companion 卡片侧栏");
    const sharedStyles = [
      "display:block", "width:332px", "min-width:332px", "max-width:332px",
      "padding:12px 16px 16px", "overflow:visible", "pointer-events:auto",
      "box-sizing:border-box"
    ];
    rail.style.cssText = summary.mode === "summary-popover"
      ? [...sharedStyles, "position:relative", "flex:none", "margin-top:12px", "margin-left:-16px"].join(";")
      : ["position:absolute", "left:-16px", ...sharedStyles, "z-index:1"].join(";");
    summary.mountParent.append(rail);
    return rail;
  };

  const positionAnimatedRail = (rail, nativeColumn, nativePanel) => {
    const columnBounds = nativeColumn.getBoundingClientRect();
    const panelBounds = nativePanel.getBoundingClientRect();
    const transform = getComputedStyle(nativeColumn).transform;
    const matrix = transform && transform !== "none" ? new DOMMatrixReadOnly(transform) : null;
    const scale = matrix ? Math.max(0.01, Math.hypot(matrix.a, matrix.b)) : 1;
    // getBoundingClientRect 包含 Summary 的 scale 动画；反算后才能保证首帧也是 24px 布局间距。
    const topValue = Math.round((panelBounds.bottom - columnBounds.top) / scale + 12);
    const top = `${topValue}px`;
    if (rail.style.top !== top) rail.style.top = top;
    rail.style.removeProperty("height");
    rail.style.removeProperty("flex-basis");
  };

  // 播放器独立挂载；入口优先占用顶栏位置，找不到可靠锚点时回退悬浮按钮。
  // 随 Summary 模式优先复用原生卡片的下方空间；缺少入口时保留独立入口。
  // 顶栏与悬浮入口共用同一枚 16px 线框图标，规格对齐 Codex 原生顶栏按钮。
  const ENTRY_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.25" y="2.25" width="4.75" height="4.75" rx="1.4"/><rect x="2.25" y="9" width="4.75" height="4.75" rx="1.4"/><rect x="9" y="9" width="4.75" height="4.75" rx="1.4"/><path d="M11.4 1.9c.2 1.55.8 2.15 2.35 2.35-1.55.2-2.15.8-2.35 2.35-.2-1.55-.8-2.15-2.35-2.35 1.55-.2 2.15-.8 2.35-2.35Z"/></svg>';
  let standalone = placement === "standalone-button";
  let inlineEntryFallback = false;
  // Summary 已打开却定位不到可挂载结构（宿主改版）时，短暂等待后退回独立入口，
  // 并保持到重新定位成功为止；否则摘要模式下卡片与设置入口会一起消失。
  const UNLOCATED_SUMMARY_GRACE_MS = 800;
  let summaryUnlocatedSince = 0;
  let summaryUnlocatedTimer = null;
  let summaryUnsupported = false;
  const usesStandalone = () => standalone || fallbackActive || inlineEntryFallback;
  const shell = document.createElement("div");
  shell.id = `${hostId}-shell`;
  // shell 铺满整窗，不能声明 -webkit-app-region:no-drag：Electron 不看 pointer-events，会把整窗从标题栏的
  // 可拖动区域里扣掉，窗口就拖不动了。只有真正可点的入口按钮和抽屉自己声明 no-drag。
  shell.style.cssText = "all:initial !important;position:fixed !important;inset:0 !important;z-index:2147483646 !important;pointer-events:none !important";
  // Codex 模态弹窗（侧聊关闭确认等）的遮罩为 `.codex-dialog-overlay`（z-50），Codex 自身也以此判断模态。
  // 弹窗期间 shell 降为 z-index:auto：仍盖在会话内容上，但让出遮罩与确认框，避免挡住按钮。
  const SHELL_TOP_LAYER = "2147483646";
  const syncShellLayer = () => {
    // 类名之外再认 ARIA 语义，遮罩改名后模态弹窗仍能盖过抽屉。
    const layer = document.querySelector('.codex-dialog-overlay, [aria-modal="true"], dialog[open]') ? "auto" : SHELL_TOP_LAYER;
    if (shell.style.getPropertyValue("z-index") !== layer) shell.style.setProperty("z-index", layer, "important");
  };
  const shellShadow = shell.attachShadow({ mode: "open" });
  shellShadow.innerHTML = `
    <style>
      :host { color-scheme: light dark; }
      * { box-sizing: border-box; }
      button {
        position:absolute; top:48px; right:12px; width:32px; height:32px; padding:0;
        display:flex; align-items:center; justify-content:center; border:1px solid var(--color-token-border, rgba(127,127,127,.18));
        border-radius:12px; cursor:pointer; pointer-events:auto; -webkit-app-region:no-drag;
        color:var(--color-token-text-secondary, #555);
        background:var(--color-token-dropdown-background, #fff);
        box-shadow:0 2px 8px #0001;
      }
      button:hover { color:var(--color-token-text-primary, #1a1c1f); }
      svg { width:16px; height:16px; fill:none; stroke:currentColor; stroke-width:1.15; stroke-linecap:round; stroke-linejoin:round; }
      button[hidden] { display:none; }
      button[aria-expanded="true"] { outline:2px solid #8888; }
      button:focus-visible { outline:2px solid #4b91e2; outline-offset:2px; }
      /* 高度随内容，最多到窗口底部：卡片下方的空白不能拦截原生页面的点击。 */
      .drawer {
        position:absolute; top:88px; right:0; max-height:calc(100% - 88px);
        width:min(${PANEL_WIDTH + 24}px, 100%); padding:12px 8px 16px 16px;
        overflow:auto; overscroll-behavior:contain; pointer-events:auto;
        -webkit-app-region:no-drag; transform-origin:top right;
      }
      .drawer[hidden] { display:none; }
      @media (prefers-color-scheme:dark) {
        button { color:var(--color-token-text-primary, #ececec); background:var(--color-token-dropdown-background, #252525); }
      }
    </style>
    <button type="button" aria-label="Companion 卡片" aria-expanded="false" aria-controls="companion-drawer" title="Companion（Esc 关闭）">${ENTRY_ICON}</button>
    <div id="companion-drawer" class="drawer" role="region" aria-label="Companion 卡片" hidden></div>
  `;
  const companionButton = shellShadow.querySelector("button");
  const ownedRail = shellShadow.querySelector(".drawer");
  ownedRail.dataset.mode = "standalone";
  let drawerOpen = false;
  let drawerAnimation = null;
  const drawerMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  // 曲线取自 Codex 原生 Summary 的逐帧实测：面板与会话平移各一组，用 linear() 重放原生弹簧手感。
  const supportsLinearEasing = window.CSS?.supports?.("transition-timing-function", "linear(0, 1)") === true;
  const MOTION = {
    drawerOpen: [225, "linear(0, 0.113 7.1%, 0.321 14.2%, 0.52 21.3%, 0.679 28.4%, 0.794 35.6%, 0.872 42.7%, 0.923 49.8%, 0.954 56.9%, 0.974 64%, 0.985 71.1%, 0.992 78.2%, 0.996 85.3%, 0.998 92.4%, 1)"],
    drawerClose: [304, "linear(0, 0.194 5.3%, 0.379 10.5%, 0.528 15.1%, 0.644 19.7%, 0.742 24.3%, 0.811 29.3%, 0.867 33.9%, 0.905 38.5%, 0.933 43.1%, 0.953 47.7%, 0.967 52.3%, 0.977 56.9%, 0.984 61.5%, 0.989 66.1%, 0.993 70.7%, 0.995 75.3%, 0.997 79.9%, 0.998 84.5%, 0.999 93.4%, 1)"],
    dockOpen: [352, "linear(0, 0.015 4.5%, 0.112 9.4%, 0.211 13.9%, 0.317 18.2%, 0.416 22.4%, 0.508 26.4%, 0.587 30.7%, 0.662 34.7%, 0.722 38.9%, 0.778 43.5%, 0.828 47.4%, 0.863 51.7%, 0.895 56%, 0.921 60.5%, 0.942 64.8%, 0.957 68.8%, 0.969 72.7%, 0.978 76.7%, 0.984 80.7%, 0.989 84.7%, 0.993 88.4%, 0.996 92.3%, 0.998 96.3%, 1)"],
    dockClose: [336, "linear(0, 0.154 6%, 0.278 10.7%, 0.383 14.9%, 0.478 19.3%, 0.56 23.8%, 0.638 28%, 0.701 32.1%, 0.757 36%, 0.804 40.5%, 0.844 44.6%, 0.877 48.8%, 0.904 52.7%, 0.924 56.8%, 0.943 61%, 0.957 64.9%, 0.968 69%, 0.977 73.2%, 0.984 77.1%, 0.988 81.2%, 0.993 87.5%, 0.997 91.7%, 0.999 95.8%, 1)"]
  };
  const motion = (name) => {
    const [duration, easing] = MOTION[name];
    return { duration, easing: supportsLinearEasing ? easing : "cubic-bezier(0.22, 1, 0.36, 1)" };
  };
  // 与原生面板一致：从自身宽度外滑入并由 0.8 放大，原点在右上角。
  const DRAWER_HIDDEN = { opacity: "0", transform: "translateX(100%) scale(0.8)" };
  const setDrawerVisible = (open) => {
    if (drawerOpen === open) return;
    drawerOpen = open;
    const previous = getComputedStyle(ownedRail);
    const from = ownedRail.hidden ? DRAWER_HIDDEN : { opacity: previous.opacity, transform: previous.transform };
    drawerAnimation?.cancel();
    drawerAnimation = null;
    ownedRail.hidden = false;
    ownedRail.inert = !open;
    ownedRail.dataset.state = open ? "opening" : "closing";
    const to = open ? { opacity: "1", transform: "translateX(0) scale(1)" } : DRAWER_HIDDEN;
    ownedRail.style.opacity = to.opacity;
    ownedRail.style.transform = to.transform;
    const finish = () => {
      ownedRail.hidden = !open;
      ownedRail.dataset.state = open ? "open" : "closed";

      schedulePlacement();
    };
    if (drawerMotion.matches || typeof ownedRail.animate !== "function") { finish(); return; }
    const animation = ownedRail.animate([from, to], motion(open ? "drawerOpen" : "drawerClose"));
    drawerAnimation = animation;
    // 快速反向点击沿当前帧继续；旧动画不能隐藏重开的面板或停止新播放。
    animation.finished.then(() => {
      if (disposed || drawerAnimation !== animation) return;
      drawerAnimation = null;
      finish();
    }).catch(() => {});
  };

  const toolbarHost = document.createElement("span");
  toolbarHost.id = `${hostId}-toolbar`;
  toolbarHost.style.cssText = "all:initial !important;display:inline-flex !important;flex:0 0 28px !important;width:28px !important;height:28px !important;pointer-events:auto !important;-webkit-app-region:no-drag !important";
  const toolbarShadow = toolbarHost.attachShadow({ mode: "open" });
  toolbarShadow.innerHTML = `
    <style>
      button { display:flex;align-items:center;justify-content:center;width:28px;height:28px;
        padding:0;border:0;border-radius:12.5px;background:transparent;cursor:pointer;
        color:var(--cc-entry-color, var(--color-token-text-primary, #1a1c1f));pointer-events:auto;-webkit-app-region:no-drag; }
      button:hover, button[aria-expanded="true"] { background:var(--color-token-list-hover-background, rgba(127,127,127,.12)); }
      button:focus-visible { outline:2px solid #4b91e2;outline-offset:1px; }
      /* 线宽与透明度对齐原生顶栏线性图标 */
      svg { width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.15;stroke-linecap:round;stroke-linejoin:round;opacity:var(--cc-entry-opacity, 1); }
    </style>
    <button type="button" aria-label="Companion 卡片" title="Companion" aria-expanded="false">${ENTRY_ICON}</button>
  `;
  const toolbarButton = toolbarShadow.querySelector("button");
  // 诊断：入口落在哪一级锚点上（summary / share / trailing / floating）。
  let entryAnchor = null;
  // 图标颜色与透明度照抄同组原生图标按钮里实际绘制的 SVG（避免按钮与 SVG 色档不同导致偏深）。
  const syncEntryColor = (group) => {
    const native = Array.from(group.querySelectorAll("button"))
      .find((button) => button.querySelector("svg") && !button.textContent.trim() && !button.disabled && button.getAttribute("aria-disabled") !== "true");
    let color = "";
    let opacity = "";
    if (native) {
      const icon = native.querySelector("svg");
      const shape = icon?.querySelector("path,rect,circle,line,polyline,polygon");
      const buttonStyle = getComputedStyle(native);
      const iconStyle = icon ? getComputedStyle(icon) : buttonStyle;
      const shapeStyle = shape ? getComputedStyle(shape) : iconStyle;
      const explicitFill = shape?.getAttribute("fill") || icon?.getAttribute("fill");
      const paint = [
        shapeStyle.stroke,
        explicitFill && explicitFill !== "none" ? shapeStyle.fill : "",
        iconStyle.color,
        buttonStyle.color
      ].find((value) => value && value !== "none" && value !== "transparent" && value !== "rgba(0, 0, 0, 0)");
      color = paint ?? "";
      const alpha = [buttonStyle.opacity, iconStyle.opacity, shapeStyle.opacity]
        .map((value) => Number.parseFloat(value))
        .filter((value) => Number.isFinite(value))
        .reduce((product, value) => product * value, 1);
      if (alpha < 0.999) opacity = String(Math.max(0.1, Number(alpha.toFixed(3))));
    }
    if (color) {
      if (toolbarHost.style.getPropertyValue("--cc-entry-color") !== color) toolbarHost.style.setProperty("--cc-entry-color", color);
    } else toolbarHost.style.removeProperty("--cc-entry-color");
    if (opacity) {
      if (toolbarHost.style.getPropertyValue("--cc-entry-opacity") !== opacity) toolbarHost.style.setProperty("--cc-entry-opacity", opacity);
    } else toolbarHost.style.removeProperty("--cc-entry-opacity");
  };
  const placeToolbarEntry = () => {
    // Summary 优先；按钮改名或移走时仍可放在 Share 后面。只借位置，不驱动原生按钮。
    // 容器由实际 flex 布局确定，不依赖类名、固定祖先层数或一定存在 header 标签。
    const inTitlebar = (rect) => rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= 64 && rect.left >= window.innerWidth / 2;
    let candidates = Array.from(document.querySelectorAll('header button, [role="toolbar"] button'));
    // 标题栏不再用 header / toolbar 标签时，只按位置取窗口顶部右半边的按钮。
    if (!candidates.length) candidates = Array.from(document.querySelectorAll("button")).filter((button) => inTitlebar(button.getBoundingClientRect()));
    const shareLabel = /^(?:share|分享|共享|共有|공유|compartir|partager|teilen)$/i;
    const isShare = (button) => [button.getAttribute("aria-label"), button.getAttribute("title"), button.textContent]
      .some((text) => shareLabel.test((text ?? "").trim()));
    // 新版标题栏右侧可能只剩一个按钮（如 New tab），所在分组也只有它一个：
    // 兜底放在最右侧按钮的左边，不按文案匹配，原生按钮仍贴窗口边缘。
    const trailing = candidates
      .map((trigger) => ({ trigger, rect: trigger.getBoundingClientRect() }))
      .filter(({ rect }) => inTitlebar(rect))
      .sort((a, b) => b.rect.right - a.rect.right)[0]?.trigger;
    const anchors = [
      ...candidates.filter(matchesSummaryLabel).map((trigger) => ({ trigger, after: false, minButtons: 2, kind: "summary" })),
      ...candidates.filter(isShare).map((trigger) => ({ trigger, after: true, minButtons: 2, kind: "share" })),
      ...(trailing ? [{ trigger: trailing, after: false, minButtons: 1, kind: "trailing" }] : [])
    ];
    for (const { trigger, after, minButtons, kind } of anchors) {
      if (!inTitlebar(trigger.getBoundingClientRect())) continue;
      const header = trigger.closest('header, [role="toolbar"]');
      let anchor = trigger;
      let group = anchor.parentElement;
      while (group) {
        const style = getComputedStyle(group);
        if ((style.display === "flex" || style.display === "inline-flex")
          && style.flexDirection === "row" && group.querySelectorAll("button").length >= minButtons) break;
        // 没有 header 作边界时，不能一路爬到整页的横向布局里去。
        if (group === header || (!header && group.getBoundingClientRect().height > 64)) { group = null; break; }
        anchor = group;
        group = group.parentElement;
      }
      if (!group) continue;
      if (after) {
        if (toolbarHost.parentElement !== group || toolbarHost.previousSibling !== anchor) group.insertBefore(toolbarHost, anchor.nextSibling);
      } else if (toolbarHost.parentElement !== group || toolbarHost.nextSibling !== anchor) group.insertBefore(toolbarHost, anchor);
      const bounds = toolbarHost.getBoundingClientRect();
      const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      if (bounds.width > 0 && bounds.height > 0 && bounds.left >= 0 && bounds.right <= window.innerWidth && hit === toolbarHost) {
        syncResizeObservation(header, group);
        syncEntryColor(group);
        entryAnchor = kind;
        return true;
      }
    }
    toolbarHost.remove();
    syncResizeObservation();
    entryAnchor = "floating";
    return false;
  };
  // 与原生 Summary 相同的两层意图：pinned 是常驻开关，popover 只在 overlay 档临时浮出。
  // overlay 档下 pinned 的面板不显示（拖窄窗口时消失），回到宽档再出现。
  let pinned = false;
  let popoverOpen = false;
  let displayMode = null; // 原生判定："overlay" | "shift" | "gutter"；原生模块缺失时为 null
  const wantsOpen = () => pinned || popoverOpen;
  let returnFocus = null;

  let closingSummary = null;
  let summaryCloseTimer = null;
  let drivingSummary = false;
  const summaryIsOpen = (trigger) => {
    if (!trigger?.isConnected) return false;
    // 明确的关闭状态优先于残留的退场动画，避免刚打开播放器又被旧面板关掉。
    for (const attribute of ["aria-pressed", "aria-expanded"]) {
      const value = trigger.getAttribute(attribute);
      if (value === "true" || value === "false") return value === "true";
    }
    const state = trigger.getAttribute("data-state");
    if (state === "open" || state === "closed") return state === "open";
    return (findSummaryPopover() ?? findFloatingSummary())?.trigger === trigger;
  };
  const openSummaryTrigger = () => [findSummaryToggle("pinned"), findSummaryToggle("popover")]
    .find(summaryIsOpen) ?? null;
  const clearSummaryClose = () => {
    clearTimeout(summaryCloseTimer);
    summaryCloseTimer = null;
    closingSummary = null;
  };

  const setCompanionOpen = (open, { everywhere = false } = {}) => {
    clearSummaryClose();
    if ((!hasCards && !hasSettings) || disposed) return;
    if (!usesStandalone()) {
      const trigger = findSummaryToggle("pinned") ?? findSummaryToggle("popover");
      if (trigger && summaryIsOpen(trigger) !== open) trigger.click();
      schedulePlacement();
      return;
    }
    if (open) {
      returnFocus = document.activeElement;
      failedRoom = new WeakMap();
    }
    // 同原生 toggle：overlay 档只开合浮层，其余档位改常驻开关。
    if (everywhere) pinned = popoverOpen = open;
    else if (displayMode === "overlay") popoverOpen = open;
    else pinned = open;
    if (open && usesStandalone()) {
      const trigger = openSummaryTrigger();
      if (trigger) {
        closingSummary = trigger;
        // 使用原生开关更新真实状态，不只隐藏 DOM；只响应这次播放器打开操作。
        drivingSummary = true;
        try { trigger.click(); } finally { drivingSummary = false; }
        // 原生更新可异步提交；确认关闭前不展示播放器，也不重复点击原生开关。
        summaryCloseTimer = setTimeout(() => {
          const stillOpen = openSummaryTrigger();
          clearSummaryClose();
          if (stillOpen) setCompanionOpen(false, { everywhere: true });
          else schedulePlacement();
        }, 1200);
      }
    }
    if (!open) {
      // 只在焦点仍属于播放器时还原，避免抢走用户已经移到 Codex 的焦点。
      if (document.activeElement === shell || document.activeElement === toolbarHost) {
        if (returnFocus?.isConnected && returnFocus !== shell) returnFocus.focus({ preventScroll: true });
        else (companionButton.hidden ? toolbarButton : companionButton).focus({ preventScroll: true });
      }
    }
    schedulePlacement();
  };
  const onNativeSummaryClick = (event) => {
    if (!usesStandalone() || drivingSummary || !wantsOpen()) return;
    const trigger = event.composedPath().find((node) => node instanceof HTMLButtonElement && matchesSummaryLabel(node));
    if (trigger) setCompanionOpen(false, { everywhere: true });
  };
  // 捕获阶段先撤下播放器，原生点击/键盘激活照常传播，不劫持 Toggle Summary。
  document.addEventListener("click", onNativeSummaryClick, true);
  // 「摘要下方」模式下点入口：卡片挂在原生 Summary 下面，摘要没开就用原生开关打开，卡片挂好后滚进视野；
  // 已经开着就只滚动。不在这里关摘要，关闭交给原生开关。
  const REVEAL_WINDOW_MS = 2000;
  let revealInlineUntil = 0;
  const revealInlineCards = () => {
    revealInlineUntil = performance.now() + REVEAL_WINDOW_MS;
    if (!(findSummaryPopover() ?? findFloatingSummary())) {
      const trigger = [findSummaryToggle("pinned"), findSummaryToggle("popover")].find((toggle) => toggle && !summaryIsOpen(toggle));
      trigger?.click();
    }
    schedulePlacement();
  };
  const onEntryClick = () => {
    if (!usesStandalone()) revealInlineCards();
    else setCompanionOpen(displayMode === "overlay" ? !popoverOpen : !pinned);
  };
  companionButton.addEventListener("click", onEntryClick);
  toolbarButton.addEventListener("click", onEntryClick);
  const onCompanionKeyDown = (event) => {
    if (event.key !== "Escape" || event.defaultPrevented || !wantsOpen()) return;
    // 只处理播放器自己的 Escape，避免抢占 Codex 的菜单和编辑器快捷键。
    if (!event.composedPath().includes(shell) && !event.composedPath().includes(toolbarHost)) return;
    event.preventDefault();
    event.stopPropagation();
    setCompanionOpen(false);
  };
  shell.addEventListener("keydown", onCompanionKeyDown);
  toolbarHost.addEventListener("keydown", onCompanionKeyDown);

  // 判定与平移都复用原生 Summary，不自己定阈值。
  // - 判定：原生是三个纯函数（overlay/shift/gutter 档位、可见面、会话平移量），导出名经压缩会变，
  //   按行为识别（pickNativeLayout）。随 Codex 打包方式变化，按以下顺序找，诊断 layoutSource 标出来源：
  //   1. "chunk"：Vite 打包时是独立的 thread-summary-panel-layout-*.js，按文件名找到后动态 import；
  //   2. "runtime"：26.1103 起改为 Rspack ESM，分包是 async/<数字>.<hash>.js，文件名不再可识别，
  //      页面 Resource Timing 也不记录 app:// 资源；但入口脚本导出 __webpack_require__。import 已执行
  //      的入口只取命名空间，在已实例化的模块（.c）里按工厂源码特征找到布局模块，用原生实例的导出。
  //      只读已实例化的模块，不主动执行原生工厂，避免提前触发原生副作用；
  //   3. "builtin"：26.1027 把函数并进 Vite 主 chunk 且不导出，前两种都找不到时用照抄原生的 BUILTIN_LAYOUT。
  // - 平移：原生在 [data-request-input-activity-root] 上写 --thread-content-x，会话与输入框的
  //   shiftWithTranscript 类据此 translate 并收窄宽块。我们只覆盖这一个变量。
  //   CSS Modules 命名随版本变：26.1027 及以前为 _shiftWithTranscript_<hash>，26.1103 起为
  //   shiftWithTranscript-<hash>，只按不带分隔符的类名主体匹配。
  //   平移钩子缺失或实测不生效时改用不依赖内部命名的让位方式（见 ROOM_DECLARATIONS）。
  const NATIVE_LAYOUT_CHUNK = /\/thread-summary-panel-layout-[\w-]+\.js(?:[?#]|$)/;
  // 布局模块是只有三个小函数的纯模块；限制长度，排除引用它的状态模块等大工厂。
  const isLayoutFactorySource = (source) => source.length < 2000 && source.includes("visibleSurface")
    && source.includes("isPopoverOpen") && source.includes('"shift"') && source.includes('"gutter"');
  let nativeLayout = null;
  let nativeLayoutSource = null;
  let nativeLayoutUrl = null;
  let nativeLayoutLoading = false;
  let nativeLayoutCheckedAt = -Infinity;
  // undefined：尚未查找；null：入口不是 Rspack ESM（Vite 版本），不再查找。
  let bundlerRuntime;
  // 已检查过的模块 id：分包懒加载会不断新增模块，每次只看新增的部分。
  const scannedRuntimeModules = new Set();
  // 照抄原生实现（26.1027、26.1103 相同）：留白=(会话宽-736)/2，<180 overlay，<400 shift，其余 gutter。
  const BUILTIN_LAYOUT = Object.freeze({
    resolveMode: (width, panelWidth = 300) => {
      const gutter = (width - 736) / 2;
      const extra = panelWidth - 300;
      return gutter < 180 + extra / 2 ? "overlay" : gutter < 400 + extra ? "shift" : "gutter";
    },
    contentOffset: ({ displayMode, isPinned, panelWidth = 300 }) => isPinned && displayMode === "shift" ? -(308 + panelWidth - 300) / 2 : 0,
    visibility: ({ displayMode, isPinned, isPopoverOpen }) => ({
      visibleSurface: isPinned && displayMode !== "overlay" ? "inline" : displayMode === "overlay" && isPopoverOpen ? "popover" : null
    })
  });
  const pickNativeLayout = (module) => {
    const exports = Object.values(module ?? {}).filter((value) => typeof value === "function");
    const probe = (fn, argument) => { try { return fn(argument); } catch { return undefined; } };
    const find = (matches) => exports.find((fn) => matches((argument) => probe(fn, argument)));
    const resolveMode = find((call) => call(0) === "overlay" && call(1300) === "shift" && call(2000) === "gutter");
    const contentOffset = find((call) => {
      const shifted = call({ displayMode: "shift", isPinned: true, panelWidth: PANEL_WIDTH });
      return typeof shifted === "number" && shifted < 0 && call({ displayMode: "gutter", isPinned: true }) === 0;
    });
    const visibility = find((call) => call({ displayMode: "shift", isPinned: true })?.visibleSurface === "inline"
      && call({ displayMode: "overlay", isPinned: true, isPopoverOpen: true })?.visibleSurface === "popover");
    return resolveMode && contentOffset && visibility ? { resolveMode, contentOffset, visibility } : null;
  };
  const findLayoutChunkUrl = () => [
    ...Array.from(document.querySelectorAll("link[href], script[src]"), (node) => node.href || node.src),
    ...(window.performance?.getEntriesByType?.("resource") ?? []).map((entry) => entry.name)
  ].find((candidate) => NATIVE_LAYOUT_CHUNK.test(candidate));
  const findBundlerRuntime = async () => {
    for (const script of document.querySelectorAll('script[type="module"][src]')) {
      try {
        const runtime = (await import(script.src))?.__webpack_require__;
        if (typeof runtime === "function" && runtime.c && runtime.m) return runtime;
      } catch {}
    }
    return null;
  };
  const scanBundlerRuntime = (runtime) => {
    for (const id of Object.keys(runtime.c)) {
      if (scannedRuntimeModules.has(id)) continue;
      scannedRuntimeModules.add(id);
      let source;
      try { source = Function.prototype.toString.call(runtime.m[id]); } catch { continue; }
      if (!isLayoutFactorySource(source)) continue;
      const layout = pickNativeLayout(runtime.c[id]?.exports);
      if (layout) return layout;
      reportError(new Error(`无法识别原生 Summary 布局模块 ${id} 的导出`));
    }
    return null;
  };
  const loadNativeLayout = () => {
    if (nativeLayout || nativeLayoutLoading) return;
    // 原生模块随会话页懒加载；未找到时每秒最多复查一次，不在流式输出时反复扫描。
    const now = performance.now();
    if (now - nativeLayoutCheckedAt < 1000) return;
    nativeLayoutCheckedAt = now;
    const adopt = (layout, source) => {
      if (!layout || nativeLayout || disposed) return;
      nativeLayout = layout;
      nativeLayoutSource = source;
      schedulePlacement();
    };
    let pending = null;
    const url = findLayoutChunkUrl();
    if (url && url !== nativeLayoutUrl) {
      nativeLayoutUrl = url;
      pending = import(url).then((module) => {
        const layout = pickNativeLayout(module);
        if (!layout) reportError(new Error("无法识别原生 Summary 布局模块的导出"));
        adopt(layout, "chunk");
      });
    } else if (bundlerRuntime !== null) {
      pending = (bundlerRuntime ? Promise.resolve(bundlerRuntime) : findBundlerRuntime()).then((runtime) => {
        bundlerRuntime = runtime;
        if (runtime) adopt(scanBundlerRuntime(runtime), "runtime");
      });
    }
    if (!pending) return;
    nativeLayoutLoading = true;
    pending.catch(reportError).finally(() => { nativeLayoutLoading = false; });
  };
  // mainContentTargetWidth 的 DOM 对应：会话布局根（含输入框）的宽度。只认 Codex 的具名钩子。
  const SHIFT_HOOK = '[class*="shiftWithTranscript"]';
  const measureHooks = () => {
    const content = Array.from(document.querySelectorAll("[data-thread-user-message-navigation-content]"))
      .find((node) => node.getBoundingClientRect().width > 0);
    const root = content?.closest("[data-request-input-activity-root]") ?? null;
    const frame = root ?? content?.closest(".thread-scroll-container") ?? null;
    const bounds = frame?.getBoundingClientRect() ?? null;
    return bounds && bounds.width > 0 && bounds.height > 0
      ? { bounds, frame, shiftRoot: root?.querySelector(SHIFT_HOOK) ? root : null, source: "hooks" }
      : { bounds: null, frame: null, shiftRoot: null, source: null };
  };
  // 宿主改版保障：上面的钩子都是 Codex 的内部命名，改版后可能一个也找不到。
  // 输入框（textarea / contenteditable / role=textbox）是聊天界面一定有的语义元素；
  // 它所在的主面板就是会话区，宽度与原生布局根一致，判档照常用原生公式。
  const findComposer = () => {
    let composer = null;
    let widest = 0;
    for (const node of document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]')) {
      const rect = node.getBoundingClientRect();
      if (rect.height > 0 && rect.width > widest) { composer = node; widest = rect.width; }
    }
    return composer;
  };
  // 主面板：包住 start 的、占据窗口大半高度的最外层祖先。优先取标题栏以下的（不动标题栏），
  // 其次取不占满整窗的（不含左侧栏），都没有时才是整个应用。
  const findThreadPane = (start) => {
    const tall = [];
    for (let node = start; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      const rect = node.getBoundingClientRect();
      if (rect.width > 0 && rect.height >= window.innerHeight / 2) tall.push({ node, rect });
    }
    return (tall.findLast(({ rect }) => rect.top >= 24) ?? tall.findLast(({ rect }) => rect.width < window.innerWidth - 8) ?? tall.at(-1))?.node ?? null;
  };
  const measureThread = () => {
    const hooks = measureHooks();
    if (hooks.bounds) return hooks;
    const composer = findComposer();
    const pane = composer ? findThreadPane(composer) : null;
    return pane
      ? { bounds: pane.getBoundingClientRect(), frame: pane, shiftRoot: null, composer, source: "composer" }
      : hooks;
  };
  const isShown = (node) => {
    const bounds = node.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0;
  };
  // 设置页左侧导航的自动化属性，Codex 自己也按它查找；已挂载但隐藏的页面不算。
  const SETTINGS_HOOK = "[data-settings-nav-scroll-container], [data-settings-panel-slug]";
  // Codex 应用外框。认得它，「找不到会话」才说明当前是别的页面，而不是宿主改版后钩子全失效。
  const APP_SHELL_HOOK = "[data-app-shell-frame]";
  // 只在会话页提供入口。conversation：会话（含新建会话页）；dot：Dot 会话，右上角有原生通话等浮动按钮；
  // settings：设置页；other：插件、技能等其余页面，右侧都是原生控件，抽屉会挡住点击；
  // unknown：连应用外框都认不出，按「自有界面不依赖宿主」保留入口。
  const classifyPage = () => {
    const shown = (selector) => Array.from(document.querySelectorAll(selector)).some(isShown);
    if (shown(SETTINGS_HOOK)) return "settings";
    const hooked = Boolean(measureHooks().bounds);
    // Dot 页也有输入框，这里只按具名钩子判断「不是普通会话」。
    if (!hooked && shown(".messaging-root")) return "dot";
    if (hooked || findComposer()) return "conversation";
    return shown(APP_SHELL_HOOK) ? "other" : "unknown";
  };
  let pageKind = null;
  const layoutResizeObserver = new ResizeObserver(() => schedulePlacement());
  let layoutObserved = null;
  const observeLayout = (element) => {
    if (element === layoutObserved) return;
    if (layoutObserved) layoutResizeObserver.unobserve(layoutObserved);
    layoutObserved = element;
    if (element) layoutResizeObserver.observe(element);
  };

  // 平移量由注册过的自定义属性驱动，才能与抽屉同时开始、同时结束地动画；
  // 样式表覆盖而非改写原生 inline style，关闭时恢复的是原生当前状态。
  const DOCK_SHIFT = "--agent-companion-dock-shift";
  let dockShiftAnimatable = false;
  if (typeof window.CSS?.registerProperty === "function") {
    try {
      window.CSS.registerProperty({ name: DOCK_SHIFT, syntax: "<length>", inherits: false, initialValue: "0px" });
      dockShiftAnimatable = true;
    } catch (error) {
      // 同一文档重新注入时已注册过，同样可以插值。
      dockShiftAnimatable = error?.name === "InvalidModificationError";
    }
  }
  const dockStyle = document.createElement("style");
  dockStyle.id = `${hostId}-dock-style`;
  let dockRoot = null;
  let dockKind = null;
  let dockBase = 0;
  let dockShift = 0;
  let dockAnimation = null;
  let threadSource = null;
  let roomFallbacks = 0;
  const stopDockAnimation = () => {
    const animation = dockAnimation;
    dockAnimation = null;
    animation?.cancel();
  };
  const clearConversationDock = () => {
    stopDockAnimation();
    dockShift = 0;
    dockStyle.remove();
    if (dockRoot) restoreNativeAttribute(dockRoot, "data-companion-dock");
    dockRoot = null;
    dockKind = null;
    dockBase = 0;
  };
  // 当前实际平移量（含进行中的动画），中途反向时从当前帧继续。
  const renderedDockShift = () => {
    const value = dockRoot ? parseFloat(getComputedStyle(dockRoot).getPropertyValue(DOCK_SHIFT)) : 0;
    return Number.isFinite(value) ? value : 0;
  };
  // 让位方式，按顺序尝试，前一种不可用或实测不生效才用后一种：
  // - native：覆盖原生的 --thread-content-x，与 Summary 完全一致；依赖 Codex 的内部钩子；
  // - pad：给主面板加右侧留白，会话与输入框由原生布局自己重新居中；不依赖任何内部命名；
  // - clamp：留白对该面板不起作用（如写死宽度）时，直接限制面板宽度。
  // 每种方式启用前先实测（probeRoom）：写入样式、同步读回位置、撤销，同一帧内完成，不会闪。
  // 不生效的记在节点上，本次打开期间不再尝试（避免每帧重复实测）；用户下次打开抽屉时重新实测。
  // 全部不行时抽屉浮在会话上方，与此前行为一致。
  const ROOM_WIDTH = PANEL_WIDTH + 24; // 抽屉宽度
  const ROOM_DECLARATIONS = {
    native: () => `--thread-content-x:calc(var(${DOCK_SHIFT}) * -1) !important;`,
    pad: (base) => `padding-right:calc(${base}px + var(${DOCK_SHIFT})) !important;`,
    // base 是面板右缘到窗口右缘的距离（启用前量得），窗口缩放后宽度上限随之重算。
    clamp: (base, root) => `max-width:calc(${Math.round(window.innerWidth - base - root.getBoundingClientRect().left)}px - var(${DOCK_SHIFT})) !important;`
  };
  let failedRoom = new WeakMap();
  const roomFailed = (node, kind) => failedRoom.get(node)?.has(kind) === true;
  const markRoomFailed = (node, kind) => {
    if (!failedRoom.has(node)) failedRoom.set(node, new Set());
    failedRoom.get(node).add(kind);
    roomFallbacks += 1;
  };
  const probeStyle = document.createElement("style");
  probeStyle.id = `${hostId}-dock-probe`;
  const probeRoom = (plan) => {
    // 收起动画还没走完就重新打开时，上一种让位方式的样式（如 clamp 的 max-width）和平移动画还留在节点上，
    // 会把它的效果算到这次实测的方式头上（例如 pad 实际不生效却被判为生效）。实测期间先撤下残留的让位样式，
    // 平移量直接写成数值、不读可能正被动画改写的变量；结束后原样放回，同一帧内完成，不会闪。
    const residual = dockStyle.isConnected;
    if (residual) dockStyle.remove();
    markNative(plan.root, "data-companion-dock-probe", "root");
    const declarations = ROOM_DECLARATIONS[plan.kind](plan.base, plan.root).replaceAll(`var(${DOCK_SHIFT})`, `${plan.shift}px`);
    probeStyle.textContent = `[data-companion-dock-probe="root"] { ${declarations} }`;
    document.documentElement.append(probeStyle);
    try { return plan.works(); } catch { return false; } finally {
      probeStyle.remove();
      restoreNativeAttribute(plan.root, "data-companion-dock-probe");
      if (residual) document.documentElement.append(dockStyle);
    }
  };
  // limit：让位后会话内容右缘不得超过的位置（抽屉左缘）。
  const roomPlans = function* ({ shiftRoot, frame, composer, target, limit }) {
    if (shiftRoot) {
      yield { kind: "native", root: shiftRoot, shift: target, base: 0, works: () => {
        // 原生样式把变量用作 translate；读回的位移与写入值一致才算生效。
        const moved = Number.parseFloat(getComputedStyle(shiftRoot.querySelector(SHIFT_HOOK)).translate);
        return Math.abs(moved + target) <= 1;
      } };
    }
    const input = composer ?? findComposer();
    const pane = findThreadPane(frame ?? input);
    if (!pane) return;
    const clear = (nodes) => nodes.length > 0 && nodes.every((node) => node.getBoundingClientRect().right <= limit + 1);
    const active = (kind) => dockRoot === pane && dockKind === kind;
    const inside = [frame, input].filter((node) => node && node !== pane && pane.contains(node));
    // 留白不改变面板自身的右缘，只能靠面板里的会话区或输入框来确认是否生效。
    if (inside.length) {
      yield { kind: "pad", root: pane, shift: ROOM_WIDTH, works: () => clear(inside),
        base: active("pad") ? dockBase : Number.parseFloat(getComputedStyle(pane).paddingRight) || 0 };
    }
    yield { kind: "clamp", root: pane, shift: ROOM_WIDTH, works: () => clear([pane, ...inside]),
      base: active("clamp") ? dockBase : Math.max(0, Math.round(window.innerWidth - pane.getBoundingClientRect().right)) };
  };
  const planRoom = (context) => {
    for (const plan of roomPlans(context)) {
      if (roomFailed(plan.root, plan.kind)) continue;
      // 正在使用的方式启用时已实测过。
      if ((plan.root === dockRoot && plan.kind === dockKind) || probeRoom(plan)) return plan;
      markRoomFailed(plan.root, plan.kind);
    }
    return null;
  };
  const dockConversation = (plan, { visible, animate }) => {
    // 抽屉已隐藏、原生 Summary 接管或没有可用的让位方式：立即交还，不与原生动画叠加。
    if (!visible || !plan) { clearConversationDock(); return; }
    const { root, kind, shift: target } = plan;
    const from = renderedDockShift();
    const sameRoot = root === dockRoot && kind === dockKind;
    if (!sameRoot) {
      // 原生替换了节点或换了让位方式：旧节点上的动画作废，在新节点上直接到位。
      clearConversationDock();
      dockRoot = root;
      dockKind = kind;
      dockBase = plan.base;
      markNative(root, "data-companion-dock", "root");
    }
    if (target !== dockShift) {
      // 只在开合之间动画；拖动窗口跨档位与原生一样直接跟随。
      const toggled = (target > 0) !== (dockShift > 0);
      if (animate && toggled && dockShiftAnimatable && !drawerMotion.matches && typeof root.animate === "function") {
        stopDockAnimation();
        const animation = root.animate([{ [DOCK_SHIFT]: `${sameRoot ? from : 0}px` }, { [DOCK_SHIFT]: `${target}px` }],
          motion(target > 0 ? "dockOpen" : "dockClose"));
        dockAnimation = animation;
        animation.finished.then(() => {
          if (dockAnimation !== animation) return;
          dockAnimation = null;
          // 平移回 0 后由下一轮放置移除标记和样式。
          if (!disposed) schedulePlacement();
        }).catch(() => {});
      } else stopDockAnimation();
      dockShift = target;
    }
    if (target === 0 && !dockAnimation) { clearConversationDock(); return; }
    const css = `[data-companion-dock="root"] { ${DOCK_SHIFT}:${target}px; ${ROOM_DECLARATIONS[kind](dockBase, root)} }`;
    if (dockStyle.textContent !== css) dockStyle.textContent = css;
    if (!dockStyle.isConnected) document.documentElement.append(dockStyle);
  };

  // 同一棵文档中的 moveBefore 保留焦点、iframe 与媒体的连接状态。
  // 老 Chromium 或原生已卸载的祖先只能 append；不重建 host/子树。
  const moveHost = (parent) => {
    if (host.parentElement === parent) return;
    if (host.isConnected && parent.isConnected && typeof parent.moveBefore === "function") {
      try { parent.moveBefore(host, null); return; } catch (error) {
        moveFallbacks += 1;
        reportError(error);
      }
    } else if (host.parentNode) moveFallbacks += 1;
    parent.append(host);
  };
  let inlineRail = null;
  const clearInlineRail = () => {
    inlineRail?.remove();
    inlineRail = null;
  };
  const ensureStandalonePlacement = () => {
    // 先迁移 host 再移除旧 rail；顺序反过来会断开正在播放的媒体。
    if (!shell.isConnected) document.documentElement.append(shell);
    moveHost(ownedRail);
    clearInlineRail();
    restorePopoverPanel();
    restoreAnimationColumn();
    restoreOuterScroller();
    const inToolbar = placeToolbarEntry();
    // Codex 启动画面只有 logo、没有任何按钮（入口在 ShadowRoot 内不计入）；此时不显示悬浮入口，
    // 等界面渲染出按钮后由 observer 重新放置。
    const appReady = Boolean(document.querySelector("button"));
    companionButton.hidden = inToolbar || !appReady;
    const drawerTop = inToolbar ? "48px" : "88px";
    ownedRail.style.top = drawerTop;
    ownedRail.style.maxHeight = `calc(100% - ${drawerTop})`;
    const nativeOpen = openSummaryTrigger();
    if (closingSummary && !nativeOpen) clearSummaryClose();
    if (wantsOpen() && nativeOpen && !closingSummary) setCompanionOpen(false, { everywhere: true });
    loadNativeLayout();
    const { bounds, frame, shiftRoot, composer, source } = measureThread();
    threadSource = source;
    observeLayout(shiftRoot ?? frame);
    const layout = nativeLayout ?? BUILTIN_LAYOUT;
    // pad / clamp 让位会收窄会话区；判档与抽屉定位都按让位前的尺寸算，否则会在两档之间来回跳。
    const narrows = dockRoot && dockKind !== "native" && frame
      && (dockRoot === frame ? dockKind === "clamp" : dockRoot.contains(frame));
    const narrowedBy = narrows ? renderedDockShift() : 0;
    const nextMode = bounds ? layout.resolveMode(bounds.width + narrowedBy, PANEL_WIDTH) : null;
    const modeChanged = nextMode !== displayMode;
    // 同原生：离开 overlay 档即收起浮层，常驻开关保留。
    if (modeChanged && nextMode !== "overlay") popoverOpen = false;
    displayMode = nextMode;
    const surface = nativeOpen ? null
      : nextMode ? layout.visibility({ displayMode: nextMode, isPinned: pinned, isPopoverOpen: popoverOpen }).visibleSurface
        : (wantsOpen() ? "floating" : null);
    const open = surface !== null;
    ownedRail.dataset.surface = surface ?? "none";
    const drawerRight = bounds ? Math.max(0, window.innerWidth - bounds.right - narrowedBy) : 0;
    ownedRail.style.right = `${drawerRight}px`;
    toolbarButton.setAttribute("aria-expanded", String(open));
    setDrawerVisible(open);
    // 收起时会话与抽屉同时回位；关闭期间抽屉仍可见。
    const target = surface === "inline"
      ? Math.round(-layout.contentOffset({ displayMode: nextMode, isPinned: true, panelWidth: PANEL_WIDTH }))
      : 0;
    // 收起时沿用当前方式回到 0；需要让位时按 native → pad → clamp 选第一个实测生效的。
    const plan = nativeOpen ? null
      : target > 0 ? planRoom({ shiftRoot, frame, composer, target, limit: window.innerWidth - drawerRight - ROOM_WIDTH })
        : dockRoot?.isConnected ? { kind: dockKind, root: dockRoot, shift: 0, base: dockBase } : null;
    dockConversation(plan, { visible: !ownedRail.hidden, animate: !modeChanged });
    companionButton.setAttribute("aria-expanded", String(open));
    syncNativeStyles(null);
    placementMode = open ? "standalone" : "hidden";
    notifyVisibility(open, "standalone");
    return open;
  };

  const ensurePlacement = () => {
    if (disposed) return false;
    if (!hasCards && !hasSettings) {
      resetLayout(true);
      notifyVisibility(false, "no-cards");
      return false;
    }
    // 不是会话页（见 classifyPage）就不提供入口与抽屉；开关状态保留，回到会话后照常恢复。
    pageKind = classifyPage();
    if (pageKind !== "conversation" && pageKind !== "unknown") {
      resetLayout(false);
      companionButton.hidden = true;
      notifyVisibility(false, `${pageKind}-page`);
      return false;
    }
    // 新版/空会话可能没有 Summary。设置入口不能因此失联；原生入口出现后恢复原 placement。
    const pinnedToggle = findSummaryToggle("pinned");
    const popoverToggle = findSummaryToggle("popover");
    if (!standalone) {
      const summaryOpen = pinnedToggle?.getAttribute("aria-pressed") === "true" || popoverToggle?.getAttribute("data-state") === "open";
      const located = Boolean(findSummaryPopover() ?? findFloatingSummary());
      if (located) summaryUnsupported = false;
      if (summaryOpen && !located && !summaryUnsupported) {
        const now = performance.now();
        summaryUnlocatedSince ||= now;
        if (now - summaryUnlocatedSince >= UNLOCATED_SUMMARY_GRACE_MS) summaryUnsupported = true;
        else if (!summaryUnlocatedTimer) {
          summaryUnlocatedTimer = setTimeout(() => { summaryUnlocatedTimer = null; schedulePlacement(); }, UNLOCATED_SUMMARY_GRACE_MS + 50);
        }
      } else summaryUnlocatedSince = 0;
    }
    const nextFallback = !standalone && (summaryUnsupported || (hasSettings && !pinnedToggle && !popoverToggle));
    if (nextFallback !== inlineEntryFallback) {
      drawerAnimation?.cancel();
      drawerAnimation = null;
      drawerOpen = false;
      ownedRail.hidden = true;
      ownedRail.inert = true;
      inlineEntryFallback = nextFallback;
    }
    if (usesStandalone()) return ensureStandalonePlacement();
    clearConversationDock();
    observeLayout(null);
    // 隐藏时保留同一个已连接的 rail；只有原生自己删除父节点才迁移到停车区。
    const summary = findSummaryPopover() ?? findFloatingSummary();
    if (!summary) {
      restorePopoverPanel();
      restoreAnimationColumn();
      restoreOuterScroller();
      syncResizeObservation();
      if (!shell.isConnected) document.documentElement.append(shell);
      if (!host.isConnected) {
        moveHost(ownedRail);
        clearInlineRail();
      }
      if (inlineRail) { inlineRail.hidden = true; inlineRail.style.display = "none"; inlineRail.inert = true; }
      ownedRail.hidden = true;
      // 摘要没打开时卡片不显示，但入口要留着：否则在新建会话页（没有摘要开关，走独立入口）看得到入口，
      // 进了会话入口就整个消失，像是没加载。点入口用原生开关打开摘要（见 revealInlineCards）。
      // 顶栏放不下时同独立模式一样退到悬浮按钮。
      const inToolbar = placeToolbarEntry();
      companionButton.hidden = inToolbar || !document.querySelector("button");
      toolbarButton.setAttribute("aria-expanded", "false");
      companionButton.setAttribute("aria-expanded", "false");
      placementMode = "hidden";
      notifyVisibility(false, "summary-hidden");
      return false;
    }
    // 摘要开着时顶栏入口照样留着，位置不跟着摘要开合跳动；悬浮按钮会压住面板，不显示。
    placeToolbarEntry();
    companionButton.hidden = true;
    toolbarButton.setAttribute("aria-expanded", "true");
    const { mountParent, nativePanel, styleRoot } = summary;
    if (summary.mode === "summary-popover") {
      preservePopoverPanel(nativePanel);
      restoreAnimationColumn();
    } else {
      restorePopoverPanel();
      configureAnimationColumn(mountParent);
    }
    configureOuterScroller(summary);
    if (!inlineRail || inlineRail.parentElement !== mountParent || inlineRail.dataset.mode !== summary.mode) {
      const previous = inlineRail;
      inlineRail = createRail(summary);
      moveHost(inlineRail);
      previous?.remove();
    }
    inlineRail.hidden = false;
    inlineRail.style.display = "block";
    inlineRail.inert = false;
    if (summary.mode === "animated-summary") positionAnimatedRail(inlineRail, mountParent, nativePanel);
    moveHost(inlineRail);
    ownedRail.hidden = true;
    syncNativeStyles(styleRoot);
    syncResizeObservation(mountParent, nativePanel);
    placementMode = summary.mode;
    notifyVisibility(true, "summary-visible");
    // 从入口点进来的：卡片挂好后滚进视野一次。超过时限（摘要没能打开）就不再滚，免得之后手动开摘要时突然跳动。
    if (revealInlineUntil) {
      if (performance.now() <= revealInlineUntil) inlineRail.scrollIntoView?.({ block: "nearest", behavior: drawerMotion.matches ? "auto" : "smooth" });
      revealInlineUntil = 0;
    }
    return true;
  };

  // 显式状态变化（开关、放置方式、动画结束等）在微任务里立即补位。
  const schedulePlacement = () => {
    if (disposed || placementQueued) return;
    placementQueued = true;
    queueMicrotask(() => {
      placementQueued = false;
      runPlacement();
    });
  };

  // DOM mutation 按帧合并：rAF 回调在本帧绘制前执行，Codex 改动标题栏后同一帧内
  // 就能补位，不会闪；流式输出时每帧最多跑一次扫描。窗口不可见时浏览器暂停 rAF，
  // 回到前台的第一帧再统一补一次。
  const scheduleObservedPlacement = () => {
    if (disposed || placementQueued || placementFrame) return;
    if (typeof window.requestAnimationFrame !== "function") {
      schedulePlacement();
      return;
    }
    placementFrame = window.requestAnimationFrame(() => {
      placementFrame = 0;
      if (!placementQueued) runPlacement();
    });
  };

  const observer = new MutationObserver(scheduleObservedPlacement);

  // MutationObserver 只看 DOM/属性变化：纯窗口 resize、原生面板因内容换行改高度
  // （无 mutation）时 rail 的 top/宽度会陈旧 → 卡片与原生面板之间重叠或空档。
  // ResizeObserver 盯挂载列与原生面板的尺寸变化，window resize 盯位置变化
  // （bounds 移动但尺寸不变时 RO 不触发），两者都复用 schedulePlacement 去抖。
  const resizeObserver = new ResizeObserver(schedulePlacement);
  let resizeObserved = [];
  const syncResizeObservation = (...elements) => {
    const next = elements.filter(Boolean);
    if (
      next.length === resizeObserved.length
      && next.every((element, index) => element === resizeObserved[index])
    ) return;
    for (const element of resizeObserved) resizeObserver.unobserve(element);
    resizeObserved = next;
    for (const element of resizeObserved) resizeObserver.observe(element);
  };
  window.addEventListener("resize", schedulePlacement);

  // 关键：ensurePlacement 自身会改 DOM（隐藏原生面板、写 rail 定位、同步样式等），
  // 这些改动又会被 observer 捕获并再次触发 schedulePlacement，形成微任务风暴（渲染冻结）。
  // 因此运行放置逻辑时先断开 observer，跑完再重连并清空期间自产生的 records。
  const runPlacement = () => {
    observer.disconnect();
    const startedAt = performance.now();
    try {
      syncShellLayer();
      return ensurePlacement();
    } catch (error) {
      reportError(error);
      restorePopoverPanel();
      restoreAnimationColumn();
      restoreOuterScroller();
      clearConversationDock();
      fallbackActive = true;
      try { return ensureStandalonePlacement(); } catch (fallbackError) {
        reportError(fallbackError);
        resetLayout(false);
        notifyVisibility(false, "placement-error");
        return false;
      }
    } finally {
      const elapsed = performance.now() - startedAt;
      placementStats.runs += 1;
      placementStats.totalMs += elapsed;
      placementStats.maxMs = Math.max(placementStats.maxMs, elapsed);
      if (!disposed) {
        observer.takeRecords();
        observer.observe(document.documentElement, {
          childList: true, subtree: true, attributes: true,
          attributeFilter: ["style", "class", "aria-pressed", "aria-expanded", "aria-controls", "data-state"]
        });
      }
    }
  };

  const resetLayout = (detach) => {
    clearSummaryClose();
    drawerAnimation?.cancel();
    drawerAnimation = null;
    drawerOpen = false;
    ownedRail.hidden = true;
    ownedRail.inert = true;
    restorePopoverPanel();
    restoreAnimationColumn();
    restoreOuterScroller();
    clearConversationDock();
    observeLayout(null);
    syncResizeObservation();
    toolbarHost.remove();
    if (detach) {
      host.remove();
      clearInlineRail();
      shell.remove();
    } else {
      if (!shell.isConnected) document.documentElement.append(shell);
      moveHost(ownedRail);
      clearInlineRail();
      companionButton.hidden = false;
    }
    placementMode = "hidden";
  };
  const api = Object.freeze({
    setPlacement(value) {
      validatePlacement(value);
      if (disposed || placement === value) return;
      clearSummaryClose();
      drawerAnimation?.cancel();
      drawerAnimation = null;
      drawerOpen = false;
      ownedRail.hidden = true;
      pinned = popoverOpen = false;
      placement = value;
      standalone = value === "standalone-button";
      summaryUnsupported = false;
      summaryUnlocatedSince = 0;
      fallbackActive = false;
      runPlacement();
    },
    setHasCards(value) {
      if (disposed || hasCards === Boolean(value)) return;
      hasCards = Boolean(value);
      if (!hasCards && !hasSettings) pinned = popoverOpen = false;
      runPlacement();
    },
    setOpen(value) { setCompanionOpen(Boolean(value)); },
    isOpen: () => !disposed && Boolean(lastVisibility?.visible),
    isPlaced: () => !disposed && (hasCards || hasSettings) && host.isConnected && placementMode !== "hidden",
    getDiagnostics: () => ({ placement, mode: placementMode, visible: !disposed && Boolean(lastVisibility?.visible), hasCards, hasSettings, disposed, fallbackActive, inlineEntryFallback, summaryUnsupported, moveFallbacks,
      nativeLayout: Boolean(nativeLayout), layoutSource: nativeLayoutSource ?? "builtin", displayMode, drawerSurface: ownedRail.dataset.surface ?? "none", dockShift,
      // 宿主适配落在哪一级：entry 入口锚点，thread 会话区来源（hooks 具名钩子 / composer 按输入框），
      // room 当前让位方式（native / pad / clamp），roomFallbacks 实测不生效而降级的次数。
      // page 当前页面类型（conversation / dot / settings / other / unknown），只有会话页显示入口。
      entry: entryAnchor, thread: threadSource, room: dockKind, roomFallbacks, page: pageKind, placementStats: { ...placementStats } }),
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(summaryUnlocatedTimer);
      if (placementFrame) window.cancelAnimationFrame?.(placementFrame);
      observer.disconnect();
      resizeObserver.disconnect();
      layoutResizeObserver.disconnect();
      window.removeEventListener("resize", schedulePlacement);
      document.removeEventListener("click", onNativeSummaryClick, true);
      shell.removeEventListener("keydown", onCompanionKeyDown);
      toolbarHost.removeEventListener("keydown", onCompanionKeyDown);
      companionButton.removeEventListener("click", onEntryClick);
      toolbarButton.removeEventListener("click", onEntryClick);
      resetLayout(true);
      for (const [property, { value, priority }] of hostStyles) {
        if (value) host.style.setProperty(property, value, priority);
        else host.style.removeProperty(property);
      }
      hostStyles.clear();
      notifyVisibility(false, "disposed");
    }
  });
  runPlacement();
  return api;
}
