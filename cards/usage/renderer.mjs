// 额度卡片：各时间窗口（5 小时 / 每周 …）的剩余额度与重置时间。
// 在 Codex 里显示 Codex 账号的额度（后台经官方 app-server 读）；在 Antigravity 里显示 Antigravity 自己的
// 模型额度（ctx.host.quota()，即 Hub「模型额度」面板的数据，按 Gemini / Claude·GPT 分组）。
const POLL_MS = 60_000;
const TICK_MS = 30_000;
// 取消、实例替换和卡片关闭都不是需要提示用户的失败。
const SILENT_CODES = new Set(["ABORTED", "RPC_CANCELLED", "RPC_STALE_GENERATION", "CARD_DISABLED"]);
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function windowLabel(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return "额度";
  if (minutes === 300) return "5 小时";
  if (minutes === 10_080) return "每周";
  if (minutes >= 40_320 && minutes <= 44_640) return "每月";
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

export function resetText(resetsAt, now = Date.now()) {
  if (!Number.isFinite(resetsAt)) return "";
  const at = new Date(resetsAt * 1000);
  const minutes = Math.max(0, Math.round((at.getTime() - now) / 60_000));
  if (minutes < 1) return "即将重置";
  if (minutes < 60) return `${minutes} 分钟后重置`;
  if (minutes < 24 * 60) {
    const rest = minutes % 60;
    return `${Math.floor(minutes / 60)} 小时${rest ? ` ${rest} 分` : ""}后重置`;
  }
  const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  return `${at.getMonth() + 1}/${at.getDate()} ${WEEKDAYS[at.getDay()]} ${time} 重置`;
}

export function remainingTone(remaining) {
  if (remaining === null) return "off";
  if (remaining > 50) return "ok";
  if (remaining > 20) return "warn";
  return "bad";
}

// Antigravity 的窗口写法：5h / weekly / daily，或 <数字><s|m|h|d>。
export function antigravityWindowLabel(window, fallback = "额度") {
  const value = String(window ?? "").trim().toLowerCase();
  if (value === "weekly") return "每周";
  if (value === "daily") return "每天";
  const match = /^(\d+)([smhd])$/.exec(value);
  if (match) return `${match[1]} ${{ s: "秒", m: "分钟", h: "小时", d: "天" }[match[2]]}`;
  return fallback || "额度";
}

// 分组名：按桶 id 前缀认出 Gemini 与第三方模型，其余用 Antigravity 给的名字。
export function antigravityGroupLabel(group) {
  const id = group?.buckets?.[0]?.id ?? "";
  if (id.startsWith("gemini")) return "Gemini 模型";
  if (id.startsWith("3p")) return "Claude / GPT 模型";
  return group?.name || "模型";
}

// 圆环下的短写法：「1h48m 后」「12/1 04:08」；完整说法放在 title 里。
export function shortResetText(resetsAt, now = Date.now()) {
  if (!Number.isFinite(resetsAt)) return "";
  const at = new Date(resetsAt * 1000);
  const minutes = Math.max(0, Math.round((at.getTime() - now) / 60_000));
  if (minutes < 1) return "即将重置";
  if (minutes < 60) return `${minutes}m 后`;
  if (minutes < 24 * 60) {
    const rest = minutes % 60;
    return `${Math.floor(minutes / 60)}h${rest ? `${rest}m` : ""} 后`;
  }
  return `${at.getMonth() + 1}/${at.getDate()} ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

function agoText(fetchedAt, now = Date.now()) {
  const minutes = Math.floor((now - fetchedAt) / 60_000);
  return minutes < 1 ? "刚刚更新" : minutes < 60 ? `${minutes} 分钟前更新` : `${Math.floor(minutes / 60)} 小时前更新`;
}

// 两家的数据整理成同一种形状：若干组，每组若干窗口（剩余百分比 0..100 或 null）。
function sectionsOf(data) {
  const sections = [];
  for (const group of data.groups ?? []) {
    if (!group.buckets?.length) continue;
    sections.push({ title: antigravityGroupLabel(group), items: group.buckets.map((bucket) => ({
      label: antigravityWindowLabel(bucket.window, bucket.name), hint: bucket.description || bucket.name,
      remaining: bucket.remaining === null ? null : Math.round(bucket.remaining * 100), resetsAt: bucket.resetsAt, disabled: bucket.disabled
    })) });
  }
  if (data.limits?.length) {
    sections.push({ title: "", items: data.limits.map((limit) => ({
      label: windowLabel(limit.windowMinutes), hint: limit.scope ?? "",
      remaining: limit.usedPercent === null ? null : Math.round(100 - limit.usedPercent), resetsAt: limit.resetsAt, disabled: false
    })) });
  }
  return sections;
}

// 多分组或 3 个及以上窗口用紧凑两列细条省空间；1~2 个无分组窗口（如 Codex）用全宽横向细条。
export function shouldUseCompactGrid(sections) {
  const count = sections.reduce((sum, section) => sum + (section.items?.length ?? 0), 0);
  return count >= 3 || sections.some((section) => Boolean(section.title));
}
export const shouldUseRings = shouldUseCompactGrid;

// 读取失败（RPC 或宿主接口出错）后要显示的数据：手里有过成功的额度就继续显示并标记 stale。
// 连续失败时上一份已经是 ok:false + stale:true，仍要保持 stale，不能让旧的额度条看起来像是最新的。
export function failedUsageData(previous, message) {
  return {
    ...(previous ?? { limits: [] }),
    ok: false,
    stale: Boolean(previous?.ok || previous?.stale),
    error: message || "读取失败，请稍后重试"
  };
}

const REFRESH_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.2 8a5.2 5.2 0 1 1-1.3-3.45"/><path d="M13.2 2.8v2.3h-2.3"/></svg>';

export function mount({ root, rpc, effects, signal, host }) {
  const antigravity = host?.id === "antigravity" && typeof host.quota === "function";
  root.innerHTML = `<style>
    :host{display:block;--text:var(--cc-card-fg-muted,color-mix(in srgb,currentColor 52%,transparent));
      --secondary:color-mix(in srgb,currentColor 72%,transparent);
      --line:var(--cc-card-border,color-mix(in srgb,currentColor 9%,transparent));
      --hover:var(--cc-card-hover,color-mix(in srgb,currentColor 5%,transparent));
      --bar-track:var(--cc-bar-track,color-mix(in srgb,currentColor 9%,transparent));
      --bar-fill:var(--cc-bar-fill,color-mix(in srgb,currentColor 78%,transparent));
      --warn:var(--cc-warn,#9f4f0c);--danger:var(--cc-danger,#c42b25);
      font-family:var(--cc-card-font,var(--hg-font-family,inherit));letter-spacing:-.006em;-webkit-font-smoothing:antialiased}
    *{box-sizing:border-box}
    .wrap{padding:10px 13px 12px;display:flex;flex-direction:column;gap:8px;font-size:12px;line-height:1.35}
    .head{display:flex;align-items:center;gap:6px;min-height:22px}
    .head strong{font-size:var(--cc-section-title-size,13px);font-weight:var(--cc-section-title-weight,600);
      color:var(--cc-section-title-color,inherit)}
    .plan{font-size:10.5px;padding:0 6px;border-radius:999px;color:var(--text);box-shadow:inset 0 0 0 1px var(--line)}
    .plan:empty{display:none}
    .ago{margin-left:auto;font-size:10.5px;color:var(--text);font-variant-numeric:tabular-nums}
    .refresh{flex:none;display:grid;place-items:center;width:22px;height:22px;padding:0;border:0;border-radius:6px;
      background:transparent;color:var(--text);cursor:pointer;transition:background-color .14s,color .14s}
    .refresh:hover:not(:disabled){background:var(--hover);color:inherit}
    .refresh:focus-visible{outline:2px solid var(--cc-card-focus,color-mix(in srgb,currentColor 30%,transparent));outline-offset:1px}
    .refresh:disabled{opacity:.5;cursor:default}
    .refresh svg{display:block;width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round}
    .refresh[data-busy] svg{animation:spin .75s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    .sections{display:flex;flex-direction:column;gap:9px}
    .section{display:flex;flex-direction:column;gap:5px;min-width:0}
    .title{font-size:11px;font-weight:500;color:var(--text);white-space:nowrap}
    .title:empty{display:none}
    .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 12px}
    .bar{--tone:var(--bar-fill);--pct-color:inherit;display:flex;flex-direction:column;gap:4px;min-width:0}
    .bar[data-tone=warn]{--tone:var(--warn);--pct-color:var(--warn)}
    .bar[data-tone=bad]{--tone:var(--danger);--pct-color:var(--danger)}
    .bar[data-tone=off]{--tone:var(--bar-track);--pct-color:var(--text)}
    .bar-head{display:flex;align-items:baseline;gap:5px;font-size:11.5px;min-width:0}
    .bar-name{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--secondary);font-weight:450}
    .bar-reset{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10.5px;color:var(--text);font-variant-numeric:tabular-nums}
    .bar-pct{flex:none;margin-left:auto;font-size:11.5px;font-weight:500;font-variant-numeric:tabular-nums;color:var(--pct-color)}
    .bar-track{height:3px;border-radius:999px;background:var(--bar-track);overflow:hidden}
    .bar-fill{height:100%;border-radius:inherit;background:var(--tone);transition:width .26s ease}
    .note{font-size:11px;line-height:1.45;color:var(--text);overflow-wrap:anywhere}
    .note[data-tone=warn]{padding:6px 8px;border-radius:8px;color:var(--warn);background:color-mix(in srgb,var(--warn) 10%,transparent);
      border:1px solid color-mix(in srgb,var(--warn) 24%,transparent)}
    .note[data-tone=bad]{padding:6px 8px;border-radius:8px;color:var(--danger);background:color-mix(in srgb,var(--danger) 10%,transparent);
      border:1px solid color-mix(in srgb,var(--danger) 24%,transparent)}
    .note:empty{display:none}
    @media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
  </style><div class="wrap">
    <div class="head"><strong>${antigravity ? "模型额度" : "额度"}</strong><span class="plan"></span><span class="ago" role="status">正在读取额度…</span>
      <button type="button" class="refresh" aria-label="刷新额度" title="刷新">${REFRESH_ICON}</button></div>
    <div class="sections"></div>
    <div class="note"></div>
  </div>`;
  const plan = root.querySelector(".plan");
  const ago = root.querySelector(".ago");
  const list = root.querySelector(".sections");
  const note = root.querySelector(".note");
  const button = root.querySelector("button");
  const doc = root.ownerDocument;
  const el = (tag, cls, text) => {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };
  let data = null;
  let pending = null;

  function bar(item, now, compact = false) {
    const node = el("div", "bar");
    const remaining = item.disabled ? null : item.remaining;
    node.dataset.tone = item.disabled ? "off" : remainingTone(remaining);
    const reset = item.disabled ? "不可用" : remaining === 100 ? "未使用" : remaining === 0 ? "已用完"
      : (compact ? shortResetText(item.resetsAt, now) : resetText(item.resetsAt, now));
    const head = el("div", "bar-head");
    head.append(el("span", "bar-name", item.label), el("span", "bar-reset", reset),
      el("span", "bar-pct", item.disabled || remaining === null ? "—" : `${remaining}%`));
    const track = el("div", "bar-track");
    const fill = el("div", "bar-fill");
    fill.style.width = `${Math.max(0, Math.min(100, remaining ?? 0))}%`;
    track.append(fill);
    node.append(head, track);
    const full = item.disabled ? "不可用" : remaining === null ? "未知" : `剩余 ${remaining}%`;
    node.title = [item.label + (item.hint ? `（${item.hint}）` : ""), full, remaining === 100 ? "" : resetText(item.resetsAt, now)].filter(Boolean).join(" · ");
    return node;
  }

  function render() {
    if (!data) return;
    const now = Date.now();
    plan.textContent = data.plan ?? "";
    ago.textContent = data.fetchedAt && (data.ok || data.stale) ? agoText(data.fetchedAt, now) : "";
    const sections = sectionsOf(data);
    const compact = shouldUseCompactGrid(sections);
    list.dataset.layout = compact ? "grid" : "bars";
    if (compact) {
      list.replaceChildren(...sections.map((section) => {
        const node = el("div", "section");
        const grid = el("div", "grid");
        grid.append(...section.items.map((item) => bar(item, now, true)));
        node.append(el("div", "title", section.title), grid);
        return node;
      }));
    } else {
      list.replaceChildren(...sections.flatMap((section) => section.items.map((item) => bar(item, now, false))));
    }
    const notes = [];
    let tone = "";
    if (data.limitReached) { notes.push("已用完额度，重置前无法继续使用"); tone = "bad"; }
    if (data.credits !== null && data.credits !== undefined) notes.push(`积分余额 ${Math.floor(data.credits).toLocaleString()}`);
    if (!data.ok || data.stale) { notes.push(data.stale ? `刷新失败，显示的是上次结果：${data.error}` : data.error); tone ||= "warn"; }
    if (data.ok && !sections.length && !notes.length) notes.push("这个账号没有返回额度窗口");
    note.textContent = notes.join(" · ");
    note.dataset.tone = tone;
  }

  function refresh(force = false) {
    if (pending) return pending;
    button.disabled = true;
    button.setAttribute("data-busy", "");
    pending = (async () => {
      try {
        const next = antigravity
          ? { ok: true, fetchedAt: Date.now(), plan: null, limits: [], credits: null, ...(await host.quota({ force })) }
          : await rpc("status", force ? { force: true } : {});
        if (signal.aborted) return;
        data = next;
        render();
      } catch (error) {
        if (signal.aborted || SILENT_CODES.has(error?.code)) return;
        data = failedUsageData(data, error?.message);
        render();
      } finally {
        pending = null;
        if (!signal.aborted) {
          button.disabled = false;
          button.removeAttribute("data-busy");
        }
      }
    })();
    return pending;
  }

  effects.listen(button, "click", () => { void refresh(true); });
  // Codex：后台有 5 分钟缓存；Antigravity：不带 force 时取它自己的缓存。每分钟问一次，倒计时文字每 30 秒重算。
  effects.interval(() => { void refresh(); }, POLL_MS);
  effects.interval(render, TICK_MS);
  void refresh();
  return {
    visibilityChanged({ visible }) { if (visible) void refresh(); },
    dispose() { root.replaceChildren(); }
  };
}
