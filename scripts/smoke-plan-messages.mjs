import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, appendFile, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CdpConnection } from "../src/cdp-connection.mjs";
import { CodexSessions, threadCreatedAt } from "../src/codex-sessions.mjs";
import { createService } from "../src/cards/tasks/service.mjs";
import { TaskBoardStorage } from "../src/task-board-storage.mjs";
import { reserveLoopbackPort } from "../src/launcher.mjs";
import { listCdpTargets } from "../src/targets.mjs";

const run = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temporary = await mkdtemp(join(tmpdir(), "companion-plan-messages-"));
const id = "01a18216-3b02-7db0-b394-9543cce4d535";
const codexHome = join(temporary, "codex");
const created = new Date(threadCreatedAt(id));
const pad = value => String(value).padStart(2, "0");
const sessionDirectory = join(codexHome, "sessions", String(created.getFullYear()), pad(created.getMonth() + 1), pad(created.getDate()));
await mkdir(sessionDirectory, { recursive: true });
const rollout = join(sessionDirectory, `rollout-fixture-${id}.jsonl`);
const record = (type, payload) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload });
const steps = ["检查现状", "验证动态进度", "汇总结果"];
const snapshot = (done, role = "assistant") => record("response_item", {
  type: "message", role, phase: "commentary", content: [{ type: "output_text", text: `同步当前任务进度。\n\n\`\`\`companion-plan\n${JSON.stringify({
    plan: steps.map((step, index) => ({ step, status: index < done ? "completed" : index === done ? "in_progress" : "pending" }))
  })}\n\`\`\`\n\n${done < steps.length ? `正在进行：${steps[done]}。` : "各阶段已完成。"}` }]
});
await writeFile(rollout, `${record("event_msg", { type: "task_started" })}\n${snapshot(0)}\n`);
const service = createService({ taskBoard: new TaskBoardStorage({ path: join(temporary, "board.json") }), codexSessions: new CodexSessions({ codexHome }) });
await service.methods.add({ threadId: id, title: "无计划工具的动态进度" }, { signal: new AbortController().signal });
const controllers = new Set();
let chrome;
let cdp;
const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end('<!doctype html><html><head><style>body{margin:0;padding:24px;background:#ededed}#host{width:332px;--cc-card-bg:#fff;--cc-card-fg:#1a1c1f}</style></head><body><div id="host"></div><script type="module" src="/page.js"></script></body></html>');
      return;
    }
    if (request.method === "GET" && request.url === "/page.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(await readFile(join(temporary, "page.js")));
      return;
    }
    if (request.method !== "POST" || request.url !== "/rpc") { response.writeHead(404).end(); return; }
    let body = "";
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 8192) { response.writeHead(413).end(); return; }
    }
    const { method, params } = JSON.parse(body);
    if (!["list", "watch", "trace"].includes(method)) { response.writeHead(400).end(); return; }
    const controller = new AbortController();
    controllers.add(controller);
    response.on("close", () => controller.abort());
    try {
      const data = await service.methods[method]({ ...params, ...(method === "watch" || method === "trace" ? { waitMs: 1000 } : {}) }, { signal: controller.signal });
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(data));
    } finally { controllers.delete(controller); }
  } catch (error) {
    if (!response.destroyed) response.writeHead(500).end(JSON.stringify({ error: error.message }));
  }
});
try {
  const fixture = join(temporary, "page.mjs");
  await writeFile(fixture, `
    import { mount } from ${JSON.stringify(join(root, "src/cards/tasks/renderer.mjs"))};
    import { createEffects } from ${JSON.stringify(join(root, "src/renderer/platform/effects.mjs"))};
    import { createOverlayLayer } from ${JSON.stringify(join(root, "src/renderer/shell/overlay-layer.mjs"))};
    const controller = new AbortController();
    globalThis.errors = [];
    const effects = createEffects({ signal: controller.signal, onError: error => errors.push(error.message) });
    globalThis.card = document.getElementById("host").attachShadow({ mode: "open" });
    const overlay = createOverlayLayer({ document, cardId: "tasks", effects });
    const rpc = async (method, params, options = {}) => {
      const response = await fetch("/rpc", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method, params }), signal: options.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      return result;
    };
    globalThis.handle = mount({ root: card, rpc, effects, signal: controller.signal, overlay, settings: { switcher: false }, isVisible: () => true });
    globalThis.cleanup = () => { handle.dispose(); controller.abort(); effects.dispose(); };
  `);
  await run(join(root, "node_modules/bun/bin/bun.exe"), ["build", fixture, "--target=browser", "--outfile", join(temporary, "page.js")]);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = await reserveLoopbackPort();
  chrome = spawn(process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--window-size=1280,900",
    "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`, `--user-data-dir=${join(temporary, "profile")}`, "about:blank"
  ], { stdio: "ignore" });
  let target;
  for (let attempt = 0; attempt < 100 && !target; attempt += 1) {
    try { target = (await listCdpTargets(port)).find(entry => entry.type === "page"); } catch {}
    if (!target) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(target);
  cdp = new CdpConnection(target.webSocketDebuggerUrl, { timeoutMs: 30000 });
  await cdp.connect();
  const evaluate = async expression => {
    const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.exception?.description);
    return result.result.value;
  };
  const wait = expression => evaluate(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => { if (${expression}) resolve(true); else if (Date.now() > deadline) reject(new Error("进度更新超时")); else setTimeout(poll, 20); };
    poll();
  })`);
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/` });
  await wait("globalThis.card?.querySelector('.progress-count')?.textContent === '0/3'");
  await appendFile(rollout, `${snapshot(1)}\n`);
  await wait("card.querySelector('.progress-count')?.textContent === '1/3' && card.querySelector('.meta .label:not(.out)')?.textContent === '验证动态进度'");
  assert.match(await evaluate("card.querySelector('.progress').title"), /助手进度消息/);
  await appendFile(rollout, `${snapshot(3, "user")}\n`);
  assert.equal((await service.methods.list({}, { signal: new AbortController().signal })).tasks[0].plan.done, 1);
  await appendFile(rollout, `${snapshot(2)}\n`);
  await wait("card.querySelector('.progress-count')?.textContent === '2/3'");
  const bounds = await evaluate("(() => { const bounds = card.querySelector('.name').getBoundingClientRect(); return { x: bounds.left + 20, y: bounds.top + bounds.height / 2 }; })()");
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...bounds });
  await wait("card.querySelectorAll('.plan-step').length === 3");
  assert.match(await evaluate("card.querySelector('.plan-head').title"), /来源：助手结构化进度消息/);
  assert.deepEqual(await evaluate("[...card.querySelectorAll('.plan-step')].map(step => step.dataset.status)"), ["completed", "completed", "in_progress"]);
  await appendFile(rollout, `${snapshot(3)}\n`);
  await wait("card.querySelector('.progress-count')?.textContent === '3/3'");
  assert.deepEqual(await evaluate("globalThis.errors"), []);
  await evaluate("cleanup()");
  console.log(JSON.stringify({ ok: true, progress: ["0/3", "1/3", "2/3", "3/3"], attachedCommentaryRecognized: true, currentStepUpdated: true, fullPlanInTrace: true, userMessageIgnored: true, updatePlanToolUsed: false, errors: [] }, null, 2));
} finally {
  cdp?.close();
  for (const controller of controllers) controller.abort();
  if (chrome && chrome.exitCode === null) {
    const exited = new Promise(resolve => chrome.once("exit", resolve));
    chrome.kill("SIGTERM");
    await exited;
  }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
