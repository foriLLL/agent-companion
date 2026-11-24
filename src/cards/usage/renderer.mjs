// 额度卡片：Codex 账号各时间窗口（5 小时 / 每周 …）的剩余额度与重置时间。
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

function agoText(fetchedAt, now = Date.now()) {
  const minutes = Math.floor((now - fetchedAt) / 60_000);
  return minutes < 1 ? "刚刚更新" : minutes < 60 ? `${minutes} 分钟前更新` : `${Math.floor(minutes / 60)} 小时前更新`;
}

export function mount({ root, rpc, effects, signal }) {
  root.innerHTML = `<style>
    :host{display:block;--text:color-mix(in srgb,currentColor 64%,transparent);--line:color-mix(in srgb,currentColor 10%,transparent);
      font-family:"Inter",ui-sans-serif,system-ui,-apple-system,"PingFang SC",sans-serif;letter-spacing:-.006em;-webkit-font-smoothing:antialiased}
    *{box-sizing:border-box}
    .wrap{padding:12px 12px 14px 14px;display:flex;flex-direction:column;gap:12px;font-size:13.5px;line-height:1.4}
    .head{display:flex;align-items:center;gap:8px}
    .head strong{font-weight:600}
    .plan{font-size:11.5px;padding:1px 7px;border-radius:999px;color:var(--text);box-shadow:inset 0 0 0 1px var(--line)}
    .plan:empty{display:none}
    .ago{margin-left:auto;font-size:12px;color:var(--text)}
    button{flex:none;font:inherit;font-size:12px;letter-spacing:inherit;border:0;border-radius:8px;padding:4px 10px;cursor:pointer;color:inherit;
      background:color-mix(in srgb,currentColor 5%,transparent);box-shadow:inset 0 0 0 1px var(--line);transition:background-color .16s ease}
    button:hover{background:color-mix(in srgb,currentColor 9%,transparent)}
    button:disabled{opacity:.5;cursor:default}
    .limits{display:flex;flex-direction:column;gap:11px}
    .limit{--tone:#8b8d98;display:flex;flex-direction:column;gap:5px}
    .limit[data-tone=ok]{--tone:#2f9e6e}.limit[data-tone=warn]{--tone:#d9661b}.limit[data-tone=bad]{--tone:#d93025}
    .line{display:flex;align-items:baseline;gap:8px}
    .name{font-weight:500}.scope{font-size:12px;color:var(--text)}
    .left{margin-left:auto;font-variant-numeric:tabular-nums;font-weight:600;color:var(--tone)}
    .bar{height:6px;border-radius:999px;background:color-mix(in srgb,currentColor 8%,transparent);overflow:hidden}
    .fill{height:100%;border-radius:inherit;background:var(--tone);transition:width .3s ease}
    .reset{font-size:12px;color:var(--text);font-variant-numeric:tabular-nums}
    .note{font-size:12px;color:var(--text);overflow-wrap:anywhere}
    .note[data-tone=warn]{color:#d9661b}.note[data-tone=bad]{color:#d93025}
    .note:empty{display:none}
  </style><div class="wrap">
    <div class="head"><strong>Codex</strong><span class="plan"></span><span class="ago" role="status">正在读取额度…</span>
      <button type="button" aria-label="刷新额度">刷新</button></div>
    <div class="limits"></div>
    <div class="note"></div>
  </div>`;
  const plan = root.querySelector(".plan");
  const ago = root.querySelector(".ago");
  const list = root.querySelector(".limits");
  const note = root.querySelector(".note");
  const button = root.querySelector("button");
  const el = (tag, cls, text) => {
    const node = root.ownerDocument.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };
  let data = null;
  let pending = null;

  function render() {
    if (!data) return;
    const now = Date.now();
    plan.textContent = data.plan ?? "";
    ago.textContent = data.fetchedAt && (data.ok || data.stale) ? agoText(data.fetchedAt, now) : "";
    list.replaceChildren();
    for (const limit of data.limits ?? []) {
      const remaining = limit.usedPercent === null ? null : Math.round(100 - limit.usedPercent);
      const row = el("div", "limit");
      row.dataset.tone = remainingTone(remaining);
      const line = el("div", "line");
      line.append(el("span", "name", windowLabel(limit.windowMinutes)));
      if (limit.scope) line.append(el("span", "scope", limit.scope));
      line.append(el("span", "left", remaining === null ? "—" : `剩余 ${remaining}%`));
      const bar = el("div", "bar");
      const fill = el("div", "fill");
      fill.style.width = `${remaining ?? 0}%`;
      bar.append(fill);
      row.append(line, bar, el("div", "reset", resetText(limit.resetsAt, now)));
      list.append(row);
    }
    const notes = [];
    let tone = "";
    if (data.limitReached) { notes.push("已用完额度，重置前无法继续使用"); tone = "bad"; }
    if (data.credits !== null && data.credits !== undefined) notes.push(`积分余额 ${Math.floor(data.credits).toLocaleString()}`);
    if (!data.ok || data.stale) { notes.push(data.stale ? `刷新失败，显示的是上次结果：${data.error}` : data.error); tone ||= "warn"; }
    if (data.ok && !data.limits?.length && !notes.length) notes.push("这个账号没有返回额度窗口");
    note.textContent = notes.join(" · ");
    note.dataset.tone = tone;
  }

  function refresh(force = false) {
    if (pending) return pending;
    button.disabled = true;
    pending = (async () => {
      try {
        const next = await rpc("status", force ? { force: true } : {});
        if (signal.aborted) return;
        data = next;
        render();
      } catch (error) {
        if (signal.aborted || SILENT_CODES.has(error?.code)) return;
        data = { ...(data ?? { limits: [] }), ok: false, stale: Boolean(data?.ok), error: error?.message || "读取失败，请稍后重试" };
        render();
      } finally {
        pending = null;
        if (!signal.aborted) button.disabled = false;
      }
    })();
    return pending;
  }

  effects.listen(button, "click", () => { void refresh(true); });
  // 后台有 5 分钟缓存，这里每分钟问一次只是取缓存；倒计时文字每 30 秒重算。
  effects.interval(() => { void refresh(); }, POLL_MS);
  effects.interval(render, TICK_MS);
  void refresh();
  return {
    visibilityChanged({ visible }) { if (visible) void refresh(); },
    dispose() { root.replaceChildren(); }
  };
}
