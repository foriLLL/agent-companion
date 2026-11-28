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
  plus: '<path d="M8 3.2v9.6M3.2 8h9.6"/>',
  edit: '<path d="M10.8 3.1l2.1 2.1-6.9 6.9H3.9V10z"/>',
  done: '<path d="M3.5 8.3l2.9 2.9 6.1-6.5"/>',
  color: '<circle cx="8" cy="8" r="5.1"/><circle cx="8" cy="8" r="1.8" fill="currentColor" stroke="none"/>',
  archive: '<path d="M2.8 3.6h10.4v2.6H2.8zM3.8 6.2v5.9a1 1 0 0 0 1 1h6.4a1 1 0 0 0 1-1V6.2M6.6 8.8h2.8"/>'
};
// 撤销提示里的会话名最多这么多字：长名字（比如整段首条消息）只留开头，动作本身始终看得见。
const TOAST_NAME_MAX = 10;
const clipName = (name) => {
  const chars = Array.from(String(name ?? "").replace(/\s+/g, " ").trim());
  return chars.length > TOAST_NAME_MAX ? `${chars.slice(0, TOAST_NAME_MAX).join("")}…` : chars.join("");
};
// 细线单色状态图标（主要用于 Option+Tab 切换面板与行内编辑器），去掉渐变填充与投影以贴合宿主原生风格。
const SPINNER_THIN = '<svg viewBox="0 0 16 16" width="12.5" height="12.5" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-opacity=".2" stroke-width="1.5"/><path class="arc" d="M8 2.5A5.5 5.5 0 0 1 13.5 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
const BUBBLE_OUTLINE = '<path d="M3.6 6.4A2.8 2.8 0 0 1 6.4 3.6h7.2a2.8 2.8 0 0 1 2.8 2.8v4.2a2.8 2.8 0 0 1-2.8 2.8H9.8l-3.3 2.5V13.4h-.1a2.8 2.8 0 0 1-2.8-2.8z"/>';
const STATUS_ICONS = {
  ask: '<circle cx="10" cy="10" r="6.8"/><path d="M8.3 8.1a1.9 1.9 0 1 1 2.7 1.7c-.55.28-.95.68-.95 1.25"/><circle cx="10" cy="13.8" r=".85" fill="currentColor" stroke="none"/>',
  alert: '<circle cx="10" cy="10" r="6.8"/><path d="M10 6.5v4.2"/><circle cx="10" cy="13.7" r=".85" fill="currentColor" stroke="none"/>',
  spin: '<circle cx="10" cy="10" r="6.6" stroke="currentColor" stroke-opacity=".2" stroke-width="1.9"/><path class="arc" d="M10 3.4a6.6 6.6 0 0 1 6.6 6.6" stroke="currentColor" stroke-width="1.9"/>',
  reply: `<g opacity=".62">${BUBBLE_OUTLINE}</g>`,
  unread: `${BUBBLE_OUTLINE}<circle cx="15.8" cy="4.4" r="2.4" fill="var(--running)" stroke="var(--cc-card-bg,#fff)" stroke-width="1.2"/>`,
  gone: '<circle cx="10" cy="10" r="6.6" stroke-dasharray="2.2 2.5" opacity=".48"/>',
  stopped: '<circle cx="10" cy="10" r="6.6" opacity=".52"/><rect x="7.5" y="7.5" width="5" height="5" rx="1" fill="currentColor" stroke="none" opacity=".62"/>',
  outside: `<g opacity=".48">${BUBBLE_OUTLINE}</g>`
};
const icon = (name) => `<svg viewBox="0 0 16 16" width="13.5" height="13.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

// 看板与 Option+Tab 切换面板共用：颜色变量，以及条目的状态图标、名字、标签、第二行与计划进度条。
const TOKENS = `--text:color-mix(in srgb,currentColor 66%,transparent);--muted:var(--cc-card-fg-muted,color-mix(in srgb,currentColor 48%,transparent));
      --line:var(--cc-card-border,color-mix(in srgb,currentColor 9%,transparent));--line-strong:var(--cc-card-border-strong,color-mix(in srgb,currentColor 16%,transparent));
      --hover:var(--cc-card-hover,color-mix(in srgb,currentColor 4.5%,transparent));--active:var(--cc-card-active,color-mix(in srgb,currentColor 8%,transparent));
      --bar-track:var(--cc-bar-track,color-mix(in srgb,currentColor 9%,transparent));--bar-fill:var(--cc-bar-fill,color-mix(in srgb,currentColor 78%,transparent));
      --attention:var(--cc-warn,#9f4f0c);--danger:var(--cc-danger,#c42b25);--ok:var(--cc-ok,#238559);--running:var(--cc-card-accent,#2563eb);
      --urgent-dur:1.6s;--ease:cubic-bezier(.22,1,.36,1)`;
const ROW_STYLE = `
    .status{position:relative;z-index:2;display:grid;place-items:center;width:28px;height:28px;border-radius:8px;
      background:color-mix(in srgb,var(--task) 13%,transparent);color:var(--muted)}
    .status svg{display:block;overflow:visible;width:16px;height:16px}
    .status[data-icon=ask]{color:var(--attention)}
    .status[data-icon=alert]{color:var(--danger)}
    .status[data-icon=unread]{color:var(--running)}
    .status[data-icon=spin] .arc{transform-origin:10px 10px;animation:turn .95s linear infinite}
    .text{min-width:0}
    .title{display:flex;align-items:center;gap:6px;min-width:0}
    .name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
    .tag{flex:none;display:inline-flex;align-items:center;gap:3px;padding:0 5px;border-radius:5px;font-size:11px;font-weight:500;line-height:17px;
      color:var(--attention);background:color-mix(in srgb,var(--attention) 11%,transparent)}
    .tag[data-tone=danger]{color:var(--danger);background:color-mix(in srgb,var(--danger) 11%,transparent)}
    .meta{position:relative;display:block;height:var(--meta-h,18px);line-height:var(--meta-h,18px);margin-top:var(--meta-gap,2px);overflow:hidden;font-size:11.5px}
    .meta:empty{display:none}
    .label{position:absolute;inset:0 auto 0 0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)}
    /* 进行中：文字整体压暗，一道亮带（文字本色）从左扫到右；用遮罩实现，深浅色主题都成立。
       内容变化时新文字从下方模糊浮入，旧文字向上淡出。 */
    .label.live{color:inherit;-webkit-mask-image:linear-gradient(90deg,rgba(0,0,0,.44) 38%,#000 50%,rgba(0,0,0,.44) 62%);
      mask-image:linear-gradient(90deg,rgba(0,0,0,.44) 38%,#000 50%,rgba(0,0,0,.44) 62%);-webkit-mask-size:280% 100%;mask-size:280% 100%;
      animation:sweep 2s linear infinite}
    .label.live.in{animation:roll-in .46s var(--ease) both,sweep 2s linear infinite}
    .label.in{animation:roll-in .46s var(--ease) both}
    .label.out{animation:roll-out .32s var(--ease) both}
    /* 计划进度：2.5px 细线分段，中性灰阶为主，进行中的那格明暗呼吸；右侧是完成数。 */
    .progress{display:flex;align-items:center;gap:7px;min-width:0}
    .progress-bar{flex:1;min-width:0;display:flex;gap:3px;height:2.5px}
    .progress-bar i{flex:1;min-width:2px;border-radius:99px;background:var(--bar-track)}
    .progress-bar i[data-status=completed],.progress-bar i[data-status=in_progress]{background:var(--bar-fill)}
    .progress-bar i[data-status=in_progress]{animation:breathe 1.8s ease-in-out infinite}
    .progress-count{flex:none;font-size:10.5px;line-height:1;color:var(--muted);font-variant-numeric:tabular-nums}
    @keyframes breathe{0%,100%{opacity:.35}50%{opacity:1}}
    @keyframes turn{to{transform:rotate(360deg)}}
    @keyframes sweep{from{-webkit-mask-position:100% 0;mask-position:100% 0}to{-webkit-mask-position:0 0;mask-position:0 0}}
    @keyframes roll-in{from{opacity:0;transform:translateY(70%);filter:blur(3px)}to{opacity:1;transform:none;filter:none}}
    @keyframes roll-out{from{opacity:1;transform:none;filter:none}to{opacity:0;transform:translateY(-70%);filter:blur(3px)}}`;

function ago(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) return "";
  const minutes = Math.floor((now - ms) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
function agoFull(ms, now = Date.now()) {
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
      font-family:var(--cc-card-font,var(--hg-font-family,inherit));letter-spacing:-.006em;-webkit-font-smoothing:antialiased}
    *{box-sizing:border-box}
    .board{padding:10px 6px 8px;font-size:12.5px;line-height:1.4}
    header{display:flex;align-items:center;gap:6px;padding:0 8px 7px;min-height:22px}
    h2{flex:none;margin:0;font-size:var(--cc-section-title-size,13px);font-weight:var(--cc-section-title-weight,600);
      color:var(--cc-section-title-color,inherit);white-space:nowrap}
    .count{font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums}
    .count:empty{display:none}
    .chips{min-width:0;margin-left:auto;display:flex;align-items:center;gap:8px;overflow:hidden;font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums}
    .chip{display:inline-flex;align-items:center;white-space:nowrap}
    .chip[data-kind=human]{color:var(--attention)}
    button{font:inherit;color:inherit;border:0;background:none;padding:0;cursor:pointer;letter-spacing:inherit}
    .add{display:flex;align-items:center;gap:7px;width:calc(100% - 8px);margin:0 4px 5px;padding:6px 9px;
      border:1px dashed var(--line-strong);border-radius:var(--cc-card-row-radius,8px);color:var(--muted);font-size:12px;text-align:left;
      transition:background-color .14s ease,color .14s ease,border-color .14s ease}
    .add:hover{background:var(--hover);color:inherit;border-color:var(--muted)}
    .add svg{flex:none}
    .add .title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .add b{font-weight:500;color:var(--text)}
    ul{list-style:none;margin:0;padding:0;display:grid;gap:1px}
    /* 条目：左侧 2.2px 短促居中指示线呼应侧栏颜色；需要人处理且未读时，指示线与右侧状态圆点同速脉冲。 */
    .task{--task:#8b8d98;--row-pad-y:7.5px;--line1-h:19px;--meta-gap:2px;--meta-h:18px;--action-size:20px;
      position:relative;display:flex;align-items:stretch;border-radius:var(--cc-card-row-radius,8px);
      transition:background-color .12s ease}
    .task::before{content:"";position:absolute;left:3.5px;top:10px;height:15px;width:2.2px;border-radius:2px;
      background:var(--task);opacity:.72;transform-origin:center;pointer-events:none;
      transition:opacity .15s ease,height .15s ease,top .15s ease}
    .task:hover::before,.task:focus-within::before,.task[data-peek]::before{opacity:1;top:8px;height:calc(100% - 16px)}
    .task:hover,.task:focus-within,.task[data-peek]{background:var(--hover)}
    .task[data-tone=warn]::before{background:var(--attention);opacity:.94}
    .task[data-tone=danger]::before{background:var(--danger);opacity:.96}
    .task[data-tone=warn][data-urgent]{background:color-mix(in srgb,var(--attention) 4.5%,transparent)}
    .task[data-tone=warn][data-urgent]:hover,.task[data-tone=warn][data-urgent]:focus-within,.task[data-tone=warn][data-urgent][data-peek]{
      background:color-mix(in srgb,var(--attention) 8.5%,transparent)}
    .task[data-tone=danger][data-urgent]{background:color-mix(in srgb,var(--danger) 5%,transparent)}
    .task[data-tone=danger][data-urgent]:hover,.task[data-tone=danger][data-urgent]:focus-within,.task[data-tone=danger][data-urgent][data-peek]{
      background:color-mix(in srgb,var(--danger) 9%,transparent)}
    /* 待确认 / 已中断 / 没动静统一节奏的快速双拍脉冲（纯 GPU 合成，与右侧涟漪同周期，已读自动静止）。 */
    .task[data-urgent]::before{width:2.5px;animation:edge-urgent var(--urgent-dur) ease-in-out infinite;will-change:transform,opacity}
    .task[data-status=stopped]{opacity:.8}
    .task[data-status=archived],.task[data-status=missing]{opacity:.72}
    .main{flex:1;min-width:0;display:flex;flex-direction:column;padding:var(--row-pad-y) 9px var(--row-pad-y) 13px;text-align:left;border-radius:var(--cc-card-row-radius,8px)}
    .main:focus-visible{outline:2px solid var(--cc-card-focus,color-mix(in srgb,currentColor 35%,transparent));outline-offset:-2px}
${ROW_STYLE}
    /* 第一行严格三列网格：[标题] [右对齐 3 字状态] [固定 34px 右对齐时间]，纵向严丝合缝对齐且悬停不隐藏时间。 */
    .line1{display:grid;grid-template-columns:minmax(0,1fr) auto 34px;align-items:center;column-gap:7px;height:var(--line1-h)}
    .main .name{font-size:12.5px;font-weight:450}
    .task[data-unread] .main .name,.task[data-tone] .main .name{font-weight:550}
    .state{display:inline-flex;align-items:center;justify-content:flex-end;gap:5px;font-size:11px;font-weight:500;line-height:1;white-space:nowrap}
    .state[data-tone=warn]{color:var(--attention)}
    .state[data-tone=warn-read]{color:var(--attention);font-weight:400}
    .state[data-tone=danger]{color:var(--danger)}
    .state[data-tone=accent]{color:var(--running)}
    .state[data-tone=muted]{color:var(--muted)}
    .state[data-tone=quiet]{color:var(--muted);font-weight:400}
    .beacon{position:relative;display:inline-flex;align-items:center;justify-content:center;width:6px;height:6px;flex:none}
    .beacon-core{width:5.5px;height:5.5px;border-radius:999px;background:currentColor}
    .beacon-ring{position:absolute;inset:0;border-radius:999px;background:currentColor;pointer-events:none;
      animation:ripple-urgent var(--urgent-dur) cubic-bezier(0,0,.2,1) infinite;will-change:transform,opacity}
    .unread-dot{width:5.5px;height:5.5px;border-radius:999px;background:currentColor;flex:none;
      animation:unread-breathe 2.4s ease-in-out infinite;will-change:transform,opacity}
    .spin-glyph{display:inline-flex;align-items:center}
    .spin-glyph .arc{transform-origin:8px 8px;animation:turn .95s linear infinite}
    .when{text-align:right;font-size:11px;color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums}
    .task[data-tone=danger] .meta .label{color:var(--danger)}
    .main .progress{margin-top:5px}
    /* 悬停操作放在第二行右侧：与行高变量联动定位，无底板无阴影，透明融入行背景，第一行标题/状态/时间纹丝不动。 */
    .actions{position:absolute;right:7px;top:calc(var(--row-pad-y) + var(--line1-h) + var(--meta-gap) + (var(--meta-h) - var(--action-size)) / 2);
      z-index:3;height:var(--action-size);display:inline-flex;align-items:center;gap:1px;
      background:transparent;opacity:0;pointer-events:none;transition:opacity .12s ease}
    .task:hover .actions,.task:focus-within .actions{opacity:1;pointer-events:auto}
    .task:hover .meta,.task:focus-within .meta{margin-right:66px}
    .icon{display:grid;place-items:center;width:var(--action-size);height:var(--action-size);border-radius:6px;color:var(--muted);transition:background-color .12s ease,color .12s ease}
    .icon:hover{color:currentColor;background:var(--active)}
    .icon[data-action=done]:hover{color:var(--ok);background:color-mix(in srgb,var(--ok) 12%,transparent)}
    .palette{flex:1;display:flex;align-items:center;justify-content:space-between;gap:4px;padding:10px 10px 10px 16px;min-height:46px}
    .palette button{width:18px;height:18px;border-radius:50%;background:var(--swatch);box-shadow:inset 0 0 0 1px rgba(0,0,0,.12);transition:transform .16s var(--ease)}
    .palette button:hover{transform:scale(1.16)}
    .palette button[aria-checked=true]{box-shadow:0 0 0 2px var(--cc-card-bg,Canvas),0 0 0 3.5px currentColor}
    .editor{flex:1;display:flex;align-items:center;padding:8px 10px 8px 13px;min-height:46px}
    input{width:100%;font:inherit;font-size:12.5px;font-weight:500;color:inherit;background:var(--cc-card-input-bg,transparent);border:1px solid var(--line-strong);
      border-radius:6px;padding:3px 7px;outline:none}
    input:focus{border-color:var(--cc-card-focus,currentColor)}
    .empty{margin:6px 10px;font-size:12px;line-height:1.55;color:var(--muted)}
    .note{margin:6px 8px 2px;padding:7px 9px;border-radius:8px;font-size:11.5px;line-height:1.4;
      color:var(--danger);background:color-mix(in srgb,var(--danger) 10%,transparent);border:1px solid color-mix(in srgb,var(--danger) 24%,transparent)}
    /* 撤销提示：与条目同一套浅底细边，底边细线随倒计时缩短。 */
    .toast{position:relative;display:flex;align-items:center;gap:8px;margin:8px 4px 0;padding:5px 6px 5px 10px;border-radius:8px;
      overflow:hidden;font-size:12px;color:var(--text);background:var(--hover);box-shadow:inset 0 0 0 1px var(--line);
      animation:toast-in .22s var(--ease) both}
    .toast::after{content:"";position:absolute;left:8px;right:8px;bottom:0;height:1.5px;border-radius:1px;
      background:color-mix(in srgb,currentColor 20%,transparent);transform-origin:left;animation:toast-drain ${UNDO_MS}ms linear both}
    .toast .glyph{flex:none;display:grid;place-items:center}
    .toast span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .toast button{flex:none;font-size:11.5px;font-weight:500;padding:2px 8px;border-radius:6px;color:inherit;
      background:var(--active);transition:opacity .12s ease}
    .toast button:hover{opacity:.82}
    @keyframes toast-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
    @keyframes toast-drain{from{transform:scaleX(1)}to{transform:scaleX(0)}}
    [hidden]{display:none!important}
    /* Trace 浮层放在顶层（popover），不受卡片宽度和裁剪限制，贴在看板左侧展开。 */
    .peek{position:fixed;inset:auto;margin:0;padding:14px 12px 12px;border:0;border-radius:var(--cc-card-radius,var(--hg-panel-radius,14px));overflow:auto;max-height:calc(100vh - 24px);
      color:inherit;background:var(--cc-card-bg,Canvas);font:inherit;font-size:13px;line-height:1.4;
      box-shadow:0 0 0 1px var(--cc-card-border,color-mix(in srgb,currentColor 14%,transparent)),0 12px 32px rgba(0,0,0,.14),0 2px 6px rgba(0,0,0,.05);
      opacity:0;transform:translateX(6px);transition:opacity .16s ease,transform .2s var(--ease),overlay .2s allow-discrete,display .2s allow-discrete}
    .peek:popover-open{opacity:1;transform:none}
    @starting-style{.peek:popover-open{opacity:0;transform:translateX(6px)}}
${TRACE_STYLE}
    @keyframes ray{0%{opacity:1}100%{opacity:.18}}
    @keyframes ripple-urgent{0%{transform:scale(1);opacity:.72}60%,100%{transform:scale(2.9);opacity:0}}
    @keyframes edge-urgent{0%,100%{opacity:.42;transform:scaleY(.8)}14%{opacity:1;transform:scaleY(1.22)}28%{opacity:.45;transform:scaleY(.84)}44%{opacity:1;transform:scaleY(1.22)}60%{opacity:.42;transform:scaleY(.8)}}
    @keyframes unread-breathe{0%,100%{opacity:.48;transform:scale(.92)}50%{opacity:1;transform:scale(1.08)}}
    @media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
  </style><section class="board" aria-label="任务看板">
    <header><h2>任务看板</h2><span class="count"></span><span class="chips"></span></header>
    <button type="button" class="add" hidden>${icon("plus")}<span class="title">加入当前会话 · <b></b></span></button>
    <ul></ul>
    <div class="peek" popover="manual" aria-label="会话 Trace"></div>
    <p class="empty" hidden></p>
    <p class="note" hidden></p>
    <div class="toast" role="status" hidden><i class="glyph"></i><span></span><button type="button">撤销</button></div>
  </section>`;
  const count = root.querySelector(".count");
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
  // 未自定义名字时：侧栏按会话 id 精确绑定的实时标题（Codex）优先；
  // 只能从窗口标题兜底的宿主（Antigravity，titleFallback: true）优先用后台摘要库里的真实标题，
  // 避免切页瞬间窗口标题滞后把上一个会话的名字盖到当前任务上。
  const liveTitle = (task) => idsOf(task).map((id) => threads?.title(id)).find(Boolean) ?? null;
  const displayName = (task) => task.customName
    ?? (threads?.titleFallback ? (task.suggestedName ?? liveTitle(task)) : (liveTitle(task) ?? task.suggestedName))
    ?? task.name;

  function renderHeader() {
    const current = threads?.current();
    const added = current && taskFor(current.id);
    addButton.hidden = !board || !current || added;
    addTitle.textContent = current?.title ?? "未命名会话";
    addButton.title = current?.title ?? "";
    const total = board?.tasks.length ?? 0;
    count.textContent = total ? String(total) : "";
    const running = board?.tasks.filter((task) => task.status === "running").length ?? 0;
    const human = board?.tasks.filter((task) => STATUS[task.status]?.human).length ?? 0;
    const nextChips = [human ? ["human", `${human} 待处理`] : null, running ? ["running", `${running} 进行中`] : null].filter(Boolean);
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
    editor.append(input);
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
  const whenTitleOf = (task) => (["running", "archived", "missing"].includes(task.status) ? "" : agoFull(task.turnAt ?? task.updatedAt));
  function tagOf(task) {
    if (!STATUS[task.status]?.human) return null;
    return task.status === "asking" ? { text: task.unread ? "待确认" : "待回复" } : { text: task.status === "stalled" ? "没动静" : "已中断", tone: "danger" };
  }
  const iconOf = (task) => (task.status === "idle" && task.unread ? "unread" : STATUS[task.status]?.icon ?? "gone");

  // 看板行右侧的对齐状态单元：统一 3 字（待确认 / 待回复 / 已中断 / 没动静 / 进行中 / 新回复 / 已停止 / 已归档 / 找不到），
  // 去掉中间多余小图标，待确认与已中断/没动静使用同速涟漪圆点，已读后自动静止。
  function boardState(task) {
    const node = element("span", "state");
    node.dataset.icon = iconOf(task);
    node.title = statusLabel(task);
    node.setAttribute("role", "img");
    node.setAttribute("aria-label", statusLabel(task));
    const beacon = () => {
      const wrap = element("span", "beacon");
      wrap.setAttribute("aria-hidden", "true");
      wrap.append(element("i", "beacon-ring"), element("i", "beacon-core"));
      return wrap;
    };
    if (task.status === "asking") {
      node.dataset.tone = task.unread ? "warn" : "warn-read";
      if (task.unread) node.append(beacon());
      node.append(element("span", "state-text", task.unread ? "待确认" : "待回复"));
    } else if (task.status === "interrupted" || task.status === "stalled") {
      node.dataset.tone = "danger";
      if (task.unread) node.append(beacon());
      node.append(element("span", "state-text", task.status === "stalled" ? "没动静" : "已中断"));
    } else if (task.status === "running") {
      node.dataset.tone = "muted";
      const spin = element("span", "spin-glyph");
      spin.innerHTML = SPINNER_THIN;
      node.append(spin, element("span", "state-text", "进行中"));
    } else if (task.status === "idle" && task.unread) {
      node.dataset.tone = "accent";
      const dot = element("i", "unread-dot");
      dot.setAttribute("aria-hidden", "true");
      node.append(dot, element("span", "state-text", "新回复"));
    } else if (task.status === "stopped") {
      node.dataset.tone = "quiet";
      node.append(element("span", "state-text", "已停止"));
    } else if (task.status === "archived" || task.status === "missing") {
      node.dataset.tone = "quiet";
      node.append(element("span", "state-text", task.status === "archived" ? "已归档" : "找不到"));
    }
    return node;
  }

  function statusIcon(task) {
    const node = element("span", "status");
    node.dataset.icon = iconOf(task);
    node.title = statusLabel(task);
    node.setAttribute("role", "img");
    node.setAttribute("aria-label", statusLabel(task));
    const glyph = STATUS_ICONS[node.dataset.icon];
    node.innerHTML = `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${glyph}</svg>`;
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
    if (task.status === "asking") item.dataset.tone = "warn";
    else if (task.status === "interrupted" || task.status === "stalled") item.dataset.tone = "danger";
    if (STATUS[task.status]?.human && task.unread) item.dataset.urgent = "";
    if (task.unread) item.dataset.unread = "";
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
    const line1 = element("span", "line1");
    const whenNode = element("span", "when", whenOf(task));
    const whenTip = whenTitleOf(task);
    if (whenTip) whenNode.title = whenTip;
    line1.append(element("span", "name", displayName(task)), boardState(task), whenNode);
    const meta = element("span", "meta");
    setLabel(meta, metaOf(task, BOARD_META));
    main.append(line1, meta);
    syncProgress(main, task.plan);
    const latest = () => taskFor(task.threadId) ?? task;
    main.addEventListener("click", () => { closePeek(); void reveal(latest(), item); });
    item.addEventListener("pointerenter", () => hoverPeek(latest(), item));
    item.addEventListener("pointerleave", schedulePeekClose);
    const actions = element("span", "actions");
    actions.append(
      colorToggle(iconButton("color", "换颜色", () => { picking = picking === task.threadId ? null : task.threadId; render(); })),
      iconButton("edit", "改名", () => { picking = null; editing = task.threadId; render(); }),
      iconButton("done", "完成，移出看板", () => { void complete(latest()); })
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
    if (!task) {
      const previous = visited.get(current.id);
      visited.set(current.id, { title: current.title ?? previous?.title ?? null, projectId: current.projectId ?? previous?.projectId ?? null });
    }
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
        if (when) {
          const nextWhen = whenOf(task);
          if (when.textContent !== nextWhen) when.textContent = nextWhen;
          const nextWhenTip = whenTitleOf(task);
          if (when.title !== nextWhenTip) when.title = nextWhenTip;
        }
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
    // 忽略乱序迟到的旧版快照（例如 watch 在本地修改前已算好旧 revision），避免短暂回退旧标题或旧列表。
    if (board && Number.isSafeInteger(next.revision) && next.revision > 0 && Number.isSafeInteger(board.revision) && next.revision < board.revision) return;
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
    const result = await threads.reveal(id, { source: item ? (item.querySelector(".state:not(:empty), .status") ?? item.querySelector(".name") ?? item) : null, projectId: task.projectId });
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
