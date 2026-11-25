import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexSessions, isDesktopUserSession } from "../src/codex-sessions.mjs";
import { MAX_RECENT, MAX_TASKS, TaskBoardStorage, TaskRecentStorage } from "../cards/tasks/task-board-storage.mjs";
import { createSessionWatcher } from "../cards/tasks/task-auto-add.mjs";
import { createService } from "../cards/tasks/service.mjs";
import { assertMode } from "./helpers/permissions.mjs";

const context = { signal: new AbortController().signal };
const pad = (value) => String(value).padStart(2, "0");

// UUIDv7：前 48 位是毫秒时间戳，sessions 按它的本地日期分目录。
let serial = 0;
function idAt(ms) {
  const hex = ms.toString(16).padStart(12, "0");
  const tail = (serial += 1).toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-${tail}`;
}

const DESKTOP = { originator: "Codex Desktop", source: "vscode", thread_source: "user" };

async function withDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "companion-task-auto-add-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeSession(codexHome, id, meta = DESKTOP, { raw } = {}) {
  const created = new Date(Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16));
  const directory = join(codexHome, "sessions", String(created.getFullYear()), pad(created.getMonth() + 1), pad(created.getDate()));
  await mkdir(directory, { recursive: true });
  const path = join(directory, `rollout-2026-11-23T10-00-00-${id}.jsonl`);
  const line = JSON.stringify({ timestamp: created.toISOString(), type: "session_meta", payload: { id, base_instructions: { text: "x".repeat(70_000) }, ...meta } });
  await writeFile(path, raw ?? `${line}\n`);
  return path;
}

async function fixture(t, options = {}) {
  const dir = await withDir(t);
  const codexHome = join(dir, "codex");
  await mkdir(codexHome, { recursive: true });
  const warnings = [];
  const taskBoard = new TaskBoardStorage({ path: join(dir, "task-board.json") });
  const recentStorage = new TaskRecentStorage({ path: join(dir, "task-recent.json") });
  const service = createService({
    taskBoard, recentStorage, codexSessions: new CodexSessions({ codexHome }), openThread: async () => {},
    logger: { warn: (message) => warnings.push(message) }, autoAddIntervalMs: 60_000, ...options
  });
  t.after(() => service.dispose());
  const call = (method, params = {}) => service.methods[method](params, context);
  const ids = async () => (await taskBoard.load()).tasks.map((task) => task.threadId);
  return { dir, codexHome, taskBoard, recentStorage, service, call, ids, warnings };
}

const autoAddConfig = (value = true, extra = {}) => ({ enabled: true, cards: { tasks: { enabled: true, settings: { autoAdd: value } } }, ...extra });

test("只认用户在 Codex 桌面端自己新开的会话", () => {
  assert.equal(isDesktopUserSession(DESKTOP), true);
  assert.equal(isDesktopUserSession({ originator: "Codex Desktop", source: "vscode" }), true, "旧版没有 thread_source");
  assert.equal(isDesktopUserSession({ ...DESKTOP, forked_from_id: "x", attached_thread: false }), true, "普通分叉算新会话");
  for (const meta of [
    { ...DESKTOP, originator: "codex-tui" },
    { ...DESKTOP, originator: "codex_exec" },
    { ...DESKTOP, originator: "codex_cli_rs" },
    { ...DESKTOP, originator: "codex_vscode" },
    { ...DESKTOP, source: "exec" },
    { ...DESKTOP, source: "mcp" },
    { ...DESKTOP, source: { subagent: { thread_spawn: {} } } },
    { ...DESKTOP, thread_source: "subagent" },
    { ...DESKTOP, attached_thread: true },
    {},
    null
  ]) assert.equal(isDesktopUserSession(meta), false, JSON.stringify(meta));
});

test("会话记录第一行：没写完时为 null，不是 session_meta 时为空对象", async (t) => {
  const dir = await withDir(t);
  const sessions = new CodexSessions({ codexHome: dir });
  const path = join(dir, "rollout.jsonl");
  await writeFile(path, `{"type":"session_meta","payload":{"id":"a"`);
  assert.equal(await sessions.sessionMeta(path), null);
  await writeFile(path, `${JSON.stringify({ type: "session_meta", payload: { id: "a", text: "y".repeat(200_000) } })}\n{"type":"event_msg"}\n`);
  assert.equal((await sessions.sessionMeta(path)).id, "a", "长于一次读取的第一行也能读完");
  await writeFile(path, `${JSON.stringify({ type: "event_msg", payload: {} })}\n`);
  assert.deepEqual(await sessions.sessionMeta(path), {});
  await writeFile(path, "not json\n");
  assert.equal(await sessions.sessionMeta(path), null);
  await assert.rejects(sessions.sessionMeta(join(dir, "missing.jsonl")));
});

test("自动加入：启动时已有的会话不加，之后新开的桌面会话加到最前并带上项目 id", async (t) => {
  const { codexHome, service, ids, call } = await fixture(t);
  const before = idAt(Date.now() - 60_000);
  await writeSession(codexHome, before);
  await service.applyConfig(autoAddConfig());
  assert.equal(service.autoAdd.running, true);
  await service.autoAdd.start();
  await service.autoAdd.scanOnce();
  assert.deepEqual(await ids(), [], "基线里的会话不加");

  const fresh = idAt(Date.now());
  await writeSession(codexHome, fresh);
  await writeFile(join(codexHome, ".codex-global-state.json"), JSON.stringify({
    "thread-project-assignments": { [fresh]: { projectKind: "local", projectId: "987ca6a1-169e-42f0-92ee-b5c425f4a37c" } }
  }));
  await service.autoAdd.scanOnce();
  const board = await call("list");
  assert.deepEqual(board.tasks.map((task) => [task.threadId, task.projectId, task.suggestedName, task.customName]), [
    [fresh, "987ca6a1-169e-42f0-92ee-b5c425f4a37c", null, null]
  ]);

  const second = idAt(Date.now());
  await writeSession(codexHome, second);
  await service.autoAdd.scanOnce();
  assert.deepEqual(await ids(), [second, fresh], "新任务放最前");
});

test("自动加入：终端、exec、子代理、侧边对话与非用户来源不加；从归档恢复的旧会话不加", async (t) => {
  const { codexHome, service, ids } = await fixture(t);
  await service.applyConfig(autoAddConfig());
  await service.autoAdd.start();
  for (const meta of [
    { ...DESKTOP, originator: "codex-tui" },
    { ...DESKTOP, source: "exec" },
    { ...DESKTOP, source: { subagent: "review" } },
    { ...DESKTOP, thread_source: "automation" },
    { ...DESKTOP, attached_thread: true }
  ]) await writeSession(codexHome, idAt(Date.now()), meta);
  // 两天前创建、今天才出现在 sessions 目录下（从归档里恢复）：日期目录按 id 时间算，这里直接放进今天的目录。
  const old = idAt(Date.now() - 2 * 86_400_000);
  const today = new Date();
  const directory = join(codexHome, "sessions", String(today.getFullYear()), pad(today.getMonth() + 1), pad(today.getDate()));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `rollout-x-${old}.jsonl`), `${JSON.stringify({ type: "session_meta", payload: { id: old, ...DESKTOP } })}\n`);
  await service.autoAdd.scanOnce();
  assert.deepEqual(await ids(), []);
});

test("自动加入：第一行没写完时下一轮再读；移出看板后不再加回", async (t) => {
  const { codexHome, service, ids, call } = await fixture(t);
  await service.applyConfig(autoAddConfig());
  await service.autoAdd.start();
  const id = idAt(Date.now());
  const path = await writeSession(codexHome, id, DESKTOP, { raw: `{"type":"session_meta","payload":{"id":"${id}"` });
  await service.autoAdd.scanOnce();
  assert.deepEqual(await ids(), []);
  await writeSession(codexHome, id);
  await service.autoAdd.scanOnce();
  assert.deepEqual(await ids(), [id]);
  await call("remove", { threadId: id });
  await writeFile(path, `${await readFile(path, "utf8")}{"type":"event_msg"}\n`);
  await service.autoAdd.scanOnce();
  assert.deepEqual(await ids(), [], "处理过的文件不再处理");
  // 手动加过的会话也不重复加入。
  await call("add", { threadId: id });
  const other = idAt(Date.now());
  await writeSession(codexHome, other);
  await service.autoAdd.scanOnce();
  assert.deepEqual(await ids(), [other, id]);
});

test("自动加入：一直读不出第一行的文件 30 秒后放弃", async () => {
  let now = Date.now();
  const added = [];
  const reads = [];
  const files = ["a"];
  const watcher = createSessionWatcher({
    now: () => now, intervalMs: 60_000, logger: { warn() {} }, onSession: ({ threadId }) => added.push(threadId),
    codexSessions: { recentRollouts: async () => [...files], sessionMeta: async (path) => { reads.push(path); return null; } }
  });
  await watcher.scanOnce();
  files.push("b");
  await watcher.scanOnce();
  now += 29_000;
  await watcher.scanOnce();
  now += 2_000;
  await watcher.scanOnce();
  await watcher.scanOnce();
  assert.deepEqual(reads, ["b", "b", "b"], "放弃后不再读");
  assert.deepEqual(added, []);
});

test("自动加入：目录一时读不出来时这一轮作废，已处理过的会话不会被当成新的再加回；同一个错误只记一次", async () => {
  const id = idAt(Date.now());
  const added = [];
  const warnings = [];
  let files = [];
  let failure = null;
  const watcher = createSessionWatcher({
    intervalMs: 60_000, logger: { warn: (message) => warnings.push(message) }, onSession: ({ threadId }) => added.push(threadId),
    codexSessions: {
      recentRollouts: async () => { if (failure) throw failure; return [...files]; },
      sessionMeta: async () => ({ id, ...DESKTOP })
    }
  });
  await watcher.start();
  files = ["a"];
  await watcher.scanOnce();
  assert.deepEqual(added, [id]);
  failure = Object.assign(new Error("too many open files"), { code: "EMFILE" });
  await watcher.scanOnce();
  await watcher.scanOnce();
  assert.equal(warnings.length, 1, "连着失败只记一次");
  failure = null;
  await watcher.scanOnce();
  assert.deepEqual(added, [id], "恢复后不重复加入");
  failure = Object.assign(new Error("too many open files"), { code: "EMFILE" });
  await watcher.scanOnce();
  assert.equal(warnings.length, 2, "恢复后再失败照常记");
  watcher.stop();
});

test("最近两天的会话记录：目录不存在或不是目录时为空，只列 rollout 文件", async (t) => {
  const dir = await withDir(t);
  const sessions = new CodexSessions({ codexHome: dir });
  assert.deepEqual(await sessions.recentRollouts(), []);
  const today = new Date();
  const month = join(dir, "sessions", String(today.getFullYear()), pad(today.getMonth() + 1));
  await mkdir(month, { recursive: true });
  // 日期目录的位置上是个普通文件：按不存在处理。
  await writeFile(join(month, pad(today.getDate())), "");
  assert.deepEqual(await sessions.recentRollouts(), []);
  await rm(join(month, pad(today.getDate())));
  await mkdir(join(month, pad(today.getDate())));
  await writeFile(join(month, pad(today.getDate()), "rollout-x.jsonl"), "");
  await writeFile(join(month, pad(today.getDate()), "notes.txt"), "");
  assert.deepEqual(await sessions.recentRollouts(), [join(month, pad(today.getDate()), "rollout-x.jsonl")]);
});

test("自动加入：看板满了跳过并记日志，不抛", async (t) => {
  const { codexHome, service, taskBoard, ids, warnings } = await fixture(t);
  const base = Date.now() - 3600_000;
  await taskBoard.mutate(() => Array.from({ length: MAX_TASKS }, (_, index) => ({ threadId: idAt(base + index), addedAt: 1 })));
  await service.applyConfig(autoAddConfig());
  await service.autoAdd.start();
  const id = idAt(Date.now());
  await writeSession(codexHome, id);
  await service.autoAdd.scanOnce();
  const now = await ids();
  assert.equal(now.length, MAX_TASKS);
  assert.equal(now.includes(id), false);
  assert.equal(warnings.some((message) => message.includes("看板已满")), true);
});

test("自动加入：开关关闭、任务看板或 Companion 停用、服务销毁时停止；与「长任务先列计划」互不影响", async (t) => {
  const planned = [];
  const { service } = await fixture(t, { planHint: { set: async (value) => { planned.push(value); } } });
  await service.applyConfig(autoAddConfig(true, { cards: { tasks: { enabled: true, settings: { autoAdd: true, planHint: true } } } }));
  assert.equal(service.autoAdd.running, true, "planHint 生效时也启动");
  assert.deepEqual(planned, [true]);
  await service.applyConfig(autoAddConfig(false));
  assert.equal(service.autoAdd.running, false);
  await service.applyConfig(autoAddConfig());
  assert.equal(service.autoAdd.running, true);
  await service.applyConfig({ enabled: true, cards: { tasks: { enabled: false, settings: { autoAdd: true } } } });
  assert.equal(service.autoAdd.running, false);
  await service.applyConfig(autoAddConfig(true, { enabled: false }));
  assert.equal(service.autoAdd.running, false);
  await service.applyConfig({ enabled: true, cards: {} });
  assert.equal(service.autoAdd.running, false, "缺省关闭");
  await service.applyConfig(autoAddConfig());
  service.dispose();
  assert.equal(service.autoAdd.running, false);
});

test("自动加入：定时扫描，停止后不再扫描", async () => {
  const timers = [];
  let listed = 0;
  const watcher = createSessionWatcher({
    intervalMs: 50, logger: { warn() {} }, onSession() {},
    setTimer: (fn, ms) => { const timer = { fn, ms, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; },
    codexSessions: { recentRollouts: async () => { listed += 1; return []; }, sessionMeta: async () => null }
  });
  await watcher.start();
  await watcher.start();
  assert.equal(listed, 1, "已在运行时不重取基线");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 50);
  timers[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(listed, 2);
  assert.equal(timers.length, 2);
  watcher.stop();
  assert.equal(timers[1].cancelled, true);
});

test("最近打开：移到最前、去重、限长，已在最前不写盘；参数严格校验；文件损坏回退为空", async (t) => {
  const { call, recentStorage, dir } = await fixture(t);
  const [a, b] = [idAt(Date.now()), idAt(Date.now())];
  assert.deepEqual(await call("recent"), { recent: [] });
  assert.deepEqual(await call("visit", { threadId: a }), { recent: [a] });
  assert.deepEqual(await call("visit", { threadId: b }), { recent: [b, a] });
  assert.deepEqual(await call("visit", { threadId: a }), { recent: [a, b] });
  assertMode(await stat(recentStorage.path), 0o600);
  const before = (await stat(recentStorage.path)).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await call("visit", { threadId: a }), { recent: [a, b] });
  assert.equal((await stat(recentStorage.path)).mtimeMs, before, "已在最前不写盘");
  assert.deepEqual(await call("recent"), { recent: [a, b] }, "从文件读回");
  assert.deepEqual(JSON.parse(await readFile(recentStorage.path, "utf8")), { version: 1, recent: [a, b] });
  for (let index = 0; index < MAX_RECENT + 20; index += 1) await recentStorage.visit(idAt(Date.now() + index));
  const long = (await call("recent")).recent;
  assert.equal(long.length, MAX_RECENT);
  assert.equal(new Set(long).size, MAX_RECENT);
  await assert.rejects(call("visit", { threadId: "../etc" }), { code: "RPC_INVALID_PARAMS" });
  await assert.rejects(call("visit", {}), { code: "RPC_INVALID_PARAMS" });
  await assert.rejects(call("visit", { threadId: a, extra: 1 }), { code: "RPC_INVALID_PARAMS" });
  await assert.rejects(call("recent", { x: 1 }), { code: "RPC_INVALID_PARAMS" });
  await writeFile(recentStorage.path, "{broken");
  assert.deepEqual(await call("recent"), { recent: [] });
  await writeFile(recentStorage.path, JSON.stringify({ recent: [a, a, "bad id", 3, b] }));
  assert.deepEqual(await call("recent"), { recent: [a, b] });
  assert.equal((await stat(join(dir, "task-board.json")).catch(() => null)), null, "不碰看板文件");
});

test("看板里没存项目 id 的任务按 Codex 当前的项目分配补上，只补返回值", async (t) => {
  const { codexHome, call, taskBoard } = await fixture(t);
  const id = idAt(Date.now());
  const client = "55df1b41-eb1f-4317-a606-7543ae182ba0";
  await call("add", { threadId: id, title: "一" });
  assert.equal((await call("list")).tasks[0].projectId, null);
  // 项目分配可能记在客户端临时 id 上。
  await writeFile(join(codexHome, ".codex-global-state.json"), JSON.stringify({
    "electron-owner-atoms:abc": { "client-thread-bindings-v1": { [`client-new-thread:${client}`]: id } },
    "thread-project-assignments": { [client]: { projectId: "proj-1" }, "bad id": { projectId: "x" }, [idAt(Date.now())]: { projectId: 3 } }
  }));
  assert.equal((await call("list")).tasks[0].projectId, "proj-1");
  assert.equal((await taskBoard.load()).tasks[0].projectId, null, "不写盘");
  await call("remove", { threadId: id });
  await call("add", { threadId: id, projectId: "/repo" });
  assert.equal((await call("list")).tasks[0].projectId, "/repo", "已存的项目 id 优先");
});

test("自动加入：加入看板失败时下一轮重试，连续 30 秒仍失败才放弃；失败只记一次日志", async () => {
  let now = Date.now();
  let fail = true;
  const added = [];
  const warnings = [];
  const files = [];
  const id = idAt(now);
  const watcher = createSessionWatcher({
    now: () => now, intervalMs: 60_000, logger: { warn: (message) => warnings.push(message) },
    onSession: ({ threadId }) => { if (fail) throw new Error("EIO"); added.push(threadId); },
    codexSessions: { recentRollouts: async () => [...files], sessionMeta: async () => ({ id, ...DESKTOP }) }
  });
  await watcher.start();
  files.push("a");
  await watcher.scanOnce();
  await watcher.scanOnce();
  assert.deepEqual(added, []);
  assert.equal(warnings.length, 1, "同一个会话的失败只记一次");
  fail = false;
  await watcher.scanOnce();
  await watcher.scanOnce();
  assert.deepEqual(added, [id], "恢复后补上，且只加一次");
  // 一直失败的 30 秒后放弃，不再反复尝试。
  fail = true;
  let tries = 0;
  const stuck = createSessionWatcher({
    now: () => now, intervalMs: 60_000, logger: { warn() {} }, onSession: () => { tries += 1; throw new Error("EIO"); },
    codexSessions: { recentRollouts: async () => [...files], sessionMeta: async () => ({ id, ...DESKTOP }) }
  });
  files.length = 0;
  await stuck.start();
  files.push("b");
  await stuck.scanOnce();
  now += 31_000;
  await stuck.scanOnce();
  await stuck.scanOnce();
  assert.equal(tries, 2, "放弃后不再尝试");
  watcher.stop();
  stuck.stop();
});

test("同一会话先用客户端临时 id 手动加入、又被自动加入用真实 id 加了一次：绑定出现后只留先加入的那条", async (t) => {
  const { codexHome, call, ids, service, taskBoard } = await fixture(t);
  const client = "55df1b41-eb1f-4317-a606-7543ae182ba0";
  const real = idAt(Date.now() + 1000);
  await call("add", { threadId: client, title: "手动加入的", projectId: "proj-1" });
  await service.applyConfig(autoAddConfig());
  await service.autoAdd.scanOnce();
  // 会话记录先出现，绑定还没写：自动加入认不出是同一个会话。
  await writeSession(codexHome, real);
  await service.autoAdd.scanOnce();
  assert.deepEqual(await ids(), [real, client]);
  await writeFile(join(codexHome, ".codex-global-state.json"), JSON.stringify({ "client-thread-bindings-v1": { [`client-new-thread:${client}`]: real } }));
  const listed = await call("list");
  assert.deepEqual(listed.tasks.map((task) => [task.threadId, task.suggestedName, task.projectId]), [[client, "手动加入的", "proj-1"]], "留下先加入的，名字和项目不丢");
  assert.deepEqual(await ids(), [client], "多的那条从看板文件删掉");
  const revision = (await taskBoard.load()).revision;
  await call("list");
  assert.equal((await taskBoard.load()).revision, revision, "没有重复时不写盘");
});
