import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { CdpConnection } from "../src/cdp-connection.mjs";
import { reserveLoopbackPort } from "../src/launcher.mjs";
import { listCdpTargets } from "../src/targets.mjs";
import { createAntigravityAdapter } from "../src/renderer/adapters/antigravity.mjs";
import { createAntigravityThreads } from "../src/renderer/adapters/antigravity-threads.mjs";

// 只启动独立临时 Chrome profile；不访问用户 Antigravity 的 CDP 端口或数据。
const port = await reserveLoopbackPort();
const profile = await mkdtemp(path.join(os.tmpdir(), "companion-antigravity-adapter-"));
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--window-size=1200,800",
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
  // pushState 需要同源的 http 页面，起一个只回空白页的本机服务。
  const evaluate = async (expression) => {
    const result = await connection.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const key = async (type, extra = {}) => connection.send("Input.dispatchKeyEvent", { type, code: "KeyJ", key: "j", windowsVirtualKeyCode: 74, modifiers: 1 | 4, ...extra });
  const http = await import("node:http");
  const server = http.createServer((_request, response) => response.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><html><head></head><body></body></html>"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await connection.send("Page.enable");
    await connection.send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/` });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await evaluate(`globalThis.createAntigravityAdapter = ${createAntigravityAdapter.toString()}`);
    await evaluate(`globalThis.createAntigravityThreads = ${createAntigravityThreads.toString()}`);
    await evaluate(`(() => {
      document.documentElement.style.cssText = '--card:rgb(250, 250, 250);--foreground:rgb(20, 20, 20);--border:rgb(200, 200, 200);--muted-foreground:rgb(120, 120, 120)';
      document.body.innerHTML = \`<style>body{margin:0}.bar{display:flex;justify-content:flex-end;gap:4px;padding:6px}.h-7{height:28px}.w-7{width:28px}</style>
        <div class="bar" id="bar"><button id="more">⋮</button><button id="overview" class="agy-button h-7 w-7 bg-secondary text-foreground" data-testid="toggle-overview-panel">O</button><button>A</button></div>
        <main id="main" style="height:600px">conversation</main>\`;
      globalThis.host = document.createElement('div');
      host.id = 'agent-companion-root';
      host.attachShadow({ mode: 'open' }).innerHTML = '<div id="cards" style="height:200px">cards</div>';
      globalThis.events = []; globalThis.errors = [];
      globalThis.adapter = createAntigravityAdapter({ host, hasCards: true, onVisibilityChange: (event) => events.push(event), onError: (error) => errors.push(error.message) });
    })()`);
    await evaluate("new Promise((resolve) => requestAnimationFrame(() => resolve()))");

    // 入口插在 Overview 左侧，抄它的尺寸 class，但用普通态（不是它当前的选中态）
    const entry = await evaluate(`(() => { const e = document.getElementById('overview').previousElementSibling; return e && { mark: e.hasAttribute('data-agent-companion-entry'), cls: e.className }; })()`);
    assert.equal(entry?.mark, true, "入口插在 Overview 开关左侧");
    assert.match(entry.cls, /agy-button h-7 w-7/);
    assert.match(entry.cls, /bg-transparent/);
    assert.doesNotMatch(entry.cls, /bg-secondary/);
    assert.equal(await evaluate("document.getElementById('agent-companion-entry').hidden"), true, "有标题栏锚点时不显示悬浮按钮");
    assert.equal(await evaluate("document.getElementById('agent-companion-rail').hidden"), true);
    assert.equal(await evaluate("document.getElementById('overview').className"), "agy-button h-7 w-7 bg-secondary text-foreground", "原生节点不被改动");

    // 点入口打开弹层：挂在按钮下方、右对齐，主题变量来自 Antigravity
    await evaluate("document.querySelector('[data-agent-companion-entry]').click()");
    assert.equal(await evaluate("adapter.isOpen()"), true);
    assert.deepEqual(await evaluate("events.at(-1)"), { visible: true, reason: "popover", placement: "standalone-button" });
    const layout = await evaluate(`(() => { const b = document.querySelector('[data-agent-companion-entry]').getBoundingClientRect(); const r = document.getElementById('agent-companion-rail').getBoundingClientRect(); return { top: r.top, buttonBottom: b.bottom, right: r.right, width: innerWidth, host: host.isConnected }; })()`);
    assert.ok(Math.abs(layout.top - layout.buttonBottom - 6) <= 1, "弹层在按钮下方 6px");
    assert.ok(Math.abs(layout.right - (layout.width - 14)) <= 1, "没有对话区时贴窗口右边");
    // 有对话区时卡片右边贴着对话区右边框（rail 右边 = 对话区右边 - 6）
    await evaluate(`document.body.insertAdjacentHTML('beforeend', '<main id="conversation" data-cascade-id="5f13e99e-f461-4309-9796-ce99e2b141ef" style="position:fixed;left:0;top:0;width:700px;height:10px"></main>'); dispatchEvent(new Event('resize'))`);
    await evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    assert.ok(Math.abs(await evaluate("document.getElementById('agent-companion-rail').getBoundingClientRect().right") - 694) <= 1, "弹层右边对齐对话区");
    await evaluate("document.getElementById('conversation').remove(); dispatchEvent(new Event('resize'))");
    assert.equal(await evaluate("host.style.getPropertyValue('--hg-panel-bg')"), "rgb(250, 250, 250)");
    assert.equal(await evaluate("host.style.getPropertyValue('--cc-card-border')"), "rgb(200, 200, 200)");
    assert.match(await evaluate("document.querySelector('[data-agent-companion-entry]').className"), /bg-secondary/, "打开时入口显示选中态");

    // 浮层不随点击收起：点卡片、点对话、聚焦输入框后都还开着
    await evaluate("host.shadowRoot.getElementById('cards').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }))");
    assert.equal(await evaluate("adapter.isOpen()"), true, "点卡片不收起");
    await evaluate("document.getElementById('main').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }))");
    assert.equal(await evaluate("adapter.isOpen()"), true, "点对话不收起");
    await evaluate("document.body.insertAdjacentHTML('beforeend', '<textarea id=\"composer\"></textarea>'); document.getElementById('composer').focus()");
    await connection.send("Input.dispatchKeyEvent", { type: "rawKeyDown", code: "Escape", key: "Escape", windowsVirtualKeyCode: 27 });
    assert.equal(await evaluate("adapter.isOpen()"), true, "输入框里的 Esc 留给 Antigravity");

    // ⌥⌘J 开关；焦点在卡片里时 Esc 收起
    await key("rawKeyDown");
    assert.equal(await evaluate("adapter.isOpen()"), false, "⌥⌘J 收起");
    assert.equal(await evaluate("events.at(-1).visible"), false);
    await key("rawKeyDown");
    assert.equal(await evaluate("adapter.isOpen()"), true, "⌥⌘J 打开");
    // 卡片自己消费的 Esc（设置页确认框、播放器返回、取消重命名）会 preventDefault：只做卡片里的事，不连带收起弹层
    await evaluate(`(() => {
      const box = document.createElement('input'); box.id = 'consumer'; globalThis.consumed = 0;
      box.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); consumed += 1; } });
      host.shadowRoot.append(box); box.focus();
    })()`);
    await connection.send("Input.dispatchKeyEvent", { type: "rawKeyDown", code: "Escape", key: "Escape", windowsVirtualKeyCode: 27 });
    assert.deepEqual(await evaluate("[adapter.isOpen(), consumed]"), [true, 1], "卡片消费的 Esc 不收起弹层");
    await evaluate("host.shadowRoot.getElementById('consumer').remove()");
    await evaluate("document.getElementById('composer').remove(); host.shadowRoot.getElementById('cards').tabIndex = 0; host.shadowRoot.getElementById('cards').focus()");
    await connection.send("Input.dispatchKeyEvent", { type: "rawKeyDown", code: "Escape", key: "Escape", windowsVirtualKeyCode: 27 });
    assert.equal(await evaluate("adapter.isOpen()"), false, "焦点在卡片里时 Esc 收起");

    // Overview 开关消失但标题栏右侧仍有原生图标按钮（新建会话页的 ⋮）：退到第二级 titlebar-trailing，弹层仍从右上展开
    await evaluate(`document.getElementById('bar').innerHTML = '<button id="more-icon" class="agy-button h-7 w-7 bg-transparent text-secondary-foreground"><svg width="16" height="16"><circle cx="8" cy="8" r="2"/></svg></button>'`);
    await evaluate("new Promise((resolve) => setTimeout(resolve, 50))");
    assert.equal(await evaluate("adapter.getDiagnostics().entry"), "titlebar-trailing", "无 Overview 时退到右上角图标按钮旁");
    assert.equal(await evaluate("document.getElementById('more-icon').previousElementSibling?.hasAttribute('data-agent-companion-entry')"), true);
    assert.equal(await evaluate("document.getElementById('agent-companion-entry').hidden"), true);
    await evaluate("document.querySelector('[data-agent-companion-entry]').click()");
    assert.equal(await evaluate("adapter.isOpen()"), true);
    assert.equal(await evaluate("document.getElementById('agent-companion-rail').style.bottom"), "auto", "第二级弹层从右上向下展开");
    await evaluate("adapter.setOpen(false)");

    // 标题栏钩子全无：入口清掉，退到右上角悬浮按钮（不挡右下角发送按钮），弹层从上方展开
    await evaluate("document.getElementById('bar').innerHTML = ''");
    await evaluate("new Promise((resolve) => setTimeout(resolve, 50))");
    assert.equal(await evaluate("document.querySelectorAll('[data-agent-companion-entry]').length"), 0, "孤立入口被移除");
    assert.equal(await evaluate("document.getElementById('agent-companion-entry').hidden"), false, "退到悬浮按钮");
    assert.equal(await evaluate("adapter.getDiagnostics().entry"), "floating");
    await evaluate("document.getElementById('agent-companion-entry').shadowRoot.querySelector('button').click()");
    assert.equal(await evaluate("adapter.isOpen()"), true);
    assert.equal(await evaluate("document.getElementById('agent-companion-rail').style.top"), "94px");
    // Overview 回来后重新挂到标题栏第一级
    await evaluate("document.getElementById('bar').insertAdjacentHTML('beforeend', '<button id=\"overview\" class=\"agy-button h-7 w-7 bg-transparent text-secondary-foreground\" data-testid=\"toggle-overview-panel\">O</button>')");
    await evaluate("new Promise((resolve) => setTimeout(resolve, 50))");
    assert.equal(await evaluate("document.getElementById('overview').previousElementSibling?.hasAttribute('data-agent-companion-entry')"), true);
    assert.equal(await evaluate("adapter.getDiagnostics().entry"), "overview-toggle");
    assert.equal(await evaluate("document.getElementById('agent-companion-entry').hidden"), true);

    // 没有卡片时不显示任何入口
    await evaluate("adapter.setOpen(false); adapter.setHasCards(false)");
    await evaluate("new Promise((resolve) => setTimeout(resolve, 50))");
    assert.equal(await evaluate("document.getElementById('agent-companion-rail').hidden"), true);
    await evaluate("adapter.setHasCards(true)");

    // threads：地址里的会话 id、路由跳转、订阅
    await evaluate(`(() => {
      globalThis.threads = createAntigravityThreads({ document, onError: (error) => errors.push(error.message) });
      globalThis.routeChanges = 0; globalThis.pops = 0;
      addEventListener('popstate', () => { pops += 1; });
      globalThis.unsubscribe = threads.subscribe(() => { routeChanges += 1; });
    })()`);
    assert.equal(await evaluate("threads.current()"), null);
    const id = "5f13e99e-f461-4309-9796-ce99e2b141ef";
    assert.equal(await evaluate(`threads.has(${JSON.stringify(id)})`), true);
    assert.equal(await evaluate("threads.has('not-a-conversation')"), false);
    assert.deepEqual(await evaluate(`threads.reveal(${JSON.stringify(id)})`), { ok: true });
    assert.equal(await evaluate("location.pathname"), `/c/${id}`);
    assert.equal(await evaluate("history.state.__TSR_index"), 1, "按 TanStack Router 的格式写历史记录");
    assert.equal(await evaluate("pops"), 1, "发 popstate 通知路由");
    assert.equal(await evaluate("threads.current().id"), id);
    assert.equal(await evaluate("routeChanges"), 1, "地址变化通知订阅者");
    assert.deepEqual(await evaluate(`threads.reveal(${JSON.stringify(id)})`), { ok: true });
    assert.equal(await evaluate("pops"), 1, "已在该会话时不重复跳转");
    assert.deepEqual(await evaluate("threads.reveal('../settings')"), { ok: false, reason: "invalid" });

    // 侧栏颜色标记：第一级 [data-cascade-id]；React 替换条目后补回；没有自动化属性时退到 /c/<id> 链接
    const other = "116aed13-e977-429d-9b9e-ba854977fd4a";
    const third = "0a2b3c4d-1111-4222-8333-944455556666";
    await evaluate(`document.body.insertAdjacentHTML('beforeend', '<nav id="side"><div data-sidebar-row-id="${id}"><div id="row1" class="rounded-lg" data-cascade-id="${id}"><a href="/c/${id}"></a>Pi</div></div><div data-sidebar-row-id="${other}"><div id="row2" data-cascade-id="${other}">Ping</div></div></nav><main id="pane" data-cascade-id="${id}" style="height:400px">正文</main>')`);
    await evaluate(`threads.setMarks([{ id: "${id}", color: 2 }, { id: "bad", color: 1 }, { id: "${other}", color: 99 }])`);
    assert.equal(await evaluate("document.getElementById('row1').getAttribute('data-agent-companion-task')"), "2");
    assert.equal(await evaluate("document.getElementById('row2').hasAttribute('data-agent-companion-task')"), false, "颜色越界不标");
    assert.equal(await evaluate("document.getElementById('pane').hasAttribute('data-agent-companion-task')"), false, "正文区的对话容器不是侧栏条目");
    assert.equal(await evaluate("document.getElementById('row1').className"), "rounded-lg", "不改原生 class");
    assert.notEqual(await evaluate("getComputedStyle(document.getElementById('row1')).boxShadow"), "none", "画出左侧竖条");
    await evaluate(`document.getElementById('row1').outerHTML = '<div id="row1b" data-cascade-id="${id}">Pi</div>'`);
    await evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    assert.equal(await evaluate("document.getElementById('row1b').getAttribute('data-agent-companion-task')"), "2", "重绘后补回");
    await evaluate(`threads.setMarks([{ id: "${other}", color: 0 }])`);
    assert.equal(await evaluate("document.getElementById('row1b').hasAttribute('data-agent-companion-task')"), false, "整体替换上一次的标记");
    assert.equal(await evaluate("document.getElementById('row2').getAttribute('data-agent-companion-task')"), "0");
    await evaluate(`document.getElementById('pane').remove(); document.getElementById('side').innerHTML = '<div id="row3"><a href="/c/${third}"></a>无自动化属性</div><div id="big" style="height:300px"><a href="/c/${other}"></a></div>'`);
    await evaluate(`threads.setMarks([{ id: "${third}", color: 4 }])`);
    assert.equal(await evaluate("document.getElementById('row3').getAttribute('data-agent-companion-task')"), "4", "退到链接所在条目");
    await evaluate(`threads.setMarks([{ id: "${third}", color: 4 }, { id: "${other}", color: 1 }])`);
    assert.equal(await evaluate("document.getElementById('big').hasAttribute('data-agent-companion-task')"), false, "不像一行条目的不标");

    // dispose 清理干净
    await evaluate("adapter.dispose(); threads.dispose(); unsubscribe()");
    assert.equal(await evaluate("document.querySelectorAll('[data-agent-companion-task]').length + (document.getElementById('agent-companion-thread-marks') ? 1 : 0)"), 0, "撤掉标记与样式");
    assert.equal(await evaluate("!!document.getElementById('agent-companion-rail') || !!document.getElementById('agent-companion-entry') || document.querySelectorAll('[data-agent-companion-entry]').length > 0"), false);
    assert.equal(await evaluate("host.isConnected"), false);
    assert.deepEqual(await evaluate("errors"), []);
    console.log("antigravity adapter smoke ok");
  } finally {
    server.close();
  }
} finally {
  connection?.close();
  chrome.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 200));
  await rm(profile, { recursive: true, force: true });
}
