import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { CdpConnection } from "../src/cdp-connection.mjs";
import { reserveLoopbackPort } from "../src/launcher.mjs";
import { listCdpTargets } from "../src/targets.mjs";

// 平台提醒层冒烟：独立临时 Chrome profile，卡片 ShadowRoot 里放真实播放的 <video>，验证
// 只在播放时提醒、暂停 / 继续播放、自动收起、合并、全屏时盖在画面上、去处理先退出全屏、卡片卸载撤回。
//   node scripts/smoke-attention.mjs [--screenshot-dir <dir>]
const shotIndex = process.argv.indexOf("--screenshot-dir");
const shotDir = shotIndex > 0 ? process.argv[shotIndex + 1] : null;
const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
// data: URL 无法解析相对导入，先把同目录下的相对导入递归换成 data: URL。
const moduleUrl = async (file) => {
  let source = await readFile(path.join(root, file), "utf8");
  for (const [statement, specifier] of source.matchAll(/from "(\.\/[^"]+)"/g)) {
    source = source.replace(statement, `from "${await moduleUrl(path.join(path.dirname(file), specifier))}"`);
  }
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
};

const port = await reserveLoopbackPort();
const profile = await mkdtemp(path.join(os.tmpdir(), "companion-attention-"));
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--window-size=1280,760",
  "--autoplay-policy=no-user-gesture-required",
  "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"
], { stdio: "ignore" });
let connection;
try {
  const deadline = Date.now() + 15_000;
  while (!connection && Date.now() < deadline) {
    try {
      const target = (await listCdpTargets(port)).find((entry) => entry.type === "page");
      if (target?.webSocketDebuggerUrl) {
        connection = new CdpConnection(target.webSocketDebuggerUrl);
        await connection.connect();
      }
    } catch {}
    if (!connection) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(connection, "独立 Chromium 必须启动");
  // userGesture：全屏需要用户激活，冒烟里模拟成用户操作。
  const evaluate = async (expression) => {
    const result = await connection.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const waitFor = (expression, label, timeoutMs = 4000) => evaluate(`new Promise((resolve, reject) => {
    const deadline = Date.now() + ${timeoutMs};
    const poll = () => { if (${expression}) resolve(true); else if (Date.now() > deadline) reject(new Error(${JSON.stringify(label)})); else setTimeout(poll, 20); };
    poll();
  })`);
  const screenshot = async (name) => {
    if (!shotDir) return;
    const { data } = await connection.send("Page.captureScreenshot", { format: "png" });
    await writeFile(path.join(shotDir, name), Buffer.from(data, "base64"));
  };

  await evaluate(`(async () => {
    const [{ createAttentionLayer }, { createEffects }] = await Promise.all([
      import(${JSON.stringify(await moduleUrl("src/renderer/shell/attention-layer.mjs"))}),
      import(${JSON.stringify(await moduleUrl("src/renderer/platform/effects.mjs"))})
    ]);
    document.body.innerHTML = '<style>html,body{margin:0;height:100%;background:#fff;font:13px -apple-system,sans-serif}'
      + ':root{--color-token-dropdown-background:#fff;--color-token-text-primary:#0d0d0d}'
      + '#drawer{position:fixed;right:14px;top:60px;width:332px;height:320px}#other{position:fixed;left:20px;top:60px;width:200px;height:120px}</style>'
      + '<div id="drawer"></div><div id="other"></div>';
    // 两张卡片：播放卡里有视频；提醒卡没有媒体，靠平台知道别的卡片在播。
    globalThis.playerRoot = document.getElementById('drawer').attachShadow({ mode: 'open' });
    globalThis.otherRoot = document.getElementById('other').attachShadow({ mode: 'open' });
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 180;
    const paint = canvas.getContext('2d');
    globalThis.frame = setInterval(() => { paint.fillStyle = 'hsl(' + (Date.now() / 10 % 360) + ',60%,50%)'; paint.fillRect(0, 0, 320, 180); }, 30);
    globalThis.stage = document.createElement('div');
    stage.style.cssText = 'width:320px;height:180px;background:#000';
    globalThis.video = document.createElement('video');
    video.muted = true;
    video.style.cssText = 'width:100%;height:100%';
    video.srcObject = canvas.captureStream(30);
    stage.append(video);
    playerRoot.append(stage);

    globalThis.errors = [];
    globalThis.layer = createAttentionLayer({ document, onError: (error) => errors.push(error.message), autoDismissMs: 400 });
    globalThis.unobservePlayer = layer.observe(playerRoot);
    layer.observe(otherRoot);
    globalThis.controller = new AbortController();
    const effects = createEffects({ signal: controller.signal, onError: (error) => errors.push(error.message) });
    globalThis.effects = effects;
    globalThis.api = layer.forCard('tasks', effects);
    globalThis.changes = 0;
    api.subscribe(() => { changes += 1; });
    globalThis.actions = [];
    // 无头 Chrome 一律拒绝全屏（not granted）。用顶层 popover 代替全屏元素：同样进浏览器顶层、
    // 后进的盖住先进的，再配合 document.fullscreenElement 与 fullscreenchange，覆盖面板依赖的全部行为。
    let fullscreen = null;
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreen });
    globalThis.enterFullscreen = () => {
      stage.popover = 'manual';
      stage.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;margin:0;border:0;padding:0;background:#000';
      stage.showPopover();
      fullscreen = stage;
    };
    globalThis.announceFullscreen = () => document.dispatchEvent(new Event('fullscreenchange'));
    document.exitFullscreen = async () => {
      stage.hidePopover();
      stage.removeAttribute('popover');
      stage.style.cssText = 'width:320px;height:180px;background:#000';
      fullscreen = null;
      announceFullscreen();
    };
    globalThis.alert = (key, extra = {}) => api.notify({ key, tone: 'attention', title: '任务 ' + key, text: '在等你回答', detail: '要先合并 #482 还是先发预览？',
      color: '#e5484d', action: { label: '去处理', run: () => actions.push({ key, fullscreen: Boolean(document.fullscreenElement) }) }, ...extra });
  })()`);

  const host = `document.getElementById('codex-companion-attention')`;
  const panel = `${host}?.shadowRoot.querySelector('.panel')`;
  const open = `Boolean(${panel}?.matches(':popover-open'))`;
  const button = (name) => `${host}.shadowRoot.querySelector(${JSON.stringify(name)})`;
  // 面板中心的命中元素：被别的顶层元素（全屏视频）盖住时就不是提醒层。
  const onTop = () => evaluate(`(() => { const rect = ${panel}.getBoundingClientRect(); return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.id ?? null; })()`);

  // 没在播放：默认不提醒，也不创建节点。
  assert.equal(await evaluate(`api.isPlaying()`), false);
  assert.equal(await evaluate(`alert('a')`), false, "没在播放时不提醒");
  assert.equal(await evaluate(`${host}`), null, "没提醒过不创建节点");
  assert.equal(await evaluate(`api.notify({ key: 'forced', title: '强制', whilePlaying: false })`), true, "whilePlaying:false 不看播放状态");
  await waitFor(open, "强制提醒打开面板");
  await waitFor(`!${open} && api.pending() === 0`, "非常驻提醒自动收起");

  // 别的卡片开始播放：提醒卡能知道，并收到变化通知。
  const before = await evaluate(`changes`);
  await evaluate(`video.play()`);
  await waitFor(`api.isPlaying()`, "跨卡片识别播放");
  assert.ok(await evaluate(`changes`) > before, "播放状态变化通知订阅者");

  // 只提醒：不暂停，自动收起。
  assert.equal(await evaluate(`alert('done', { tone: 'done', sticky: false })`), true);
  await waitFor(open, "提醒打开面板");
  assert.equal(await evaluate(`video.paused`), false, "只提醒不暂停");
  assert.equal(await evaluate(`${button(".resume")}.hidden`), true, "没暂停时不显示继续播放");
  assert.equal(await evaluate(`${button(".close")}.textContent`), "知道了");
  assert.equal(await onTop(), "codex-companion-attention", "面板在最上层可点");
  // 不全屏：贴在正在看的视频左侧，不挡画面。
  // offset* 不受打开动画的位移影响。
  const box = `(() => { const node = ${panel}; return { left: node.offsetLeft, top: node.offsetTop, right: innerWidth - node.offsetLeft - node.offsetWidth }; })()`;
  const beside = await evaluate(`(() => { const a = ${box}, b = video.getBoundingClientRect(); return { gap: Math.round(b.left) - (innerWidth - a.right), top: a.top - Math.round(b.top) }; })()`);
  assert.deepEqual(beside, { gap: 12, top: 0 }, "面板贴在视频左侧、顶端对齐");
  assert.equal(await evaluate(`getComputedStyle(${host}).pointerEvents`), "none", "宿主铺满整窗但不接收指针事件");
  assert.equal(await evaluate(`getComputedStyle(${host}).getPropertyValue('-webkit-app-region') || 'none'`), "none", "宿主不声明拖拽区域");
  await waitFor(`!${open}`, "只提醒自动收起");

  // 暂停：暂停正在播放的视频，常驻直到处理；继续播放只恢复被平台暂停的。
  assert.equal(await evaluate(`alert('ask', { pause: true })`), true);
  await waitFor(`${open} && video.paused`, "暂停播放并提醒");
  assert.deepEqual(await evaluate(`[${button(".resume")}.hidden, ${button(".state")}.textContent, ${button(".close")}.textContent]`), [false, "已暂停播放", "关闭"]);
  assert.deepEqual(await evaluate(`layer.diagnostics()`), { items: 1, open: true, playing: false, paused: 1 });
  await screenshot("attention-paused.png");
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(await evaluate(open), true, "暂停的提醒不自动收起");
  await evaluate(`${button(".resume")}.click()`);
  await waitFor(`!${open} && !video.paused && api.pending() === 0`, "继续播放并收起");

  // 用户自己先点了播放：继续播放按钮随之消失，提醒保留。
  await evaluate(`alert('ask', { pause: true })`);
  await waitFor(`video.paused && !${button(".resume")}.hidden`, "再次暂停");
  await evaluate(`video.play()`);
  await waitFor(`!video.paused && ${button(".resume")}.hidden && ${open}`, "用户恢复播放后不再显示继续播放");
  await evaluate(`${button(".close")}.click()`);
  await waitFor(`!${open} && api.pending() === 0 && !video.paused`, "知道了只收起，不动播放");

  // 合并：同一 key 替换，最多显示 3 条，其余计数；关闭清空。
  for (const key of ["m1", "m2", "m3", "m4", "m2"]) await evaluate(`alert(${JSON.stringify(key)})`);
  await waitFor(`${open} && api.pending() === 4`, "同 key 去重后 4 条");
  assert.deepEqual(await evaluate(`[...${host}.shadowRoot.querySelectorAll('li')].map((item) => item.dataset.key.split('\\u0000')[1])`), ["m2", "m4", "m3"], "最新在上，最多 3 条");
  assert.equal(await evaluate(`${button(".more")}.textContent`), "还有 1 条提醒");
  await evaluate(`api.dismiss('m4')`);
  await waitFor(`api.pending() === 3 && ${button(".more")}.hidden`, "卡片撤回单条");
  await evaluate(`${button(".close")}.click()`);
  await waitFor(`!${open} && api.pending() === 0`, "关闭清空");

  // 全屏：先提醒再进全屏，面板重新排到全屏视频之上；全屏后再提醒同样在上面。
  await evaluate(`alert('fs1')`);
  await waitFor(open, "全屏前的提醒");
  await evaluate(`enterFullscreen()`);
  assert.notEqual(await onTop(), "codex-companion-attention", "夹具：全屏元素后进顶层，先盖住面板");
  await evaluate(`announceFullscreen()`);
  await waitFor(`document.fullscreenElement === stage && ${panel}.dataset.fullscreen === 'true'`, "进入全屏");
  assert.equal(await onTop(), "codex-companion-attention", "进入全屏后面板重新排到画面之上");
  assert.deepEqual(await evaluate(`(() => { const a = ${box}; return [a.top, a.right]; })()`), [16, 16], "全屏时在右上角");
  await evaluate(`${button(".close")}.click()`);
  await waitFor(`!${open}`, "收起");
  await evaluate(`alert('fs2', { pause: true })`);
  await waitFor(`${open} && video.paused`, "全屏中暂停并提醒");
  assert.equal(await onTop(), "codex-companion-attention", "全屏中的新提醒在画面之上");
  await screenshot("attention-fullscreen.png");
  // 去处理：先退出全屏再跳转，不替用户恢复播放。
  await evaluate(`${host}.shadowRoot.querySelector('li button.go').click()`);
  await waitFor(`actions.length === 1 && !document.fullscreenElement && !${open}`, "去处理退出全屏并执行动作");
  assert.deepEqual(await evaluate(`actions[0]`), { key: "fs2", fullscreen: false }, "动作在退出全屏之后执行");
  assert.equal(await evaluate(`video.paused`), true, "去处理不自动恢复播放");

  // 卡片卸载：撤回它的提醒并退订；停止观察后不再算作播放中。
  await evaluate(`video.play()`);
  await waitFor(`api.isPlaying()`, "恢复播放");
  await evaluate(`alert('gone', { pause: true })`);
  await waitFor(`${open} && api.pending() === 1`, "卸载前的提醒");
  const settled = await evaluate(`changes`);
  await evaluate(`controller.abort(); effects.dispose?.()`);
  await waitFor(`!${open} && layer.diagnostics().items === 0`, "卡片卸载撤回提醒");
  await evaluate(`video.play()`);
  assert.equal(await evaluate(`changes`), settled + 1, "卸载时撤回算一次变化，之后不再通知");
  await evaluate(`unobservePlayer()`);
  assert.equal(await evaluate(`layer.diagnostics().playing`), false, "停止观察后不算播放中");
  await evaluate(`layer.dispose(); clearInterval(frame)`);
  assert.equal(await evaluate(`${host}`), null, "释放后移除节点");
  assert.deepEqual(await evaluate(`errors`), []);
  console.log("Attention smoke passed:", JSON.stringify({ actions: await evaluate(`actions.length`) }));
} finally {
  connection?.close();
  chrome.kill("SIGTERM");
  await new Promise((resolve) => { chrome.once("exit", resolve); setTimeout(resolve, 2000).unref(); });
  await rm(profile, { recursive: true, force: true });
}
