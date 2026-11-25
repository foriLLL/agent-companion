const REFRESH_MS = 30_000;
// 取消、实例替换和卡片关闭都不是需要提示用户的失败。
const SILENT_CODES = new Set(["ABORTED", "RPC_CANCELLED", "RPC_STALE_GENERATION", "CARD_DISABLED"]);
const REFRESH_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.2 8a5.2 5.2 0 1 1-1.3-3.45"/><path d="M13.2 2.8v2.3h-2.3"/></svg>';

export function mount({ root, rpc, effects, signal }) {
  root.innerHTML = `<style>
    :host{display:block;--text:color-mix(in srgb,currentColor 60%,transparent);
      font-family:"Inter",ui-sans-serif,system-ui,-apple-system,"PingFang SC",sans-serif;letter-spacing:-.006em;-webkit-font-smoothing:antialiased}
    *{box-sizing:border-box}
    .row{display:flex;align-items:center;gap:8px;padding:9px 10px 9px 14px;font-size:12.5px;line-height:1.35}
    .dot{--tone:#8b8d98;flex:none;width:7px;height:7px;border-radius:50%;background:var(--tone)}
    .dot[data-tone=ok]{--tone:#2f9e6e;box-shadow:0 0 0 3px color-mix(in srgb,var(--tone) 18%,transparent)}
    .dot[data-tone=warn]{--tone:#d9661b;box-shadow:0 0 0 3px color-mix(in srgb,var(--tone) 18%,transparent)}
    .text{flex:1;min-width:0;display:flex;align-items:baseline;gap:6px;overflow:hidden}
    strong{flex:none;font-weight:600;white-space:nowrap}
    .meta{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--text);font-variant-numeric:tabular-nums}
    .meta:empty{display:none}
    .refresh{flex:none;display:grid;place-items:center;width:24px;height:24px;padding:0;border:0;border-radius:7px;
      background:transparent;color:var(--text);cursor:pointer;transition:background-color .15s,color .15s}
    .refresh:hover:not(:disabled){background:color-mix(in srgb,currentColor 7%,transparent);color:inherit}
    .refresh:focus-visible{outline:2px solid color-mix(in srgb,currentColor 30%,transparent);outline-offset:1px}
    .refresh:disabled{opacity:.55;cursor:default}
    .refresh svg{display:block;width:13.5px;height:13.5px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
    .refresh[data-busy] svg{animation:spin .75s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
  </style><div class="row"><span class="dot" aria-hidden="true"></span><div class="text" role="status"><strong>读取代理…</strong><span class="meta"></span></div><button type="button" class="refresh" aria-label="刷新代理状态" title="刷新">${REFRESH_ICON}</button></div>`;
  const row = root.querySelector(".row");
  const dot = root.querySelector(".dot");
  const title = root.querySelector("strong");
  const meta = root.querySelector(".meta");
  const button = root.querySelector("button");
  let pending = null;

  function show(tone, heading, text, hint = "") {
    dot.dataset.tone = tone;
    title.textContent = heading;
    meta.textContent = text;
    row.title = hint;
  }

  function render({ supported = true, running, proxyPort, reachable }) {
    if (!supported) {
      show("off", "暂不检测代理", "", "请在系统或 Codex 设置中配置网络代理");
    } else if (proxyPort === null) {
      show("off", "未开启代理", running ? "直连" : "Codex 未运行", running ? "启动时勾选「通过代理启动」即可" : "未找到 Codex 进程");
    } else if (reachable) {
      show("ok", "代理已开启", `127.0.0.1:${proxyPort}`, `已通过代理启动（127.0.0.1:${proxyPort}），对话与界面请求均走此代理`);
    } else {
      show("warn", "代理无响应", `127.0.0.1:${proxyPort}`, "请检查代理软件是否在运行");
    }
  }

  function refresh() {
    if (pending) return pending;
    button.disabled = true;
    button.setAttribute("data-busy", "");
    pending = (async () => {
      try {
        const status = await rpc("status");
        if (!signal.aborted) render(status);
      } catch (error) {
        if (signal.aborted || SILENT_CODES.has(error?.code)) return;
        show("off", "代理状态未知", "读取失败", error?.message || "读取失败，请稍后重试");
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

  effects.listen(button, "click", () => { void refresh(); });
  // hidden=suspend：收起时平台暂停这个轮询，展开时由 visibilityChanged 立即补一次。
  effects.interval(() => { void refresh(); }, REFRESH_MS);
  void refresh();
  return {
    visibilityChanged({ visible }) { if (visible) void refresh(); },
    dispose() { root.replaceChildren(); }
  };
}
