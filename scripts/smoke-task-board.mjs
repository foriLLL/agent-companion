import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { CdpConnection } from "../src/cdp-connection.mjs";
import { reserveLoopbackPort } from "../src/launcher.mjs";
import { listCdpTargets } from "../src/targets.mjs";

// 任务看板冒烟：独立临时 Chrome profile + 模拟的 Codex 侧栏，验证定位、自动展开、滚动、
// 指向动画、颜色标记、点击打开与 Option+Tab 切换。不访问用户 Codex 的 CDP 端口、配置或会话数据。
//   node scripts/smoke-task-board.mjs [--screenshot-dir <dir>]
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
const profile = await mkdtemp(path.join(os.tmpdir(), "companion-task-board-"));
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--window-size=1280,760",
  "--force-device-scale-factor=2",
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
  const evaluate = async (expression) => {
    const result = await connection.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
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
    const [{ createCodexThreads }, { mount }, { createEffects }, { createOverlayLayer }, { createAttentionLayer }] = await Promise.all([
      import(${JSON.stringify(await moduleUrl("src/renderer/adapters/codex-threads.mjs"))}),
      import(${JSON.stringify(await moduleUrl("src/cards/tasks/renderer.mjs"))}),
      import(${JSON.stringify(await moduleUrl("src/renderer/platform/effects.mjs"))}),
      import(${JSON.stringify(await moduleUrl("src/renderer/shell/overlay-layer.mjs"))}),
      import(${JSON.stringify(await moduleUrl("src/renderer/shell/attention-layer.mjs"))})
    ]);
    const id = (n) => '01a18216-3b02-7db0-b394-' + String(n).padStart(12, '0');
    globalThis.ids = { a3: id(3), a10: id(10), a24: id(24), b1: id(101), bHidden: id(105), s1: id(201) };
    const row = (n, title) => '<div class="row" data-app-action-sidebar-thread-row="" data-app-action-sidebar-thread-id="local:' + id(n) + '" data-app-action-sidebar-thread-kind="local" data-app-action-sidebar-thread-active="false" data-app-action-sidebar-thread-pinned="false" data-app-action-sidebar-thread-selected="false" data-app-action-sidebar-thread-title="' + title + '"><span data-thread-title>' + title + '</span></div>';
    const titles = ['修复登录页闪烁', '整理周报数据', '升级 hls.js', '接入任务看板', '排查代理超时', 'Emby 字幕偏移', '重构播放器状态机', '补齐 Windows 测试'];
    const rowsA = Array.from({ length: 25 }, (_, n) => row(n, n === 24 ? '发布 v0.2 检查清单' : titles[n % titles.length] + (n >= titles.length ? ' ' + n : ''))).join('');
    document.body.innerHTML = \`<style>
      :root{--bg:#fff;--side:#f7f7f7;--fg:#0d0d0d;--fg2:#8f8f8f;--line:#ececec;--active:rgba(0,0,0,.055);--card:#fff;--cardline:rgba(0,0,0,.08);color-scheme:light;
        --color-token-dropdown-background:#fff;--color-token-text-primary:#0d0d0d}
      :root[data-theme=dark]{--bg:#212121;--side:#181818;--fg:#ececec;--fg2:#8a8a8a;--line:#2a2a2a;--active:rgba(255,255,255,.07);--card:#2a2a2a;--cardline:rgba(255,255,255,.08);color-scheme:dark;
        --color-token-dropdown-background:#2f2f2f;--color-token-text-primary:#ececec;--color-token-border-heavy:rgba(255,255,255,.14)}
      html,body{margin:0;height:100%;font:13px/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;background:var(--bg);color:var(--fg);overflow:hidden;-webkit-font-smoothing:antialiased}
      nav{position:fixed;left:0;top:0;bottom:0;width:264px;background:var(--side);border-right:1px solid var(--line)}
      .brand{display:flex;align-items:center;gap:8px;height:48px;padding:0 18px;font-weight:600;font-size:14px}
      .newchat{margin:0 10px 6px;padding:7px 10px;border-radius:8px;color:var(--fg)}
      [data-app-action-sidebar-scroll]{position:absolute;inset:92px 0 0;overflow:auto;padding:0 10px 16px;scrollbar-width:none}
      .row{height:30px;display:flex;align-items:center;padding:0 10px 0 28px;border-radius:8px;cursor:pointer;white-space:nowrap;overflow:hidden}
      .row span{overflow:hidden;text-overflow:ellipsis}
      .row:hover{background:var(--active)}
      .row[data-app-action-sidebar-thread-active=true]{background:var(--active)}
      .project,.toggle{display:flex;align-items:center;gap:6px;height:30px;padding:0 10px;border:0;background:none;font:inherit;color:var(--fg2);cursor:pointer;width:100%;text-align:left}
      .project::before{content:"";width:13px;height:10px;border:1.4px solid currentColor;border-radius:2.5px;opacity:.8}
      .toggle{padding-left:28px;font-size:12px}
      main{position:fixed;left:265px;right:0;top:0;bottom:0}
      main header{height:48px;display:flex;align-items:center;padding:0 24px;font-weight:500;border-bottom:1px solid var(--line)}
      .msg{max-width:560px;margin:28px auto 0;padding:0 24px;color:var(--fg2);line-height:1.7}
      .msg p{margin:0 0 14px}.msg .user{margin-left:auto;width:fit-content;max-width:70%;padding:8px 14px;border-radius:18px;background:var(--active);color:var(--fg)}
      #composer{position:absolute;left:50%;bottom:24px;width:520px;height:56px;margin-left:-300px;padding:12px 14px;border:1px solid var(--line);border-radius:18px;font:inherit;color:var(--fg);background:var(--bg);resize:none}
      #companion{position:fixed;right:14px;top:60px;width:332px;background:var(--card);color:var(--fg);border-radius:18px;box-shadow:0 0 0 1px var(--cardline),0 8px 28px rgba(0,0,0,.08);--cc-card-bg:var(--card);--cc-card-fg:var(--fg)}
    </style>
    <nav id="app-shell-sidebar"><div class="brand">Codex</div><div class="newchat">＋ 新对话</div><div data-app-action-sidebar-scroll="">
      <div data-app-action-sidebar-section="" data-app-action-sidebar-section-collapsed="true" data-app-action-sidebar-section-heading="已置顶">
        <button class="project" data-app-action-sidebar-section-toggle="">已置顶</button></div>
      <div class="project" data-app-action-sidebar-project-row="" data-app-action-sidebar-project-id="/Users/me/projects/agent-companion" data-app-action-sidebar-project-label="agent-companion" data-app-action-sidebar-project-collapsed="false">agent-companion</div>
      <div data-app-action-sidebar-project-list-id="/Users/me/projects/agent-companion" data-app-action-sidebar-project-show-all="true">\${rowsA}</div>
      <div class="project" id="project-b" data-app-action-sidebar-project-row="" data-app-action-sidebar-project-id="/Users/me/projects/docs-site" data-app-action-sidebar-project-label="docs-site" data-app-action-sidebar-project-collapsed="true">docs-site</div>
    </div></nav><main><header>接入任务看板</header><div class="msg"><p class="user">帮我给 Companion 加一个任务看板卡片</p><p>好的，先梳理现有卡片平台的接口……</p></div><textarea id="composer" placeholder="要求后续变更"></textarea></main><div id="companion"></div>\`;
    // 模拟 React：异步提交展开结果，点击条目即切换当前会话。
    globalThis.clicks = [];
    globalThis.flowAtClick = [];
    document.addEventListener('click', (event) => {
      const thread = event.target.closest('[data-app-action-sidebar-thread-row]');
      if (thread) {
        clicks.push(thread.getAttribute('data-app-action-sidebar-thread-id'));
        // 模拟 Codex 打开会话时主线程被占住；此时落点动画必须已经交给合成器（WAAPI）。
        const flow = document.querySelector('.agent-companion-thread-flow');
        flowAtClick.push(flow ? flow.getAnimations({ subtree: true }).length : -1);
        const busyUntil = performance.now() + 300;
        while (performance.now() < busyUntil) {}
        for (const item of document.querySelectorAll('[data-app-action-sidebar-thread-active=true]')) item.setAttribute('data-app-action-sidebar-thread-active', 'false');
        thread.setAttribute('data-app-action-sidebar-thread-active', 'true');
        return;
      }
      const project = event.target.closest('#project-b[data-app-action-sidebar-project-collapsed=true]');
      if (project) setTimeout(() => {
        project.setAttribute('data-app-action-sidebar-project-collapsed', 'false');
        project.insertAdjacentHTML('afterend', '<div data-app-action-sidebar-project-list-id="/Users/me/projects/docs-site" data-app-action-sidebar-project-show-all="false">' + [101, 102, 103].map((n) => row(n, '整理发布说明 ' + n)).join('') + '<button class="toggle" data-app-action-sidebar-project-show-all-toggle="">显示全部</button></div>');
      }, 60);
      const showAll = event.target.closest('[data-app-action-sidebar-project-show-all-toggle]');
      if (showAll) setTimeout(() => {
        const list = showAll.parentElement;
        list.setAttribute('data-app-action-sidebar-project-show-all', 'true');
        showAll.insertAdjacentHTML('beforebegin', [104, 105].map((n) => row(n, n === 105 ? '评审设置页二期前端' : '旧会话 ' + n)).join(''));
        showAll.remove();
      }, 60);
      const section = event.target.closest('[data-app-action-sidebar-section-collapsed=true]');
      if (section) setTimeout(() => {
        section.setAttribute('data-app-action-sidebar-section-collapsed', 'false');
        section.insertAdjacentHTML('beforeend', row(201, '准备周五分享'));
      }, 60);
    });
    document.querySelector('[data-app-action-sidebar-thread-id="local:' + ids.a3 + '"]').setAttribute('data-app-action-sidebar-thread-active', 'true');

    // 内存版看板服务，语义与 src/cards/tasks/service.mjs 一致。
    globalThis.rpcCalls = [];
    let revision = 0, tasks = [];
    const statusOf = globalThis.statusOf = { [ids.a24]: 'running', [ids.bHidden]: 'asking', [ids.s1]: 'interrupted' };
    const ageOf = { [ids.a24]: 40e3, [ids.bHidden]: 2 * 3600e3, [ids.s1]: 3 * 86400e3, [ids.a10]: 25 * 60e3 };
    const started = Date.now();
    globalThis.activityOf = { [ids.a24]: '运行 npm test' };
    // 计划（Codex 自带 update_plan）：冒烟后段才给 a24 加上。
    globalThis.planOf = {};
    const summaryOf = { [ids.bHidden]: '要先合并 #482 还是先发预览？', [ids.a10]: '已升级到 1.6.2，播放冒烟通过', [ids.a3]: '看板已接入，等你确认样式' };
    // 长轮询：sig 没变就挂起，变了（或超时）再返回。
    let wake = null;
    globalThis.bump = () => { wake?.(); };
    const view = () => ({ revision, tasks: tasks.map((task) => {
      const updatedAt = started - (ageOf[task.threadId] ?? 6 * 60e3);
      const status = statusOf[task.threadId] ?? 'idle';
      return { ...task, name: task.customName ?? task.suggestedName ?? '未命名会话', status, updatedAt, turnAt: updatedAt, unread: status !== 'running' && updatedAt > task.seenAt,
        activity: status === 'running' ? activityOf[task.threadId] ?? '思考中' : null, summary: summaryOf[task.threadId] ?? null, plan: planOf[task.threadId] ?? null };
    }), sig: String(revision) + ':' + JSON.stringify(activityOf) + JSON.stringify(planOf) + JSON.stringify(statusOf) + tasks.map((task) => task.seenAt).join() });
    const pick = () => { const used = new Array(8).fill(0); for (const task of tasks) used[task.color] += 1; return used.indexOf(Math.min(...used)); };
    const methods = {
      list: () => view(),
      add: ({ threadId, title, projectId, seenAt }) => { if (!tasks.some((task) => task.threadId === threadId)) { tasks = [{ threadId, suggestedName: title, customName: null, color: pick(), projectId: projectId ?? null, addedAt: Date.now(), seenAt: seenAt ?? Date.now() }, ...tasks]; revision += 1; } return view(); },
      rename: ({ threadId, name }) => { const task = tasks.find((item) => item.threadId === threadId); task.customName = name; revision += 1; return view(); },
      remove: ({ threadId }) => { const index = tasks.findIndex((task) => task.threadId === threadId); const removed = { task: tasks[index], index }; tasks = tasks.toSpliced(index, 1); revision += 1; return { ...view(), removed }; },
      restore: ({ task, index }) => { tasks = tasks.toSpliced(index, 0, task); revision += 1; return view(); },
      recolor: ({ threadId, color }) => { tasks.find((task) => task.threadId === threadId).color = color; revision += 1; return view(); },
      seen: ({ threadId, at }) => { const task = tasks.find((item) => item.threadId === threadId); if (task.seenAt < at) { task.seenAt = at; revision += 1; } return view(); },
      open: () => ({ opened: true }),
      // 最近打开顺序：后台已存着一个看板外打不开的会话，页面接上后排在本页记下的之后。
      recent: () => ({ recent: [...storedRecent] }),
      visit: ({ threadId }) => { visits.push(threadId); storedRecent = [threadId, ...storedRecent.filter((id) => id !== threadId)]; return { recent: [...storedRecent] }; },
      // Trace：两个已结束的回合（一个以提问结束）和一个进行中的回合，最后一段还在长。
      trace: async ({ threadId, since }) => {
        if (since === 'trace-' + threadId + (globalThis.traceRevision ?? '')) await new Promise((resolve) => setTimeout(resolve, 2000));
        const now = Date.now();
        const s = 1000;
        const seg = (lane, kind, from, to, label, extra = {}) => ({ lane, kind, start: from, end: to, label, ...extra });
        const t1 = now - 31 * 60 * s;
        const t2 = now - 9 * 60 * s;
        const t3 = now - 70 * s;
        const turns = [
          { start: t1, end: t1 + 48 * s, status: 'done', asking: false, ttftMs: 2100, tokens: { input: 40000, output: 2100, reasoning: 800 }, segments: [
            seg('model', 'think', t1, t1 + 9 * s, '思考'), seg('model', 'call', t1 + 9 * s, t1 + 12 * s, '准备运行 git status', { tokens: { output: 420, reasoning: 300, perSecond: 35 } }),
            seg('shell', 'tool', t1 + 12 * s, t1 + 15 * s, '运行 git status', { failed: false }), seg('model', 'think', t1 + 15 * s, t1 + 30 * s, '思考'),
            seg('model', 'reply', t1 + 30 * s, t1 + 48 * s, '工作区干净，可以开始', { tokens: { output: 1680, reasoning: 500, perSecond: 51 } })] },
          { start: t2, end: t2 + 150 * s, status: 'done', asking: true, ttftMs: 1500, tokens: { input: 52000, output: 5200, reasoning: 2400 }, segments: [
            seg('model', 'think', t2, t2 + 14 * s, '思考'), seg('model', 'reply', t2 + 14 * s, t2 + 17 * s, '先跑一遍测试'),
            seg('model', 'call', t2 + 17 * s, t2 + 20 * s, '准备运行 npm test', { tokens: { output: 600, reasoning: 400, perSecond: 30 } }),
            seg('shell', 'tool', t2 + 20 * s, t2 + 62 * s, '运行 npm test', { failed: true }), seg('model', 'think', t2 + 62 * s, t2 + 80 * s, '思考'),
            seg('model', 'call', t2 + 80 * s, t2 + 101 * s, '准备修改 renderer.mjs', { tokens: { output: 2900, reasoning: 1300, perSecond: 74 } }),
            seg('edit', 'tool', t2 + 101 * s, t2 + 103 * s, '修改 renderer.mjs', { failed: false }),
            seg('agent', 'tool', t2 + 103 * s, t2 + 130 * s, '派出子代理', { failed: false }),
            seg('model', 'reply', t2 + 130 * s, t2 + 150 * s, '改好了，要我提交吗？', { tokens: { output: 1700, reasoning: 700, perSecond: 60 } })] },
          { start: t3, end: null, status: 'running', asking: false, ttftMs: null, tokens: { input: 61000, output: 900, reasoning: 300 }, segments: [
            seg('model', 'think', t3, t3 + 12 * s, '思考'), seg('model', 'call', t3 + 12 * s, t3 + 16 * s, '准备运行 npm run smoke', { tokens: { output: 900, reasoning: 300, perSecond: 56 } }),
            seg('shell', 'tool', t3 + 16 * s, t3 + 52 * s, '运行 npm run smoke', { failed: false }), seg('model', 'think', t3 + 52 * s, null, '思考中')],
            notes: [{ at: t3 + 5 * s, text: '先跑一遍冒烟，看看现在的状态' }, { at: t3 + 14 * s, text: '冒烟脚本在跑，等结果出来再决定改哪里' }] }
        ];
        // 计划：第 1 步在上一个回合做完，第 2 步跨回合，第 3 步正在做。
        const summary = planOf[threadId];
        const timings = [[t2 + 5 * s, t2 + 60 * s], [t2 + 60 * s, t3 + 20 * s], [t3 + 20 * s, null], [null, null]];
        const plan = summary ? { createdAt: t2 + 5 * s, updatedAt: t3 + 20 * s, explanation: '样式已改完，正在跑冒烟确认',
          steps: summary.steps.map((step, index) => ({ ...step, start: timings[index][0], end: timings[index][1] })) } : null;
        const data = { threadId, model: 'gpt-5.6-sol', contextWindow: 258400, turns, updatedAt: now, plan };
        return { ...data, sig: 'trace-' + threadId + (globalThis.traceRevision ?? ''), now };
      },
      watch: async ({ since, waitMs }) => {
        if (globalThis.failWatch > 0) { globalThis.failWatch -= 1; throw Object.assign(new Error('watch 请求超时'), { code: 'RPC_TIMEOUT' }); }
        if (view().sig === since) await new Promise((resolve) => { wake = resolve; setTimeout(resolve, Math.min(waitMs, 2000)); });
        return view();
      }
    };
    globalThis.storedRecent = ['01a18216-3b02-7db0-b394-999999999999'];
    globalThis.visits = [];
    globalThis.unsee = (id) => { tasks.find((task) => task.threadId === id).seenAt = 1; };
    globalThis.seed = (entries) => { for (const entry of entries) methods.add(entry); };
    const rpc = async (method, params = {}) => { rpcCalls.push(method); return structuredClone(await methods[method](params)); };

    globalThis.errors = [];
    globalThis.threads = createCodexThreads({ document, onError: (error) => errors.push(error.message) });
    const host = document.getElementById('companion');
    globalThis.card = host.attachShadow({ mode: 'open' });
    globalThis.controller = new AbortController();
    const effects = createEffects({ signal: controller.signal, onError: (error) => errors.push(error.message) });
    const overlay = createOverlayLayer({ document, cardId: 'tasks', effects });
    // 播放提醒：另一张卡片里放一个真实播放的视频（画布流），平台提醒层在卡片根上识别播放。
    const player = document.createElement('div');
    player.style.cssText = 'position:fixed;left:-400px;top:0;width:320px;height:180px';
    document.body.append(player);
    const playerRoot = player.attachShadow({ mode: 'open' });
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 36;
    const paint = canvas.getContext('2d');
    globalThis.frame = setInterval(() => { paint.fillStyle = 'hsl(' + (Date.now() / 10 % 360) + ',60%,50%)'; paint.fillRect(0, 0, 64, 36); }, 30);
    globalThis.video = document.createElement('video');
    video.muted = true;
    video.srcObject = canvas.captureStream(30);
    playerRoot.append(video);
    globalThis.layer = createAttentionLayer({ document, onError: (error) => errors.push(error.message), autoDismissMs: 500 });
    layer.observe(playerRoot);
    globalThis.visible = true;
    globalThis.handle = mount({ root: card, rpc, effects, signal: controller.signal, threads, overlay, attention: layer.forCard('tasks', effects),
      settings: {}, isVisible: () => globalThis.visible });
  })()`);

  const $ = (selector) => `card.querySelector(${JSON.stringify(selector)})`;
  const task = (key) => `card.querySelector('.task[data-id="' + ids.${key} + '"]')`;
  const marked = (key) => `document.querySelector('[data-app-action-sidebar-thread-id="local:' + ids.${key} + '"]')?.getAttribute('data-agent-companion-task')`;
  // 按浏览器实际配色合成透明背景，验证文字和撤销按钮可读，避免 currentColor 导致同色。
  const toastContrast = () => evaluate(`(() => {
    const toast = ${$(".toast")};
    const paint = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    paint.canvas.width = paint.canvas.height = 1;
    const luminance = (colors) => {
      paint.clearRect(0, 0, 1, 1);
      for (const color of colors) { paint.fillStyle = color; paint.fillRect(0, 0, 1, 1); }
      return [...paint.getImageData(0, 0, 1, 1).data].slice(0, 3).map((value) => {
        const srgb = value / 255;
        return srgb <= .04045 ? srgb / 12.92 : ((srgb + .055) / 1.055) ** 2.4;
      }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    };
    const layers = [getComputedStyle(card.host).backgroundColor, getComputedStyle(toast).backgroundColor];
    const background = luminance(layers);
    return [...toast.children].map((node) => {
      const foreground = luminance([...layers, getComputedStyle(node).color]);
      return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
    });
  })()`);

  await waitFor(`${$(".add b")}.textContent === '接入任务看板' && !${$(".add")}.hidden`, "当前会话标题");
  assert.equal(await evaluate(`${$(".empty")}.hidden`), false, "空看板提示");
  const emptyHeight = await evaluate(`card.host.getBoundingClientRect().height`);
  await screenshot("task-board-0-empty.png");
  await evaluate(`${$(".add")}.click()`);
  await waitFor(`${task("a3")} && ${$(".add")}.hidden`, "加入看板");
  assert.equal(await evaluate(marked("a3")), "0", "侧栏条目同色标记");
  assert.deepEqual(await evaluate(`threads.current()`), { id: await evaluate(`ids.a3`), title: "接入任务看板", projectId: "/Users/me/projects/agent-companion" });

  // 移出最后一项：提示仍可读、可以撤销，超时后收起且不留下空白条。
  await evaluate(`${task("a3")}.querySelector('[data-action=done]').click()`);
  await waitFor(`!${task("a3")} && !${$(".toast")}.hidden && !${$(".empty")}.hidden`, "移出最后一项后显示撤销提示");
  assert.equal(await evaluate(`${$(".toast span")}.textContent`), "已完成「接入任务看板」");
  for (const theme of ["light", "dark"]) {
    await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
    await screenshot(`task-board-undo-${theme}.png`);
    const contrast = await toastContrast();
    assert.ok(contrast.every((ratio) => ratio >= 4.5), `${theme} 完成提示与撤销按钮应清晰可读，实际对比度 ${contrast}`);
  }
  await evaluate(`delete document.documentElement.dataset.theme; ${$(".toast button")}.click()`);
  await waitFor(`${task("a3")} && ${$(".toast")}.hidden && ${marked("a3")} === '0'`, "撤销后恢复最后一项并收起提示");
  await evaluate(`${task("a3")}.querySelector('[data-action=done]').click()`);
  await waitFor(`!${task("a3")} && !${$(".toast")}.hidden`, "再次移出最后一项");
  await waitFor(`${$(".toast")}.hidden`, "完成提示到期自动收起", 8000);
  assert.equal(await evaluate(`card.host.getBoundingClientRect().height`), emptyHeight, "提示到期后恢复空看板高度");
  await evaluate(`${$(".add")}.click()`);
  await waitFor(`${task("a3")} && ${$(".add")}.hidden`, "重新加入看板");

  // React 重绘替换节点后，标记在下一帧补回。
  await evaluate(`(() => { const old = document.querySelector('[data-app-action-sidebar-thread-id="local:' + ids.a3 + '"]'); const fresh = old.cloneNode(true); fresh.removeAttribute('data-agent-companion-task'); old.replaceWith(fresh); })()`);
  await waitFor(`${marked("a3")} === '0'`, "重绘后补回标记");

  await evaluate(`seed([
    { threadId: ids.s1, title: '准备周五分享', projectId: null },
    { threadId: ids.a10, title: '升级 hls.js', projectId: '/Users/me/projects/agent-companion', seenAt: 1 },
    { threadId: ids.bHidden, title: '评审设置页二期前端', projectId: '/Users/me/projects/docs-site', seenAt: 1 },
    { threadId: ids.a24, title: '发布 v0.2 检查清单', projectId: '/Users/me/projects/agent-companion' }
  ]); handle.visibilityChanged({ visible: true })`);
  await waitFor(`card.querySelectorAll('.task').length === 5`, "刷新出 5 个任务");
  // 当前会话 a3 的新回复视为已读；需要人处理且没看过的排最前并跳动，其次是没看过的回复。
  await evaluate(`unsee(ids.a3); handle.visibilityChanged({ visible: true })`);
  await waitFor(`rpcCalls.includes('seen') && ${task("a3")}?.querySelector('.status').dataset.icon === 'reply'`, "停在当前会话即已读");
  assert.deepEqual(await evaluate(`[...card.querySelectorAll('.task')].map((item) => item.querySelector('.status').dataset.icon)`), ["ask", "unread", "alert", "spin", "reply"], "按需要处理的程度排序");
  assert.equal(await evaluate(`${task("bHidden")}.hasAttribute('data-hop')`), true, "没看过的提问会跳动");
  assert.equal(await evaluate(`${task("s1")}.hasAttribute('data-hop')`), false, "看过的中断不跳");
  assert.equal(await evaluate(`${task("a10")}.hasAttribute('data-shake')`), true, "没看过的新回复会摇晃");
  assert.equal(await evaluate(`${task("a3")}.hasAttribute('data-shake')`), false, "看过的回复不摇");
  assert.equal(await evaluate(`getComputedStyle(${task("a10")}).backgroundColor`), "rgba(0, 0, 0, 0)", "条目不铺任务色底");
  assert.notEqual(await evaluate(`getComputedStyle(${task("a10")}, '::before').backgroundColor`), "rgba(0, 0, 0, 0)", "任务色是最左侧的竖条");
  assert.equal(await evaluate(`getComputedStyle(${task("a10")}.querySelector('.status')).backgroundColor`), "rgba(0, 0, 0, 0)", "图标不铺底块");
  assert.equal(await evaluate(`${task("a10")}.querySelector('.when').textContent`), "25 分钟前", "时间在标题行右侧");
  assert.equal(await evaluate(`${task("a10")}.querySelector('.meta').textContent`), "已升级到 1.6.2，播放冒烟通过", "第二行是最后一句回复");
  // 用 offsetLeft 量：图标在摇晃（rotate），外框会随角度变宽。
  assert.equal(await evaluate(`(() => { const row = ${task("a10")}; return row.querySelector('.meta').offsetLeft - row.querySelector('.status').offsetLeft; })()`), 0, "第二行与图标左对齐");
  assert.equal(await evaluate(`card.querySelector('h2').children.length`), 0, "标题前没有图标");
  assert.equal(await evaluate(`${task("a24")}.querySelector('.meta .live')?.textContent`), "运行 npm test", "进行中显示当前动作");
  assert.equal(await evaluate(`${task("bHidden")}.querySelector('.tag')?.textContent`), "需要你");
  assert.deepEqual(await evaluate(`[...card.querySelectorAll('.chip')].map((chip) => chip.textContent)`), ["1 进行中", "2 需要你"]);
  // 实时：进度一变，原条目原地换文字（不重建），旧文字淡出、新文字浮入。
  await evaluate(`globalThis.liveNode = ${task("a24")}; activityOf[ids.a24] = '修改 renderer.mjs'; bump()`);
  await waitFor(`${task("a24")}.querySelector('.meta .label:not(.out)')?.textContent === '修改 renderer.mjs'`, "进度实时更新");
  assert.equal(await evaluate(`${task("a24")} === liveNode`), true, "条目节点被复用");
  await screenshot("task-board-1d-live.png");
  assert.equal(await evaluate(marked("a24")), "4");
  await evaluate(`(() => { for (const node of card.querySelectorAll('[data-hop], [data-hop] .status')) node.getAnimations().forEach((animation) => { animation.pause(); animation.currentTime = 3200 * 0.22; }); })()`);
  await screenshot("task-board-1b-hop.png");
  await evaluate(`card.querySelectorAll('[data-hop], [data-hop] .status').forEach((node) => node.getAnimations().forEach((animation) => { animation.currentTime = 3200 * 0.37; }))`);
  await screenshot("task-board-1c-knock.png");
  await evaluate(`card.querySelectorAll('[data-hop], [data-hop] .status').forEach((node) => node.getAnimations().forEach((animation) => { animation.currentTime = 0; animation.play(); }))`);
  await screenshot("task-board-1-light.png");
  await evaluate(`document.documentElement.dataset.theme = 'dark'`);
  await screenshot("task-board-2-dark.png");
  await evaluate(`delete document.documentElement.dataset.theme`);

  // Trace 浮层：悬停任务一会儿，在看板左侧弹出该会话的 Trace；进行中的最后一段随时间生长。
  const pointAt = async (expression) => {
    const { x, y } = await evaluate(`(() => { const rect = ${expression}.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`);
    await connection.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  };
  await pointAt(`${task("a3")}.querySelector('.name')`);
  await waitFor(`card.querySelector('.peek').matches(':popover-open') && card.querySelectorAll('.seg-bar').length === 18`, "悬停打开 Trace 浮层");
  // 内容画出来后浮层变高，ResizeObserver 在下一帧重新贴位置。
  await waitFor(`(() => { const peek = card.querySelector('.peek').getBoundingClientRect(); return peek.top >= 0 && peek.bottom <= innerHeight; })()`, "浮层重新贴位置");
  assert.deepEqual(await evaluate(`(() => {
    const peek = card.querySelector('.peek').getBoundingClientRect();
    const board = document.getElementById('companion').getBoundingClientRect();
    return { leftOfBoard: peek.right <= board.left, wide: peek.width >= 600, inView: peek.top >= 0 && peek.bottom <= innerHeight, title: card.querySelector('.trace-title')?.textContent };
  })()`), { leftOfBoard: true, wide: true, inView: true, title: "接入任务看板" }, "浮层在看板左侧、足够宽、不出窗口");
  assert.deepEqual(await evaluate(`[...card.querySelectorAll('.tl-lane')].map((lane) => lane.dataset.lane)`), ["model", "shell", "edit", "agent", "you"]);
  assert.equal(await evaluate(`card.querySelectorAll('.seg-bar[data-failed]').length`), 1, "失败的工具标红");
  assert.equal(await evaluate(`card.querySelectorAll('.needs').length`), 1, "以提问结束的回合标出「需要你」");
  const grow = await evaluate(`(async () => { const bar = card.querySelector('.seg-bar[data-live]'); const before = bar.getBoundingClientRect().width; await new Promise((r) => setTimeout(r, 1200)); return [before, bar.getBoundingClientRect().width, card.querySelector('.trace-live').textContent]; })()`);
  assert.ok(grow[1] > grow[0], "进行中的段向右生长");
  assert.match(grow[2], /^思考 \d+(\.\d)?s$/);
  assert.equal(await evaluate(`(() => { const box = card.querySelector('.tl-scroll'); return box.scrollLeft + box.clientWidth >= box.scrollWidth - 2; })()`), true, "默认跟随最新进度");
  await screenshot("task-board-3-trace-light.png");
  await evaluate(`document.documentElement.dataset.theme = 'dark'`);
  await screenshot("task-board-4-trace-dark.png");
  await evaluate(`delete document.documentElement.dataset.theme`);
  // 鼠标移进浮层不关；移到别的任务直接切换；移出后关闭。
  await pointAt(`card.querySelector('.tl-scroll')`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(await evaluate(`card.querySelector('.peek').matches(':popover-open')`), true, "移进浮层保持打开");
  await evaluate(`card.querySelector('.tl-scroll').scrollLeft = 0`);
  await screenshot("task-board-5-trace-scrolled.png");
  // 新数据到来会重建时间轴：翻看到中间时位置不变；正在滚动时等停下再重建，不打断手势。
  await evaluate(`(() => { const box = card.querySelector('.tl-scroll'); box.scrollLeft = Math.round((box.scrollWidth - box.clientWidth) / 2); globalThis.oldScroll = box; globalThis.middleLeft = box.scrollLeft; globalThis.traceRevision = 1; })()`);
  await waitFor(`card.querySelector('.tl-scroll') !== oldScroll`, "新 Trace 数据未重建");
  assert.equal(await evaluate(`Math.abs(card.querySelector('.tl-scroll').scrollLeft - middleLeft) <= 1`), true, "重建后保持翻看位置");
  const settle = await evaluate(`(async () => {
    const box = card.querySelector('.tl-scroll');
    globalThis.traceRevision = 2;
    const until = Date.now() + 2600;
    while (Date.now() < until) { box.dispatchEvent(new WheelEvent('wheel', { deltaX: 1, bubbles: true })); await new Promise((r) => setTimeout(r, 100)); }
    const kept = card.querySelector('.tl-scroll') === box;
    const start = Date.now();
    while (card.querySelector('.tl-scroll') === box && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 20));
    return { kept, redrawn: card.querySelector('.tl-scroll') !== box };
  })()`);
  assert.deepEqual(settle, { kept: true, redrawn: true }, "滚动中不重建，停下后再画");
  // 没列计划：计划区退回本回合的进度说明。
  assert.deepEqual(await evaluate(`[...card.querySelectorAll('.plan[data-inferred] .plan-text')].map((node) => node.textContent)`),
    ["先跑一遍冒烟，看看现在的状态", "冒烟脚本在跑，等结果出来再决定改哪里"], "没列计划时按进度说明推断");
  // Codex 列了计划：条目第二行换成正在做的那一步，下面一条按步分格的进度条。
  await evaluate(`planOf[ids.a24] = { total: 4, done: 2, active: 2, steps: [
    { text: '梳理现有看板卡片结构', status: 'completed' }, { text: '改条目样式与配色', status: 'completed' },
    { text: '跑冒烟并截图确认', status: 'in_progress' }, { text: '整理改动说明', status: 'pending' }] }; bump()`);
  await waitFor(`${task("a24")}.querySelector('.progress-count')?.textContent === '2/4'`, "条目显示计划进度");
  assert.deepEqual(await evaluate(`[...${task("a24")}.querySelectorAll('.progress-bar i')].map((cell) => cell.dataset.status)`), ["completed", "completed", "in_progress", "pending"]);
  await waitFor(`${task("a24")}.querySelector('.meta .label:not(.out)')?.textContent === '跑冒烟并截图确认'`, "第二行显示正在做的那一步");
  assert.equal(await evaluate(`(() => { const row = ${task("a24")}; return row.querySelector('.progress').offsetLeft - row.querySelector('.status').offsetLeft; })()`), 0, "进度条与图标左对齐");
  await screenshot("task-board-6-plan-row.png");
  await pointAt(`${task("a24")}.querySelector('.name')`);
  await waitFor(`card.querySelector('.trace-title')?.textContent === ${task("a24")}.querySelector('.name').textContent && ${task("a24")}.hasAttribute('data-peek')`, "移到别的任务直接切换");
  await waitFor(`card.querySelectorAll('.plan-step').length === 4`, "Trace 显示计划");
  assert.deepEqual(await evaluate(`[...card.querySelectorAll('.tl-lane')].map((lane) => lane.dataset.lane)`), ["plan", "model", "shell", "edit", "agent", "you"], "计划泳道在最上面");
  assert.equal(await evaluate(`card.querySelectorAll('.seg-bar[data-kind=step]').length`), 3, "有起点的步骤画成段");
  assert.equal(await evaluate(`card.querySelectorAll('.seg-bar[data-kind=step][data-live]').length`), 1, "进行中的步骤在生长");
  assert.match(await evaluate(`card.querySelector('.plan-head').textContent`), /^计划第 3\/4 步已用 \d+m \d+s$/);
  assert.equal(await evaluate(`(() => { const link = card.querySelector('.tl-link'); const model = card.querySelectorAll('.tl-row')[1].getBoundingClientRect(); return Math.round(link.getBoundingClientRect().top - model.top); })()`), 29, "工具连线从模型泳道出发");
  await screenshot("task-board-7-plan-trace-light.png");
  await evaluate(`document.documentElement.dataset.theme = 'dark'`);
  await screenshot("task-board-8-plan-trace-dark.png");
  await evaluate(`delete document.documentElement.dataset.theme`);
  await connection.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 600, y: 700 });
  await waitFor(`!card.querySelector('.peek').matches(':popover-open') && !card.querySelector('[data-peek]')`, "移出后关闭浮层");

  // 底部条目：先滚动到可视，再播放指向动画，最后打开。
  await evaluate(`document.querySelector('[data-app-action-sidebar-scroll]').scrollTop = 0`);
  assert.equal(await evaluate(`(() => { const rect = document.querySelector('[data-app-action-sidebar-thread-id="local:' + ids.a24 + '"]').getBoundingClientRect(); return rect.top < innerHeight; })()`), false, "目标初始不在可视区");
  // 对照：没有指向动画时（看板里的跳动、转圈照常）的帧间隔。
  const idleFrames = await evaluate(`new Promise((resolve) => { const list = []; let last = performance.now(); const tick = (now) => { list.push(now - last); last = now; if (list.length < 40) requestAnimationFrame(tick); else { const gaps = list.slice(1); resolve({ max: Math.round(Math.max(...gaps)), avg: Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length * 10) / 10 }); } }; requestAnimationFrame(tick); })`);
  const measureIdle = `new Promise((resolve) => { const list = []; let last = performance.now(); const tick = (now) => { list.push(now - last); last = now; if (list.length < 40) requestAnimationFrame(tick); else { const gaps = list.slice(1); resolve(Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length * 10) / 10); } }; requestAnimationFrame(tick); })`;
  await evaluate(`card.getAnimations().forEach((animation) => animation.pause())`);
  const pausedAvg = await evaluate(measureIdle);
  await evaluate(`card.getAnimations().forEach((animation) => animation.play())`);
  idleFrames.pausedAvg = pausedAvg;
  // 记录动画期间的帧间隔，用来发现掉帧。
  await evaluate(`(() => { globalThis.frames = []; let last = performance.now(); const tick = (now) => { frames.push(now - last); last = now; if (frames.length < 120) requestAnimationFrame(tick); }; requestAnimationFrame(tick); })()`);
  await evaluate(`${task("a24")}.querySelector('.main').click()`);
  await waitFor(`document.querySelectorAll('.agent-companion-thread-flow').length === 1`, "动画开始");
  const scrolledFirst = await evaluate(`(() => { const rect = document.querySelector('[data-app-action-sidebar-thread-id="local:' + ids.a24 + '"]').getBoundingClientRect(); const box = document.querySelector('[data-app-action-sidebar-scroll]').getBoundingClientRect(); return rect.top >= box.top && rect.bottom <= box.bottom; })()`);
  assert.equal(scrolledFirst, true, "动画开始前目标已完整可见");
  await new Promise((resolve) => setTimeout(resolve, 60));
  await screenshot("task-board-3-flow.png");
  await screenshot("task-board-4-landing.png");
  await waitFor(`threads.current()?.id === ids.a24 && !document.querySelector('.agent-companion-thread-flow')`, "动画结束并打开会话");
  assert.ok(await evaluate(`flowAtClick.at(-1) >= 3`), "打开会话时落点铺开、液流淡出、整体淡出都已交给 WAAPI");
  const frameStats = await evaluate(`(() => { const list = frames.slice(1, 40); return { max: Math.round(Math.max(...list)), avg: Math.round(list.reduce((a, b) => a + b, 0) / list.length * 10) / 10, slow: list.filter((gap) => gap > 25).length }; })()`);

  // 折叠项目 + 「显示全部」：按加入时记录的项目精确展开。
  await evaluate(`${task("bHidden")}.querySelector('.main').click()`);
  // 展开会改侧栏、触发看板重绘，起点节点被替换后动画仍要播放。
  await waitFor(`document.querySelectorAll('.agent-companion-thread-flow').length === 1`, "展开项目后播放动画", 6000);
  await waitFor(`threads.current()?.id === ids.bHidden`, "展开折叠项目并打开", 6000);
  assert.equal(await evaluate(`document.getElementById('project-b').getAttribute('data-app-action-sidebar-project-collapsed')`), "false");
  assert.equal(await evaluate(marked("bHidden")), "3", "新出现的条目同样被标记");
  // 没有项目信息时展开折叠分区。
  await evaluate(`${task("s1")}.querySelector('.main').click()`);
  await waitFor(`document.querySelectorAll('.agent-companion-thread-flow').length === 1`, "展开分区后播放动画", 6000);
  await waitFor(`threads.current()?.id === ids.s1`, "展开折叠分区并打开", 6000);
  await screenshot("task-board-5-opened.png");

  // 侧栏找不到时回退到深链。
  await evaluate(`seed([{ threadId: '01a18216-3b02-7db0-b394-999999999999', title: '已不在列表中的会话' }]); handle.visibilityChanged({ visible: true })`);
  await waitFor(`card.querySelectorAll('.task').length === 6`, "加入不在侧栏的会话");
  assert.equal(await evaluate(`card.querySelector('.task[data-id="01a18216-3b02-7db0-b394-999999999999"] .meta').textContent`), "已回复", "没有回复内容时第二行写状态");
  await evaluate(`card.querySelector('.task[data-id="01a18216-3b02-7db0-b394-999999999999"] .main').click()`);
  await waitFor(`rpcCalls.includes('open')`, "回退深链", 8000);

  // Option+Tab：照 ⌘Tab，按最近打开的顺序在看板会话间切换。到这里依次打开过 a3、a24、bHidden、s1。
  const ALT = 1;
  const SHIFT = 8;
  const key = (type, name, code, keyCode, modifiers, text) => connection.send("Input.dispatchKeyEvent", {
    type, key: name, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers, ...(text ? { text, unmodifiedText: text } : {})
  });
  const altDown = () => key("rawKeyDown", "Alt", "AltLeft", 18, ALT);
  const altUp = () => key("keyUp", "Alt", "AltLeft", 18, 0);
  const tab = async (modifiers = ALT) => { await key("rawKeyDown", "Tab", "Tab", 9, modifiers); await key("keyUp", "Tab", "Tab", 9, modifiers); };
  const layer = `document.getElementById('agent-companion-overlay-tasks')?.shadowRoot`;
  const panelOpen = `Boolean(${layer}?.querySelector('.backdrop:not([hidden])'))`;
  const switchRows = `[...${layer}.querySelectorAll('.item')].map((item) => Object.keys(ids).find((name) => ids[name] === item.dataset.id) ?? 'other')`;
  const switchSelected = `Object.keys(ids).find((name) => ids[name] === ${layer}?.querySelector('.item[aria-selected=true]')?.dataset.id)`;
  await evaluate(`(() => { const box = document.getElementById('composer'); box.value = ''; box.focus(); })()`);
  assert.equal(await evaluate(`threads.current()?.id === ids.s1`), true);

  // 快速点按：不弹面板，直接回到上一个会话。
  await altDown();
  await tab();
  await altUp();
  await waitFor(`threads.current()?.id === ids.bHidden`, "快速点按回到上一个会话", 6000);
  assert.equal(await evaluate(panelOpen), false, "快速点按不弹面板");

  // 按住：面板列出看板会话（最近打开的在前），默认选中上一个；连按 Tab 往下选，松开切过去。
  await altDown();
  await tab();
  await waitFor(panelOpen, "按住 Option 后弹出切换面板");
  assert.deepEqual(await evaluate(switchRows), ["bHidden", "s1", "a24", "a3", "other", "a10"], "最近打开的在前（接上后台存的），没打开过的按看板顺序");
  assert.equal(await evaluate(switchSelected), "s1");
  assert.equal(await evaluate(`${layer}.querySelector('.item[aria-selected=true] .name').textContent`), "准备周五分享");
  await tab();
  assert.equal(await evaluate(switchSelected), "a24");
  await tab(ALT | SHIFT);
  await tab();
  assert.equal(await evaluate(switchSelected), "a24", "Shift+Tab 反向");
  // 面板期间的按键不进输入框：Tab 不移焦点，Option+A 不打出 å。
  await key("keyDown", "å", "KeyA", 65, ALT, "å");
  await key("keyUp", "å", "KeyA", 65, ALT);
  assert.deepEqual(await evaluate(`(() => { const box = document.getElementById('composer'); return { value: box.value, focused: document.activeElement === box }; })()`), { value: "", focused: true });
  assert.deepEqual(await evaluate(`(() => {
    const panel = ${layer}.querySelector('.panel').getBoundingClientRect();
    return { centered: Math.abs(panel.left + panel.width / 2 - innerWidth / 2) < 2, inView: panel.top >= 0 && panel.bottom <= innerHeight, bg: getComputedStyle(${layer}.querySelector('.panel')).backgroundColor };
  })()`), { centered: true, inView: true, bg: "rgb(255, 255, 255)" }, "面板居中、不出窗口、用 Codex 的浮层底色");
  await screenshot("task-board-8-switcher.png");
  await evaluate(`document.documentElement.dataset.theme = 'dark'`);
  await connection.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await screenshot("task-board-9-switcher-dark.png");
  await connection.send("Emulation.setEmulatedMedia", { features: [] });
  await evaluate(`delete document.documentElement.dataset.theme`);
  await altUp();
  await waitFor(`threads.current()?.id === ids.a24 && !${panelOpen}`, "松开 Option 切到选中的会话", 6000);

  // Esc 取消：松开 Option 后不切换。
  await altDown();
  await tab();
  await waitFor(panelOpen, "再次弹出面板");
  assert.equal(await evaluate(switchSelected), "bHidden", "a24 成了当前，上一个是 bHidden");
  await key("rawKeyDown", "Escape", "Escape", 27, ALT);
  await key("keyUp", "Escape", "Escape", 27, ALT);
  assert.equal(await evaluate(panelOpen), false, "Esc 关闭面板");
  await altUp();
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(await evaluate(`threads.current()?.id === ids.a24`), true, "Esc 后不切换");

  // 抽屉收起（卡片整块隐藏）时照样能弹出；鼠标移到条目上改选中，点一下直接切过去。
  await evaluate(`document.getElementById('companion').style.display = 'none'`);
  await altDown();
  await tab();
  await waitFor(panelOpen, "抽屉收起时也能弹出面板");
  assert.deepEqual(await evaluate(switchRows), ["a24", "bHidden", "s1", "a3", "other", "a10"]);
  assert.equal(await evaluate(switchSelected), "bHidden", "鼠标没动时不改选中");
  await pointAt(`${layer}.querySelectorAll('.item')[2]`);
  await waitFor(`${switchSelected} === 's1'`, "鼠标移到条目上改选中");
  const target = await evaluate(`(() => { const rect = ${layer}.querySelectorAll('.item')[2].getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`);
  await connection.send("Input.dispatchMouseEvent", { type: "mousePressed", ...target, button: "left", clickCount: 1, modifiers: ALT });
  await connection.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...target, button: "left", clickCount: 1, modifiers: ALT });
  await waitFor(`threads.current()?.id === ids.s1 && !${panelOpen}`, "点击条目直接切换", 6000);
  await altUp();
  await connection.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 600, y: 700 });
  await evaluate(`document.getElementById('companion').style.display = ''`);

  // 设置里关掉后不再拦截 Option+Tab。
  await evaluate(`handle.updateSettings({ switcher: false })`);
  await altDown();
  await tab();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await evaluate(panelOpen), false, "关闭后不弹面板");
  await altUp();
  assert.equal(await evaluate(`threads.current()?.id === ids.s1`), true, "关闭后不切换");
  await evaluate(`handle.updateSettings({})`);
  assert.ok(await evaluate(`['a3', 'a24', 'bHidden', 's1'].every((name) => visits.includes(ids[name]))`), "每次打开都记到后台");
  const current = () => evaluate(`Object.keys(ids).find((name) => ids[name] === threads.current()?.id)`);
  const press = async (name, code, keyCode, modifiers = ALT) => { await key("rawKeyDown", name, code, keyCode, modifiers); await key("keyUp", name, code, keyCode, modifiers); };
  const footer = `${layer}.querySelector('footer').textContent`;

  // 数字键直达；面板里也显示计划进度。
  await altDown();
  await tab();
  await waitFor(panelOpen, "弹出面板（数字键）");
  assert.deepEqual(await evaluate(switchRows), ["s1", "a24", "bHidden", "a3", "other", "a10"]);
  assert.deepEqual(await evaluate(`[...${layer}.querySelectorAll('.item .key')].map((key) => key.textContent)`), ["1", "2", "3", "4", "5", "6"]);
  assert.equal(await evaluate(`${layer}.querySelector('.item[data-id="' + ids.a24 + '"] .progress-count')?.textContent`), "2/4", "面板里也显示计划进度");
  assert.equal(await evaluate(footer), "⌥ 松开切换⇧Tab 反向1–9 直达W 移出看板Esc 取消");
  await screenshot("task-board-10-switcher-keys.png");
  await press("£", "Digit3", 51);
  await waitFor(`threads.current()?.id === ids.bHidden && !${panelOpen}`, "数字键直达第 3 个", 6000);
  await altUp();

  // 面板里 W 移出选中的会话、Z 撤销，面板一直开着；底部换成一句说明。
  await altDown();
  await tab();
  await waitFor(panelOpen, "弹出面板（移出）");
  assert.deepEqual(await evaluate(switchRows), ["bHidden", "s1", "a24", "a3", "other", "a10"]);
  assert.equal(await evaluate(switchSelected), "s1");
  await press("∑", "KeyW", 87);
  await waitFor(`!${task("s1")} && ${footer} === '已移出「准备周五分享」，按 Z 撤销'`, "W 移出选中的会话");
  assert.equal(await evaluate(panelOpen), true, "移出后面板还开着");
  assert.equal(await evaluate(switchSelected), "a24", "选中顺延到下一个");
  await screenshot("task-board-11-switcher-removed.png");
  await press("Ω", "KeyZ", 90);
  await waitFor(`${task("s1")} && ${footer} === '已放回「准备周五分享」' && ${switchRows}.at(-1) === 's1'`, "Z 撤销，放回的排在面板最后");
  await press("Escape", "Escape", 27);
  await altUp();
  assert.equal(await current(), "bHidden", "取消后不切换");

  // ⌥J：按看板顺序跳到需要你处理的会话（先是没看过的新结果，再是看过但还在等你的），当前会话除外；没有时提示一句。
  const jump = async () => { await altDown(); await press("∆", "KeyJ", 74); await altUp(); };
  await jump();
  await waitFor(`threads.current()?.id === ids.a10`, "⌥J 先到没看过的新回复", 6000);
  await jump();
  await waitFor(`threads.current()?.id === ids.bHidden || threads.current()?.id === ids.s1`, "再到等你处理的会话", 6000);
  const firstWaiting = await current();
  await jump();
  await waitFor(`threads.current()?.id === ids.${firstWaiting === "bHidden" ? "s1" : "bHidden"}`, "当前会话除外，跳到另一个", 6000);
  const lastWaiting = await current();
  assert.equal(await evaluate(`document.getElementById('composer').value`), "", "⌥J 不打出 ∆");
  await evaluate(`statusOf[ids.bHidden] = 'running'; statusOf[ids.s1] = 'running'; bump()`);
  await jump();
  const flash = `${layer}.querySelector('.flash')`;
  await waitFor(`${flash} && !${flash}.hidden && ${flash}.textContent === '没有需要你处理的会话'`, "没有需要处理的会话时提示");
  assert.equal(await current(), lastWaiting, "没有时不切换");
  await screenshot("task-board-12-jump-none.png");
  await waitFor(`${flash}.hidden`, "提示自动收起");
  await evaluate(`statusOf[ids.bHidden] = 'asking'; statusOf[ids.s1] = 'interrupted'; bump()`);

  // 切换键改成 Control：⌥Tab 交还 Codex，⌃Tab 快速点按回到上一个会话。
  await evaluate(`handle.updateSettings({ switcherKey: 'ctrl' })`);
  await altDown();
  await tab();
  await altUp();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await current(), lastWaiting, "Option+Tab 不再切换");
  const CTRL = 2;
  await key("rawKeyDown", "Control", "ControlLeft", 17, CTRL);
  await tab(CTRL);
  await key("keyUp", "Control", "ControlLeft", 17, 0);
  await waitFor(`threads.current()?.id === ids.${firstWaiting}`, "⌃Tab 回到上一个会话", 6000);
  await evaluate(`handle.updateSettings({})`);

  // 看板外的会话：缺省不列，打开它后快速点按回到看板上最近的会话；打开设置后能切回来，面板里标出「不在看板」。
  await evaluate(`ids.out5 = '01a18216-3b02-7db0-b394-000000000005'; document.querySelector('[data-app-action-sidebar-thread-id="local:' + ids.out5 + '"]').click()`);
  await waitFor(`threads.current()?.id === ids.out5`, "打开看板外的会话");
  await waitFor(`visits.at(-1) === ids.out5`, "看板外的会话也记到后台");
  await altDown();
  await tab();
  await altUp();
  await waitFor(`threads.current()?.id === ids.${firstWaiting}`, "不列看板外时回到看板上最近的会话", 6000);
  await evaluate(`handle.updateSettings({ switcherAll: true })`);
  await altDown();
  await tab();
  await waitFor(panelOpen, "弹出面板（看板外）");
  assert.deepEqual((await evaluate(switchRows)).slice(0, 2), [firstWaiting, "out5"]);
  assert.deepEqual(await evaluate(`(() => { const item = ${layer}.querySelector('.item[data-id="' + ids.out5 + '"]'); return [item.hasAttribute('data-outside'), item.querySelector('.name').textContent, item.querySelector('.meta').textContent]; })()`),
    [true, "Emby 字幕偏移", "agent-companion · 不在看板"]);
  await screenshot("task-board-13-switcher-outside.png");
  await altUp();
  await waitFor(`threads.current()?.id === ids.out5 && !${panelOpen}`, "切回看板外的会话", 6000);

  // 找不到记录的会话切过去也打不开，不列。
  await evaluate(`statusOf['01a18216-3b02-7db0-b394-999999999999'] = 'missing'; bump()`);
  await waitFor(`card.querySelector('.task[data-id="01a18216-3b02-7db0-b394-999999999999"] .status')?.dataset.icon === 'gone'`, "看板显示找不到记录");
  await altDown();
  await tab();
  await waitFor(panelOpen, "弹出面板（找不到记录）");
  assert.equal((await evaluate(switchRows)).includes("other"), false, "找不到记录的不列");
  await press("Escape", "Escape", 27);
  await altUp();
  await evaluate(`delete statusOf['01a18216-3b02-7db0-b394-999999999999']; handle.updateSettings({}); bump()`);
  // 三个都看过、还在等你的会话：连按 ⌥J 依次轮一圈，不在头两个之间来回。
  await evaluate(`statusOf[ids.a3] = 'asking'; bump()`);
  const round = [];
  for (let step = 0; step < 4; step += 1) {
    const before = await current();
    await jump();
    await waitFor(`Object.keys(ids).find((name) => ids[name] === threads.current()?.id) !== ${before === undefined ? "undefined" : JSON.stringify(before)}`, `⌥J 第 ${step + 1} 次跳转`, 6000);
    round.push(await current());
  }
  assert.deepEqual(round.slice(1).toSorted(), ["a3", "bHidden", "s1"], "三个等你处理的会话轮流到");
  await evaluate(`delete statusOf[ids.a3]; bump()`);
  // 回到看板会话，后面的用例从这里接着走。
  await evaluate(`document.querySelector('[data-app-action-sidebar-thread-id="local:' + ids.s1 + '"]').click()`);
  await waitFor(`threads.current()?.id === ids.s1`, "回到 s1");

  // 改名：默认推荐名，可改，留空回到推荐名。
  await evaluate(`${task("a3")}.querySelectorAll('.icon')[1].click()`);
  await waitFor(`${task("a3")}.querySelector('input')`, "进入改名");
  await evaluate(`(() => { const input = ${task("a3")}.querySelector('input'); input.value = '任务看板：着色与跳转'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await waitFor(`${task("a3")}.querySelector('.name')?.textContent === '任务看板：着色与跳转'`, "改名生效");
  await evaluate(`${task("a3")}.querySelectorAll('.icon')[1].click()`);
  await waitFor(`${task("a3")}.querySelector('input')`, "再次改名");
  await evaluate(`(() => { const input = ${task("a3")}.querySelector('input'); input.value = ''; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await waitFor(`${task("a3")}.querySelector('.name')?.textContent === '接入任务看板'`, "留空回到推荐名");

  // 换颜色：色板选深靛，条目底色随任务色，侧栏标记同步。
  await evaluate(`${task("a24")}.querySelectorAll('.icon')[0].click()`);
  await waitFor(`${task("a24")}?.querySelectorAll('.palette button').length === 8`, "打开色板");
  await screenshot("task-board-6-palette.png");
  await evaluate(`${task("a24")}.querySelectorAll('.palette button')[7].click()`);
  await waitFor(`${marked("a24")} === '7' && !card.querySelector('.palette')`, "换成深靛");
  assert.equal(await evaluate(`${task("a24")}.style.getPropertyValue('--task')`), "#3f3ca8", "条目底色取任务色");
  await screenshot("task-board-7-deep.png");

  // 完成即移出，可撤销。
  await evaluate(`${task("s1")}.querySelectorAll('.icon')[2].click()`);
  await waitFor(`!${task("s1")} && !${$(".toast")}.hidden`, "完成后移出");
  assert.equal(await evaluate(marked("s1")), null, "移出后撤销侧栏标记");
  await evaluate(`${$(".toast button")}.click()`);
  await waitFor(`${task("s1")} && ${marked("s1")} === '1'`, "撤销后放回原位");

  // 会话在 Codex 里归档：自动移出并提示，可撤销；撤销放回的不再自动移出。
  // 会话名是整段首条消息时，提示只留开头几个字，不铺成一整条。
  const renameS1 = (title) => evaluate(`(() => {
    const row = document.querySelector('[data-app-action-sidebar-thread-id="local:' + ids.s1 + '"]');
    row.setAttribute('data-app-action-sidebar-thread-title', ${JSON.stringify(title)});
    row.querySelector('[data-thread-title]').textContent = ${JSON.stringify(title)};
  })()`);
  await renameS1("帮我排查一下为什么线上接口一启动就连不上数据库，\n对照几个环境之后给出修复方案并验证");
  await evaluate(`statusOf[ids.s1] = 'archived'; bump()`);
  await waitFor(`!${task("s1")} && !${$(".toast")}.hidden && ${$(".toast span")}.textContent.startsWith('已归档「')`, "归档后自动移出");
  assert.equal(await evaluate(marked("s1")), null, "归档移出后撤销侧栏标记");
  assert.equal(await evaluate(`${$(".toast span")}.textContent`), "已归档「帮我排查一下为什么线…」", "长会话名截短");
  assert.ok(await evaluate(`Boolean(${$(".toast .glyph svg")})`), "归档提示带图标");
  for (const theme of ["light", "dark"]) {
    await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
    await screenshot(`task-board-8-archived-${theme}.png`);
    const contrast = await toastContrast();
    assert.ok(contrast.every((ratio) => ratio >= 4.5), `${theme} 归档提示应清晰可读，实际对比度 ${contrast}`);
  }
  await evaluate(`delete document.documentElement.dataset.theme; ${$(".toast button")}.click()`);
  await waitFor(`${task("s1")} && ${marked("s1")} === '1'`, "撤销后放回原位");
  await renameS1("准备周五分享");
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.ok(await evaluate(`Boolean(${task("s1")})`), "撤销放回的归档任务不再被自动移出");
  // 自己点停止：灰色「已停止」，没有「已中断」标签。
  await evaluate(`statusOf[ids.s1] = 'stopped'; bump()`);
  await waitFor(`${task("s1")}?.querySelector('.status')?.dataset.icon === 'stopped'`, "自己停止显示已停止");
  assert.equal(await evaluate(`${task("s1")}.querySelector('.tag')`), null, "已停止不带需要你处理的标签");
  await screenshot("task-board-9-stopped.png");
  await evaluate(`statusOf[ids.s1] = 'interrupted'; bump()`);

  // 长轮询超时（收不到后台回包）：提示正在重连，下一次同步成功后自动消失，不残留。
  await evaluate(`globalThis.failWatch = 1`);
  // 空闲时一轮长轮询最长约 5 秒（挂起 2 秒 + 重试间隔 3 秒），下一次 watch 才会失败。
  await waitFor(`!${$(".note")}.hidden && ${$(".note")}.textContent === '与后台的连接中断，正在自动重连…'`, "同步失败提示为正在重连", 8000);
  await waitFor(`${$(".note")}.hidden`, "同步恢复后清除提示", 8000);

  // 播放提醒：抽屉收起后，没视频在播就停止同步；有视频在播就继续同步，任务需要你时暂停并提醒，完成时只提醒。
  const alertPanel = `document.getElementById('agent-companion-attention')?.shadowRoot.querySelector('.panel')`;
  const alertOpen = `Boolean(${alertPanel}?.matches(':popover-open'))`;
  const watches = () => evaluate(`rpcCalls.filter((method) => method === 'watch').length`);
  await evaluate(`globalThis.visible = false; handle.visibilityChanged({ visible: false })`);
  let watched = await watches();
  await evaluate(`activityOf[ids.a24] = '收起后的变化'; bump()`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(await watches(), watched, "收起且没在播放时不同步");
  await evaluate(`video.play()`);
  await waitFor(`layer.diagnostics().playing && rpcCalls.filter((method) => method === 'watch').length >= ${watched + 2}`, "开始播放后恢复同步，先取基线再挂起");
  assert.equal(await evaluate(alertOpen), false, "停止同步期间的变化不补发提醒");
  await evaluate(`unsee(ids.a24); statusOf[ids.a24] = 'asking'; bump()`);
  await waitFor(`${alertOpen} && video.paused`, "任务需要你：暂停播放并提醒");
  assert.deepEqual(await evaluate(`(() => { const item = ${alertPanel}.querySelector('li'); return [item.dataset.tone, item.querySelector('strong').textContent, item.querySelector('.text').textContent, item.style.getPropertyValue('--task') !== '']; })()`),
    ["attention", "发布 v0.2 检查清单", "在等你回答", true]);
  await screenshot("task-board-alert.png");
  const clicked = await evaluate(`clicks.length`);
  await evaluate(`${alertPanel}.querySelector('li button.go').click()`);
  await waitFor(`clicks.length > ${clicked} && clicks.at(-1) === 'local:' + ids.a24 && !${alertOpen}`, "去处理：在侧栏打开这个会话");
  assert.equal(await evaluate(`video.paused`), true, "去处理不替用户恢复播放");
  await evaluate(`video.play()`);
  await evaluate(`statusOf[ids.a24] = 'running'; bump()`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await evaluate(alertOpen), false, "回到进行中不提醒");
  await evaluate(`unsee(ids.a24); statusOf[ids.a24] = 'idle'; bump()`);
  await waitFor(`${alertOpen} && ${alertPanel}.querySelector('li').dataset.tone === 'done' && !video.paused`, "完成：只提醒不暂停");
  assert.equal(await evaluate(`${alertPanel}.querySelector('.text').textContent`), "已完成");
  await waitFor(`!${alertOpen}`, "完成提醒自动收起");
  // 提醒弹着时按 ⌥J 等于点「去处理」：在侧栏打开这个会话，不替用户恢复播放。
  await evaluate(`unsee(ids.s1); statusOf[ids.s1] = 'asking'; bump()`);
  await waitFor(`${alertOpen} && video.paused && ${alertPanel}.querySelector('strong').textContent === '准备周五分享'`, "s1 需要你：暂停并提醒");
  const beforeJump = await evaluate(`clicks.length`);
  await altDown();
  await key("rawKeyDown", "∆", "KeyJ", 74, ALT);
  await key("keyUp", "∆", "KeyJ", 74, ALT);
  await altUp();
  await waitFor(`clicks.length > ${beforeJump} && clicks.at(-1) === 'local:' + ids.s1 && !${alertOpen}`, "⌥J 去处理");
  assert.equal(await evaluate(`video.paused`), true, "⌥J 去处理也不恢复播放");
  await evaluate(`video.play()`);
  // 两项都关掉：收起时即使在播放也不再同步。
  await evaluate(`handle.updateSettings({ alertAttention: 'off', alertDone: 'off' })`);
  watched = await watches();
  await evaluate(`unsee(ids.a24); statusOf[ids.a24] = 'asking'; bump()`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(await watches(), watched, "提醒全关时收起即停止同步");
  assert.equal(await evaluate(`${alertOpen} || video.paused`), false, "提醒全关时不提醒也不暂停");
  await evaluate(`video.pause(); clearInterval(frame); globalThis.visible = true; handle.updateSettings({}); handle.visibilityChanged({ visible: true })`);

  await evaluate(`controller.abort(); handle.dispose(); threads.dispose(); layer.dispose()`);
  assert.equal(await evaluate(`document.querySelectorAll('[data-agent-companion-task]').length + (document.getElementById('agent-companion-thread-marks') ? 1 : 0)`), 0, "释放后不残留标记");
  assert.equal(await evaluate(`document.getElementById('agent-companion-overlay-tasks')`), null, "释放后移除顶层浮层");
  assert.deepEqual(await evaluate(`errors`), []);
  console.log("Task board smoke passed:", JSON.stringify({ clicks: (await evaluate(`clicks`)).length, rpc: await evaluate(`rpcCalls.length`), idleFrames, flowFrames: frameStats }));
} finally {
  connection?.close();
  chrome.kill("SIGTERM");
  await new Promise((resolve) => { chrome.once("exit", resolve); setTimeout(resolve, 2000).unref(); });
  await rm(profile, { recursive: true, force: true });
}
