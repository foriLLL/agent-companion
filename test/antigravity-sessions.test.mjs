import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AntigravitySessions, decodeSummary, describeAntigravityTool, parseAntigravityTrace, querySqlite } from "../src/antigravity-sessions.mjs";
import { createSessionWatcher } from "../cards/tasks/task-auto-add.mjs";
import { defaultTaskBoardPath, defaultTaskRecentPath } from "../cards/tasks/task-board-storage.mjs";

// ---------- 最小 protobuf 编码器（只为造测试数据） ----------
const varint = (value) => {
  const bytes = [];
  let rest = value;
  do {
    let byte = rest % 128;
    rest = Math.floor(rest / 128);
    if (rest) byte |= 0x80;
    bytes.push(byte);
  } while (rest);
  return Buffer.from(bytes);
};
const field = (number, value) => {
  if (typeof value === "number") return Buffer.concat([varint(number * 8), varint(value)]);
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
};
const msg = (...fields) => Buffer.concat(fields);
const time = (ms) => msg(field(1, Math.floor(ms / 1000)), field(2, (ms % 1000) * 1e6));
const stepWith = (index, ...stepFields) => msg(field(1, msg(...stepFields)), field(2, index));

const T0 = Date.parse("2026-11-24T08:00:00Z");
const ID = "5f13e99e-f461-4309-9796-ce99e2b141ef";
const OTHER = "0b0f5e0a-1111-4222-8333-944445555666";

test("raw_summary 解码：标题、状态、等你处理的步骤、任务进度与标注", () => {
  const waiting = stepWith(7,
    field(4, 9),
    field(5, msg(field(1, time(T0 + 5000)), field(4, msg(field(2, "run_command"), field(3, JSON.stringify({ CommandLine: "npm test\nmore" })))))),
    field(56, msg(field(3, Buffer.alloc(0)))));
  const raw = msg(
    field(1, "修登录"), field(2, 12), field(3, time(T0 + 9000)), field(5, 2), field(7, time(T0)),
    field(8, waiting),
    field(14, stepWith(6, field(5, msg(field(1, time(T0 + 4000)))), field(93, msg(field(1, "Fix login"), field(2, "正在跑测试"), field(3, "修复登录页"))))),
    field(15, msg(field(1, "我的名字"), field(8, 1))),
    field(23, 0)
  );
  const summary = decodeSummary(raw);
  assert.equal(summary.title, "修登录");
  assert.equal(summary.status, 2);
  assert.equal(summary.modifiedAt, T0 + 9000);
  assert.equal(summary.createdAt, T0);
  assert.deepEqual(summary.waiting, [{ index: 7, at: T0 + 5000, text: "要运行 npm test" }]);
  assert.deepEqual(summary.task, { name: "Fix login", status: "正在跑测试", summary: "修复登录页", at: T0 + 4000 });
  assert.deepEqual(summary.annotations, { title: "我的名字", archived: false, unread: true });
  assert.equal(summary.killed, false);
  // 截断或乱码不抛出，只返回读得出的部分
  assert.doesNotThrow(() => decodeSummary(raw.subarray(0, raw.length - 3)));
  assert.equal(decodeSummary(Buffer.from([0xff, 0xff, 0xff])).title, null);
});

test("等待原因：提问、授权、文件权限与笼统说法", () => {
  const waitingText = (interaction) => decodeSummary(field(8, stepWith(1, field(56, interaction)))).waiting[0].text;
  assert.equal(waitingText(field(22, field(1, field(1, "要用哪个分支？")))), "要用哪个分支？");
  assert.equal(waitingText(field(21, msg(field(4, "需要网络"), field(5, "访问 npm registry")))), "访问 npm registry");
  assert.equal(waitingText(field(19, field(1, "file:///Users/me/repo/.env"))), "要访问 .env，等你允许");
  assert.equal(waitingText(field(13, Buffer.alloc(0))), "要操作浏览器，等你确认");
  assert.equal(waitingText(field(99, Buffer.alloc(0))), "在等你处理");
});

test("工具描述与泳道", () => {
  assert.equal(describeAntigravityTool("run_command", { CommandLine: "\"git status\"" }), "运行 git status");
  assert.equal(describeAntigravityTool("read_file", { Path: "\"/Users/me/repo/package.json\"" }), "读取 package.json");
  assert.equal(describeAntigravityTool("edit_file", { TargetFile: "\"/a/b.mjs\"" }), "修改 b.mjs");
  assert.equal(describeAntigravityTool("mystery_tool", {}), "调用 mystery_tool");
});

const transcript = [
  { step_index: "0", type: "USER_INPUT", source: "USER_EXPLICIT", status: "DONE", created_at: "2026-11-24T08:00:00Z", content: "<USER_REQUEST>\n看下目录\n</USER_REQUEST>" },
  { step_index: "1", type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", created_at: "2026-11-24T08:00:01Z", model: "gemini-x", input_tokens: "100", cache_read_tokens: "900", output_tokens: "50",
    tool_calls: [{ name: "run_command", args: { CommandLine: "\"ls\"" } }, { name: "read_file", args: { Path: "\"/r/README.md\"" } }] },
  { step_index: "2", type: "GENERIC", source: "MODEL", status: "DONE", created_at: "2026-11-24T08:00:05Z", content: "Created At: 2026-11-24T16:00:05+08:00\nCompleted At: 2026-11-24T16:00:07+08:00\n..." },
  { step_index: "3", type: "GENERIC", source: "MODEL", status: "DONE", created_at: "2026-11-24T08:00:05Z", content: "Created At: 2026-11-24T16:00:05+08:00\nCompleted At: 2026-11-24T16:00:06+08:00\n..." },
  { step_index: "4", type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", created_at: "2026-11-24T08:00:07Z", output_tokens: "600", content: "目录如下：\n- src" },
  { step_index: "5", type: "USER_INPUT", source: "USER_EXPLICIT", status: "DONE", created_at: "2026-11-24T08:10:00Z", content: "<USER_REQUEST>\n继续\n</USER_REQUEST>" },
  { step_index: "6", type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", created_at: "2026-11-24T08:10:01Z", output_tokens: "10", tool_calls: [{ name: "edit_file", args: { TargetFile: "\"/r/a.mjs\"" } }] }
];

test("Trace：回合切分、工具配对、模型段时长与进行中的回合", () => {
  const running = parseAntigravityTrace(transcript, { live: { running: true, waiting: false, activity: "修改 a.mjs", updatedAt: T0 + 601_000 } });
  assert.equal(running.model, "gemini-x");
  assert.equal(running.turns.length, 2);
  const [first, second] = running.turns;
  assert.equal(first.status, "done");
  assert.deepEqual(first.segments.map((segment) => [segment.kind, segment.lane, segment.label]), [
    ["call", "model", "准备运行 ls"], ["tool", "shell", "运行 ls"], ["tool", "other", "读取 README.md"], ["reply", "model", "目录如下："]
  ]);
  assert.equal(first.segments[0].end - first.segments[0].start, 4000, "组织调用到第一个工具开始");
  assert.equal(first.segments[1].end - first.segments[1].start, 2000, "工具时长取 Created/Completed At");
  // 旧回合最后一段回复按 600 token / 60 tok/s 估 10 秒
  assert.equal(first.segments[3].end - first.segments[3].start, 10_000);
  assert.equal(first.end, first.segments[3].end);
  assert.equal(first.tokens.input, 1000);
  assert.equal(second.end, null);
  assert.equal(second.status, "running");
  assert.equal(second.segments.at(-1).kind, "tool");
  assert.equal(second.segments.at(-1).end, null, "还没结果的工具仍在运行");

  const idle = parseAntigravityTrace(transcript.slice(0, 5), { live: { running: false, status: "idle", updatedAt: Date.parse("2026-11-24T08:00:12Z") } });
  assert.equal(idle.turns[0].end, Date.parse("2026-11-24T08:00:12Z"), "最新回合用会话最后修改时间收尾");
  assert.equal(idle.turns[0].asking, false);

  const waiting = parseAntigravityTrace(transcript, { live: { running: true, waiting: true } });
  assert.equal(waiting.turns.at(-1).asking, true);
});

async function fixture(rows, files = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agy-sessions-"));
  await writeFile(path.join(dir, "conversation_summaries.db"), "");
  for (const [id, steps] of Object.entries(files)) {
    const logs = path.join(dir, "brain", id, ".system_generated", "logs");
    await mkdir(logs, { recursive: true });
    await writeFile(path.join(logs, "transcript.jsonl"), steps.map((step) => JSON.stringify(step)).join("\n") + "\n");
  }
  let queries = 0;
  const sessions = new AntigravitySessions({ dataDir: dir, now: () => T0 + 60_000, query: async () => { queries += 1; return rows(); } });
  return { dir, sessions, queries: () => queries };
}

const row = (id, raw, extra = {}) => ({ id, title: "", status: "CASCADE_RUN_STATUS_IDLE", source: "", workspaces: "[\"file:///Users/me/pi-src\"]", modifiedAt: "2026-11-24 08:00:30.5+00:00", raw: raw?.toString("hex") ?? null, ...extra });

test("会话状态：等你处理、进行中、卡住、已结束（回复摘要/提问）、终止、归档、找不到", async () => {
  const summaries = {
    asking: msg(field(1, "等授权"), field(3, time(T0 + 30_000)), field(5, 2), field(8, stepWith(3, field(5, msg(field(1, time(T0 + 20_000)))), field(56, field(21, field(5, "允许访问网络")))))),
    running: msg(field(3, time(T0 + 30_000)), field(5, 2), field(14, stepWith(2, field(93, msg(field(1, "Refactor"), field(2, "正在改 service")))))),
    stalled: msg(field(3, time(T0 - 20 * 60_000)), field(5, 4)),
    idle: msg(field(1, "看目录"), field(3, time(T0 + 30_000)), field(5, 1)),
    killed: msg(field(3, time(T0)), field(5, 1), field(23, 1)),
    archived: msg(field(5, 1), field(15, field(4, 1)))
  };
  const ids = Object.fromEntries(Object.keys(summaries).map((key, index) => [key, `${String(index).repeat(8)}-0000-4000-8000-000000000000`]));
  const { dir, sessions, queries } = await fixture(
    () => Object.entries(summaries).map(([key, raw]) => row(ids[key], raw)).concat([{ id: "bad", raw: null }]),
    { [ids.idle]: transcript.slice(0, 5), [ids.running]: transcript }
  );
  try {
    assert.deepEqual(await sessions.status(ids.asking), { status: "asking", updatedAt: T0 + 30_000, turnAt: T0 + 20_000, activity: "在等你处理", summary: "允许访问网络" });
    assert.deepEqual(await sessions.status(ids.running), { status: "running", updatedAt: T0 + 30_000, turnAt: T0 + 30_000, activity: "正在改 service", summary: null });
    assert.equal((await sessions.status(ids.stalled)).status, "stalled");
    assert.deepEqual(await sessions.status(ids.idle), { status: "idle", updatedAt: T0 + 30_000, turnAt: T0 + 30_000, activity: null, summary: "目录如下：" });
    assert.equal((await sessions.status(ids.killed)).status, "stopped");
    assert.equal((await sessions.status(ids.archived)).status, "archived");
    assert.equal((await sessions.status(OTHER)).status, "missing");
    assert.equal((await sessions.titles()).get(ids.idle), "看目录");
    assert.equal(await sessions.projectOf(ids.idle), "file:///Users/me/pi-src");
    assert.equal(await sessions.canonicalId(ids.idle), ids.idle);
    assert.deepEqual(await sessions.aliases(ids.idle), []);
    assert.equal(await sessions.plan(ids.idle), null);
    const trace = await sessions.trace(ids.running);
    assert.equal(trace.turns.at(-1).end, null);
    assert.equal(trace.updatedAt, T0 + 30_000);
    // 库文件没变时只查一次
    assert.equal(queries(), 1);
    const before = await sessions.fingerprint([ids.idle]);
    await writeFile(path.join(dir, "conversation_summaries.db"), "changed");
    assert.notEqual(await sessions.fingerprint([ids.idle]), before);
    await sessions.titles();
    assert.equal(queries(), 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("回复以问句结束时算在等你回答", async () => {
  const steps = [transcript[0], { ...transcript[4], content: "要我顺手把测试也补上吗？" }];
  const { dir, sessions } = await fixture(() => [row(ID, msg(field(5, 1), field(3, time(T0))))], { [ID]: steps });
  try {
    assert.equal((await sessions.status(ID)).status, "asking");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("自动加入：只收 Hub 里新开的顶层会话，按摘要里的创建时间判断新旧", async () => {
  let rows = [row(ID, msg(field(5, 1), field(7, time(T0 - 60_000))))];
  const { dir, sessions } = await fixture(() => rows);
  try {
    const added = [];
    let clock = T0;
    const watcher = createSessionWatcher({ codexSessions: sessions, now: () => clock, onSession: async ({ threadId }) => { added.push(threadId); }, setTimer: () => () => {} });
    await watcher.start();
    rows = [...rows,
      row(OTHER, msg(field(5, 2), field(7, time(T0 + 1000)))),
      row("11111111-2222-4333-8444-555555555555", msg(field(5, 2), field(7, time(T0 + 1000))), { source: "CORTEX_TRAJECTORY_SOURCE_CLI" })];
    await writeFile(path.join(dir, "conversation_summaries.db"), "v2");
    clock = T0 + 2000;
    await watcher.scanOnce();
    assert.deepEqual(added, [OTHER], "基线里的旧会话和命令行会话都不收");
    watcher.stop();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("sqlite 只读打不开 WAL 库时退回 immutable 快照读", async () => {
  const calls = [];
  const execFileImpl = async (_binary, args) => {
    calls.push(args[2]);
    if (calls.length === 1) { const error = new Error("fail"); error.stderr = "Error: unable to open database file (14)"; throw error; }
    return { stdout: "[{\"id\":\"x\"}]\n" };
  };
  assert.deepEqual(await querySqlite("/data/conversation summaries.db", "SELECT 1", { execFileImpl, binary: "sqlite3" }), [{ id: "x" }]);
  assert.deepEqual(calls, ["/data/conversation summaries.db", "file:/data/conversation%20summaries.db?mode=ro&immutable=1"]);
  await assert.rejects(querySqlite("/x.db", "SELECT 1", { execFileImpl: async () => { throw new Error("syntax error"); }, binary: "sqlite3" }), /syntax error/);
});

test("看板文件按宿主分开，Codex 沿用原文件名", () => {
  assert.match(defaultTaskBoardPath("/home/me"), /task-board\.json$/);
  assert.match(defaultTaskBoardPath("/home/me", "antigravity"), /task-board-antigravity\.json$/);
  assert.match(defaultTaskRecentPath("/home/me", "antigravity"), /task-recent-antigravity\.json$/);
});

test("Antigravity 宿主的任务服务：不碰 Codex 计划提示，深链打开给出提示", async () => {
  const { createService } = await import("../cards/tasks/service.mjs");
  const { AntigravitySessions: Sessions } = await import("../src/antigravity-sessions.mjs");
  const dir = await mkdtemp(path.join(os.tmpdir(), "agy-tasks-"));
  try {
    const { TaskBoardStorage, TaskRecentStorage } = await import("../cards/tasks/task-board-storage.mjs");
    let hintCalls = 0;
    const service = createService({
      host: "antigravity",
      taskBoard: new TaskBoardStorage({ path: path.join(dir, "board.json") }),
      recentStorage: new TaskRecentStorage({ path: path.join(dir, "recent.json") }),
      codexSessions: new Sessions({ dataDir: dir, query: async () => [] }),
      planHint: { async set() { hintCalls += 1; } }
    });
    await service.applyConfig({ cards: { tasks: { enabled: true, settings: { planHint: true } } } });
    assert.equal(hintCalls, 0);
    await assert.rejects(service.methods.open({ threadId: ID }, {}), (error) => error.code === "UNSUPPORTED");
    const added = await service.methods.add({ threadId: ID }, {});
    assert.equal(added.tasks[0].status, "missing");
    service.dispose();
    // 不传 codexSessions 时默认就是 Antigravity 数据源
    const fallback = createService({ host: "antigravity", taskBoard: new TaskBoardStorage({ path: path.join(dir, "b2.json") }) });
    await assert.rejects(fallback.methods.open({ threadId: ID }, {}), (error) => error.code === "UNSUPPORTED");
    fallback.dispose();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
