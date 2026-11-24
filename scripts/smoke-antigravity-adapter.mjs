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
    const layout = await evaluate(`(() => { const b = document.querySelector('[data-agent-companion-entry]').getBoundingClientRect(); const r = document.getElementById('agent-companion-rail').getBoundingClientRect(); return { top: r.top, buttonBottom: b.bottom, right: r.right, buttonRight: b.right, host: host.isConnected }; })()`);
    assert.ok(Math.abs(layout.top - layout.buttonBottom - 6) <= 1, "弹层在按钮下方 6px");
    assert.ok(Math.abs(layout.right - layout.buttonRight) <= 1, "弹层与按钮右对齐");
    assert.equal(await evaluate("host.style.getPropertyValue('--hg-panel-bg')"), "rgb(250, 250, 250)");
    assert.equal(await evaluate("host.style.getPropertyValue('--cc-card-border')"), "rgb(200, 200, 200)");
    assert.match(await evaluate("document.querySelector('[data-agent-companion-entry]').className"), /bg-secondary/, "打开时入口显示选中态");

    // 弹层里点不关；点外面关
    await evaluate("host.shadowRoot.getElementById('cards').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }))");
    assert.equal(await evaluate("adapter.isOpen()"), true, "点弹层内部不关闭");
    await evaluate("document.getElementById('main').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }))");
    assert.equal(await evaluate("adapter.isOpen()"), false, "点弹层外关闭");
    assert.equal(await evaluate("events.at(-1).visible"), false);

    // ⌥⌘J 开关、Esc 关闭
    await key("rawKeyDown");
    assert.equal(await evaluate("adapter.isOpen()"), true, "⌥⌘J 打开");
    await connection.send("Input.dispatchKeyEvent", { type: "rawKeyDown", code: "Escape", key: "Escape", windowsVirtualKeyCode: 27 });
    assert.equal(await evaluate("adapter.isOpen()"), false, "Esc 关闭");

    // Overview 开关消失（首页、新建会话）：入口跟着清掉，换成悬浮按钮，弹层贴右下
    await evaluate("document.getElementById('overview').remove()");
    await evaluate("new Promise((resolve) => setTimeout(resolve, 50))");
    assert.equal(await evaluate("document.querySelectorAll('[data-agent-companion-entry]').length"), 0, "孤立入口被移除");
    assert.equal(await evaluate("document.getElementById('agent-companion-entry').hidden"), false, "退到悬浮按钮");
    await evaluate("document.getElementById('agent-companion-entry').shadowRoot.querySelector('button').click()");
    assert.equal(await evaluate("adapter.isOpen()"), true);
    assert.equal(await evaluate("document.getElementById('agent-companion-rail').style.bottom"), "72px");
    // Overview 回来后重新挂到标题栏
    await evaluate("document.getElementById('bar').insertAdjacentHTML('beforeend', '<button id=\"overview\" class=\"agy-button h-7 w-7 bg-transparent text-secondary-foreground\" data-testid=\"toggle-overview-panel\">O</button>')");
    await evaluate("new Promise((resolve) => setTimeout(resolve, 50))");
    assert.equal(await evaluate("document.getElementById('overview').previousElementSibling?.hasAttribute('data-agent-companion-entry')"), true);
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

    // dispose 清理干净
    await evaluate("adapter.dispose(); threads.dispose(); unsubscribe()");
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
