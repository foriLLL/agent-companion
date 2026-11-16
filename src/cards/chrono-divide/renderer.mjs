import { gatherIce } from "./stream.mjs";
import { bindGameControls } from "./controls.mjs";

export function mount({ root, signal, effects, rpc, isVisible }) {
  root.innerHTML = `<style>
    :host{display:block;font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    *{box-sizing:border-box} .panel{color:inherit;padding:13px;background:var(--cc-card-bg,Canvas)}
    .panel:popover-open{position:fixed;inset:0;margin:auto;width:min(1100px,94vw);height:fit-content;
      max-height:96vh;overflow:auto;border:none;border-radius:14px;color:CanvasText;box-shadow:0 12px 60px #0005}
    header{display:flex;align-items:center;gap:8px;margin-bottom:9px} h2{font-size:15px;margin:0}
    .mark{width:9px;height:9px;background:#cb4939;transform:rotate(45deg)}
    small{margin-left:auto;opacity:.65;font-size:10px;letter-spacing:.08em}
    .surface{position:relative;display:grid;place-items:center;aspect-ratio:4/3;width:100%;overflow:hidden;
      background:#121b22;border-radius:7px;outline-offset:-2px;touch-action:none;user-select:none}
    .panel:popover-open .surface{aspect-ratio:16/10;max-height:calc(90vh - 110px)}
    .surface:fullscreen{width:100vw;height:100vh;max-height:none;aspect-ratio:auto;border-radius:0}
    video{display:block;width:100%;height:100%;object-fit:contain;pointer-events:none}
    .frame{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none}
    .surface:not([data-playing])::after{content:"CHRONO DIVIDE";position:absolute;color:#e0e6dd99;
      letter-spacing:.15em;font-size:13px;font-weight:650;pointer-events:none}
    .controls{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-top:10px}
    button{cursor:pointer;color:inherit;font:inherit;font-size:12px;border:0;border-radius:7px;padding:5px 9px;
      background:color-mix(in srgb,currentColor 8%,transparent)} button:focus-visible,.surface:focus-visible{outline:2px solid Highlight}
    .start{background:#a4382d;color:white} button:disabled{opacity:.5}
    p{margin:8px 0 0;font-size:12px;color:color-mix(in srgb,currentColor 70%,transparent)}
  </style><section class="panel"><header><span class="mark"></span><h2>红色警戒 2</h2><small>CHRONO DIVIDE</small></header>
    <div class="surface" tabindex="0" role="application" aria-label="红警战场"><video autoplay muted playsinline></video><audio autoplay></audio><img class="frame" hidden crossorigin="anonymous" alt=""></div>
    <div class="controls"><button class="start" type="button">开始游戏</button><button class="expand" type="button">放大</button>
      <button class="full" type="button" disabled>全屏</button><button class="audio" type="button" aria-label="游戏声音" aria-pressed="true">声音开</button></div>
    <p role="status">游戏在卡片内运行。将鼠标贴近画面边缘卷动地图。</p></section>`;
  const panel = root.querySelector(".panel"), surface = root.querySelector(".surface"), video = root.querySelector("video");
  const frame = root.querySelector(".frame"), sound = root.querySelector("audio");
  const start = root.querySelector(".start"), expand = root.querySelector(".expand"), full = root.querySelector(".full");
  const audio = root.querySelector(".audio"), status = root.querySelector("[role=status]");
  let player = null, muted = false, expanded = false, ending = false;

  function dimensions() {
    const { width, height } = surface.getBoundingClientRect();
    // 小卡按比例缩小整块战场。放大/全屏时提升游戏的实际渲染分辨率。
    const scale = Math.min(Math.max(1, 1024 / (width || 1), 768 / (height || 1)), 2560 / (width || 1), 1600 / (height || 1));
    const dpr = root.ownerDocument.defaultView.devicePixelRatio || 1;
    return width && height ? { width: Math.round(width * scale), height: Math.round(height * scale),
      displayWidth: Math.ceil(width * dpr), displayHeight: Math.ceil(height * dpr) } : { width: 1024, height: 768 };
  }
  function updateMute() { sound.muted = muted || !isVisible(); }
  const controls = bindGameControls({ surface, video, frame, effects,
    send: events => player?.connected && !signal.aborted ? rpc("input", { events }) : Promise.resolve() });

  function disconnect() {
    if (!player) return;
    controls.reset();
    const old = player;
    player = null;
    old.abort.abort();
    frame.hidden = true;
    frame.removeAttribute("src");
    old.peer.close();
    video.srcObject = sound.srcObject = null;
    delete surface.dataset.playing;
    full.disabled = true;
  }
  async function stop(message = "游戏已结束。") {
    if (ending || !player) return;
    ending = true;
    disconnect();
    start.disabled = true;
    try { await rpc("stop", {}); }
    finally {
      ending = false;
      if (!signal.aborted) { start.disabled = false; start.textContent = "开始游戏"; status.textContent = message; }
    }
  }
  async function resize() {
    const state = player;
    if (!state?.connected || state.resizing) return;
    state.resizing = true;
    try {
      while (state === player) {
        const size = dimensions(), key = JSON.stringify(size);
        if (state.sizeKey === key) break;
        await rpc("resize", size);
        state.sizeKey = key;
      }
    } catch (error) {
      if (state === player && !signal.aborted) status.textContent = error.message;
    } finally { state.resizing = false; }
  }
  async function play() {
    if (typeof RTCPeerConnection !== "function") {
      status.textContent = "当前宿主不支持卡内游戏所需的 WebRTC。";
      return;
    }
    const peer = new RTCPeerConnection({ iceServers: [] });
    const state = { peer, abort: new AbortController(), connected: false };
    player = state;
    status.textContent = "正在连接游戏…";
    start.textContent = "取消";
    try {
      peer.ontrack = ({ track }) => {
        if (player !== state) return;
        // 音频有独立的播放时钟，即使直送画面停用 WebRTC 视频发送端仍然可以播放。
        const output = track.kind === "audio" ? sound : video;
        output.srcObject = new MediaStream([track]);
      };
      peer.onconnectionstatechange = () => {
        if (player !== state) return;
        if (peer.connectionState === "connected") {
          state.connected = true;
          surface.dataset.playing = "";
          start.textContent = "结束游戏";
          full.disabled = false;
          status.textContent = "首次进入可在游戏里点 Download 准备资源。";
          updateMute();
          void video.play().catch(() => {});
          void sound.play().catch(() => {
            if (player !== state) return;
            muted = true; updateMute(); audio.textContent = "声音关"; audio.setAttribute("aria-pressed", "false");
            void sound.play().catch(() => {});
          });
          void resize();
        } else if (peer.connectionState === "failed") void stop("画面已断开，请重新开始。");
      };
      for (const kind of ["audio", "video"]) peer.addTransceiver(kind, { direction: "recvonly" });
      await peer.setLocalDescription(await peer.createOffer());
      await gatherIce(peer);
      if (player !== state) return;
      const { answer, framesUrl } = await rpc("open", { offer: peer.localDescription.toJSON(), ...dimensions() }, { signal: state.abort.signal });
      if (player !== state) return;
      await peer.setRemoteDescription(answer);
      if (player !== state) return;
      if (framesUrl) {
        frame.src = framesUrl;
        effects.timeout(() => { if (player === state && !frame.naturalWidth) frame.removeAttribute("src"); }, 4000);
      }
      effects.timeout(() => { if (player === state && !state.connected) void stop("无法连接游戏画面，请重试。"); }, 15_000);
    } catch (error) {
      if (player === state && !signal.aborted) await stop(error.message);
    }
  }
  function shrink() {
    if (!expanded) return;
    expanded = false;
    panel.hidePopover();
    panel.removeAttribute("popover");
    expand.textContent = "放大";
  }
  effects.listen(frame, "load", () => { if (player && frame.hasAttribute("src") && frame.naturalWidth) frame.hidden = false; });
  effects.listen(frame, "error", () => { frame.hidden = true; frame.removeAttribute("src"); });
  effects.listen(start, "click", () => player ? stop() : play());
  effects.listen(expand, "click", () => {
    if (expanded) shrink();
    else { panel.setAttribute("popover", "manual"); panel.showPopover(); expanded = true; expand.textContent = "缩回卡片"; }
  });
  effects.listen(full, "click", async () => {
    try { await surface.requestFullscreen(); surface.focus({ preventScroll: true }); }
    catch { status.textContent = "当前环境暂不支持全屏，可使用「放大」。"; }
  });
  effects.listen(audio, "click", () => {
    muted = !muted; updateMute(); audio.textContent = muted ? "声音关" : "声音开"; audio.setAttribute("aria-pressed", String(!muted));
    if (!muted && sound.srcObject) void sound.play().catch(() => {});
  });
  const observer = new ResizeObserver(() => { void resize(); });
  effects.observe(observer); observer.observe(surface);
  return {
    visibilityChanged({ visible }) { updateMute(); if (!visible) { controls.reset(); shrink(); } else void resize(); },
    dispose() { shrink(); disconnect(); root.replaceChildren(); }
  };
}
