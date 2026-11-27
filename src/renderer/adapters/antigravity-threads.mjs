/**
 * Antigravity 的会话定位：当前会话取自地址 `/c/<会话 id>`，打开会话走 Hub 自己的路由（TanStack Router，
 * 浏览器 history）。
 *
 * 侧栏颜色标记：会话条目按稳定程度分两级找——侧栏条目里的自动化属性 `[data-sidebar-row-id] [data-cascade-id]`
 * （值即会话 id；正文区的对话容器也带 data-cascade-id，但不在侧栏条目里，不能单用它），
 * 再退到指向 `/c/<会话 id>` 的链接所在的、高度像一行条目的元素。只在条目上加 `data-agent-companion-task`，
 * 由自己的样式表画底色和左侧竖条，不改原生 class / style；React 重绘替换节点后下一帧补回。
 */
export function createAntigravityThreads({ document, onError } = {}) {
  const window = document.defaultView;
  // 与 Codex 版同一套看板颜色，顺序即分配颜色的顺序。
  const COLORS = Object.freeze(["#3fb37f", "#3b8ff0", "#f08a36", "#ee6b8f", "#a07ae8", "#1fb0bc", "#e6b422", "#3f3ca8"]);
  const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ROUTE = /\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i;
  const MARK = "data-agent-companion-task";
  const LANDING = "data-agent-companion-task-landing";
  const STYLE_ID = "agent-companion-thread-marks";
  const ROW_ATTR = "data-cascade-id";
  const MAX_ROW_HEIGHT = 72;
  const LINK = /^\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
  const listeners = new Set();
  const marks = new Map();
  let observer = null;
  let frame = 0;
  let styled = false;
  let disposed = false;
  let timer = 0;
  let lastPath = window.location.pathname;
  let lastRawTitle = String(document.title ?? "");
  // 这份 document.title 最初是在哪个 pathname 下看到的：切页后 Antigravity 先改地址、
  // 稍后才更新窗口标题，在标题真正变成新值之前不能把上一个会话的标题套给当前会话。
  let titleOwnerPath = lastPath;
  let notifiedKey = `${lastPath}\u0000${lastRawTitle}`;

  function syncRoute() {
    const path = window.location.pathname;
    const raw = String(document.title ?? "");
    if (raw !== lastRawTitle) {
      lastRawTitle = raw;
      titleOwnerPath = path;
    }
    if (path !== lastPath) lastPath = path;
  }

  const currentId = () => ROUTE.exec(window.location.pathname)?.[1]?.toLowerCase() ?? null;
  // 会话页的窗口标题是「会话标题 - 项目 - Antigravity」；没有项目时是「会话标题 - Antigravity」。
  // 标题本身可能带 " - "，所以只从右边剥掉固定的后缀和项目名。
  const currentTitle = () => {
    syncRoute();
    if (titleOwnerPath !== lastPath) return null;
    const parts = lastRawTitle.split(" - ");
    if (parts.length < 2 || parts.at(-1).trim() !== "Antigravity") return null;
    const rest = parts.slice(0, -1);
    const title = (rest.length > 1 ? rest.slice(0, -1) : rest).join(" - ").trim();
    return title && title !== "Antigravity" ? title.slice(0, 200) : null;
  };

  // 侧栏会话条目：[{ row, id }]。第一级没有命中时才退到链接。
  function rows() {
    const found = [];
    for (const row of document.querySelectorAll(`[data-sidebar-row-id] [${ROW_ATTR}]`)) {
      const id = row.getAttribute(ROW_ATTR);
      if (CONVERSATION_ID.test(id ?? "")) found.push({ row, id: id.toLowerCase() });
    }
    if (found.length) return found;
    for (const link of document.querySelectorAll('a[href^="/c/"]')) {
      const id = LINK.exec(link.getAttribute("href") ?? "")?.[1];
      const row = link.parentElement;
      // 几何兜底：只认一行高的条目，避免把整块正文区当成会话条目。
      const height = row?.getBoundingClientRect().height ?? 0;
      if (id && row && height > 0 && height <= MAX_ROW_HEIGHT) found.push({ row, id: id.toLowerCase() });
    }
    return found;
  }
  function ensureStyle() {
    styled = true;
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = [
      "@property --agent-companion-tint{syntax:'<color>';inherits:false;initial-value:transparent}",
      ...COLORS.map((color, index) => `[${MARK}="${index}"]{--agent-companion-task:${color}}`),
      // background-image 叠在原生 hover / 选中背景之上，不覆盖它们。
      `[${MARK}]{--agent-companion-tint:color-mix(in srgb,var(--agent-companion-task) 13%,transparent);background-image:linear-gradient(var(--agent-companion-tint),var(--agent-companion-tint))!important;box-shadow:inset 2px 0 0 color-mix(in srgb,var(--agent-companion-task) 85%,transparent)}`,
      `[${MARK}][${LANDING}]{animation:agent-companion-task-land .7s ease-out}`,
      "@keyframes agent-companion-task-land{0%{--agent-companion-tint:color-mix(in srgb,var(--agent-companion-task) 34%,transparent)}100%{--agent-companion-tint:color-mix(in srgb,var(--agent-companion-task) 13%,transparent)}}",
      `@media (prefers-reduced-motion:reduce){[${MARK}][${LANDING}]{animation:none}}`
    ].join("\n");
    (document.head ?? document.documentElement).append(style);
  }
  function applyMarks() {
    frame = 0;
    if (disposed) return;
    try {
      for (const { row, id } of rows()) {
        const color = marks.get(id);
        const value = color === undefined ? null : String(color);
        if (row.getAttribute(MARK) === value) continue;
        if (value === null) row.removeAttribute(MARK);
        else row.setAttribute(MARK, value);
      }
    } catch (error) { try { onError?.(error); } catch {} }
  }
  const scheduleMarks = () => { if (!frame && !disposed) frame = window.requestAnimationFrame(applyMarks); };
  // 有标记时才观察；回复输出期间正文区一直在变，只理会新增 / 移除了节点或会话 id 变了的记录，按帧合并。
  function syncObserver() {
    const needed = !disposed && marks.size > 0;
    if (needed && !observer) {
      observer = new window.MutationObserver((records) => {
        if (records.some((record) => record.type === "attributes" || record.addedNodes.length || record.removedNodes.length)) scheduleMarks();
      });
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: [ROW_ATTR, "href"] });
    } else if (!needed && observer) {
      observer.disconnect();
      observer = null;
    }
  }
  function land(id) {
    const entry = rows().find((item) => item.id === id && item.row.hasAttribute(MARK));
    if (!entry) return;
    entry.row.removeAttribute(LANDING);
    void entry.row.offsetWidth;
    entry.row.setAttribute(LANDING, "");
    window.setTimeout(() => entry.row.removeAttribute(LANDING), 800);
  }

  const notify = () => {
    for (const listener of [...listeners]) {
      try { listener(); } catch (error) { try { onError?.(error); } catch {} }
    }
  };
  // Hub 用 pushState 切页，没有可订阅的事件；不去改写 history，低频比对地址与窗口标题即可。
  const check = () => {
    syncRoute();
    const key = `${lastPath}\u0000${lastRawTitle}`;
    if (key === notifiedKey) return;
    notifiedKey = key;
    notify();
  };
  const syncWatch = () => {
    if (!disposed && listeners.size && !timer) {
      timer = window.setInterval(check, 400);
      window.addEventListener("popstate", check);
    } else if ((disposed || !listeners.size) && timer) {
      window.clearInterval(timer);
      timer = 0;
      window.removeEventListener("popstate", check);
    }
  };

  // 补一条带 __TSR_index 的历史记录再发 popstate，路由当成一次前进导航处理，不刷新页面。
  function navigate(id) {
    // 切页前先记下旧路由对应的窗口标题，避免 popstate 同步触发 render 时误用旧标题。
    syncRoute();
    const state = window.history.state ?? {};
    const index = (Number.isInteger(state.__TSR_index) ? state.__TSR_index : 0) + 1;
    const key = Math.random().toString(36).slice(2, 10);
    window.history.pushState({ __TSR_index: index, key, __TSR_key: key }, "", `/c/${id}`);
    window.dispatchEvent(new window.PopStateEvent("popstate", { state: window.history.state }));
  }

  return Object.freeze({
    colors: COLORS,
    // 窗口标题异步更新且无会话 id 绑定，仅在后台摘要还没有标题时作兜底，不覆盖后台给出的真实标题。
    titleFallback: true,
    current() {
      const id = currentId();
      return id ? { id, title: currentTitle(), projectId: null } : null;
    },
    // 会话不需要在侧栏可见也能直接打开，合法的会话 id 都算「找得到」。
    has(id) { return CONVERSATION_ID.test(id ?? ""); },
    // 只知道当前打开的会话的标题；其它会话的名字由后台从会话摘要里补。
    title(id) { return id && id.toLowerCase() === currentId() ? currentTitle() : null; },
    projectLabel() { return null; },
    subscribe(listener) {
      if (disposed || typeof listener !== "function") return () => {};
      listeners.add(listener);
      syncWatch();
      return () => { listeners.delete(listener); syncWatch(); };
    },
    // entries: [{ id, color }]，color 为 COLORS 下标；整体替换上一次的标记。
    setMarks(entries = []) {
      if (disposed) return;
      marks.clear();
      for (const { id, color } of entries) {
        if (CONVERSATION_ID.test(id ?? "") && Number.isInteger(color) && color >= 0 && color < COLORS.length) marks.set(id.toLowerCase(), color);
      }
      if (marks.size) ensureStyle();
      applyMarks();
      syncObserver();
    },
    async reveal(id) {
      if (disposed || !CONVERSATION_ID.test(id ?? "")) return { ok: false, reason: "invalid" };
      try {
        if (currentId() !== id.toLowerCase()) navigate(id.toLowerCase());
        check();
        // 落点闪一下只是点缀，失败不影响跳转结果。
        if (marks.has(id.toLowerCase())) { try { land(id.toLowerCase()); } catch (error) { try { onError?.(error); } catch {} } }
        return { ok: true };
      } catch (error) {
        try { onError?.(error); } catch {}
        return { ok: false, reason: "error" };
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      syncWatch();
      if (frame) window.cancelAnimationFrame(frame);
      marks.clear();
      syncObserver();
      // 从没画过标记就不碰页面。
      if (!styled) return;
      for (const row of document.querySelectorAll(`[${MARK}], [${LANDING}]`)) { row.removeAttribute(MARK); row.removeAttribute(LANDING); }
      document.getElementById(STYLE_ID)?.remove();
    }
  });
}
