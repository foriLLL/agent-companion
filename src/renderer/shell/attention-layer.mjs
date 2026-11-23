// 平台提醒层：声明了 attention 能力的卡片发出提醒，由平台决定显示与否、要不要暂停正在播放的媒体。
// - 媒体指所有卡片 ShadowRoot 里的 <video> / <audio>。媒体事件不冒泡，但捕获阶段会经过所在的
//   ShadowRoot，所以平台在每个卡片根上做捕获监听，播放类卡片不用登记播放器；
// - 默认只在有媒体播放时提醒：没在看视频时，卡片自己的提示就够了，也不和 Codex 的系统通知重复；
// - 面板放进浏览器顶层（popover），视频全屏时也盖在画面上；全屏切换后重新打开一次，排到全屏元素之上；
// - 不全屏时贴在正在看的视频左侧（放不下就放到视频下方），不挡画面；全屏时在右上角；
// - 被平台暂停的媒体记下来，「继续播放」只恢复这些；用户自己点了播放的不再归平台管。
// 宿主节点不声明 -webkit-app-region（铺满整窗的 no-drag 会让窗口拖不动），也不接收指针事件。

const AUTO_DISMISS_MS = 6000;
const MAX_VISIBLE = 3;
const MEDIA_EVENTS = ["play", "playing", "pause", "ended", "emptied"];
const SEP = "\u0000";

const STYLE = `
  .panel{position:fixed;inset:auto;top:52px;right:16px;margin:0;box-sizing:border-box;width:320px;max-width:calc(100vw - 32px);
    padding:6px;border:0;border-radius:16px;overflow:hidden;pointer-events:auto;
    color:var(--color-token-text-primary,CanvasText);background:var(--color-token-dropdown-background,Canvas);
    box-shadow:0 0 0 .5px var(--color-token-border-heavy,rgba(0,0,0,.14)),0 12px 32px rgba(0,0,0,.18),0 2px 8px rgba(0,0,0,.08);
    font:13px/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;letter-spacing:-.006em}
  .panel[data-fullscreen="true"]{top:16px}
  .panel:popover-open{animation:in .18s cubic-bezier(.2,.8,.2,1) both}
  @keyframes in{from{opacity:0;transform:translateY(-6px) scale(.98)}}
  .panel *{box-sizing:border-box}
  ul{list-style:none;margin:0;padding:0;display:grid;gap:2px}
  li{--task:#8b8d98;display:grid;grid-template-columns:3px minmax(0,1fr) auto;column-gap:10px;align-items:center;
    padding:8px 8px 8px 6px;border-radius:10px}
  li[data-tone="attention"]{background:color-mix(in srgb,var(--task) 11%,transparent)}
  .bar{align-self:stretch;border-radius:2px;background:var(--task)}
  .body{min-width:0}
  strong{display:block;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .text{display:block;margin-top:1px;font-size:12px;color:var(--color-token-text-secondary,color-mix(in srgb,currentColor 65%,transparent))}
  .detail{display:-webkit-box;margin-top:2px;font-size:12px;overflow:hidden;-webkit-line-clamp:2;-webkit-box-orient:vertical;
    color:var(--color-token-text-tertiary,color-mix(in srgb,currentColor 50%,transparent))}
  .detail:empty{display:none}
  .more{margin:4px 8px 0;font-size:12px;color:var(--color-token-text-tertiary,color-mix(in srgb,currentColor 50%,transparent))}
  footer{display:flex;align-items:center;gap:6px;padding:6px 2px 2px 8px}
  .state{margin-right:auto;font-size:12px;color:var(--color-token-text-tertiary,color-mix(in srgb,currentColor 50%,transparent))}
  button{display:inline-flex;align-items:center;justify-content:center;flex:none;height:26px;padding:0 10px;
    border:1px solid var(--color-token-border-heavy,color-mix(in srgb,currentColor 14%,transparent));border-radius:8px;
    background:transparent;color:inherit;font:inherit;font-size:12px;font-weight:500;cursor:pointer}
  button:hover{background:var(--color-token-list-hover-background,color-mix(in srgb,currentColor 6%,transparent))}
  button.primary{border-color:transparent;background:var(--color-token-text-primary,CanvasText);color:var(--color-token-dropdown-background,Canvas)}
  button.primary:hover{opacity:.86}
  button:focus-visible{outline:2px solid var(--color-token-focus-border,#3a83f7);outline-offset:1px}
  [hidden]{display:none!important}
  @media (prefers-reduced-motion:reduce){.panel:popover-open{animation:none}}
`;

export function createAttentionLayer({ document: doc, onError = () => {}, autoDismissMs = AUTO_DISMISS_MS }) {
  const win = doc?.defaultView ?? globalThis;
  const items = new Map();
  const roots = new Set();
  const paused = new Set();
  const listeners = new Set();
  let playing = false;
  let host = null;
  let panel = null;
  // 提醒时正在播放的媒体：面板挨着它放。
  let anchor = null;
  let disposed = false;

  const report = (error) => { try { onError(error); } catch {} };
  const mediaIn = (root) => Array.from(root.querySelectorAll?.("video, audio") ?? []);
  const playingMedia = () => [...roots].flatMap(mediaIn).filter((media) => !media.paused && !media.ended);
  const pausedMedia = () => [...paused].filter((media) => media.isConnected && media.paused);

  function changed() {
    for (const listener of [...listeners]) {
      try { listener(); } catch (error) { report(error); }
    }
  }
  function syncPlaying() {
    const next = playingMedia().length > 0;
    if (next === playing) return;
    playing = next;
    changed();
  }
  function onMediaEvent(event) {
    // 用户自己恢复播放：「继续播放」不再管它。
    if (event.type === "play" && paused.delete(event.target)) render();
    syncPlaying();
  }
  // 全屏：右上角（样式默认值）。不全屏：贴在视频左侧，顶端对齐；左侧放不下就放到视频下方；都不行用默认位置。
  function place() {
    const fullscreen = Boolean(doc.fullscreenElement);
    panel.dataset.fullscreen = String(fullscreen);
    panel.style.removeProperty("top");
    panel.style.removeProperty("right");
    const rect = !fullscreen && anchor?.isConnected ? anchor.getBoundingClientRect() : null;
    if (!rect?.width || !rect.height) return;
    const viewport = win.innerWidth;
    const width = Math.min(320, viewport - 32);
    if (rect.left >= width + 24) {
      panel.style.top = `${Math.round(Math.max(52, rect.top))}px`;
      panel.style.right = `${Math.round(viewport - rect.left + 12)}px`;
    } else if (rect.bottom + 8 + (panel.offsetHeight || 140) <= win.innerHeight - 12) {
      panel.style.top = `${Math.round(rect.bottom + 8)}px`;
      panel.style.right = `${Math.round(Math.max(16, viewport - rect.right))}px`;
    }
  }
  function onFullscreenChange() {
    if (!panel?.matches(":popover-open")) return;
    // 全屏元素后进顶层会盖住面板；重新打开一次排到它上面。
    place();
    try { panel.hidePopover(); panel.showPopover(); } catch (error) { report(error); }
  }
  function onResize() {
    if (panel?.matches(":popover-open")) place();
  }
  doc?.addEventListener?.("fullscreenchange", onFullscreenChange);
  win?.addEventListener?.("resize", onResize);

  function ensurePanel() {
    if (host?.isConnected && panel) return panel;
    host?.remove();
    host = doc.createElement("div");
    host.id = "codex-companion-attention";
    host.style.cssText = "all:initial !important;position:fixed !important;inset:0 !important;z-index:2147483647 !important;"
      + "pointer-events:none !important;color-scheme:light dark !important";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>${STYLE}</style>`
      + '<section class="panel" popover="manual" aria-label="Companion 提醒"><ul aria-live="polite"></ul><p class="more" hidden></p>'
      + '<footer><span class="state"></span><button type="button" class="resume primary" hidden>继续播放</button>'
      + '<button type="button" class="close">知道了</button></footer></section>';
    panel = shadow.querySelector(".panel");
    panel.addEventListener("click", onPanelClick);
    doc.documentElement.append(host);
    return panel;
  }

  function renderItem(item) {
    const li = doc.createElement("li");
    li.dataset.tone = item.tone;
    li.dataset.key = item.id;
    if (item.color) li.style.setProperty("--task", item.color);
    const bar = doc.createElement("span");
    bar.className = "bar";
    const body = doc.createElement("div");
    body.className = "body";
    const title = doc.createElement("strong");
    title.textContent = item.title;
    const text = doc.createElement("span");
    text.className = "text";
    text.textContent = item.text;
    const detail = doc.createElement("span");
    detail.className = "detail";
    detail.textContent = item.detail;
    body.append(title, text, detail);
    li.append(bar, body);
    if (item.action) {
      const go = doc.createElement("button");
      go.type = "button";
      go.className = "go";
      go.textContent = item.action.label || "去处理";
      li.append(go);
    } else li.append(doc.createElement("span"));
    return li;
  }

  function render() {
    if (disposed) return;
    const list = [...items.values()];
    if (!list.length) {
      paused.clear();
      anchor = null;
      if (panel?.matches(":popover-open")) {
        try { panel.hidePopover(); } catch (error) { report(error); }
      }
      return;
    }
    ensurePanel();
    panel.querySelector("ul").replaceChildren(...list.slice(-MAX_VISIBLE).reverse().map(renderItem));
    panel.querySelector("ul").setAttribute("aria-live", list.some((item) => item.tone === "attention") ? "assertive" : "polite");
    const more = panel.querySelector(".more");
    more.hidden = list.length <= MAX_VISIBLE;
    more.textContent = `还有 ${list.length - MAX_VISIBLE} 条提醒`;
    const held = pausedMedia().length > 0;
    panel.querySelector(".state").textContent = held ? "已暂停播放" : "";
    panel.querySelector(".resume").hidden = !held;
    panel.querySelector(".close").textContent = held ? "关闭" : "知道了";
    if (!panel.matches(":popover-open")) {
      try { panel.showPopover(); } catch (error) { report(error); }
    }
    place();
  }

  function remove(id) {
    const item = items.get(id);
    if (!item) return false;
    item.stop?.();
    items.delete(id);
    return true;
  }
  function dismiss(id) {
    if (!remove(id)) return;
    render();
    changed();
  }
  function dismissAll() {
    for (const id of [...items.keys()]) remove(id);
    render();
    changed();
  }

  async function onPanelClick(event) {
    const button = event.target.closest?.("button");
    if (!button) return;
    if (button.classList.contains("resume")) {
      for (const media of pausedMedia()) Promise.resolve(media.play()).catch(() => {});
      paused.clear();
      dismissAll();
    } else if (button.classList.contains("close")) {
      paused.clear();
      dismissAll();
    } else if (button.classList.contains("go")) {
      const item = items.get(button.closest("li")?.dataset.key);
      if (item) await go(item);
    }
  }

  // 去处理：不再替用户恢复播放；先退出全屏，宿主界面才看得见。
  async function go(item) {
    paused.clear();
    dismiss(item.id);
    try { if (doc.fullscreenElement) await doc.exitFullscreen(); } catch {}
    try { item.action.run?.(); } catch (error) { report(error); }
  }

  function notify(cardId, options = {}) {
    if (disposed) return false;
    const { key, tone = "info", title, text = "", detail = "", color = "", pause = false, sticky = false, whilePlaying = true, action = null } = options;
    if (typeof key !== "string" || !key) throw new TypeError("提醒必须提供 key");
    const media = playingMedia();
    if (whilePlaying && !media.length) return false;
    if (media.length) anchor = media.find((element) => element.getBoundingClientRect().width > 0) ?? media[0];
    if (pause) {
      for (const element of media) {
        paused.add(element);
        try { element.pause(); } catch (error) { report(error); }
      }
    }
    const id = `${cardId}${SEP}${key}`;
    remove(id);
    const item = {
      id, cardId, tone: String(tone), title: String(title ?? ""), text: String(text ?? ""), detail: String(detail ?? ""),
      color: typeof color === "string" ? color : "", action: typeof action?.run === "function" ? action : null,
      // 暂停了播放的提醒一直留着，直到用户处理或卡片撤回。
      sticky: Boolean(sticky || pause)
    };
    if (!item.sticky) {
      const timer = win.setTimeout(() => dismiss(id), autoDismissMs);
      item.stop = () => win.clearTimeout(timer);
    }
    items.set(id, item);
    render();
    changed();
    return true;
  }

  return Object.freeze({
    // 平台在卡片根创建后调用；返回撤销函数。
    observe(root) {
      if (disposed || typeof root?.addEventListener !== "function" || roots.has(root)) return () => {};
      roots.add(root);
      for (const type of MEDIA_EVENTS) root.addEventListener(type, onMediaEvent, true);
      syncPlaying();
      return () => {
        if (!roots.delete(root)) return;
        for (const type of MEDIA_EVENTS) root.removeEventListener(type, onMediaEvent, true);
        syncPlaying();
      };
    },
    // 交给卡片的接口：key 按卡片隔离；卡片卸载时撤回它的提醒与订阅。
    forCard(cardId, effects) {
      const own = () => [...items.values()].filter((item) => item.cardId === cardId);
      effects?.add?.(() => {
        let removed = false;
        for (const item of own()) removed = remove(item.id) || removed;
        if (removed) { render(); changed(); }
      });
      return Object.freeze({
        notify: (options) => notify(cardId, options),
        dismiss: (key) => dismiss(`${cardId}${SEP}${key}`),
        isPlaying: () => playing,
        pending: () => own().length,
        // 快捷键版的「去处理」：对本卡最新一条带操作的提醒执行，没有这样的提醒返回 false。
        act() {
          const item = own().filter((entry) => entry.action).at(-1);
          if (!item) return false;
          void go(item);
          return true;
        },
        // 播放状态或提醒数量变化时回调；卡片卸载时自动退订。
        subscribe(listener) {
          if (disposed || typeof listener !== "function") return () => {};
          listeners.add(listener);
          const stop = () => listeners.delete(listener);
          return effects?.add?.(stop) ?? stop;
        }
      });
    },
    diagnostics: () => ({ items: items.size, open: Boolean(panel?.matches(":popover-open")), playing, paused: pausedMedia().length }),
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const id of [...items.keys()]) remove(id);
      for (const root of roots) for (const type of MEDIA_EVENTS) root.removeEventListener(type, onMediaEvent, true);
      roots.clear();
      paused.clear();
      listeners.clear();
      doc?.removeEventListener?.("fullscreenchange", onFullscreenChange);
      win?.removeEventListener?.("resize", onResize);
      anchor = null;
      host?.remove();
      host = null;
      panel = null;
    }
  });
}
