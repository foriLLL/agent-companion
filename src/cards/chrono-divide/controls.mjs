export function gamePoint(clientX, clientY, rect, videoWidth, videoHeight) {
  const scale = Math.min(rect.width / videoWidth, rect.height / videoHeight);
  const width = videoWidth * scale, height = videoHeight * scale;
  return {
    x: Math.min(1, Math.max(0, (clientX - rect.left - (rect.width - width) / 2) / Math.max(1, width - 1))),
    y: Math.min(1, Math.max(0, (clientY - rect.top - (rect.height - height) / 2) / Math.max(1, height - 1)))
  };
}

export function bindGameControls({ surface, video, frame, effects, send }) {
  const keys = new Map();
  const buttons = new Set();
  let point = { x: 0.5, y: 0.5 }, click, queue = [], pending = false;
  const buttonNames = ["left", "middle", "right"];
  const modifiers = e => Number(e.altKey) + 2 * Number(e.ctrlKey) + 4 * Number(e.metaKey) + 8 * Number(e.shiftKey);
  async function flush() {
    if (pending) return;
    pending = true;
    try {
      while (queue.length) await send(queue.splice(0, 128));
    } finally { pending = false; }
  }
  function enqueue(event) {
    if (event.type === "mouseMoved" && queue.at(-1)?.type === "mouseMoved") queue.pop();
    queue.push(event);
    void flush().catch(() => { queue = []; });
  }
  function updatePoint(e) {
    const direct = !frame.hidden && frame.naturalWidth > 0;
    point = gamePoint(e.clientX, e.clientY, surface.getBoundingClientRect(),
      direct ? frame.naturalWidth : video.videoWidth || 1024, direct ? frame.naturalHeight : video.videoHeight || 768);
  }
  function pointer(type, e) {
    if (!video.srcObject || e.isPrimary === false) return;
    e.preventDefault();
    updatePoint(e);
    const button = buttonNames[e.button];
    if (type !== "mouseMoved" && !button) return;
    if (type === "mousePressed") {
      surface.focus({ preventScroll: true });
      surface.setPointerCapture(e.pointerId);
      buttons.add(button);
      const twice = click && click.button === button && e.timeStamp - click.at < 450
        && Math.hypot(e.clientX - click.x, e.clientY - click.y) < 5;
      click = { button, at: e.timeStamp, x: e.clientX, y: e.clientY, count: twice ? 2 : 1 };
    } else if (type === "mouseReleased") buttons.delete(button);
    enqueue({ type, ...point, button: type === "mouseMoved" ? "none" : button,
      buttons: e.buttons, modifiers: modifiers(e), clickCount: type === "mouseMoved" ? 0 : click?.count || 1 });
  }
  effects.listen(surface, "pointerdown", e => pointer("mousePressed", e));
  effects.listen(surface, "pointermove", e => pointer("mouseMoved", e));
  effects.listen(surface, "pointerup", e => pointer("mouseReleased", e));
  effects.listen(surface, "wheel", e => {
    if (!video.srcObject) return;
    e.preventDefault(); updatePoint(e);
    enqueue({ type: "mouseWheel", ...point, button: "none", buttons: e.buttons, modifiers: modifiers(e),
      deltaX: e.deltaX, deltaY: e.deltaY });
  }, { passive: false });
  effects.listen(surface, "contextmenu", e => e.preventDefault());
  function key(type, e) {
    if (!video.srcObject || e.key === "Tab" || e.isComposing) return;
    // 保留系统退出全屏和退出卡片焦点的途径。
    if (e.key === "Escape" && surface.matches(":fullscreen")) return;
    e.preventDefault(); e.stopPropagation();
    const event = { type, key: e.key, code: e.code, keyCode: e.keyCode, repeat: e.repeat, modifiers: modifiers(e) };
    if (type === "keyDown") keys.set(e.code, event); else keys.delete(e.code);
    enqueue(event);
  }
  effects.listen(surface, "keydown", e => key("keyDown", e));
  effects.listen(surface, "keyup", e => key("keyUp", e));
  function leave() {
    if (video.srcObject) enqueue({ type: "mouseMoved", x: 0.5, y: 0.5, button: "none", buttons: 0 });
  }
  function reset() {
    for (const [code, event] of keys) enqueue({ ...event, code, type: "keyUp", modifiers: 0 });
    keys.clear();
    for (const button of buttons) enqueue({ type: "mouseReleased", ...point, button, buttons: 0, clickCount: 1 });
    buttons.clear();
    leave();
  }
  effects.listen(surface, "pointerleave", () => { if (!buttons.size) leave(); });
  effects.listen(surface, "pointercancel", reset);
  effects.listen(surface, "blur", reset);
  effects.listen(surface.ownerDocument.defaultView, "blur", reset);
  return { reset };
}
