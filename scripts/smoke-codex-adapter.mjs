import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import http from "node:http";
import { CdpConnection } from "../src/cdp-connection.mjs";
import { reserveLoopbackPort } from "../src/launcher.mjs";
import { listCdpTargets } from "../src/targets.mjs";
import { createCodexAdapter } from "../src/renderer/adapters/codex.mjs";

// 原生 Summary 布局函数的同构替身：函数体照抄原生，导出名故意打乱，验证适配器按行为而非导出名识别。
const nativeLayoutFunctions = `function a(e,t=300){let n=(e-736)/2,r=t-300;return n<180+r/2?"overlay":n<400+r?"shift":"gutter"}
function b({displayMode:e,isPinned:t,isPopoverOpen:n}){let r=t&&e!=="overlay",i=null;return r?i="inline":e==="overlay"&&n&&(i="popover"),{displayMode:e,shouldHideInlineImmediately:e==="overlay"&&n,shouldShow:r,visibleSurface:i}}
function c({displayMode:e,isPinned:t,panelWidth:n=300}){return t&&e==="shift"?-(308+n-300)/2:0}
function d(){}`;
// Vite 打包（26.1027 之前）：独立的 thread-summary-panel-layout-*.js。
const nativeLayoutSource = `${nativeLayoutFunctions}
export { d as q, c as w, a as k, b as z };`;
// Rspack ESM（26.1103 起）：入口脚本导出 __webpack_require__，布局模块是 .m 里的一个工厂。
// decoy 的源码同样像布局模块但尚未实例化，执行它就记一笔，验证适配器不主动执行原生工厂。
const runtimeEntrySource = `const factories = {
  big(e, t) { t.Ab = () => "overlay"; t.Cd = () => "shift"; },
  w2yL(e, t) { ${nativeLayoutFunctions}
    Object.assign(t, { D6: b, Sj: c, UQ: a, Zz: d }); },
  decoy(e, t) { globalThis.decoyExecuted = true; ${nativeLayoutFunctions}
    Object.assign(t, { D6: b, Sj: c, UQ: a }); }
};
const cache = {};
function __webpack_require__(id) {
  if (cache[id]) return cache[id].exports;
  const module = cache[id] = { exports: {} };
  factories[id](module, module.exports, __webpack_require__);
  return module.exports;
}
__webpack_require__.m = factories;
__webpack_require__.c = cache;
__webpack_require__("big");
__webpack_require__("w2yL");
export { __webpack_require__ };`;
const layoutServer = http.createServer((request, response) => {
  const body = request.url?.startsWith("/assets/thread-summary-panel-layout-") ? nativeLayoutSource
    : request.url?.startsWith("/assets/348410.") ? runtimeEntrySource : null;
  if (body === null) { response.writeHead(404).end(); return; }
  response.writeHead(200, { "content-type": "text/javascript", "access-control-allow-origin": "*" }).end(body);
});
await new Promise((resolve) => layoutServer.listen(0, "127.0.0.1", resolve));
const layoutUrl = `http://127.0.0.1:${layoutServer.address().port}/assets/thread-summary-panel-layout-0a1b2c3d.js`;
const runtimeEntryUrl = `http://127.0.0.1:${layoutServer.address().port}/assets/348410.0a1b2c3d4e.js`;

// 只启动独立临时 Chrome profile；不访问用户 Codex 的 CDP 端口或配置。
const port = await reserveLoopbackPort();
const profile = await mkdtemp(path.join(os.tmpdir(), "companion-native-adapter-"));
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--autoplay-policy=no-user-gesture-required", "--window-size=1280,900",
  "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, "about:blank"
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
  const evaluate = async (expression) => {
    const result = await connection.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const waitFor = (expression, label) => evaluate(`new Promise((resolve,reject) => {
    const deadline = Date.now() + 4000;
    const poll = () => { if (${expression}) resolve(true); else if(Date.now()>deadline) reject(new Error(${JSON.stringify(label)})); else setTimeout(poll,20); }; poll();
  })`);
  await evaluate(`globalThis.createCodexAdapter = ${createCodexAdapter.toString()}`);
  await evaluate(`(() => {
    document.body.innerHTML = \`
      <style>html,body{margin:0;height:100%;overflow:hidden}header.toolbar{display:flex;justify-content:flex-end;height:40px}header.toolbar>div{display:flex;gap:8px}button{width:28px;height:28px}.thread-scroll-container{position:absolute;inset:48px 0 0;width:100%;height:700px}</style>
      <header class="toolbar"><div><button aria-label="Share">S</button><button id="toggle" aria-label="Toggle pinned summary" aria-pressed="false">T</button></div></header>
      <div class="thread-scroll-container"><div id="frame" style="transform:translateX(-80px)"><div data-thread-user-message-navigation-content>Conversation</div></div><div data-thread-scroll-footer style="transform:translateX(-80px)">Input</div></div>
      <div id="floating-root" class="thread-floating-content-top-inset right-0" style="position:absolute;top:48px;right:0;height:650px;width:316px">
        <div id="summary-animation" class="origin-top-right" style="height:100%;width:316px;opacity:0;transform:none">
          <div id="native-panel" style="height:240px;width:300px;background:white;border-radius:24px"><header>Summary</header><section>Sources</section></div>
        </div>
      </div>\`;
    globalThis.toggle = document.getElementById('toggle');
    toggle.onclick = () => {
      const open = toggle.getAttribute('aria-pressed') !== 'true';
      toggle.setAttribute('aria-pressed', String(open));
      document.getElementById('summary-animation').style.opacity = open ? '1' : '0';
    };
    globalThis.host = document.createElement('div');
    host.id = 'codex-companion-root';
    host.style.cssText = 'display:block;width:300px;height:1100px';
    host.attachShadow({mode:'open'});
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
    const ctx = canvas.getContext('2d');
    globalThis.frameTimer = setInterval(() => { ctx.fillStyle = 'rgb('+(Date.now()%255)+',20,40)';ctx.fillRect(0,0,32,32); }, 30);
    globalThis.video = document.createElement('video'); video.muted = true; video.autoplay = true;
    video.srcObject = canvas.captureStream(30); host.shadowRoot.append(video);
    globalThis.events = []; globalThis.errors = [];
    globalThis.nativeBefore = ['floating-root','summary-animation','native-panel','frame'].map(id => document.getElementById(id).style.cssText);
    globalThis.adapter = createCodexAdapter({host,hasCards:false,onVisibilityChange:event=>events.push(event),onError:error=>errors.push(error.message)});
  })()`);
  assert.equal(await evaluate(`host.isConnected || !!document.getElementById('codex-companion-root-shell')`), false, "初始空集合不能挂载占位");
  await evaluate(`adapter.setHasCards(true)`);
  assert.equal(await evaluate(`adapter.isOpen()`), false);
  assert.equal(await evaluate(`!!document.getElementById('codex-companion-root-toolbar')`), true, "优先顶栏入口");
  assert.equal(await evaluate(`host.isConnected`), true, "初始隐藏也连接 host");
  await evaluate(`adapter.setOpen(true)`);
  await waitFor(`adapter.isOpen()`, "独立面板未打开");
  // 铺满整窗的 shell 不能是 no-drag，否则 Electron 把整窗从标题栏可拖动区域里扣掉、窗口拖不动；
  // 只有可点的入口和抽屉声明 no-drag。
  assert.deepEqual(await evaluate(`(() => {
    const shell=document.getElementById('codex-companion-root-shell'), region=(el)=>getComputedStyle(el).getPropertyValue('-webkit-app-region');
    return {shell:region(shell), drawer:region(shell.shadowRoot.querySelector('.drawer')), entry:region(document.getElementById('codex-companion-root-toolbar'))};
  })()`), { shell: "none", drawer: "no-drag", entry: "no-drag" }, "整窗 shell 不得阻止拖动窗口");
  await waitFor(`video.currentTime > .1`, "测试媒体未播放");
  assert.equal(await evaluate(`getComputedStyle(document.getElementById('frame')).transform`), "matrix(1, 0, 0, 1, -80, 0)", "不改写原生自己的平移");
  // 没有原生平移钩子（也没有输入框）：按内置公式判档，改为限制会话面板宽度来让位，抽屉不压会话。
  const drawerLeft = `document.getElementById('codex-companion-root-shell').shadowRoot.querySelector('.drawer').getBoundingClientRect().left`;
  await waitFor(`adapter.getDiagnostics().room === 'clamp' && document.querySelector('.thread-scroll-container').getBoundingClientRect().right <= innerWidth - 324 + 1`, "没有平移钩子时应收窄会话面板让位");
  assert.deepEqual(await evaluate(`(() => { const {drawerSurface, thread, entry} = adapter.getDiagnostics(); return {drawerSurface, thread, entry}; })()`),
    { drawerSurface: "inline", thread: "hooks", entry: "summary" });
  const beforeHide = await evaluate(`video.currentTime`);
  await evaluate(`adapter.setOpen(false)`);
  await waitFor(`!adapter.isOpen() && document.getElementById('codex-companion-root-shell').shadowRoot.querySelector('.drawer').hidden`, "关闭动画未结束");
  await waitFor(`video.currentTime > ${beforeHide} + .2`, "收起必须继续播放");
  assert.equal(await evaluate(`host.isConnected && video === host.shadowRoot.querySelector('video') && !video.paused`), true);
  await waitFor(`document.querySelector('[data-companion-dock]') === null`, "关闭后撤销让位标记");
  assert.equal(await evaluate(`document.querySelector('.thread-scroll-container').getBoundingClientRect().width === innerWidth && adapter.getDiagnostics().room`), null, "关闭后会话面板恢复原宽");
  await evaluate(`adapter.setOpen(true);adapter.setOpen(false);adapter.setOpen(true)`);
  await waitFor(`adapter.isOpen() && document.getElementById('codex-companion-root-shell').shadowRoot.querySelector('.drawer').dataset.state === 'open'`, "快速反向动画");
  await evaluate(`toggle.click()`);
  await waitFor(`!adapter.isOpen()`, "Summary 打开必须关闭独立卡片");
  assert.equal(await evaluate(`toggle.getAttribute('aria-pressed')`), "true");
  await evaluate(`adapter.setOpen(true)`);
  await waitFor(`adapter.isOpen() && toggle.getAttribute('aria-pressed') === 'false'`, "卡片打开必须关闭原生 Summary");
  // 原生状态异步提交时先等待关闭，不重复点击或短暂展示两侧栏。
  await evaluate(`toggle.click();globalThis.nativeClick=toggle.onclick;toggle.onclick=()=>setTimeout(nativeClick,80);adapter.setOpen(true)`);
  assert.equal(await evaluate(`adapter.isOpen()`), false);
  await waitFor(`adapter.isOpen() && toggle.getAttribute('aria-pressed') === 'false'`, "等待原生异步关闭");
  await evaluate(`toggle.onclick=nativeClick;document.getElementById('codex-companion-root-toolbar').shadowRoot.querySelector('button').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,composed:true,cancelable:true}))`);
  await waitFor(`!adapter.isOpen()`, "入口 Escape 应关闭");
  await evaluate(`adapter.setPlacement('inline-in-summary');adapter.setOpen(true)`);
  await waitFor(`adapter.getDiagnostics().mode === 'animated-summary'`, "inline 未挂载");
  assert.equal(await evaluate(`host.style.getPropertyValue('--cc-card-bg') === host.style.getPropertyValue('--hg-panel-bg') && host.style.getPropertyValue('--cc-card-fg') === host.style.getPropertyValue('--hg-panel-color') && !!host.style.getPropertyValue('--cc-card-border')`), true);
  assert.equal(await evaluate(`Math.round(host.getBoundingClientRect().top-document.getElementById('native-panel').getBoundingClientRect().bottom)`), 24);
  assert.equal(await evaluate(`Math.round(host.getBoundingClientRect().left-document.getElementById('native-panel').getBoundingClientRect().left)`), 0);
  assert.equal(await evaluate(`(() => {const panel=document.getElementById('native-panel'),root=document.getElementById('floating-root'),before=panel.getBoundingClientRect().top;root.scrollTop=100;const delta=Math.round(before-panel.getBoundingClientRect().top);root.scrollTop=0;return delta;})()`), 100, "原生 Summary 和卡片共享滚动");
  const beforeInlineHide = await evaluate(`video.currentTime`);
  await evaluate(`adapter.setOpen(false)`);
  await waitFor(`!adapter.isOpen()`, "inline Summary 开关未同步");
  assert.equal(await evaluate(`host.isConnected && host.parentElement.hidden`), true, "inline 关闭保留原 rail/host");
  await waitFor(`video.currentTime > ${beforeInlineHide} + .2`, "inline 收起媒体必须继续");
  // 「摘要下方」模式：摘要关着时顶栏入口仍在；点它用原生开关打开摘要，卡片回到摘要下方，入口不跟着消失。
  const inlineEntry = `(() => { const entry = document.getElementById('codex-companion-root-toolbar'); const box = entry?.getBoundingClientRect(); return { shown: Boolean(entry?.isConnected && box.width > 0 && box.height > 0), expanded: entry?.shadowRoot.querySelector('button').getAttribute('aria-expanded') ?? null }; })()`;
  assert.deepEqual(await evaluate(inlineEntry), { shown: true, expanded: "false" }, "摘要关着时顶栏入口必须保留");
  assert.equal(await evaluate(`adapter.getDiagnostics().entry`), "summary");
  await evaluate(`document.getElementById('codex-companion-root-toolbar').shadowRoot.querySelector('button').click()`);
  await waitFor(`adapter.isOpen() && toggle.getAttribute('aria-pressed') === 'true' && adapter.getDiagnostics().mode === 'animated-summary'`, "点入口应打开原生摘要并显示卡片");
  assert.deepEqual(await evaluate(inlineEntry), { shown: true, expanded: "true" }, "摘要打开后入口仍在");
  // 摘要已经开着时再点入口不关摘要。
  await evaluate(`document.getElementById('codex-companion-root-toolbar').shadowRoot.querySelector('button').click()`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(await evaluate(`adapter.isOpen() && toggle.getAttribute('aria-pressed') === 'true'`), true, "开着时点入口不关闭摘要");
  await evaluate(`adapter.setOpen(false)`);
  await waitFor(`!adapter.isOpen()`, "inline 再次收起");
  await evaluate(`adapter.setOpen(true)`);
  await waitFor(`adapter.isOpen()`, "inline 重新打开");
  assert.equal(await evaluate(`video === host.shadowRoot.querySelector('video') && !video.paused`), true);
  // 保留原生退场动画直到 opacity 归零；scale 期间仍保持 24px 未变换布局间距。
  await evaluate(`toggle.setAttribute('aria-pressed','false');document.getElementById('summary-animation').style.opacity='.04';document.getElementById('summary-animation').style.transform='translateX(50px) scale(.8)'`);
  assert.equal(await evaluate(`adapter.isOpen()`), true);
  assert.equal(await evaluate(`document.getElementById('codex-companion-rail').style.top`), "252px");
  await evaluate(`document.getElementById('summary-animation').style.opacity='0'`);
  await waitFor(`!adapter.isOpen()`, "原生退场未完成");
  // 原生 popover 的 flex 压缩、共享滚动和状态还原。
  await evaluate(`(() => {
    toggle.setAttribute('aria-label','Toggle summary');toggle.setAttribute('aria-controls','popover');toggle.dataset.state='open';
    const popover=document.createElement('div');popover.id='popover';popover.setAttribute('role','dialog');popover.dataset.state='open';
    popover.style.cssText='position:absolute;top:48px;right:0';
    popover.innerHTML='<div id="stack" style="display:flex;max-height:650px;flex-direction:column;width:300px"><div id="popover-panel" style="height:300px;width:300px;flex:none;background:white;border-radius:24px">Summary</div></div>';
    document.body.append(popover);
  })()`);
  await waitFor(`adapter.getDiagnostics().mode === 'summary-popover'`, "popover 未识别");
  assert.equal(await evaluate(`Math.round(host.getBoundingClientRect().top-document.getElementById('popover-panel').getBoundingClientRect().bottom)`), 24);
  assert.equal(await evaluate(`getComputedStyle(document.getElementById('stack')).overflowY`), "auto");
  await evaluate(`globalThis.oldPanel=document.getElementById('popover-panel');document.getElementById('popover').remove();toggle.removeAttribute('aria-controls');toggle.removeAttribute('data-state')`);
  await waitFor(`!adapter.isOpen() && host.isConnected`, "原生删除父节点后必须停放 host");
  assert.equal(await evaluate(`oldPanel.style.height`), "300px");
  assert.equal(await evaluate(`oldPanel.style.getPropertyPriority('height')`), "");
  // 入口锚点缺失时仍有独立按钮。
  await evaluate(`document.querySelector('header.toolbar').style.display='none';adapter.setPlacement('standalone-button');adapter.setOpen(true)`);
  await waitFor(`adapter.isOpen()`, "悬浮入口打开");
  assert.equal(await evaluate(`document.getElementById('codex-companion-root-shell').shadowRoot.querySelector('button').hidden`), false);
  await connection.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await evaluate(`adapter.setOpen(false)`);
  await waitFor(`document.getElementById('codex-companion-root-shell').shadowRoot.querySelector('.drawer').hidden`, "减少动态效果关闭");
  assert.equal(await evaluate(`document.getElementById('codex-companion-root-shell').shadowRoot.querySelector('.drawer').getAnimations().length`), 0);
  await evaluate(`adapter.setHasCards(false)`);
  assert.equal(await evaluate(`host.isConnected || !!document.getElementById('codex-companion-root-shell') || !!document.querySelector('[data-companion-dock]')`), false, "空集合无入口或占位");
  await evaluate(`adapter.setHasCards(true);adapter.setOpen(true)`);
  await waitFor(`adapter.isOpen()`, "重新启用");
  assert.equal(await evaluate(`video === host.shadowRoot.querySelector('video')`), true);
  await evaluate(`adapter.dispose();adapter.dispose()`);
  assert.equal(await evaluate(`host.isConnected || !!document.getElementById('codex-companion-root-shell') || !!document.getElementById('codex-companion-root-toolbar') || !!document.querySelector('[data-companion-dock]')`), false);
  assert.equal(await evaluate(`adapter.getDiagnostics().disposed`), true);
  assert.equal(await evaluate(`document.getElementById('floating-root').style.cssText === nativeBefore[0]`), true, "原生滚动样式还原");
  assert.equal(await evaluate(`document.getElementById('native-panel').style.cssText === nativeBefore[2]`), true);
  assert.equal(await evaluate(`document.getElementById('frame').style.cssText === nativeBefore[3]`), true);
  assert.deepEqual(await evaluate(`errors`), []);
  const evidence = await evaluate(`({events:events.length,moveFallbacks:adapter.getDiagnostics().moveFallbacks,final:events.at(-1),moveBefore:typeof Element.prototype.moveBefore})`);
  // 新版嵌套 Summary，样式和 marker 均须在 dispose 后原样恢复。
  await evaluate(`(() => {
    document.body.innerHTML='<button id="modern-toggle" aria-label="Toggle pinned summary" aria-pressed="true"></button><div id="modern-root" class="thread-floating-content-top-inset right-0" style="position:absolute;top:48px;bottom:16px;right:0;width:316px"><div style="position:relative;max-height:100%;width:316px"><div id="modern-scroll" data-codex-companion-scroll-root="original-scroll" style="position:absolute;top:0;bottom:0;left:0;width:300px"><div id="modern-column" class="origin-top-right" data-codex-companion-animation-column="original-column" style="opacity:1;width:300px;position:static!important"><div style="display:flex;flex-direction:column"><div id="modern-native" style="height:430px;width:300px;border-radius:24px;background:white">Summary</div></div></div></div></div></div>';
    globalThis.modernAdapter=createCodexAdapter({host,placement:'inline-in-summary',onError:error=>errors.push(error.message)});
  })()`);
  assert.equal(await evaluate(`modernAdapter.getDiagnostics().mode`), "animated-summary");
  assert.deepEqual(await evaluate(`(() => {
    const panel=document.getElementById('modern-native'),scroll=document.getElementById('modern-scroll');
    const gap=Math.round(host.getBoundingClientRect().top-panel.getBoundingClientRect().bottom);
    const x=Math.round(host.getBoundingClientRect().left-panel.getBoundingClientRect().left);
    const before=panel.getBoundingClientRect().top;scroll.scrollTop=120;
    return {gap,x,delta:Math.round(before-panel.getBoundingClientRect().top),height:scroll.clientHeight,available:Math.floor(innerHeight-64)};
  })()`), { gap: 24, x: 0, delta: 120, height: await evaluate(`Math.floor(innerHeight-64)`), available: await evaluate(`Math.floor(innerHeight-64)`) });
  await evaluate(`modernAdapter.dispose()`);
  assert.deepEqual(await evaluate(`({scroll:document.getElementById('modern-scroll').getAttribute('data-codex-companion-scroll-root'),column:document.getElementById('modern-column').getAttribute('data-codex-companion-animation-column'),position:document.getElementById('modern-column').style.position,priority:document.getElementById('modern-column').style.getPropertyPriority('position')})`), { scroll: "original-scroll", column: "original-column", position: "static", priority: "important" });
  // 原生测量失败必须恢复修改并提供入口，回调抛错不能摧毁布局。
  await evaluate(`(() => {
    const panel=document.getElementById('modern-native');
    const measure=panel.getBoundingClientRect.bind(panel);
    let fail=true;
    panel.getBoundingClientRect=()=>{if(fail){fail=false;throw new Error('fixture-native-measure');}return measure();};
    globalThis.fallbackErrors=[];
    globalThis.fallbackAdapter=createCodexAdapter({host,placement:'inline-in-summary',onError:error=>fallbackErrors.push(error.message),onVisibilityChange:()=>{throw new Error('fixture-listener');}});
  })()`);
  assert.equal(await evaluate(`fallbackAdapter.getDiagnostics().fallbackActive`), true);
  assert.equal(await evaluate(`fallbackErrors.includes('fixture-native-measure') && fallbackErrors.includes('fixture-listener')`), true);
  assert.equal(await evaluate(`document.getElementById('codex-companion-root-shell').shadowRoot.querySelector('button').hidden`), false);
  await evaluate(`document.getElementById('modern-toggle').setAttribute('aria-pressed','false');document.getElementById('modern-column').style.opacity='0';fallbackAdapter.setOpen(true)`);
  await waitFor(`fallbackAdapter.isOpen()`, "异常降级按钮仍可打开");
  await evaluate(`fallbackAdapter.dispose()`);
  assert.equal(await evaluate(`document.getElementById('modern-scroll').getAttribute('data-codex-companion-scroll-root')`), "original-scroll");
  // Summary 变体：无 origin-top-right 动画列，面板经 display:contents 包装在 flex 纵列里。
  await evaluate(`(() => {
    document.body.innerHTML='<header style="display:flex;justify-content:flex-end"><button id="variant-toggle" aria-label="Toggle pinned summary" aria-pressed="true"><svg></svg></button><button aria-label="New tab"><svg></svg></button></header><div class="thread-floating-content-top-inset right-0" style="display:none"><div style="display:flex;flex-direction:column;width:300px"><div style="display:contents"><div data-summary-panel-variant="summary" style="height:212px;border-radius:20px;background:white">后台标签</div></div></div></div><div id="variant-root" class="thread-floating-content-top-inset right-0" style="position:absolute;top:48px;bottom:16px;right:0;max-width:100%"><div style="position:relative;display:flex;max-height:100%;padding-right:8px"><div id="variant-scroll" style="max-height:100%;min-height:0"><div id="variant-column" style="display:flex;flex-direction:column;gap:12px;max-height:100%;width:300px"><div style="display:contents"><div id="variant-native" data-summary-panel-variant="summary" style="display:flex;flex-direction:column;height:212px;width:300px;border-radius:20px;background:white">Summary</div></div></div></div></div></div>';
    globalThis.variantAdapter=createCodexAdapter({host,placement:'inline-in-summary',onError:error=>errors.push(error.message)});
  })()`);
  assert.equal(await evaluate(`variantAdapter.getDiagnostics().mode`), "animated-summary", "Summary 变体应挂在摘要下方");
  assert.equal(await evaluate(`Math.round(host.getBoundingClientRect().top-document.getElementById('variant-native').getBoundingClientRect().bottom)`), 24);
  await evaluate(`variantAdapter.dispose()`);
  // 26.1117 的结构：浮层根改成 inset-x-0（不再带 right-0），铺满会话区，面板靠右；只能从 data-summary-panel-variant 出发定位。
  await evaluate(`(() => {
    document.body.innerHTML='<header style="display:flex;justify-content:flex-end"><button id="inset-toggle" aria-label="Toggle pinned summary" aria-pressed="true"><svg width="16" height="16"></svg></button><button aria-label="New tab"><svg width="16" height="16"></svg></button></header><div style="position:relative;height:600px"><div id="inset-root" class="pointer-events-none absolute inset-x-0 top-(--thread-floating-content-top-inset)" style="position:absolute;left:0;right:0;top:48px;bottom:16px"><div style="position:relative;display:flex;width:fit-content;max-height:100%;margin-left:auto;padding-right:8px"><div id="inset-scroll" style="max-height:100%;min-height:0"><div id="inset-column" style="display:flex;flex-direction:column;gap:12px;max-height:100%;width:300px"><div style="display:contents"><div id="inset-native" data-summary-panel-variant="summary" style="height:152px;border-radius:16px;background:white">来源</div></div></div></div></div></div></div>';
    globalThis.insetAdapter=createCodexAdapter({host,placement:'inline-in-summary',onError:error=>errors.push(error.message)});
  })()`);
  assert.equal(await evaluate(`insetAdapter.getDiagnostics().mode`), "animated-summary", "inset-x-0 浮层根：卡片应挂在摘要下方");
  assert.equal(await evaluate(`Math.round(host.getBoundingClientRect().top-document.getElementById('inset-native').getBoundingClientRect().bottom)`), 24);
  assert.equal(await evaluate(`Math.round(document.getElementById('inset-scroll').getBoundingClientRect().height)`), 536, "滚动高度取浮层根的可用高度");
  assert.equal(await evaluate(`Math.round(innerWidth-host.getBoundingClientRect().right) < 60`), true, "卡片与摘要一样靠右");
  // 摘要关着：入口留在顶栏，点它打开摘要。
  await evaluate(`document.getElementById('inset-toggle').onclick=function(){const open=this.getAttribute('aria-pressed')!=='true';this.setAttribute('aria-pressed',String(open));document.getElementById('inset-root').style.display=open?'':'none';};document.getElementById('inset-toggle').click()`);
  await waitFor(`insetAdapter.getDiagnostics().mode === 'hidden' && document.getElementById('codex-companion-root-toolbar')?.getBoundingClientRect().width > 0`, "摘要关着时入口保留在顶栏");
  await evaluate(`document.getElementById('codex-companion-root-toolbar').shadowRoot.querySelector('button').click()`);
  await waitFor(`insetAdapter.getDiagnostics().mode === 'animated-summary' && document.getElementById('inset-toggle').getAttribute('aria-pressed') === 'true'`, "点入口打开摘要并显示卡片");
  await evaluate(`insetAdapter.dispose()`);
  // 未知结构：Summary 已打开却定位不到面板时，短暂等待后退回独立入口，不能让入口消失。
  await evaluate(`(() => {
    document.body.innerHTML='<header style="display:flex;justify-content:flex-end"><button aria-label="Toggle pinned summary" aria-pressed="true" onclick="this.setAttribute(\\'aria-pressed\\',String(this.getAttribute(\\'aria-pressed\\')!==\\'true\\'))"><svg></svg></button><button aria-label="New tab"><svg></svg></button></header><div style="position:absolute;top:48px;right:0;width:300px;height:200px;border-radius:20px;background:white">Unknown summary</div>';
    globalThis.unknownAdapter=createCodexAdapter({host,placement:'inline-in-summary',onError:error=>errors.push(error.message)});
  })()`);
  assert.equal(await evaluate(`unknownAdapter.getDiagnostics().summaryUnsupported`), false, "宽限期内不立即切换");
  await waitFor(`unknownAdapter.getDiagnostics().summaryUnsupported && unknownAdapter.getDiagnostics().inlineEntryFallback`, "未知 Summary 结构退回独立入口");
  assert.equal(await evaluate(`Boolean(document.getElementById('codex-companion-root-toolbar')?.isConnected) || document.getElementById('codex-companion-root-shell').shadowRoot.querySelector('button').hidden === false`), true, "退回后顶栏或悬浮入口可见");
  await evaluate(`unknownAdapter.setOpen(true)`);
  await waitFor(`unknownAdapter.isOpen()`, "退回后入口可打开");
  assert.equal(await evaluate(`unknownAdapter.getDiagnostics().inlineEntryFallback`), true, "Summary 关闭后仍保持独立入口");
  await evaluate(`unknownAdapter.dispose()`);
  // 新版标题栏右侧只剩一个按钮（New tab），分组内也只有它：入口仍进顶栏，放在它左侧。
  await evaluate(`(() => {
    document.body.innerHTML='<header style="position:fixed;top:0;left:0;right:0;height:44px;display:flex"><div style="display:flex;gap:6px"><button aria-label="Back">B</button></div><div style="margin-left:auto;display:inline-flex;height:100%;align-items:center"><div style="display:flex;gap:6px;align-items:center"><div><button id="new-tab" aria-label="New tab" style="width:28px;height:28px">+</button></div></div></div></header>';
    globalThis.titlebarAdapter=createCodexAdapter({host,onError:error=>errors.push(error.message)});
  })()`);
  await waitFor(`!!document.getElementById('codex-companion-root-toolbar')`, "标题栏只有单个按钮时未进入顶栏");
  assert.deepEqual(await evaluate(`(() => {
    const entry=document.getElementById('codex-companion-root-toolbar').getBoundingClientRect(), tab=document.getElementById('new-tab').getBoundingClientRect();
    return {leftOfNative:entry.right<=tab.left, sameRow:Math.round(entry.top)===Math.round(tab.top), nativeAtEdge:Math.round(innerWidth-tab.right)===0,
      floatingHidden:document.getElementById('codex-companion-root-shell').shadowRoot.querySelector('button').hidden};
  })()`), { leftOfNative: true, sameRow: true, nativeAtEdge: true, floatingHidden: true });
  await evaluate(`titlebarAdapter.setOpen(true)`);
  await waitFor(`titlebarAdapter.isOpen()`, "顶栏入口打开");
  await evaluate(`titlebarAdapter.dispose()`);
  assert.equal(await evaluate(`!!document.getElementById('codex-companion-root-toolbar')`), false, "dispose 移除顶栏入口");
  // 宿主改版保障：标题栏不再是 header / toolbar，Summary 开关的文案也认不出，只剩自动化属性和位置。
  // 入口仍进顶栏、紧贴 Summary 开关左侧；整页的横向布局不是标题栏，不能把入口塞进去。
  await evaluate(`(() => {
    document.body.innerHTML='<div style="display:flex;height:100%"><div style="flex:1"><div style="height:44px;display:flex"><div style="margin-left:auto;display:flex;gap:6px;align-items:center">'
      + '<button aria-label="Zzz" style="width:28px;height:28px">S</button><button id="attr-toggle" data-thread-summary-panel-toggle="true" aria-label="Qqq" aria-pressed="false" style="width:28px;height:28px;color:rgb(1, 2, 3)"><svg width="16" height="16"></svg></button></div></div>'
      + '<button style="width:28px;height:28px">body</button></div></div>';
    globalThis.semanticAdapter=createCodexAdapter({host,onError:error=>errors.push(error.message)});
  })()`);
  assert.deepEqual(await evaluate(`(() => {
    const entry=document.getElementById('codex-companion-root-toolbar'), toggle=document.getElementById('attr-toggle');
    return {entry:semanticAdapter.getDiagnostics().entry, beforeToggle:entry?.nextElementSibling===toggle,
      sameRow:Math.round(entry?.getBoundingClientRect().top)===Math.round(toggle.getBoundingClientRect().top),
      color:getComputedStyle(entry.shadowRoot.querySelector('button')).color};
  })()`), { entry: "summary", beforeToggle: true, sameRow: true, color: "rgb(1, 2, 3)" }, "按自动化属性和位置定位顶栏入口，图标颜色照抄同组原生图标按钮");
  await evaluate(`document.getElementById('attr-toggle').parentElement.parentElement.remove()`);
  await waitFor(`semanticAdapter.getDiagnostics().entry === 'floating'`, "标题栏消失后退回悬浮入口");
  assert.equal(await evaluate(`!document.getElementById('codex-companion-root-toolbar') && document.getElementById('codex-companion-root-shell').shadowRoot.querySelector('button').hidden === false`), true, "不把入口放进页面正文");
  await evaluate(`semanticAdapter.dispose()`);
  assert.deepEqual(await evaluate(`errors`), []);

  // 原生 Summary 布局：判定来自原生 layout chunk（这里用导出名打乱的同构替身），
  // 平移只写原生的 --thread-content-x，由原生 shiftWithTranscript 样式完成。Vite 时代类名为 _shiftWithTranscript_<hash>，
  // 26.1103 起为 shiftWithTranscript-<hash>，样式两种都声明，各段按对应版本切换。
  // gutter 留白=(宽度-736)/2：<180 overlay，<400 shift（平移 154px），其余 gutter。
  await connection.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
  await evaluate(`(() => {
    document.body.innerHTML='<style>._shiftWithTranscript_t_2,.shiftWithTranscript-t2{translate:var(--thread-content-x,none);--thread-wide-block-inline-shift:max(var(--thread-content-x,0px), calc(-1 * var(--thread-content-x,0px)))}</style>'
      + '<link rel="modulepreload" href="${layoutUrl}">'
      + '<header style="position:fixed;top:0;left:0;right:0;height:44px;display:flex"><div style="margin-left:auto;display:flex;gap:6px"><div><button aria-label="New tab" style="width:28px;height:28px">+</button></div></div></header>'
      + '<div id="layout-root" data-request-input-activity-root style="position:absolute;top:48px;left:0;width:1280px;height:700px;--thread-content-x: initial;">'
      + '<div class="thread-scroll-container" style="height:100%;overflow:auto"><div id="shift-column" class="_shiftWithTranscript_t_2"><div data-thread-user-message-navigation-content style="max-width:736px;margin:0 auto">Conversation</div></div></div>'
      + '<div id="shift-footer" class="_shiftWithTranscript_t_2" style="position:absolute;left:0;right:0;bottom:0">Input</div></div>';
    globalThis.shiftAdapter=createCodexAdapter({host,onError:error=>errors.push(error.message)});
    globalThis.shiftOf=(id)=>{const t=getComputedStyle(document.getElementById(id)).translate;return t==='none'?0:-parseFloat(t);};
    globalThis.drawerOf=()=>document.getElementById('codex-companion-root-shell').shadowRoot.querySelector('.drawer');
    globalThis.setRootWidth=(width)=>new Promise(resolve=>{document.getElementById('layout-root').style.width=width+'px';requestAnimationFrame(()=>requestAnimationFrame(resolve));});
    globalThis.sampleShift=(ms)=>new Promise(resolve=>{const out=[],start=performance.now();const tick=()=>{out.push(Math.round(shiftOf('shift-column')*10)/10);if(performance.now()-start<ms)requestAnimationFrame(tick);else resolve(out);};requestAnimationFrame(tick);});
  })()`);
  await waitFor(`shiftAdapter.getDiagnostics().nativeLayout && shiftAdapter.getDiagnostics().displayMode === 'shift'`, "加载原生布局模块并判定 shift 档");
  assert.equal(await evaluate(`shiftAdapter.getDiagnostics().layoutSource`), "chunk", "Vite 独立分包");
  const expectedShift = 154;
  const opening = await evaluate(`(async()=>{shiftAdapter.setOpen(true);return sampleShift(500);})()`);
  assert.equal(opening.at(-1), expectedShift, "平移量取自原生模块");
  assert.ok(opening.filter((value) => value > 0 && value < expectedShift).length >= 5, `打开需逐帧平移：${opening.join(",")}`);
  assert.ok(opening.every((value, index) => index === 0 || value >= opening[index - 1] - 0.5), "打开平移单调");
  assert.deepEqual(await evaluate(`({footer:Math.round(shiftOf('shift-footer')),surface:shiftAdapter.getDiagnostics().drawerSurface,width:Math.round(drawerOf().getBoundingClientRect().width)})`),
    { footer: expectedShift, surface: "inline", width: 324 }, "输入框同步平移，抽屉与原生面板同宽");
  const reversed = await evaluate(`(async()=>{shiftAdapter.setOpen(false);const head=await sampleShift(90);shiftAdapter.setOpen(true);const tail=await sampleShift(500);return {head,tail};})()`);
  const jump = Math.abs(reversed.tail[0] - reversed.head.at(-1));
  assert.ok(reversed.head.at(-1) < expectedShift && reversed.head.at(-1) > 0, `关闭中途：${reversed.head.join(",")}`);
  assert.ok(jump < 40, `中途反向必须从当前帧继续，跳变 ${jump}px`);
  assert.equal(reversed.tail.at(-1), expectedShift);

  // 常驻打开时拖窄到 overlay 档：与原生一样直接消失、会话回位；拖回宽档后重新出现。
  await evaluate(`setRootWidth(1000)`);
  await waitFor(`shiftAdapter.getDiagnostics().displayMode === 'overlay' && drawerOf().dataset.state === 'closed'`, "overlay 档常驻抽屉应消失");
  assert.deepEqual(await evaluate(`({shift:shiftOf('shift-column'),open:shiftAdapter.isOpen()})`), { shift: 0, open: false }, "overlay 档不平移");
  await evaluate(`setRootWidth(1280)`);
  await waitFor(`shiftAdapter.isOpen() && drawerOf().dataset.state === 'open' && shiftOf('shift-column') === ${expectedShift}`, "回到 shift 档常驻抽屉重新出现");

  // overlay 档点入口：浮在会话上方不平移；拖回宽档时浮层收起，常驻开关不受影响。
  await evaluate(`shiftAdapter.setOpen(false)`);
  await waitFor(`drawerOf().dataset.state === 'closed' && !document.querySelector('[data-companion-dock]')`, "关闭后撤销平移标记");
  assert.equal(await evaluate(`document.getElementById('layout-root').getAttribute('style').includes('--thread-content-x: initial')`), true, "原生 inline style 原样保留");
  await evaluate(`setRootWidth(1000)`);
  await waitFor(`shiftAdapter.getDiagnostics().displayMode === 'overlay'`, "切到 overlay 档");
  await evaluate(`document.getElementById('codex-companion-root-toolbar').shadowRoot.querySelector('button').click()`);
  await waitFor(`shiftAdapter.isOpen() && drawerOf().dataset.state === 'open'`, "overlay 档点入口浮出抽屉");
  assert.deepEqual(await evaluate(`({surface:shiftAdapter.getDiagnostics().drawerSurface,shift:shiftOf('shift-column'),marks:document.querySelectorAll('[data-companion-dock]').length})`),
    { surface: "popover", shift: 0, marks: 0 }, "浮层不推会话");
  await evaluate(`setRootWidth(1280)`);
  await waitFor(`shiftAdapter.getDiagnostics().displayMode === 'shift' && !shiftAdapter.isOpen()`, "离开 overlay 档浮层收起");

  // gutter 档（留白足够）：常驻打开但不平移。
  await evaluate(`setRootWidth(1600)`);
  await evaluate(`shiftAdapter.setOpen(true)`);
  await waitFor(`shiftAdapter.getDiagnostics().displayMode === 'gutter' && shiftAdapter.isOpen()`, "gutter 档打开");
  assert.deepEqual(await evaluate(`({surface:shiftAdapter.getDiagnostics().drawerSurface,shift:shiftOf('shift-column')})`), { surface: "inline", shift: 0 }, "gutter 档不平移");
  await evaluate(`shiftAdapter.dispose()`);
  assert.equal(await evaluate(`!!document.querySelector('[data-companion-dock]') || !!document.getElementById('codex-companion-root-dock-style')`), false, "dispose 撤销平移");
  assert.deepEqual(await evaluate(`errors`), []);

  // 没有原生布局模块（新版并进主 chunk）：用照抄原生的内置公式，同样判定 shift 档并平移 154px。
  await evaluate(`(() => {
    document.querySelector('link[rel=modulepreload]').remove();
    performance.clearResourceTimings();
    document.getElementById('layout-root').style.width='1280px';
    globalThis.bareAdapter=createCodexAdapter({host,onError:error=>errors.push(error.message)});
  })()`);
  await evaluate(`bareAdapter.setOpen(true)`);
  await waitFor(`bareAdapter.isOpen() && drawerOf().dataset.state === 'open' && Math.round(shiftOf('shift-column')) === ${expectedShift}`, "无原生模块时按内置公式平移");
  assert.deepEqual(await evaluate(`(() => { const {nativeLayout, layoutSource, displayMode, drawerSurface} = bareAdapter.getDiagnostics(); return {nativeLayout, layoutSource, displayMode, drawerSurface, footer: Math.round(shiftOf('shift-footer'))}; })()`),
    { nativeLayout: false, layoutSource: "builtin", displayMode: "shift", drawerSurface: "inline", footer: expectedShift }, "内置公式与原生一致");
  await evaluate(`bareAdapter.dispose()`);
  assert.deepEqual(await evaluate(`errors`), []);

  // Rspack ESM（26.1103 起）：分包文件名不可识别，从入口导出的 __webpack_require__ 里取已实例化的原生布局模块；
  // 平移钩子换成 shiftWithTranscript-<hash> 新命名。
  await evaluate(`(() => {
    for (const node of document.querySelectorAll('._shiftWithTranscript_t_2')) node.className = 'shiftWithTranscript-t2';
    const entry = document.createElement('script');
    entry.type = 'module';
    entry.src = '${runtimeEntryUrl}';
    document.head.append(entry);
    globalThis.decoyExecuted = false;
    globalThis.runtimeAdapter=createCodexAdapter({host,onError:error=>errors.push(error.message)});
  })()`);
  await waitFor(`runtimeAdapter.getDiagnostics().layoutSource === 'runtime' && runtimeAdapter.getDiagnostics().displayMode === 'shift'`, "从 Rspack 运行时取原生布局模块");
  await evaluate(`runtimeAdapter.setOpen(true)`);
  await waitFor(`runtimeAdapter.isOpen() && drawerOf().dataset.state === 'open' && Math.round(shiftOf('shift-column')) === ${expectedShift}`, "新类名下按原生模块平移");
  assert.deepEqual(await evaluate(`({footer: Math.round(shiftOf('shift-footer')), surface: runtimeAdapter.getDiagnostics().drawerSurface, decoyExecuted})`),
    { footer: expectedShift, surface: "inline", decoyExecuted: false }, "输入框同步平移，且不执行未实例化的原生工厂");
  await evaluate(`setRootWidth(1000)`);
  await waitFor(`runtimeAdapter.getDiagnostics().displayMode === 'overlay' && shiftOf('shift-column') === 0`, "运行时模块同样判出 overlay 档");
  await evaluate(`runtimeAdapter.dispose()`);
  assert.deepEqual(await evaluate(`errors`), []);

  // 宿主改版保障：钩子都在，但原生样式不再消费 --thread-content-x（平移实测不生效）→ 不能假装已让位，
  // 自动换成限制面板宽度；会话列仍在抽屉左侧，关闭后原样恢复。
  await evaluate(`(() => {
    document.querySelector('style').remove();
    document.getElementById('layout-root').style.width='1280px';
    globalThis.ignoredAdapter=createCodexAdapter({host,onError:error=>errors.push(error.message)});
  })()`);
  await evaluate(`ignoredAdapter.setOpen(true)`);
  await waitFor(`ignoredAdapter.isOpen() && drawerOf().dataset.state === 'open' && ignoredAdapter.getDiagnostics().room === 'clamp' && ignoredAdapter.getDiagnostics().dockShift === 324`, "平移不生效时改用限制面板宽度");
  await waitFor(`document.querySelector('[data-thread-user-message-navigation-content]').getBoundingClientRect().right <= drawerOf().getBoundingClientRect().left + 1`, "会话列不被抽屉压住");
  assert.deepEqual(await evaluate(`(() => { const {displayMode, drawerSurface, roomFallbacks} = ignoredAdapter.getDiagnostics(); return {displayMode, drawerSurface, roomFallbacks, drawerRight: Math.round(innerWidth - drawerOf().getBoundingClientRect().right)}; })()`),
    { displayMode: "shift", drawerSurface: "inline", roomFallbacks: 1, drawerRight: 0 }, "判档与抽屉位置仍按让位前的会话宽度");
  await evaluate(`ignoredAdapter.setOpen(false)`);
  await waitFor(`drawerOf().dataset.state === 'closed' && !document.querySelector('[data-companion-dock]') && document.getElementById('layout-root').getBoundingClientRect().width === 1280`, "关闭后面板恢复原宽");
  await evaluate(`ignoredAdapter.dispose()`);
  assert.deepEqual(await evaluate(`errors`), []);

  // 侧聊关闭确认等 Codex 模态弹窗：遮罩（z-50）与确认框必须盖过已打开的抽屉，关闭后抽屉恢复置顶。
  await evaluate(`(() => {
    document.body.innerHTML='<header class="toolbar" style="display:flex;justify-content:flex-end;height:40px"><div><button aria-label="Share">S</button></div></header>'
      + '<div class="thread-scroll-container" style="position:absolute;inset:48px 0 0"><div data-thread-user-message-navigation-content>Conversation</div></div>';
    globalThis.modalAdapter=createCodexAdapter({host,onError:error=>errors.push(error.message)});
  })()`);
  await evaluate(`modalAdapter.setOpen(true)`);
  await waitFor(`modalAdapter.isOpen() && document.getElementById('codex-companion-root-shell').shadowRoot.querySelector('.drawer').dataset.state === 'open'`, "弹窗场景抽屉打开");
  const drawerHit = `(() => {
    const drawer=document.getElementById('codex-companion-root-shell').shadowRoot.querySelector('.drawer').getBoundingClientRect();
    return document.elementFromPoint(drawer.x+drawer.width/2,drawer.y+40);
  })()`;
  assert.equal(await evaluate(`${drawerHit}?.id`), "codex-companion-root-shell", "无弹窗时抽屉置顶");
  await evaluate(`(() => {
    const overlay=document.createElement('div');
    overlay.id='modal-overlay';overlay.className='codex-dialog-overlay';
    overlay.style.cssText='position:fixed;inset:0;z-index:50;pointer-events:auto';
    document.body.append(overlay);
  })()`);
  await waitFor(`${drawerHit}?.id === 'modal-overlay'`, "模态遮罩必须盖过抽屉");
  await evaluate(`document.getElementById('modal-overlay').remove()`);
  await waitFor(`${drawerHit}?.id === 'codex-companion-root-shell'`, "弹窗关闭后抽屉恢复置顶");
  // 遮罩类名改掉后，凭 aria-modal 仍能识别模态弹窗。
  await evaluate(`(() => {
    const dialog=document.createElement('div');
    dialog.id='aria-modal';dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');
    dialog.style.cssText='position:fixed;inset:0;z-index:50;pointer-events:auto';
    document.body.append(dialog);
  })()`);
  await waitFor(`${drawerHit}?.id === 'aria-modal'`, "只有 ARIA 语义的模态弹窗也必须盖过抽屉");
  await evaluate(`document.getElementById('aria-modal').remove()`);
  await waitFor(`${drawerHit}?.id === 'codex-companion-root-shell'`, "ARIA 弹窗关闭后抽屉恢复置顶");
  await evaluate(`modalAdapter.dispose()`);
  assert.deepEqual(await evaluate(`errors`), []);

  // Dot 会话（.messaging-root）右上角有原生通话按钮，与抽屉冲突：此页不提供入口；回到普通会话后按原开关恢复。
  await evaluate(`(() => {
    globalThis.threadPage='<header class="toolbar" style="display:flex;justify-content:flex-end;height:40px"><div><button aria-label="Share">S</button></div></header>'
      + '<div class="thread-scroll-container" style="position:absolute;inset:48px 0 0"><div data-thread-user-message-navigation-content>Conversation</div></div>';
    globalThis.dotPage='<header class="toolbar" style="display:flex;justify-content:flex-end;height:40px"><div><button aria-label="Share">S</button></div></header>'
      + '<div class="messaging-root messaging-embedded" style="position:absolute;inset:40px 0 0">'
      + '<div style="position:absolute;top:8px;right:8px"><button id="dot-call" aria-label="Start call" style="width:32px;height:32px">C</button></div>'
      + '<div data-role="messages-scroll" class="messages-scroll" style="height:100%;overflow:auto">Message</div></div>'
      // 普通会话页保活在后台：节点仍在，尺寸为 0。
      + '<div class="thread-scroll-container" style="display:none"><div data-thread-user-message-navigation-content>Hidden</div></div>';
    document.body.innerHTML=threadPage;
    globalThis.dotVisibility=[];
    globalThis.dotAdapter=createCodexAdapter({host,onError:error=>errors.push(error.message),onVisibilityChange:({visible,reason})=>dotVisibility.push([visible,reason])});
  })()`);
  const entryShown = `(() => {
    const shell=document.getElementById('codex-companion-root-shell');
    return {toolbar:Boolean(document.getElementById('codex-companion-root-toolbar')?.isConnected),
      floating:shell?.shadowRoot.querySelector('button').hidden === false, drawer:shell?.shadowRoot.querySelector('.drawer').hidden === false};
  })()`;
  await evaluate(`dotAdapter.setOpen(true)`);
  await waitFor(`dotAdapter.isOpen()`, "普通会话抽屉打开");
  await evaluate(`document.body.innerHTML=dotPage`);
  await waitFor(`!dotAdapter.isOpen() && ${entryShown}.drawer === false`, "Dot 页收起抽屉");
  assert.deepEqual(await evaluate(entryShown), { toolbar: false, floating: false, drawer: false }, "Dot 页不显示入口");
  assert.equal(await evaluate(`(() => { const call=document.getElementById('dot-call').getBoundingClientRect(); return document.elementFromPoint(call.x+call.width/2,call.y+call.height/2)?.id; })()`), "dot-call", "不挡原生通话按钮");
  assert.deepEqual(await evaluate(`dotVisibility.at(-1)`), [false, "dot-page"]);
  await evaluate(`document.body.innerHTML=threadPage`);
  await waitFor(`dotAdapter.isOpen() && ${entryShown}.toolbar && ${entryShown}.drawer`, "回到普通会话按原开关恢复");
  await evaluate(`dotAdapter.dispose()`);
  assert.deepEqual(await evaluate(`errors`), []);

  // 只在会话页提供入口：设置页（有输入框也不算会话）、插件等管理页右侧都是原生控件，不显示入口与抽屉；
  // 回到会话后按原开关恢复。认不出应用外框（宿主改版）时保留悬浮入口，抽屉高度随内容，卡片下方不挡原生按钮。
  await evaluate(`(() => {
    const frame=(body)=>'<div data-app-shell-frame="true" style="position:absolute;inset:0">'+body+'</div>';
    const action=(id,text)=>'<button id="'+id+'" style="position:absolute;right:40px;bottom:60px;width:56px;height:30px">'+text+'</button>';
    globalThis.shellThreadPage=frame(threadPage);
    globalThis.settingsPage=frame('<nav style="position:absolute;left:0;top:0;bottom:0;width:300px"><div data-settings-nav-scroll-container="true"><button data-settings-panel-slug="data-controls">存储</button></div></nav>'
      + '<main style="position:absolute;left:300px;right:0;top:0;bottom:0"><textarea>自定义指令</textarea>'+action('settings-manage','管理')+'</main>');
    globalThis.pluginsPage=frame('<main style="position:absolute;inset:0">'+action('plugin-install','安装')+'</main>');
    globalThis.barePage='<main>'+action('bare-action','按钮')+'</main>';
    globalThis.hitsSelf=(id)=>{const box=document.getElementById(id).getBoundingClientRect();return document.elementFromPoint(box.x+box.width/2,box.y+box.height/2)?.id===id;};
    host.style.height='400px';
    document.body.innerHTML=shellThreadPage;
    globalThis.pageVisibility=[];
    globalThis.pageAdapter=createCodexAdapter({host,onError:error=>errors.push(error.message),onVisibilityChange:({visible,reason})=>pageVisibility.push([visible,reason])});
  })()`);
  await evaluate(`pageAdapter.setOpen(true)`);
  for (const [page, kind, button] of [["settingsPage", "settings", "settings-manage"], ["pluginsPage", "other", "plugin-install"]]) {
    await evaluate(`document.body.innerHTML=shellThreadPage`);
    await waitFor(`pageAdapter.isOpen() && pageAdapter.getDiagnostics().page === 'conversation'`, "会话页抽屉打开");
    await evaluate(`document.body.innerHTML=${page}`);
    await waitFor(`!pageAdapter.isOpen() && ${entryShown}.drawer === false && pageAdapter.getDiagnostics().page === '${kind}'`, `${kind} 页收起抽屉`);
    assert.deepEqual(await evaluate(entryShown), { toolbar: false, floating: false, drawer: false }, `${kind} 页不显示入口`);
    assert.equal(await evaluate(`hitsSelf('${button}')`), true, `${kind} 页原生按钮可点`);
    assert.deepEqual(await evaluate(`pageVisibility.at(-1)`), [false, `${kind}-page`]);
  }
  await evaluate(`document.body.innerHTML=shellThreadPage`);
  await waitFor(`pageAdapter.isOpen() && ${entryShown}.toolbar && ${entryShown}.drawer`, "回到会话按原开关恢复");
  await evaluate(`document.body.innerHTML=barePage`);
  await waitFor(`pageAdapter.isOpen() && pageAdapter.getDiagnostics().page === 'unknown' && drawerOf().dataset.state === 'open'`, "认不出应用外框时保留悬浮抽屉");
  assert.deepEqual(await evaluate(`(() => { const drawer=drawerOf().getBoundingClientRect(); return {floating:${entryShown}.floating, short:drawer.bottom < innerHeight - 100, clickable:hitsSelf('bare-action')}; })()`),
    { floating: true, short: true, clickable: true }, "抽屉高度随内容，卡片下方的原生按钮可点");
  await evaluate(`pageAdapter.dispose(); host.style.height='1100px'`);
  assert.deepEqual(await evaluate(`errors`), []);

  // 宿主改版保障：Codex 的具名钩子一个都没有 → 按输入框找到主面板，判档照旧；给面板加右侧留白让位，
  // 会话与输入框由页面自己的布局重新居中，不被抽屉压住；滚动内容里的按钮不推低抽屉。
  await evaluate(`(() => {
    document.body.innerHTML='<header style="position:fixed;top:0;left:0;right:0;height:44px;display:flex"><div style="margin-left:auto;display:flex;gap:6px"><div><button aria-label="New tab" style="width:28px;height:28px">+</button></div></div></header>'
      + '<main style="position:absolute;inset:44px 0 0;display:flex;flex-direction:column"><div style="flex:1;overflow:auto"><div style="max-width:736px;margin:0 auto">Unknown<button id="scrolling-action" style="position:absolute;right:20px;top:20px;width:28px;height:28px">R</button></div></div>'
      + '<div contenteditable="true" style="height:40px;max-width:736px;margin:0 auto 16px;width:100%">Input</div></main>';
    globalThis.unknownAdapter=createCodexAdapter({host,onError:error=>errors.push(error.message)});
  })()`);
  assert.equal(await evaluate(`(() => { const input=document.querySelector('[contenteditable]').getBoundingClientRect(); return input.right > innerWidth - 324; })()`), true, "夹具：让位前输入框伸到抽屉位置下面");
  await evaluate(`unknownAdapter.setOpen(true)`);
  await waitFor(`unknownAdapter.isOpen() && drawerOf().dataset.state === 'open' && unknownAdapter.getDiagnostics().dockShift === 324 && document.querySelector('main').getAnimations().length === 0`, "未知结构应按输入框让位");
  assert.deepEqual(await evaluate(`(() => {
    const drawer=drawerOf(), {thread, room, displayMode, drawerSurface, roomFallbacks}=unknownAdapter.getDiagnostics();
    const left=drawer.getBoundingClientRect().left;
    return {thread, room, displayMode, drawerSurface, roomFallbacks, top:drawer.style.top,
      inputClear:document.querySelector('[contenteditable]').getBoundingClientRect().right <= left + 1,
      textClear:document.querySelector('main > div > div').getBoundingClientRect().right <= left + 1,
      paneWidth:Math.round(document.querySelector('main').getBoundingClientRect().width)};
  })()`), { thread: "composer", room: "pad", displayMode: "shift", drawerSurface: "inline", roomFallbacks: 0, top: "48px", inputClear: true, textClear: true, paneWidth: 1280 },
  "不依赖具名钩子让位：面板自身不变，内容让到抽屉左侧");
  // 拖窄到 overlay 档：与原生一样常驻抽屉消失、留白撤销；拖回后恢复。
  await connection.send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false });
  await waitFor(`unknownAdapter.getDiagnostics().displayMode === 'overlay' && drawerOf().dataset.state === 'closed' && !document.querySelector('[data-companion-dock]')`, "未知结构下 overlay 档同样收起");
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('main')).paddingRight`), "0px", "收起后撤销留白");
  await connection.send("Emulation.clearDeviceMetricsOverride");
  await waitFor(`unknownAdapter.isOpen() && unknownAdapter.getDiagnostics().room === 'pad'`, "回到宽窗后重新让位");
  await evaluate(`unknownAdapter.setOpen(false)`);
  await waitFor(`drawerOf().dataset.state === 'closed' && !document.querySelector('[data-companion-dock]') && getComputedStyle(document.querySelector('main')).paddingRight === '0px'`, "关闭后撤销留白");
  // 输入框所在面板写死了宽度、留白与限宽都挪不动它：实测不生效就放弃，抽屉浮在上方，不留下任何改动。
  await evaluate(`(() => { const input=document.querySelector('[contenteditable]'); input.style.cssText='position:fixed;left:500px;bottom:16px;width:600px;height:40px'; })()`);
  await evaluate(`unknownAdapter.setOpen(true)`);
  await waitFor(`unknownAdapter.isOpen() && drawerOf().dataset.state === 'open'`, "让位失败时抽屉仍可打开");
  assert.deepEqual(await evaluate(`(() => { const {room, roomFallbacks, drawerSurface}=unknownAdapter.getDiagnostics(); return {room, roomFallbacks, drawerSurface, marks:document.querySelectorAll('[data-companion-dock],[data-companion-dock-probe]').length, padding:getComputedStyle(document.querySelector('main')).paddingRight, probe:!!document.getElementById('codex-companion-root-dock-probe')}; })()`),
    { room: null, roomFallbacks: 2, drawerSurface: "inline", marks: 0, padding: "0px", probe: false }, "两种让位都不生效时不改动页面");
  await evaluate(`unknownAdapter.dispose()`);
  assert.deepEqual(await evaluate(`errors`), []);

  await evaluate(`clearInterval(frameTimer);video.srcObject.getTracks().forEach(track=>track.stop())`);
  console.log("Codex adapter smoke passed:", JSON.stringify(evidence));
} finally {
  connection?.close();
  layoutServer.close();
  chrome.kill("SIGTERM");
  await new Promise((resolve) => { chrome.once("exit", resolve);setTimeout(resolve, 2000).unref(); });
  await rm(profile, { recursive: true, force: true });
}
