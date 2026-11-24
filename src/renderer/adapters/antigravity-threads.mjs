/**
 * Antigravity 的会话定位：当前会话取自地址 `/c/<会话 id>`，打开会话走 Hub 自己的路由（TanStack Router，
 * 浏览器 history）。不读、不改侧栏 DOM；侧栏颜色标记暂不支持（setMarks 只记下不画）。
 */
export function createAntigravityThreads({ document, onError } = {}) {
  const window = document.defaultView;
  // 与 Codex 版同一套看板颜色，顺序即分配颜色的顺序。
  const COLORS = Object.freeze(["#3fb37f", "#3b8ff0", "#f08a36", "#ee6b8f", "#a07ae8", "#1fb0bc", "#e6b422", "#3f3ca8"]);
  const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ROUTE = /\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i;
  const listeners = new Set();
  let disposed = false;
  let timer = 0;
  let lastPath = window.location.pathname;

  const currentId = () => ROUTE.exec(window.location.pathname)?.[1]?.toLowerCase() ?? null;
  // 会话页的窗口标题是「会话标题 - 项目 - Antigravity」；没有项目时是「会话标题 - Antigravity」。
  // 标题本身可能带 " - "，所以只从右边剥掉固定的后缀和项目名。
  const currentTitle = () => {
    const parts = String(document.title ?? "").split(" - ");
    if (parts.length < 2 || parts.at(-1).trim() !== "Antigravity") return null;
    const rest = parts.slice(0, -1);
    const title = (rest.length > 1 ? rest.slice(0, -1) : rest).join(" - ").trim();
    return title && title !== "Antigravity" ? title.slice(0, 200) : null;
  };
  const notify = () => {
    for (const listener of [...listeners]) {
      try { listener(); } catch (error) { try { onError?.(error); } catch {} }
    }
  };
  // Hub 用 pushState 切页，没有可订阅的事件；不去改写 history，低频比对地址即可。
  const check = () => {
    if (window.location.pathname === lastPath) return;
    lastPath = window.location.pathname;
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
    const state = window.history.state ?? {};
    const index = (Number.isInteger(state.__TSR_index) ? state.__TSR_index : 0) + 1;
    const key = Math.random().toString(36).slice(2, 10);
    window.history.pushState({ __TSR_index: index, key, __TSR_key: key }, "", `/c/${id}`);
    window.dispatchEvent(new window.PopStateEvent("popstate", { state: window.history.state }));
  }

  return Object.freeze({
    colors: COLORS,
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
    setMarks() {},
    async reveal(id) {
      if (disposed || !CONVERSATION_ID.test(id ?? "")) return { ok: false, reason: "invalid" };
      try {
        if (currentId() !== id.toLowerCase()) navigate(id.toLowerCase());
        check();
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
    }
  });
}
