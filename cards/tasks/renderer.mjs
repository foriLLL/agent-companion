import { TRACE_STYLE, createTraceView } from "./trace.mjs";
import { createSwitcher, mergeRecent, modifierOf, orderByRecent, touchRecent } from "./switcher.mjs";
import { ALERT_TEXT, alertLevel, taskAlerts } from "./alerts.mjs";

// Companion 设置面板里本卡的一节。
export { settings } from "./settings.mjs";

// 撤销一批移出时的放回顺序：每个 index 是在前面几个移出之后记下的，必须按移出的逆序（后移出的先放回）
// 才能各回原位；按 index 升序放回，后面的任务会被前面放回的挤错位置。entries 按移出顺序排列。
export function undoRestoreOrder(entries) {
  return [...entries].reverse();
}

// 第二行旧文字淡出后移除。减少动效（animation:none）或卡片不可见时动画根本不会开始，animationend 永远等不到，
// 旧文字会一直叠在新文字上：这时直接移除。
export function retireLabel(label, view = globalThis) {
  label.classList.remove("in");
  label.classList.add("out");
  const drop = () => label.remove();
  const reduced = Boolean(view?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
  // getAnimations() 会先刷新样式，刚加上的 .out 动画能立即反映出来。
  if (reduced || (typeof label.getAnimations === "function" && label.getAnimations().length === 0)) {
    drop();
    return;
  }
  label.addEventListener("animationend", drop, { once: true });
  label.addEventListener("animationcancel", drop, { once: true });
}

// 长轮询：服务端在会话记录变化时立即返回，没变化最多挂 20 秒；出错后隔一会儿再连。
const WATCH_WAIT_MS = 20_000;
const WATCH_RETRY_MS = 3000;
const DISCONNECTED_CODES = new Set(["RPC_TIMEOUT", "BRIDGE_UNAVAILABLE"]);
const UNDO_MS = 6000;
// 切换面板最多列出这么多个看板外的会话。
const MAX_OUTSIDE = 20;
// 悬停多久打开 Trace 浮层、离开多久关闭；离开后的宽限让鼠标能移进浮层里滚动和缩放。
const PEEK_OPEN_MS = 350;
const PEEK_CLOSE_MS = 220;
const PEEK_MAX_WIDTH = 720;
const PEEK_MIN_WIDTH = 420;
const SILENT_CODES = new Set(["ABORTED", "RPC_CANCELLED", "RPC_STALE_GENERATION", "CARD_DISABLED", "STATE_DISPOSED"]);
// 左侧状态图标。需要人处理的（提问、中断、无响应）排最前，没看过的会跳动提醒；
// 其次是没看过的新回复（图标摇晃提醒），进行中的放后面。
const STATUS = {
  asking: { label: "在等你回答", icon: "ask", human: true },
  interrupted: { label: "已中断，需要你处理", icon: "alert", human: true },
  stalled: { label: "长时间无响应，需要你看看", icon: "alert", human: true },
  running: { label: "进行中", icon: "spin" },
  idle: { label: "已回复", icon: "reply" },
  // 用户自己点停止：不算需要处理，排在已回复之后。
  stopped: { label: "已停止", icon: "stopped" },
  archived: { label: "已归档", icon: "gone" },
  missing: { label: "找不到记录", icon: "gone" }
};
function rankOf(task) {
  const status = STATUS[task.status];
  if (!status) return 5;
  if (status.human) return task.unread ? 0 : 2;
  if (task.status === "idle" || task.status === "stopped") return task.unread ? 1 : 4;
  if (task.status === "running") return 3;
  return 5;
}
function statusLabel(task) {
  if (task.status === "idle" && task.unread) return "有新回复，还没看";
  return STATUS[task.status]?.label ?? task.status;
}
// 看板颜色名，与 threads.colors 下标一一对应。
const COLOR_NAMES = ["薄荷", "天空蓝", "杏橙", "樱粉", "薰衣草", "湖青", "柠檬黄", "深靛"];
const ICONS = {
  plus: '<path d="M8 3.5v9M3.5 8h9"/>',
  edit: '<path d="M10.6 3.2l2.2 2.2-7 7H3.6v-2.2z"/>',
  done: '<path d="M3.5 8.4l2.9 2.9 6.1-6.6"/>',
  color: '<path d="M8 2.6s4 4.2 4 6.9a4 4 0 0 1-8 0c0-2.7 4-6.9 4-6.9z"/>',
  archive: '<path d="M2.8 3.6h10.4v2.6H2.8zM3.8 6.2v5.9a1 1 0 0 0 1 1h6.4a1 1 0 0 0 1-1V6.2M6.6 8.8h2.8"/>'
};
// 撤销提示里的会话名最多这么多字：长名字（比如整段首条消息）只留开头，动作本身始终看得见。
const TOAST_NAME_MAX = 10;
const clipName = (name) => {
  const chars = Array.from(String(name ?? "").replace(/\s+/g, " ").trim());
  return chars.length > TOAST_NAME_MAX ? `${chars.slice(0, TOAST_NAME_MAX).join("")}…` : chars.join("");
};
// 状态图标 20×20，彩色渐变实心：状态色与任务色分开，图标底块表示是哪个任务，图标表示它在干什么。
// 渐变 id 带 cc-task- 前缀，渲染时替换成每个图标唯一的 id。
const gradient = (id, from, to) => `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>`;
const BUBBLE = '<path d="M3 6.2A3.2 3.2 0 0 1 6.2 3h7.6A3.2 3.2 0 0 1 17 6.2v4.6a3.2 3.2 0 0 1-3.2 3.2H9.6l-3.4 2.7c-.4.3-.9 0-.9-.5V14h-.1A2.2 2.2 0 0 1 3 11.8z" fill="url(#cc-task-reply)" stroke="none"/><path d="M7 7.6h6M7 10.2h3.8" stroke="#fff" stroke-width="1.5"/>';
const disc = (id) => `<circle cx="10" cy="10" r="7.6" fill="url(#${id})" stroke="none"/>`;
const STATUS_ICONS = {
  ask: `${gradient("cc-task-ask", "#ffb347", "#f07c1e")}${disc("cc-task-ask")}<path d="M8 8a2.1 2.1 0 1 1 2.9 1.9c-.6.3-.9.7-.9 1.3v.2" stroke="#fff" stroke-width="1.7"/><circle cx="10" cy="13.7" r="1" fill="#fff" stroke="none"/>`,
  alert: `${gradient("cc-task-alert", "#ff7b72", "#e2443a")}${disc("cc-task-alert")}<path d="M10 6.2v4.6" stroke="#fff" stroke-width="1.9"/><circle cx="10" cy="13.6" r="1.05" fill="#fff" stroke="none"/>`,
  // 一段渐变弧线旋转，比实心图标轻，进行中的条目不抢眼。
  spin: `${gradient("cc-task-spin", "#6aa8ff", "#3b6ff0")}<circle cx="10" cy="10" r="6.8" stroke="color-mix(in srgb,#3b82f6 16%,transparent)" stroke-width="2.2"/><path class="arc" d="M10 3.2a6.8 6.8 0 0 1 6.8 6.8" stroke="url(#cc-task-spin)" stroke-width="2.2"/>`,
  reply: `${gradient("cc-task-reply", "#8fb4ff", "#5b7cf0")}${BUBBLE}`,
  unread: `${gradient("cc-task-reply", "#8fb4ff", "#5b7cf0")}${BUBBLE}<circle cx="16" cy="4.4" r="3" fill="#ff4d4f" stroke="var(--cc-card-bg,#fff)" stroke-width="1.4"/>`,
  gone: '<circle cx="10" cy="10" r="6.8" stroke-dasharray="2.2 2.6" opacity=".45"/>',
  stopped: '<circle cx="10" cy="10" r="6.8" opacity=".5"/><rect x="7.4" y="7.4" width="5.2" height="5.2" rx="1" fill="currentColor" stroke="none" opacity=".6"/>',
  // 不在看板上的会话（切换面板可选列出）：空心气泡，没有状态。
  outside: '<path d="M3.6 6.4A2.8 2.8 0 0 1 6.4 3.6h7.2a2.8 2.8 0 0 1 2.8 2.8v4.2a2.8 2.8 0 0 1-2.8 2.8H9.8l-3.3 2.5V13.4h-.1a2.8 2.8 0 0 1-2.8-2.8z" opacity=".55"/>'
};
let gradientSeq = 0;
const icon = (name) => `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

// 看板与 Option+Tab 切换面板共用：颜色变量，以及条目的状态图标、名字、标签、第二行与计划进度条。
const TOKENS = `--text:color-mix(in srgb,currentColor 64%,transparent);--muted:color-mix(in srgb,currentColor 46%,transparent);
      --line:color-mix(in srgb,currentColor 10%,transparent);--hover:color-mix(in srgb,currentColor 5%,transparent);
      --attention:#d9661b;--danger:#d4483e;--running:#3b82f6;--ease:cubic-bezier(.22,1,.36,1)`;
const ROW_STYLE = `
    .status{position:relative;z-index:2;display:grid;place-items:center;width:28px;height:28px;border-radius:8px;
      background:color-mix(in srgb,var(--task) 16%,transparent);transform-origin:50% 100%;color:var(--muted)}
    .status svg{display:block;overflow:visible;width:18px;height:18px;filter:drop-shadow(0 1px 1px rgba(0,0,0,.08))}
    .status[data-icon=spin] svg{filter:none}
    .status[data-icon=spin] .arc{transform-origin:10px 10px;animation:turn .9s linear infinite}
    .text{min-width:0}
    .title{display:flex;align-items:center;gap:6px;min-width:0}
    .name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
    .tag{flex:none;display:inline-flex;align-items:center;gap:3px;padding:1px 6px;border-radius:6px;font-size:11px;font-weight:500;
      color:var(--attention);background:color-mix(in srgb,var(--attention) 13%,transparent)}
    .tag[data-tone=danger]{color:var(--danger);background:color-mix(in srgb,var(--danger) 12%,transparent)}
    .meta{position:relative;display:block;height:1.4em;margin-top:2px;overflow:hidden;font-size:12px}
    .meta:empty{display:none}
    .label{position:absolute;inset:0 auto 0 0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)}
    /* 进行中：文字整体压暗，一道亮带（文字本色）从左扫到右；用遮罩实现，深浅色主题都成立。
       内容变化时新文字从下方模糊浮入，旧文字向上淡出。 */
    .label.live{color:inherit;-webkit-mask-image:linear-gradient(90deg,rgba(0,0,0,.42) 40%,#000 50%,rgba(0,0,0,.42) 60%);
      mask-image:linear-gradient(90deg,rgba(0,0,0,.42) 40%,#000 50%,rgba(0,0,0,.42) 60%);-webkit-mask-size:300% 100%;mask-size:300% 100%;
      animation:sweep 1.8s linear infinite}
    .label.live.in{animation:roll-in .46s var(--ease) both,sweep 1.8s linear infinite}
    .label.in{animation:roll-in .46s var(--ease) both}
    .label.out{animation:roll-out .32s var(--ease) both}
    /* 计划进度：一格一步，做完的填任务色，进行中的那格明暗呼吸；右侧是完成数。 */
    .progress{display:flex;align-items:center;gap:8px;min-width:0}
    .progress-bar{flex:1;min-width:0;display:flex;gap:2px;height:4px}
    .progress-bar i{flex:1;min-width:2px;border-radius:2px;background:color-mix(in srgb,currentColor 11%,transparent)}
    .progress-bar i[data-status=completed],.progress-bar i[data-status=in_progress]{background:color-mix(in srgb,var(--task) 80%,currentColor 20%)}
    .progress-bar i[data-status=in_progress]{animation:breathe 1.6s ease-in-out infinite}
    .progress-count{flex:none;font-size:11px;line-height:1;color:var(--muted);font-variant-numeric:tabular-nums}
    @keyframes breathe{0%,100%{opacity:.3}50%{opacity:1}}
    @keyframes turn{to{transform:rotate(360deg)}}
    @keyframes sweep{from{-webkit-mask-position:100% 0;mask-position:100% 0}to{-webkit-mask-position:0 0;mask-position:0 0}}
    @keyframes roll-in{from{opacity:0;transform:translateY(70%);filter:blur(3px)}to{opacity:1;transform:none;filter:none}}
    @keyframes roll-out{from{opacity:1;transform:none;filter:none}to{opacity:0;transform:translateY(-70%);filter:blur(3px)}}`;

function ago(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) return "";
  const minutes = Math.floor((now - ms) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}


// 看板只列用户加入的会话（settings.autoAdd 打开时后台把新开的会话自动加进来）；颜色与左侧会话条目呼应，点击后由平台定位、动画并打开。
// macOS 上按住 Option（settings.switcherKey 为 ctrl 时是 Control）连按 Tab 在看板会话之间切换，同一修饰键加 J 跳到需要你处理的会话；
// settings.switcher 为 false 时都关闭，settings.switcherAll 为 true 时切换面板也列出看板外最近打开的会话。
// 卡片里有视频在播时，任务需要你或完成会经平台提醒层弹出提醒（settings.alertAttention / alertDone）。
export function mount({ root, rpc, effects, signal, threads, isVisible, overlay, attention, settings }) {
  const doc = root.ownerDocument;
  root.innerHTML = `<style>
    :host{display:block;${TOKENS};
      font-family:"Inter",ui-sans-serif,system-ui,-apple-system,"PingFang SC",sans-serif;letter-spacing:-.006em;-webkit-font-smoothing:antialiased}
    *{box-sizing:border-box}
    .board{padding:14px 8px 8px;font-size:13.5px;line-height:1.4}
    header{display:flex;align-items:center;gap:10px;padding:0 6px 10px 9px;min-height:22px}
    h2{flex:none;margin:0;font-size:14px;font-weight:600;white-space:nowrap}
    .chips{min-width:0;display:flex;gap:9px;overflow:hidden;font-size:12px;color:var(--text);font-variant-numeric:tabular-nums}
    .chip{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
    .chip::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--dot)}
    .chip[data-kind=running]{--dot:var(--running)}
    .chip[data-kind=human]{--dot:var(--attention);color:var(--attention)}
    button{font:inherit;color:inherit;border:0;background:none;padding:0;cursor:pointer;letter-spacing:inherit}
    .add{display:flex;align-items:center;gap:8px;width:100%;padding:9px 10px 9px 20px;border-radius:9px;color:var(--muted);text-align:left;transition:background-color .16s ease,color .16s ease}
    .add:hover{background:var(--hover);color:var(--text)}
    .add svg{flex:none;margin:0 2px}
    .add .title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .add b{font-weight:500;color:currentColor}
    ul{list-style:none;margin:0;padding:0;display:grid}
    /* 条目紧挨着排列，不铺底色；最左侧一道任务色竖条，和左侧侧栏会话条目上的标记呼应。
       状态图标放在标题最前面，时间在标题行右侧，第二行从图标左边开始；悬停时整行浅浅地铺一层任务色。 */
    .task{--task:#8b8d98;position:relative;display:flex;align-items:center;border-radius:9px;
      transition:background-color .16s ease;transform-origin:50% 60%}
    .task::before{content:"";position:absolute;left:9px;top:9px;bottom:9px;width:3px;border-radius:2px;background:var(--task);pointer-events:none}
    .task:hover,.task:focus-within,.task[data-peek]{background:color-mix(in srgb,var(--task) 10%,transparent)}
    .main{flex:1;min-width:0;display:grid;grid-template-columns:18px minmax(0,1fr) auto;grid-template-areas:"status title when" "meta meta meta" "plan plan plan";
      column-gap:8px;align-items:center;padding:7px 10px 7px 20px;text-align:left;border-radius:9px}
    .main:focus-visible{outline:2px solid color-mix(in srgb,var(--task) 55%,transparent);outline-offset:-2px}
${ROW_STYLE}
    /* 看板里图标不铺底块，和标题排在同一行；ROW_STYLE 里的底块留给 Option+Tab 切换面板。 */
    .main .status,.editor .status{grid-area:status;width:18px;height:18px;border-radius:0;background:none}
    .main .text{display:contents}
    .main .title{grid-area:title}
    .main .meta{grid-area:meta}
    .when{grid-area:when;justify-self:end;font-size:11.5px;color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums}
    .when:empty{display:none}
    .main .progress{grid-area:plan;margin-top:5px}
    /* 需要人处理且还没看过：图标跳出条目，落下时砸得条目轻晃一下。常驻动画只动 transform，交给合成器。 */
    .task[data-hop]{animation:knock 3.2s infinite;will-change:transform}
    .task[data-hop] .status{animation:hop 3.2s infinite;will-change:transform}
    /* 有新回复还没看：图标像来消息的手机一样隔一会儿摇一下。 */
    .task[data-shake] .status{transform-origin:50% 50%;animation:shake 2.6s infinite;will-change:transform}
    /* 悬停时右侧浮出一组按钮：共用一块底板，按钮本身不带边框；时间收起，标题和第二行让出位置。 */
    .actions{position:absolute;right:8px;top:50%;z-index:3;display:flex;padding:2px;border-radius:9px;background:var(--cc-card-bg,Canvas);
      box-shadow:0 0 0 .5px color-mix(in srgb,currentColor 18%,transparent),0 3px 10px rgba(0,0,0,.1);
      opacity:0;transform:translate(4px,-50%);pointer-events:none;transition:opacity .15s ease,transform .22s var(--ease)}
    .task:hover .actions,.task:focus-within .actions{opacity:1;transform:translate(0,-50%);pointer-events:auto}
    .task:hover .when,.task:focus-within .when{display:none}
    .task:hover .title,.task:focus-within .title{padding-right:70px}
    .task:hover .meta,.task:focus-within .meta,.task:hover .progress,.task:focus-within .progress{margin-right:76px}
    .icon{display:grid;place-items:center;width:24px;height:24px;border-radius:7px;color:var(--text)}
    .icon:hover{color:currentColor;background:var(--hover)}
    .icon[data-action=done]:hover{color:#2f9e6a;background:color-mix(in srgb,#2f9e6a 13%,transparent)}
    .palette{flex:1;display:flex;align-items:center;justify-content:space-between;gap:4px;padding:12px 10px 12px 20px;min-height:52px}
    .palette button{width:22px;height:22px;border-radius:50%;background:var(--swatch);box-shadow:inset 0 0 0 1px rgba(0,0,0,.08);transition:transform .2s var(--ease)}
    .palette button:hover{transform:scale(1.15)}
    .palette button[aria-checked=true]{box-shadow:0 0 0 2px currentColor}
    .editor{flex:1;display:grid;grid-template-columns:18px 1fr;column-gap:8px;align-items:center;padding:7px 10px 7px 20px;min-height:52px}
    input{width:100%;font:inherit;font-weight:500;color:inherit;background:transparent;border:0;border-radius:6px;padding:2px 6px;margin:-2px -6px;
      outline:none;box-shadow:inset 0 0 0 1px color-mix(in srgb,currentColor 30%,transparent)}
    .empty{margin:6px 8px 6px;font-size:12.5px;line-height:1.55;color:var(--muted)}
    .note{margin:6px 8px 2px;font-size:12.5px;color:var(--danger)}
    /* 撤销提示：与条目同一套浅底细边，不用反色；底边一道细线随倒计时缩短，到头自动收起。 */
    .toast{position:relative;display:flex;align-items:center;gap:8px;margin:8px 0 0;padding:5px 5px 5px 10px;border-radius:10px;
      overflow:hidden;font-size:12.5px;color:var(--text);background:var(--hover);box-shadow:inset 0 0 0 1px var(--line);
      animation:toast-in .26s var(--ease) both}
    .toast::after{content:"";position:absolute;left:10px;right:10px;bottom:0;height:1.5px;border-radius:1px;
      background:color-mix(in srgb,currentColor 18%,transparent);transform-origin:left;animation:toast-drain ${UNDO_MS}ms linear both}
    .toast .glyph{flex:none;display:grid;place-items:center}
    .toast span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .toast button{flex:none;font-weight:600;padding:3px 9px;border-radius:7px;color:inherit;
      background:color-mix(in srgb,currentColor 7%,transparent);transition:background-color .12s ease}
    .toast button:hover{background:color-mix(in srgb,currentColor 12%,transparent)}
    @keyframes toast-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
    @keyframes toast-drain{from{transform:scaleX(1)}to{transform:scaleX(0)}}
    [hidden]{display:none!important}
    /* Trace 浮层放在顶层（popover），不受卡片宽度和裁剪限制，贴在看板左侧展开。 */
    .peek{position:fixed;inset:auto;margin:0;padding:14px 12px 12px;border:0;border-radius:14px;overflow:auto;max-height:calc(100vh - 24px);
      color:inherit;background:var(--cc-card-bg,Canvas);font:inherit;font-size:13.5px;line-height:1.4;
      box-shadow:0 0 0 .5px rgba(0,0,0,.14),0 12px 32px rgba(0,0,0,.16),0 2px 6px rgba(0,0,0,.06);
      opacity:0;transform:translateX(6px);transition:opacity .16s ease,transform .2s var(--ease),overlay .2s allow-discrete,display .2s allow-discrete}
    .peek:popover-open{opacity:1;transform:none}
    @starting-style{.peek:popover-open{opacity:0;transform:translateX(6px)}}
${TRACE_STYLE}
    @keyframes ray{0%{opacity:1}100%{opacity:.18}}
    @keyframes hop{
      0%{transform:none;animation-timing-function:ease-out}
      6%{transform:scale(1.14,.82);animation-timing-function:cubic-bezier(.2,.7,.3,1)}
      22%{transform:translateY(-26px) scale(.94,1.08);animation-timing-function:cubic-bezier(.6,0,.9,.5)}
      34%{transform:translateY(0) scale(.92,1.1)}
      38%{transform:scale(1.22,.78);animation-timing-function:ease-out}
      45%{transform:translateY(-4px) scale(.97,1.04);animation-timing-function:ease-in}
      51%,100%{transform:none}}
    @keyframes shake{
      0%,30%,100%{transform:none}
      4%{transform:rotate(-14deg)}
      8%{transform:rotate(12deg)}
      12%{transform:rotate(-10deg)}
      16%{transform:rotate(7deg)}
      20%{transform:rotate(-4deg)}
      24%{transform:rotate(2deg)}}
    @keyframes knock{
      0%,33.5%,60%,100%{transform:none}
      36%{transform:translateY(1.6px) rotate(-.7deg)}
      42%{transform:translateY(-.4px) rotate(.55deg)}
      48%{transform:rotate(-.3deg)}
      54%{transform:rotate(.12deg)}}
    @media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
  </style><section class="board" aria-label="任务看板">
    <header><h2>任务看板</h2><span class="chips"></span></header>
    <button type="button" class="add" hidden>${icon("plus")}<span class="title">加入当前会话 · <b></b></span></button>
    <ul></ul>
    <div class="peek" popover="manual" aria-label="会话 Trace"></div>
    <p class="empty" hidden></p>
    <p class="note" hidden></p>
    <div class="toast" role="status" hidden><i class="glyph"></i><span></span><button type="button">撤销</button></div>
  </section>`;
  const chips = root.querySelector(".chips");
  const addButton = root.querySelector(".add");
  const addTitle = addButton.querySelector("b");
  const list = root.querySelector("ul");
  const peek = root.querySelector(".peek");
  let trace = null;
  let peekTimer = null;
  let peekItem = null;
  const empty = root.querySelector(".empty");
  const note = root.querySelector(".note");
  const toast = root.querySelector(".toast");
  const toastGlyph = toast.querySelector(".glyph");
  const toastText = toast.querySelector("span");
  const undoButton = toast.querySelector("button");
  const colors = threads?.colors ?? [];
  let board = null;
  let editing = null;
  let picking = null;
  const seeing = new Set();
  let undo = null;
  let cancelUndo = () => {};
  let loading = null;
  // 最近在 Codex 里打开过的会话（看板上的记 task.threadId，看板外的记侧栏 id），最近的在前；
  // 由后台存盘，后台服务重启、自动更新或页面刷新后接着用。visited 记下看板外会话打开时的标题和项目。
  let recent = [];
  const visited = new Map();
  let switcherOn = settings?.switcher !== false;
  let switcherKey = modifierOf(settings?.switcherKey);
  let switcherAll = settings?.switcherAll === true;
  let switcher = null;
  let autoAdd = settings?.autoAdd === true;
  const levelsOf = (value) => ({ attention: alertLevel(value, "alertAttention"), done: alertLevel(value, "alertDone") });
  let alertLevels = levelsOf(settings);
  // 已发出、还没撤回的提醒：会话 id → 提醒时的状态。状态一变（例如在 Codex 里回答了）就撤回。
  const alerted = new Map();
  // 只在看板持续同步期间比较前后两次快照；断开后重连的第一次只作基线，不补发错过的旧变化。
  let alertsArmed = false;

  function showNote(message) {
    note.textContent = message || "";
    note.hidden = !message;
  }
  function fail(error) {
    if (signal.aborted || SILENT_CODES.has(error?.code)) return;
    syncNote = false;
    showNote(error?.message || "操作失败，请稍后重试");
  }
  // 同步（list/watch）失败的提示在下一次同步成功时自动清除；操作失败的提示留到下一次操作。
  let syncNote = false;
  function failSync(error) {
    // 收不到后台回包时，平台和后台都会自动重连；提示说明正在恢复，而不是一句「watch 请求超时」。
    fail(DISCONNECTED_CODES.has(error?.code) ? { code: error.code, message: "与后台的连接中断，正在自动重连…" } : error);
    syncNote = !note.hidden;
  }

  // 新建会话在本次运行中，侧栏条目用客户端临时 id；服务端给出别名，两个都认。
  const idsOf = (task) => [task.threadId, ...(task.aliases ?? [])];
  const taskFor = (id) => board?.tasks.find((task) => idsOf(task).includes(id));
  // 未自定义名字时，优先用左侧条目上的实时标题（Codex 起名或 rename 后会立即更新）。
  const displayName = (task) => task.customName ?? idsOf(task).map((id) => threads?.title(id)).find(Boolean) ?? task.name;

  function renderHeader() {
    const current = threads?.current();
    const added = current && taskFor(current.id);
    addButton.hidden = !board || !current || added;
    addTitle.textContent = current?.title ?? "未命名会话";
    addButton.title = current?.title ?? "";
    const running = board?.tasks.filter((task) => task.status === "running").length ?? 0;
    const human = board?.tasks.filter((task) => STATUS[task.status]?.human).length ?? 0;
    const nextChips = [running ? ["running", `${running} 进行中`] : null, human ? ["human", `${human} 需要你`] : null].filter(Boolean);
    if (chips.dataset.value !== JSON.stringify(nextChips)) {
      chips.dataset.value = JSON.stringify(nextChips);
      chips.replaceChildren(...nextChips.map(([kind, text]) => {
        const chip = element("span", "chip", text);
        chip.dataset.kind = kind;
        return chip;
      }));
    }
    if (!threads) empty.textContent = "任务看板需要在 Codex 注入模式下使用。";
    else if (autoAdd) empty.textContent = "还没有任务。新开的会话会自动加入看板，也可以把当前会话加进来。";
    else if (!current) empty.textContent = "还没有任务。打开一个会话，就能把它加入看板。";
    else empty.textContent = "加入后会一直留在这里，做完点 ✓ 移出。";
    empty.hidden = Boolean(board?.tasks.length) && Boolean(threads);
  }

  function element(tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function colorToggle(button) {
    button.dataset.colorToggle = "";
    return button;
  }
  function iconButton(name, label, onClick) {
    const button = element("button", "icon");
    button.type = "button";
    button.dataset.action = name;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.innerHTML = icon(name);
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", onClick);
    return button;
  }

  function renderEditor(task, item) {
    const editor = element("div", "editor");
    const input = doc.createElement("input");
    input.value = task.customName ?? "";
    input.placeholder = task.suggestedName ?? displayName(task);
    input.maxLength = 120;
    input.setAttribute("aria-label", "任务名，留空则使用推荐名");
    let settled = false;
    const finish = (save) => {
      if (settled) return;
      settled = true;
      editing = null;
      if (save && input.value.trim() !== (task.customName ?? "")) void mutate("rename", { threadId: task.threadId, name: input.value.trim() || null });
      else render();
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); finish(true); }
      else if (event.key === "Escape") { event.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
    editor.append(statusIcon(task), input);
    item.append(editor);
    queueMicrotask(() => { input.focus(); input.select(); });
  }

  // 项目在侧栏上的名字；拿不到时，路径形式的 id 取最后一段，不透明 id 不展示。
  function projectName(projectId) {
    if (!projectId) return "";
    return threads?.projectLabel?.(projectId) ?? (/[\\/]/.test(projectId) ? projectId.split(/[\\/]/).filter(Boolean).at(-1) ?? "" : "");
  }
  // 第二行：进行中显示计划里正在做的那一步，没有计划时显示 Codex 此刻在做什么；其余显示最后一句回复（提问时是问题本身）。
  // 切换面板没有右侧一栏，时间写在第二行开头；看板把时间放在标题行右侧（whenOf），第二行不再重复。
  function metaOf(task, { withTime = true } = {}) {
    if (task.status === "running") {
      const step = Number.isInteger(task.plan?.active) ? task.plan.steps[task.plan.active]?.text : null;
      return { live: true, text: step || task.activity || "思考中" };
    }
    if (task.status === "archived" || task.status === "missing") return { text: STATUS[task.status].label };
    const when = withTime ? ago(task.turnAt ?? task.updatedAt) : "";
    if (task.status === "stopped") return { text: [when, "已停止"].filter(Boolean).join(" · ") };
    if (task.status === "interrupted" || task.status === "stalled") {
      // 标题旁已有「已中断 / 没动静」标签；看板第二行改说需要你做什么。
      const text = !withTime ? STATUS[task.status].label : task.status === "interrupted" ? "已中断" : "长时间没有动静";
      return { text: [text, when].filter(Boolean).join(" · ") };
    }
    // 看板第二行不带时间，没有回复内容也拿不到项目名时写状态，不空出一行。
    return { text: [when, task.summary || projectName(task.projectId)].filter(Boolean).join(" · ") || statusLabel(task) };
  }
  const BOARD_META = { withTime: false };
  // 看板标题行右侧的时间；进行中的第二行本身在实时变化，归档或找不到的没有可信时间，都不显示。
  const whenOf = (task) => (["running", "archived", "missing"].includes(task.status) ? "" : ago(task.turnAt ?? task.updatedAt));
  function tagOf(task) {
    if (!STATUS[task.status]?.human) return null;
    return task.status === "asking" ? { text: "需要你" } : { text: task.status === "stalled" ? "没动静" : "已中断", tone: "danger" };
  }
  const iconOf = (task) => (task.status === "idle" && task.unread ? "unread" : STATUS[task.status]?.icon ?? "gone");

  function statusIcon(task) {
    const node = element("span", "status");
    node.dataset.icon = iconOf(task);
    node.title = statusLabel(task);
    node.setAttribute("role", "img");
    node.setAttribute("aria-label", statusLabel(task));
    // 渐变 id 每个图标唯一：同名 id 只认第一个，所在节点隐藏后其它图标会丢失填色。
    const glyph = STATUS_ICONS[node.dataset.icon].replaceAll("cc-task-", `cc-task-${++gradientSeq}-`);
    node.innerHTML = `<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${glyph}</svg>`;
    return node;
  }

  function renderPalette(task) {
    const palette = element("div", "palette");
    palette.setAttribute("role", "radiogroup");
    palette.setAttribute("aria-label", "任务颜色");
    colors.forEach((color, index) => {
      const swatch = element("button");
      swatch.type = "button";
      swatch.title = COLOR_NAMES[index] ?? "";
      swatch.setAttribute("role", "radio");
      swatch.setAttribute("aria-checked", String(task.color === index));
      swatch.style.setProperty("--swatch", color);
      swatch.addEventListener("click", () => {
        picking = null;
        if (task.color === index) render();
        else void mutate("recolor", { threadId: task.threadId, color: index });
      });
      palette.append(swatch);
    });
    return palette;
  }

  // 第二行的文字换了就从下方浮入，旧文字向上淡出；没换就原样保留，扫光动画不被打断。
  function setLabel(meta, { text, live }) {
    const current = meta.querySelector(".label:not(.out)");
    if (current?.textContent === text && current.classList.contains("live") === Boolean(live)) return;
    const label = element("span", `label${live ? " live" : ""}`, text);
    if (current) {
      retireLabel(current, doc.defaultView);
      label.classList.add("in");
    }
    for (const stale of meta.querySelectorAll(".label.out")) if (stale !== current) stale.remove();
    meta.append(label);
  }

  // 计划进度条：Codex 用自带 update_plan 列了计划才有；悬停列出全部步骤。
  const STEP_MARK = { completed: "✓", in_progress: "▶", pending: "○" };
  function progressStrip(plan) {
    const strip = element("span", "progress");
    const bar = element("span", "progress-bar");
    for (const step of plan.steps) {
      const cell = element("i");
      cell.dataset.status = step.status;
      bar.append(cell);
    }
    strip.append(bar, element("span", "progress-count", `${plan.done}/${plan.total}`));
    strip.title = [`计划 ${plan.done}/${plan.total} 步${plan.source === "message" ? " · 助手进度消息" : ""}`, ...plan.steps.map((step, index) => `${STEP_MARK[step.status] ?? "○"} ${index + 1}. ${step.text}`)].join("\n");
    strip.setAttribute("role", "img");
    strip.setAttribute("aria-label", `计划进度：完成 ${plan.done} 步，共 ${plan.total} 步`);
    return strip;
  }
  // 计划变了只换进度条，不重建条目，第二行的扫光和浮层锚点都不受影响。
  function syncProgress(main, plan) {
    const current = main.querySelector(".progress");
    const sig = plan?.total ? JSON.stringify(plan) : "";
    if ((current?.dataset.sig ?? "") === sig) return;
    const next = sig ? progressStrip(plan) : null;
    if (next) next.dataset.sig = sig;
    if (current && next) current.replaceWith(next);
    else if (current) current.remove();
    else if (next) main.append(next);
  }

  // 名字、标签与第二行；看板条目和切换面板共用，metaOptions 交给 metaOf。
  function taskText(task, metaOptions) {
    const text = element("span", "text");
    const title = element("span", "title");
    title.append(element("span", "name", displayName(task)));
    const tag = tagOf(task);
    if (tag) {
      const badge = element("span", "tag", tag.text);
      if (tag.tone) badge.dataset.tone = tag.tone;
      title.append(badge);
    }
    const meta = element("span", "meta");
    setLabel(meta, metaOf(task, metaOptions));
    text.append(title, meta);
    return text;
  }

  function renderTask(task) {
    const item = element("li", "task");
    item.dataset.status = task.status;
    item.dataset.id = task.threadId;
    if (colors[task.color]) item.style.setProperty("--task", colors[task.color]);
    if (STATUS[task.status]?.human && task.unread) item.dataset.hop = "";
    else if (task.status === "idle" && task.unread) item.dataset.shake = "";
    if (editing === task.threadId) {
      renderEditor(task, item);
      return item;
    }
    if (picking === task.threadId) {
      item.append(renderPalette(task));
      return item;
    }
    const main = element("button", "main");
    main.type = "button";
    main.title = "在左侧定位并打开这个会话";
    main.append(statusIcon(task), taskText(task, BOARD_META), element("span", "when", whenOf(task)));
    syncProgress(main, task.plan);
    main.addEventListener("click", () => { closePeek(); void reveal(task, item); });
    item.addEventListener("pointerenter", () => hoverPeek(task, item));
    item.addEventListener("pointerleave", schedulePeekClose);
    const actions = element("span", "actions");
    actions.append(
      colorToggle(iconButton("color", "换颜色", () => { picking = picking === task.threadId ? null : task.threadId; render(); })),
      iconButton("edit", "改名", () => { picking = null; editing = task.threadId; render(); }),
      iconButton("done", "完成，移出看板", () => { void complete(task); })
    );
    item.append(main, actions);
    return item;
  }

  // 用户正停在某个任务的会话里，就当作已经看过这次结果。
  function markSeen() {
    const current = threads?.current();
    const task = current && taskFor(current.id);
    if (!task?.unread || !Number.isSafeInteger(task.turnAt) || seeing.has(task.threadId)) return;
    seeing.add(task.threadId);
    void mutate("seen", { threadId: task.threadId, at: task.turnAt }).finally(() => seeing.delete(task.threadId));
  }

  // 看板的显示顺序：需要处理的在前，同档按加入顺序。
  const displayOrder = () => board.tasks.map((task, index) => ({ task, index }))
    .sort((a, b) => rankOf(a.task) - rankOf(b.task) || a.index - b.index).map(({ task }) => task);

  // 记一次最近打开；侧栏切换、点看板和快捷键切过去都会走到这里。顺序有变化才告诉后台存盘。
  function noteVisit() {
    const current = threads?.current();
    if (!current?.id) return;
    const task = taskFor(current.id);
    if (!task) visited.set(current.id, { title: current.title ?? null, projectId: current.projectId ?? null });
    const id = task?.threadId ?? current.id;
    const next = touchRecent(recent, id);
    if (next === recent) return;
    recent = next;
    void rpc("visit", { threadId: id }).catch(() => {});
  }

  function render() {
    renderHeader();
    markSeen();
    noteVisit();
    if (!board || editing && root.activeElement?.tagName === "INPUT") return;
    const ordered = displayOrder();
    // 按条目复用节点：只有第二行变了就原地换文字，不重建条目，跳动、扫光和悬停状态都不被打断。
    const existing = new Map([...list.children].map((node) => [node.dataset.id, node]));
    const nodes = ordered.map((task) => {
      const key = JSON.stringify([editing === task.threadId, picking === task.threadId, task.color, task.status, task.unread, displayName(task), tagOf(task)]);
      const previous = existing.get(task.threadId);
      if (previous?.dataset.key === key) {
        const meta = previous.querySelector(".meta");
        if (meta) setLabel(meta, metaOf(task, BOARD_META));
        const when = previous.querySelector(".when");
        if (when && when.textContent !== whenOf(task)) when.textContent = whenOf(task);
        const main = previous.querySelector(".main");
        if (main) syncProgress(main, task.plan);
        return previous;
      }
      const node = renderTask(task);
      node.dataset.key = key;
      return node;
    });
    if (nodes.length !== list.children.length || nodes.some((node, index) => list.children[index] !== node)) list.replaceChildren(...nodes);
    // 条目重建后把浮层的锚点换到新节点上；任务已移出就关掉浮层。
    if (peekItem && !peekItem.isConnected) {
      const next = nodes.find((node) => node.dataset.id === peekItem.dataset.id);
      if (!next || editing || picking) closePeek();
      else { peekItem = next; next.setAttribute("data-peek", ""); }
    }
  }

  // 播放提醒：平台只在有视频播放时显示，pause 档先暂停再提醒。
  function raiseAlerts(previous, next) {
    if (!attention) return;
    for (const [id, status] of alerted) {
      if (next.tasks.find((task) => task.threadId === id)?.status === status) continue;
      alerted.delete(id);
      attention.dismiss(id);
    }
    for (const { kind, task } of taskAlerts(previous, next)) {
      const level = alertLevels[kind];
      if (level === "off") continue;
      const shown = attention.notify({
        key: task.threadId, tone: kind, title: displayName(task), text: ALERT_TEXT[task.status] ?? statusLabel(task),
        detail: typeof task.summary === "string" ? task.summary : "", color: colors[task.color] ?? "",
        pause: level === "pause", sticky: kind === "attention",
        action: { label: "去处理", run: () => { void reveal(task); } }
      });
      if (shown) alerted.set(task.threadId, task.status);
    }
  }

  function accept(next) {
    if (signal.aborted || !next) return;
    const previous = alertsArmed ? board : null;
    board = next;
    alertsArmed = watching !== null;
    try { raiseAlerts(previous, next); } catch (error) { fail(error); }
    if (syncNote) {
      syncNote = false;
      showNote("");
    }
    threads?.setMarks(board.tasks.flatMap((task) => idsOf(task).map((id) => ({ id, color: task.color }))));
    render();
    switcher?.refresh();
    void removeArchived();
  }

  async function mutate(method, params) {
    try {
      const next = await rpc(method, params);
      showNote("");
      accept(next);
      return next;
    } catch (error) { fail(error); render(); return null; }
  }

  function refresh() {
    loading ??= rpc("list").then(accept, failSync).finally(() => { loading = null; });
    return loading;
  }

  // 卡片可见时保持一个长轮询；收起时断开，展开时重新连上。
  let watching = null;
  function startWatch() {
    if (watching || signal.aborted) return;
    const controller = new AbortController();
    watching = controller;
    void (async () => {
      while (!controller.signal.aborted && !signal.aborted) {
        try {
          // 停过同步后的第一次请求不带 since，立即拿到当前看板作提醒基线（停止期间的旧变化不补发）；
          // 之后服务端挂起到有变化才返回，返回的变化都发生在同步期间，可以提醒。
          const since = alertsArmed ? board?.sig ?? null : null;
          const next = await rpc("watch", { since, waitMs: WATCH_WAIT_MS }, { signal: controller.signal, timeoutMs: WATCH_WAIT_MS + 15_000 });
          accept(next);
          // 服务端只在超时后才返回未变化的结果；万一立即返回，也歇一下再连，避免空转。
          if (since !== null && next?.sig === since) await new Promise((resolve) => effects.timeout(resolve, WATCH_RETRY_MS));
        } catch (error) {
          if (controller.signal.aborted || signal.aborted) break;
          failSync(error);
          await new Promise((resolve) => effects.timeout(resolve, WATCH_RETRY_MS));
        }
      }
    })();
  }
  function stopWatch() {
    watching?.abort();
    watching = null;
    alertsArmed = false;
  }
  // 卡片可见时同步；收起后只要还有视频在播（或提醒没处理完）也继续同步，好及时提醒。
  const alertsOn = () => Boolean(attention) && (alertLevels.attention !== "off" || alertLevels.done !== "off");
  const shouldWatch = () => isVisible() || (alertsOn() && (attention.isPlaying() || attention.pending() > 0));
  function syncWatch() {
    if (shouldWatch()) startWatch();
    else stopWatch();
  }

  // 悬停在任务上一会儿，在看板左侧弹出这个会话的 Trace；鼠标移进浮层不关，离开后稍等再关。
  function cancelPeek() { peekTimer?.(); peekTimer = null; }
  function closePeek() {
    cancelPeek();
    peekItem?.removeAttribute("data-peek");
    peekItem = null;
    if (peek.matches(":popover-open")) peek.hidePopover();
    trace?.setActive(false);
  }
  function schedulePeekClose() {
    cancelPeek();
    if (peekItem) peekTimer = effects.timeout(closePeek, PEEK_CLOSE_MS);
  }
  function placePeek(item) {
    const view = doc.defaultView;
    const card = root.host?.getBoundingClientRect?.() ?? item.getBoundingClientRect();
    const row = item.getBoundingClientRect();
    const room = card.left - 20;
    // 左侧放得下就贴在看板左边；放不下（窗口很窄）就盖在看板上方，宽度取窗口宽。
    const width = room >= PEEK_MIN_WIDTH ? Math.min(PEEK_MAX_WIDTH, room) : Math.min(PEEK_MAX_WIDTH, view.innerWidth - 24);
    const left = room >= PEEK_MIN_WIDTH ? card.left - 8 - width : Math.max(12, view.innerWidth - 12 - width);
    peek.style.width = `${width}px`;
    peek.style.left = `${left}px`;
    const height = peek.offsetHeight;
    peek.style.top = `${Math.max(12, Math.min(row.top - 14, view.innerHeight - 12 - height))}px`;
  }
  function openPeek(task, item) {
    if (!item.isConnected || editing || picking) return;
    peekItem?.removeAttribute("data-peek");
    peekItem = item;
    item.setAttribute("data-peek", "");
    // 先定宽再画：Trace 按可视宽度挑时间比例。
    if (!peek.matches(":popover-open")) peek.showPopover();
    placePeek(item);
    trace.show(task.threadId, displayName(task));
    trace.setActive(true);
  }
  function hoverPeek(task, item) {
    cancelPeek();
    // 浮层已经开着时，在条目间移动直接切换，不再等待。
    if (peekItem && peekItem !== item) { openPeek(task, item); return; }
    if (peekItem === item) return;
    peekTimer = effects.timeout(() => { peekTimer = null; openPeek(task, item); }, PEEK_OPEN_MS);
  }

  // item 是看板里被点的条目，液流从它的图标流向侧栏；键盘切换没有起点，只保留侧栏落点高亮。
  async function reveal(task, item = null) {
    if (!threads) return;
    const id = idsOf(task).find((item) => threads.has(item)) ?? task.threadId;
    const result = await threads.reveal(id, { source: item ? item.querySelector(".status") ?? item : null, projectId: task.projectId });
    if (signal.aborted || result.ok) return;
    // 侧栏里找不到（例如会话不在当前列表中）时，交给 Codex 深链打开。
    try { await rpc("open", { threadId: task.threadId }); } catch (error) { fail(error); }
  }

  // undo：可撤销的一批移出，{ entries: [{ task, index }], keepArchived }。
  // glyph 是提示左侧的小图标（ICONS 里的名字）；连续两次提示时先收起再显示，让入场和倒计时线从头开始。
  function offerUndo(entries, text, { keepArchived = false, glyph = "done" } = {}) {
    cancelUndo();
    undo = { entries, keepArchived };
    toastGlyph.innerHTML = icon(glyph);
    toastText.textContent = text;
    toast.title = text;
    toast.hidden = true;
    void toast.offsetWidth;
    toast.hidden = false;
    cancelUndo = effects.timeout(() => { undo = null; toast.hidden = true; }, UNDO_MS);
  }

  async function complete(task) {
    const next = await mutate("remove", { threadId: task.threadId });
    if (!next?.removed) return false;
    offerUndo([next.removed], `已完成「${clipName(displayName(task))}」`);
    return true;
  }

  // 会话在 Codex 里归档后自动移出看板，可撤销；撤销放回的任务记下 keepArchived，以后不再自动移出。
  // 只认 archived：missing 可能只是会话文件暂时找不到，不能据此删任务。
  const removingArchived = new Set();
  async function removeArchived() {
    const targets = board?.tasks.filter((task) => task.status === "archived" && !task.keepArchived && !removingArchived.has(task.threadId)) ?? [];
    if (!targets.length) return;
    for (const task of targets) removingArchived.add(task.threadId);
    const removed = [];
    try {
      for (const task of targets) {
        const next = await mutate("remove", { threadId: task.threadId });
        if (signal.aborted) return;
        if (next?.removed) removed.push({ ...next.removed, name: displayName(task) });
      }
    } finally {
      for (const task of targets) removingArchived.delete(task.threadId);
    }
    if (!removed.length) return;
    // 保持移出顺序；撤销时由 undoRestoreOrder 倒序放回，各回原位。
    const entries = removed.map(({ task, index }) => ({ task, index }));
    // 与「已完成」同样简短，长名字也能看到动作本身。
    offerUndo(entries, removed.length === 1 ? `已归档「${clipName(removed[0].name)}」` : `已移出 ${removed.length} 个已归档任务`,
      { keepArchived: true, glyph: "archive" });
  }

  // 撤销最近一批移出；看板提示条的按钮和切换面板里的 Z 共用。没有可撤销的返回 null，否则返回放回的任务。
  function undoLast() {
    if (!undo) return null;
    const { entries, keepArchived } = undo;
    undo = null;
    cancelUndo();
    toast.hidden = true;
    void (async () => {
      for (const { task, index } of undoRestoreOrder(entries)) {
        await mutate("restore", { task: keepArchived ? { ...task, keepArchived: true } : task, index });
        if (signal.aborted) return;
      }
    })();
    return entries.map(({ task }) => task);
  }
  effects.listen(undoButton, "click", () => { undoLast(); });
  effects.listen(addButton, "click", () => {
    const current = threads?.current();
    if (!current) return;
    addButton.hidden = true;
    void mutate("add", { threadId: current.id, title: current.title, projectId: current.projectId });
  });
  // 点在色板外面或按 Esc 关闭色板。
  effects.listen(doc, "pointerdown", (event) => {
    if (!picking || event.composedPath().some((node) => node?.classList?.contains("palette") || node?.dataset?.colorToggle !== undefined)) return;
    picking = null;
    render();
  });
  // 捕获阶段处理：Esc 在卡片或预览浮窗里按下时 preventDefault，这次 Esc 只关掉调色板 / 预览浮窗，
  // 宿主适配器看到 defaultPrevented 就不再收起整个弹层；焦点在宿主（如输入框）时不拦，Esc 照常归宿主。
  const inCard = (event) => event.composedPath().some((node) => node === root || node === peek);
  effects.listen(doc, "keydown", (event) => {
    if (event.key !== "Escape" || !picking) return;
    if (inCard(event)) event.preventDefault();
    picking = null;
    render();
  }, true);
  effects.listen(doc, "keydown", (event) => {
    if (event.key !== "Escape") return;
    if (peek.matches(":popover-open") && inCard(event)) event.preventDefault();
    closePeek();
  }, true);
  effects.listen(peek, "pointerenter", () => cancelPeek());
  effects.listen(peek, "pointerleave", () => schedulePeekClose());
  if (threads) effects.add(threads.subscribe(render));
  // 卡片收起时不必刷新状态；颜色标记由平台在侧栏重绘时自行补回。
  effects.add(stopWatch);
  effects.add(() => threads?.setMarks([]));
  trace = createTraceView({ rpc, effects, signal, threads, element, fail, isVisible });
  peek.append(trace.root);
  effects.add(closePeek);
  // Trace 读到数据后浮层会变高，重新贴位置，避免超出窗口底部。
  const peekResize = new doc.defaultView.ResizeObserver(() => { if (peekItem?.isConnected) placePeek(peekItem); });
  peekResize.observe(peek);
  effects.add(() => peekResize.disconnect());
  // 看板外最近打开的会话（settings.switcherAll）：侧栏里看得到或本页打开时记下了标题的才列，最多 MAX_OUTSIDE 个。
  function outsideItems() {
    const items = [];
    for (const id of recent) {
      if (items.length >= MAX_OUTSIDE) break;
      if (taskFor(id)) continue;
      const seen = visited.get(id);
      const title = threads?.title(id) ?? seen?.title;
      if (title) items.push({ threadId: id, outside: true, title, projectId: seen?.projectId ?? null });
    }
    return items;
  }
  function outsideRow(task, item) {
    item.dataset.outside = "";
    const status = element("span", "status");
    status.dataset.icon = "outside";
    status.setAttribute("aria-hidden", "true");
    status.innerHTML = `<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true">${STATUS_ICONS.outside}</svg>`;
    const text = element("span", "text");
    const title = element("span", "title");
    title.append(element("span", "name", task.title));
    const meta = element("span", "meta");
    setLabel(meta, { text: [projectName(task.projectId), "不在看板"].filter(Boolean).join(" · ") });
    text.append(title, meta);
    item.append(status, text);
  }

  // 需要你处理的会话，按看板顺序：先是提问、中断、没动静且没看过的，再是有新结果没看的，最后是看过但还在等你的；当前会话除外。
  // 没看过的总是优先；都看过了就从当前会话往后轮一圈，免得三个以上还在等你时只在头两个之间来回。
  function nextWaiting() {
    if (!board) return null;
    const current = threads?.current();
    const here = current ? taskFor(current.id) : null;
    const waiting = displayOrder().filter((task) => rankOf(task) <= 2);
    const fresh = waiting.find((task) => task !== here && rankOf(task) < 2);
    if (fresh) return fresh;
    const at = waiting.indexOf(here);
    return [...waiting.slice(at + 1), ...waiting.slice(0, Math.max(at, 0))][0] ?? null;
  }
  async function jumpToWaiting() {
    // 提醒弹着时等于点「去处理」。
    if (attention?.act?.()) return;
    closePeek();
    // 抽屉收起时看板可能没在同步，先拿一次最新状态。
    await refresh();
    if (signal.aborted) return;
    const task = nextWaiting();
    if (task) void reveal(task);
    else switcher?.flash("没有需要你处理的会话");
  }
  const nameOf = (task) => displayName(task) ?? task.suggestedName ?? "未命名会话";

  // 快捷键：需要平台的顶层浮层（抽屉收起时也能弹出）和侧栏会话列表。
  if (overlay && threads) {
    switcher = createSwitcher({
      doc, overlay, effects,
      style: `.panel{${TOKENS}}${ROW_STYLE}`,
      enabled: () => switcherOn,
      modifier: () => switcherKey,
      // 找不到记录的会话切过去也打不开，不列；侧栏里还有条目的除外（刚新建、还没发第一条消息的会话没有记录，但打得开）。
      items: () => {
        noteVisit();
        if (!board) return [];
        const tasks = displayOrder().filter((task) => task.status !== "missing" || idsOf(task).some((id) => threads.has(id)));
        return orderByRecent(switcherAll ? [...tasks, ...outsideItems()] : tasks, recent);
      },
      current: () => {
        const current = threads.current();
        if (!current) return null;
        return taskFor(current.id)?.threadId ?? (switcherAll ? current.id : null);
      },
      renderItem: (task, item) => {
        if (task.outside) { outsideRow(task, item); return; }
        if (colors[task.color]) item.style.setProperty("--task", colors[task.color]);
        const text = taskText(task);
        if (task.plan?.total) text.append(progressStrip(task.plan));
        item.append(statusIcon(task), text);
      },
      // Trace 浮层在页面顶层，开着会盖住切换面板，先收起。
      prepare: () => { closePeek(); void refresh(); },
      pick: (task) => { closePeek(); void reveal(task); },
      jump: () => { void jumpToWaiting(); },
      remove: (task) => {
        if (task.outside) { switcher.notice("这个会话不在看板上"); return; }
        const name = nameOf(task);
        void complete(task).then((done) => { if (done) switcher.notice(`已移出「${name}」，按 Z 撤销`); });
      },
      undo: () => {
        const tasks = undoLast();
        switcher.notice(tasks ? `已放回「${nameOf(tasks[0])}」${tasks.length > 1 ? ` 等 ${tasks.length} 个` : ""}` : "没有可撤销的移出");
      }
    });
  }
  // 接上后台存下的最近打开顺序；本页这段时间里新记的排在前面。
  void rpc("recent").then((stored) => {
    if (signal.aborted || !Array.isArray(stored?.recent)) return;
    recent = mergeRecent(recent, stored.recent);
    switcher?.refresh();
  }, () => {});
  if (attention) attention.subscribe(() => { if (!signal.aborted) syncWatch(); });
  render();
  void refresh();
  syncWatch();
  return {
    updateSettings(next) {
      switcherOn = next?.switcher !== false;
      const key = modifierOf(next?.switcherKey);
      const all = next?.switcherAll === true;
      if (!switcherOn || key !== switcherKey || all !== switcherAll) switcher?.cancel();
      switcherKey = key;
      switcherAll = all;
      autoAdd = next?.autoAdd === true;
      renderHeader();
      alertLevels = levelsOf(next);
      syncWatch();
    },
    visibilityChanged({ visible }) {
      if (visible) void refresh();
      syncWatch();
      if (!visible) closePeek();
      trace.visibilityChanged(visible);
    },
    dispose() { root.replaceChildren(); }
  };
}
