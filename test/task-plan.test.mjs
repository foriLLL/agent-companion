import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPlanEvents, createPlanState, currentPlan, parseLiteral, parsePlanEvents, planSummary, plansFromItem, planFromMessage } from "../src/codex-plan.mjs";
import { PLAN_HINT_BODY } from "../src/codex-plan-hint-text.mjs";
import { PLAN_HINT_END, PLAN_HINT_START, PLAN_TOOL_MARKER, PLAN_TOOL_SNIPPET, createPlanHint, hasHint, hasPlanTool, userPlanTool, withHint,
  withPlanTool, withoutHint, withoutPlanTool } from "../src/codex-plan-hint.mjs";
import { CodexSessions, threadCreatedAt } from "../src/codex-sessions.mjs";
import { createService } from "../src/cards/tasks/service.mjs";
import { ServiceRegistry } from "../src/platform/services/registry.mjs";
import { TaskBoardStorage } from "../src/task-board-storage.mjs";
import { uninstallAgent } from "../src/agent/launch-agent.mjs";
import { assertMode } from "./helpers/permissions.mjs";

const ID = "01a18216-3b02-7db0-b394-9543cce4d535";
const context = { signal: new AbortController().signal };

async function withDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "companion-task-plan-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const event = (timestamp, type, extra = {}) => JSON.stringify({ timestamp, type: "event_msg", payload: { type, ...extra } });
const item = (timestamp, payload) => JSON.stringify({ timestamp, type: "response_item", payload });
// 现在的桌面端：exec 工具的 JS 代码里调用 tools.update_plan。
const execPlan = (timestamp, steps, explanation) => item(timestamp, {
  type: "custom_tool_call", name: "exec", call_id: `c-${timestamp}`,
  input: `const u = await tools.update_plan({\n${explanation ? `  explanation: ${JSON.stringify(explanation)},\n` : ""}  plan: [\n${steps.map(([step, status]) => `    { step: ${JSON.stringify(step)}, status: "${status}" },`).join("\n")}\n  ]\n}); text(u);\n`
});
const messagePayload = (plan, extra = {}) => ({
  type: "message", role: "assistant", phase: "commentary",
  content: [{ type: "output_text", text: `\`\`\`companion-plan\n${JSON.stringify(plan)}\n\`\`\`` }], ...extra
});
const messagePlan = (timestamp, steps, explanation, { before = "", after = "" } = {}) => {
  const payload = messagePayload({ plan: steps.map(([step, status]) => ({ step, status })), ...(explanation ? { explanation } : {}) });
  payload.content[0].text = `${before}${payload.content[0].text}${after}`;
  return item(timestamp, payload);
};

async function writeRollout(codexHome, id, lines) {
  const created = new Date(threadCreatedAt(id));
  const pad = (value) => String(value).padStart(2, "0");
  const directory = join(codexHome, "sessions", String(created.getFullYear()), pad(created.getMonth() + 1), pad(created.getDate()));
  await mkdir(directory, { recursive: true });
  const path = join(directory, `rollout-2026-10-28T18-37-37-${id}.jsonl`);
  await writeFile(path, lines.length ? `${lines.join("\n")}\n` : "");
  return path;
}

test("JS 字面量：单双引号、模板字符串、未加引号的键、尾逗号与注释；变量和插值放弃", () => {
  assert.deepEqual(parseLiteral(`{ plan: [ { step: '它\\'s "ok"', status: \`pending\` }, ], // 注释\n explanation: "a\\nb\\u4e2d\\u{1F600}" }`),
    { plan: [{ step: "它's \"ok\"", status: "pending" }], explanation: "a\nb中😀" });
  assert.equal(parseLiteral("{ plan: steps }"), null);
  assert.equal(parseLiteral("{ plan: [{ step: `第 ${n} 步`, status: \"pending\" }] }"), null);
  assert.equal(parseLiteral("{ ...base }"), null);
});

test("计划快照：exec 代码与 JSON function_call 两种写法；补丁和变量参数不算", () => {
  const code = "await tools.update_plan({ explanation: '先确认', plan: [{ step: '检查  工作区', status: 'completed' }, { status: 'in_progress', step: '改名' }, { step: '测试', status: 'weird' }] });\nawait tools.update_plan({ plan: [{ step: '只剩一步', status: 'pending' }] });";
  assert.deepEqual(plansFromItem({ type: "custom_tool_call", name: "exec", input: code }), [
    { explanation: "先确认", steps: [{ text: "检查 工作区", status: "completed" }, { text: "改名", status: "in_progress" }, { text: "测试", status: "pending" }] },
    { explanation: null, steps: [{ text: "只剩一步", status: "pending" }] }
  ]);
  assert.deepEqual(plansFromItem({ type: "function_call", name: "update_plan", arguments: JSON.stringify({ plan: [{ step: "旧版", status: "in_progress" }] }) }),
    [{ explanation: null, steps: [{ text: "旧版", status: "in_progress" }] }]);
  assert.deepEqual(plansFromItem({ type: "function_call", name: "exec", arguments: JSON.stringify({ code: "tools.update_plan({ plan: [{ step: '包在 JSON 里', status: 'pending' }] })" }) }),
    [{ explanation: null, steps: [{ text: "包在 JSON 里", status: "pending" }] }]);
  assert.deepEqual(plansFromItem({ type: "custom_tool_call", name: "apply_patch", input: "+tools.update_plan({ plan: [{ step: 'x', status: 'pending' }] })" }), []);
  assert.deepEqual(plansFromItem({ type: "custom_tool_call", name: "exec", input: "await tools.update_plan(plan)" }), []);
  assert.deepEqual(plansFromItem({ type: "custom_tool_call", name: "exec", input: "await tools.update_plan({ plan: [] })" }), []);
});

test("无计划工具：独立的助手进度消息解析完整快照、分段文字与 CRLF", () => {
  const input = { plan: [{ step: "检查  现状", status: "completed" }, { step: "验证", status: "in_progress" }], explanation: "检查已完成" };
  const payload = messagePayload(input);
  const expected = { explanation: "检查已完成", steps: [{ text: "检查 现状", status: "completed" }, { text: "验证", status: "in_progress" }] };
  assert.deepEqual(planFromMessage(payload), expected);
  assert.deepEqual(plansFromItem(payload), [{ ...expected, source: "message" }]);
  const text = payload.content[0].text.replace(/\n/g, "\r\n");
  assert.deepEqual(planFromMessage({ ...payload, phase: undefined, channel: "commentary", content: [
    { type: "output_text", text: text.slice(0, 31) }, { type: "output_text", text: text.slice(31) }
  ] }), expected);
  const example = PLAN_HINT_BODY.match(/```companion-plan\n[\s\S]*?\n```/)[0];
  assert.equal(planFromMessage({ ...payload, content: [{ type: "output_text", text: example }] }).steps.length, 3, "实际提示词示例必须符合解析格式");
});

test("实际验收输出：计划块前后附带进度说明仍解析，分段消息与 CRLF 一致", () => {
  const payload = messagePayload({ plan: [{ step: "找到设置开关及配置保存入口", status: "in_progress" }, { step: "验证结果", status: "pending" }] });
  const expected = planFromMessage(payload);
  const text = payload.content[0].text;
  for (const described of [
    `当前会话没有 \`update_plan\` 工具，因此改用 \`companion-plan\` 快照维持同一份计划。\n\n${text}\n\n先定位相关的开关与配置实现。\n\n`,
    `${text}\n\n正在检查配置项定义、设置面板开关与 AGENTS.md 写入逻辑。\n\n\n\n`,
    `检查开始。\n${text}\n检查继续。`
  ]) {
    assert.deepEqual(planFromMessage({ ...payload, content: [{ type: "output_text", text: described }] }), expected);
    const windows = described.replace(/\n/g, "\r\n");
    assert.deepEqual(planFromMessage({ ...payload, content: [
      { type: "output_text", text: windows.slice(0, 29) }, { type: "output_text", text: windows.slice(29) }
    ] }), expected);
  }
});

test("专用计划消息拒绝用户、最终回复、引用与嵌套示例、普通文本和工具输出", () => {
  const payload = messagePayload({ plan: [{ step: "检查", status: "in_progress" }] });
  const text = payload.content[0].text;
  for (const extra of [
    { role: "user" }, { phase: "final_answer" }, { phase: undefined },
    { phase: "final_answer", channel: "commentary" },
    { phase: "final_answer", content: [{ type: "output_text", text: `示例如下：\n${text}\n这是示例` }] },
    { content: [{ type: "output_text", text: `> ${text}` }] },
    { content: [{ type: "output_text", text: text.split("\n").map(line => `> ${line}`).join("\n") }] },
    { content: [{ type: "output_text", text: `\`\`\`\`markdown\n${text}\n\`\`\`\`` }] },
    { content: [{ type: "output_text", text: `~~~markdown\n${text}\n~~~` }] },
    { content: [{ type: "output_text", text: text.split("\n").map(line => `    ${line}`).join("\n") }] },
    { content: [{ type: "output_text", text: "当前进度 2/5，下一步验证" }] },
    { content: [{ type: "input_text", text }] },
    { content: [{ type: "output_text", text: text.replace("companion-plan", "json") }] },
    { content: [{ type: "output_text", text: `${text}\n${text}` }] }
  ]) assert.equal(planFromMessage({ ...payload, ...extra }), null);
  for (const type of ["function_call_output", "custom_tool_call_output"]) {
    const record = item("2026-10-28T10:00:10Z", { type, output: text, call_id: "fixture" });
    assert.deepEqual(parsePlanEvents(record), []);
  }
  assert.deepEqual(parsePlanEvents(event("2026-10-28T10:00:10Z", "agent_message", { message: text })), [], "不重复解析 event_msg 副本");
});

test("只解析一个完整的顶层计划块，不误认普通代码块内部的标记或缺失闭合的快照", () => {
  const payload = messagePayload({ plan: [{ step: "验证", status: "in_progress" }] });
  const text = payload.content[0].text;
  const expected = planFromMessage(payload);
  assert.deepEqual(planFromMessage({ ...payload, content: [{ type: "output_text", text: `\`\`\`\`markdown\n${text}\n\`\`\`\`\n当前计划：\n${text}` }] }), expected);
  assert.deepEqual(planFromMessage({ ...payload, content: [{ type: "output_text", text: text.replace(/```/g, "~~~~") }] }), expected);
  for (const invalid of [text.slice(0, -3), `${text}\n\n${text.slice(0, -3)}`, text.replace(/\n```$/, "\n~~~"), text.replace(/\n```$/, "\n``")]) {
    assert.equal(planFromMessage({ ...payload, content: [{ type: "output_text", text: invalid }] }), null);
  }
});

test("专用计划快照严格校验状态、完整步骤和大小，不静默截断或猜状态", () => {
  const valid = { step: "检查", status: "pending" };
  for (const input of [
    null, [], {}, { plan: [] }, { plan: "检查" }, { plan: [valid], unknown: true },
    { plan: [valid], explanation: 1 }, { plan: [valid], explanation: "x".repeat(301) },
    { plan: [{ step: "检查", status: "done" }] }, { plan: [{ step: "检查" }] },
    { plan: [{ status: "pending" }] }, { plan: [{ ...valid, extra: "x" }] },
    { plan: [null] }, { plan: [{ ...valid, step: " " }] },
    { plan: [{ ...valid, step: "x".repeat(201) }] },
    { plan: [valid, { ...valid, step: " 检查 " }] },
    { plan: [{ ...valid, status: "in_progress" }, { step: "验证", status: "in_progress" }] },
    { plan: Array.from({ length: 51 }, (value, index) => ({ ...valid, step: `步骤 ${index}` })) }
  ]) assert.equal(planFromMessage(messagePayload(input)), null, JSON.stringify(input));
  const payload = messagePayload({ plan: [valid] });
  assert.equal(planFromMessage({ ...payload, content: [{ type: "output_text", text: "x".repeat(33 * 1024) }] }), null);
  assert.equal(planFromMessage({ ...payload, content: [{ type: "output_text", text: "```companion-plan\n{bad}\n```" }] }), null);
});

test("工具与进度消息共用状态机，切换通道保留步骤时间且来源跟随最新快照", () => {
  const state = applyPlanEvents(createPlanState(), parsePlanEvents([
    event("2026-10-28T10:00:00Z", "task_started"),
    messagePlan("2026-10-28T10:00:10Z", [["检查", "in_progress"], ["验证", "pending"]]),
    execPlan("2026-10-28T10:01:00Z", [["检查", "completed"], ["验证", "in_progress"]])
  ].join("\n")));
  assert.equal(currentPlan(state).source, undefined, "工具快照不沿用消息来源");
  applyPlanEvents(state, parsePlanEvents(messagePlan("2026-10-28T10:02:00Z", [["检查", "completed"], ["验证", "completed"]])));
  const plan = currentPlan(state);
  assert.equal(plan.source, "message");
  assert.equal(plan.steps[0].start, Date.parse("2026-10-28T10:00:10Z"));
  assert.equal(plan.steps[1].start, Date.parse("2026-10-28T10:01:00Z"));
  assert.equal(planSummary(plan).done, 2);
  assert.equal(planSummary(plan).source, "message");
  applyPlanEvents(state, parsePlanEvents(event("2026-10-28T10:03:00Z", "task_started")));
  assert.equal(currentPlan(state), null, "上一回合完成的消息计划也应过期");
});

test("无计划工具的动态看板：带说明的 rollout 增量推送当前步骤、总规划与 Trace", async (t) => {
  const dir = await withDir(t);
  const codexHome = join(dir, "codex");
  const path = await writeRollout(codexHome, ID, [
    event("2026-10-28T10:00:00Z", "task_started"),
    messagePlan("2026-10-28T10:00:10Z", [["检查", "in_progress"], ["验证", "pending"]], undefined, { before: "当前会话没有 update_plan，改用进度快照。\n\n", after: "\n\n先检查现状。" })
  ]);
  const sessions = new CodexSessions({ codexHome, now: () => Date.parse("2026-10-28T10:01:00Z") });
  const service = createService({ taskBoard: new TaskBoardStorage({ path: join(dir, "board.json") }), codexSessions: sessions });
  const first = await service.methods.add({ threadId: ID, title: "无工具计划" }, context);
  assert.equal(first.tasks[0].plan.total, 2);
  assert.equal(first.tasks[0].plan.done, 0);
  assert.equal(first.tasks[0].plan.active, 0);
  assert.equal(first.tasks[0].activity, "检查", "不把代码块标记显示为当前动作");
  const next = messagePlan("2026-10-28T10:00:30Z", [["检查", "completed"], ["验证", "in_progress"]], undefined, { after: "\n\n正在验证结果。" });
  await appendFile(path, next.slice(0, 50));
  assert.equal((await sessions.plan(ID)).steps[0].status, "in_progress", "半行先不解析");
  const watching = service.methods.watch({ since: first.sig, waitMs: 1000 }, context);
  await appendFile(path, `${next.slice(50)}\n`);
  const update = await watching;
  assert.notEqual(update.sig, first.sig);
  assert.deepEqual(update.tasks[0].plan, { total: 2, done: 1, active: 1, steps: [
    { text: "检查", status: "completed" }, { text: "验证", status: "in_progress" }
  ], source: "message" });
  assert.equal(update.tasks[0].activity, "验证");
  const trace = await service.methods.trace({ threadId: ID }, context);
  assert.equal(trace.plan.source, "message");
  assert.equal(trace.plan.steps[1].start, Date.parse("2026-10-28T10:00:30Z"));
  assert.deepEqual(trace.turns.at(-1).notes, [], "结构化计划不混入普通文字进展列表");
  await appendFile(path, `${messagePlan("2026-10-28T10:00:45Z", [["检查", "completed"], ["验证", "completed"]])}\n`);
  assert.equal((await service.methods.list({}, context)).tasks[0].plan.done, 2);
});

test("步骤计时：进行中从首次标记算起，直接跳到完成的从前一步完成算起；改措辞按位置对上", () => {
  const state = applyPlanEvents(createPlanState(), parsePlanEvents([
    event("2026-10-28T10:00:00Z", "task_started"),
    execPlan("2026-10-28T10:00:10Z", [["检查", "in_progress"], ["改名", "pending"], ["测试", "pending"]]),
    execPlan("2026-10-28T10:01:10Z", [["检查", "completed"], ["改名", "in_progress"], ["测试", "pending"]], "条件已确认"),
    // 改名完成并顺手做完了「跑测试」（措辞也改了）。
    execPlan("2026-10-28T10:05:10Z", [["检查", "completed"], ["改名", "completed"], ["跑测试", "completed"]]),
    "{坏行"
  ].join("\n")));
  const at = (iso) => Date.parse(iso);
  const plan = currentPlan(state);
  assert.equal(plan.createdAt, at("2026-10-28T10:00:10Z"));
  assert.deepEqual(plan.steps, [
    { text: "检查", status: "completed", start: at("2026-10-28T10:00:10Z"), end: at("2026-10-28T10:01:10Z"), inferred: false },
    { text: "改名", status: "completed", start: at("2026-10-28T10:01:10Z"), end: at("2026-10-28T10:05:10Z"), inferred: false },
    { text: "跑测试", status: "completed", start: at("2026-10-28T10:05:10Z"), end: at("2026-10-28T10:05:10Z"), inferred: true }
  ]);
  assert.equal(plan.explanation, null, "说明取最新一份快照");
  assert.deepEqual(planSummary(plan), { total: 3, done: 3, active: null, steps: plan.steps.map(({ text, status }) => ({ text, status })) });
});

test("计划是否过期：本回合的有效；上个回合没做完的还算；全部完成或更早的过期；大半步骤换了算新计划", () => {
  const state = applyPlanEvents(createPlanState(), parsePlanEvents([
    event("2026-10-28T10:00:00Z", "task_started"),
    execPlan("2026-10-28T10:00:10Z", [["a", "completed"], ["b", "in_progress"]])
  ].join("\n")));
  assert.equal(currentPlan(state).steps[1].status, "in_progress");
  applyPlanEvents(state, [{ type: "turn", at: Date.parse("2026-10-28T10:10:00Z") }]);
  assert.ok(currentPlan(state), "用户中途回复后，上个回合没做完的计划还在");
  applyPlanEvents(state, [{ type: "turn", at: Date.parse("2026-10-28T10:20:00Z") }]);
  assert.equal(currentPlan(state), null, "隔了两个回合就过期");
  applyPlanEvents(state, parsePlanEvents(execPlan("2026-10-28T10:21:00Z", [["a", "pending"], ["x", "pending"], ["y", "pending"]])));
  assert.equal(currentPlan(state).createdAt, Date.parse("2026-10-28T10:21:00Z"), "过期的计划不再接续");
  applyPlanEvents(state, parsePlanEvents(execPlan("2026-10-28T10:21:30Z", [["x", "in_progress"], ["p", "pending"], ["q", "pending"], ["r", "pending"]])));
  assert.equal(currentPlan(state).createdAt, Date.parse("2026-10-28T10:21:30Z"), "相同的步骤不到一半，算新计划");
  applyPlanEvents(state, parsePlanEvents(execPlan("2026-10-28T10:21:40Z", [["x", "in_progress"], ["p", "pending"], ["q2", "pending"]])));
  assert.equal(currentPlan(state).createdAt, Date.parse("2026-10-28T10:21:30Z"), "删改个别步骤仍是同一份计划");
  applyPlanEvents(state, parsePlanEvents(execPlan("2026-10-28T10:22:00Z", [["x", "completed"], ["p", "completed"], ["q2", "completed"]])));
  applyPlanEvents(state, [{ type: "turn", at: Date.parse("2026-10-28T10:30:00Z") }]);
  assert.equal(currentPlan(state), null, "上个回合已经全部完成");
});

test("会话计划：增量读取新增内容，半行留到下次，并发读取不重复计入回合", async (t) => {
  const codexHome = await withDir(t);
  const path = await writeRollout(codexHome, ID, [
    event("2026-10-28T10:00:00Z", "task_started"),
    execPlan("2026-10-28T10:00:10Z", [["检查", "in_progress"], ["改名", "pending"]])
  ]);
  const sessions = new CodexSessions({ codexHome });
  assert.deepEqual((await sessions.plan(ID)).steps.map((step) => step.status), ["in_progress", "pending"]);
  const next = execPlan("2026-10-28T10:02:00Z", [["检查", "completed"], ["改名", "in_progress"]]);
  await appendFile(path, next.slice(0, 40));
  assert.deepEqual((await sessions.plan(ID)).steps.map((step) => step.status), ["in_progress", "pending"], "没写完的一行先不读");
  await appendFile(path, `${next.slice(40)}\n`);
  const [first, second] = await Promise.all([sessions.plan(ID), sessions.plan(ID)]);
  assert.deepEqual(first.steps.map((step) => step.status), ["completed", "in_progress"]);
  assert.deepEqual(second, first);
  await appendFile(path, `${event("2026-10-28T10:03:00Z", "task_complete")}\n${event("2026-10-28T10:04:00Z", "task_started")}\n${event("2026-10-28T10:05:00Z", "task_started")}\n`);
  assert.equal(await sessions.plan(ID), null, "两个回合以前的计划过期");
  assert.equal(await sessions.plan("01a18216-3b02-7db0-b394-000000000000"), null);
});

test("会话计划：长回合开头在 2MB 窗口之外时扩大到 16MB 找回合开头", async (t) => {
  const codexHome = await withDir(t);
  const filler = item("2026-10-28T10:00:20Z", { type: "function_call_output", call_id: "x", output: "x".repeat(4000) });
  await writeRollout(codexHome, ID, [
    event("2026-10-28T10:00:00Z", "task_started"),
    execPlan("2026-10-28T10:00:10Z", [["很早列的计划", "in_progress"]]),
    ...Array.from({ length: 700 }, () => filler)
  ]);
  const plan = await new CodexSessions({ codexHome }).plan(ID);
  assert.equal(plan.steps[0].text, "很早列的计划");
});

test("看板与 Trace 带上计划：条目给摘要，Trace 给每步起止时间", async (t) => {
  const dir = await withDir(t);
  const codexHome = join(dir, "codex");
  await writeRollout(codexHome, ID, [
    event("2026-10-28T10:00:00Z", "task_started"),
    item("2026-10-28T10:00:05Z", { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "我先看看工作区" }] }),
    execPlan("2026-10-28T10:00:10Z", [["检查", "completed"], ["改名", "in_progress"], ["测试", "pending"]])
  ]);
  const service = createService({ taskBoard: new TaskBoardStorage({ path: join(dir, "board.json") }), codexSessions: new CodexSessions({ codexHome, now: () => Date.parse("2026-10-28T10:01:00Z") }) });
  const board = await service.methods.add({ threadId: ID, title: "改名" }, context);
  assert.deepEqual(board.tasks[0].plan, { total: 3, done: 1, active: 1, steps: [{ text: "检查", status: "completed" }, { text: "改名", status: "in_progress" }, { text: "测试", status: "pending" }] });
  const trace = await service.methods.trace({ threadId: ID }, context);
  assert.equal(trace.plan.steps[1].start, Date.parse("2026-10-28T10:00:10Z"));
  assert.deepEqual(trace.turns.at(-1).notes, [{ at: Date.parse("2026-10-28T10:00:05Z"), text: "我先看看工作区" }]);
});

test("提示块：加上与删除都保留原有文字，重复加入不叠加，旧版说明文字也能认出", () => {
  const original = "# 我的习惯\n\n- 用中文回答\n";
  const added = withHint(original);
  assert.ok(added.startsWith(original) && hasHint(added));
  assert.equal(withHint(added), added);
  assert.equal(withoutHint(added), original);
  assert.equal(withoutHint(original), original);
  assert.equal(withoutHint(withHint("")), "");
  const middle = `前面\n\n${PLAN_HINT_START}\n旧内容\n${PLAN_HINT_END}\n后面\n`;
  assert.equal(withoutHint(middle), "前面\n\n后面\n");
  const older = "前面\n\n<!-- agent-companion:plan-hint 旧说明 -->\n旧内容\n<!-- /agent-companion:plan-hint -->\n";
  assert.equal(withoutHint(older), "前面\n");
});

test("提示开关：写进 Codex 实际读取的文件，跟随符号链接、保留权限；关掉后删掉自己新建的文件", async (t) => {
  const codexHome = await withDir(t);
  const hint = createPlanHint({ codexHome });
  assert.equal(await hint.set(false), false, "没有文件时关闭什么也不做");
  await assert.rejects(stat(join(codexHome, "AGENTS.md")), { code: "ENOENT" });
  assert.equal(await hint.set(true), true);
  assert.deepEqual(await hint.status(), { enabled: true, path: join(codexHome, "AGENTS.md"), planTool: "companion" });
  assert.equal(await hint.set(true), false, "已经有了不再改写");
  assert.equal(await hint.set(false), true);
  await assert.rejects(stat(join(codexHome, "AGENTS.md")), { code: "ENOENT" }, "文件是开关新建的，关掉后删除");
  await assert.rejects(stat(join(codexHome, "config.toml")), { code: "ENOENT" }, "config.toml 也是开关新建的");

  // 用户的 AGENTS.md 是指向 dotfiles 的链接，权限 0600。
  const real = join(codexHome, "dotfiles.md");
  await writeFile(real, "我的规则\n", { mode: 0o600 });
  await symlink(real, join(codexHome, "AGENTS.md"));
  await hint.set(true);
  assert.ok(hasHint(await readFile(real, "utf8")));
  assertMode(await stat(real), 0o600);
  await hint.set(false);
  assert.equal(await readFile(real, "utf8"), "我的规则\n");

  // AGENTS.override.md 非空时 Codex 只读它。
  await writeFile(join(codexHome, "AGENTS.override.md"), "覆盖\n");
  await hint.set(true);
  assert.ok(hasHint(await readFile(join(codexHome, "AGENTS.override.md"), "utf8")));
  assert.equal(await readFile(real, "utf8"), "我的规则\n");
  await hint.set(false);
  assert.equal(await readFile(join(codexHome, "AGENTS.override.md"), "utf8"), "覆盖\n");
});

const BLOCK = `${PLAN_TOOL_MARKER}\n${PLAN_TOOL_SNIPPET}\n`;
const CODEX_CONFIG = 'model = "gpt-5"\n\n[mcp_servers.node_repl]\ncommand = "node"\ntools = ["eval"]\n\n[projects."/Users/me/app"]\ntrust_level = "trusted"\n';

test("config.toml：追加到末尾、去掉后原样恢复；Codex 之后在后面追加的表保留", () => {
  const added = withPlanTool(CODEX_CONFIG);
  assert.equal(added, `${CODEX_CONFIG}\n${BLOCK}`);
  assert.ok(hasPlanTool(added));
  assert.equal(withPlanTool(added), added, "重复开启不叠加");
  assert.equal(withoutPlanTool(added), CODEX_CONFIG);
  assert.equal(withPlanTool(""), BLOCK);
  assert.equal(withoutPlanTool(BLOCK), "");
  assert.equal(withoutPlanTool(CODEX_CONFIG), CODEX_CONFIG);
  // Codex 信任新项目时用 toml_edit 把新表加在文件末尾，也就是我们这段后面。
  const project = '[projects."/Users/me/new"]\ntrust_level = "trusted"\n';
  assert.equal(withoutPlanTool(`${added}${project}`), `${CODEX_CONFIG}\n${project}`);
  assert.equal(withoutPlanTool(`${added}\n# 新项目\n${project}`), `${CODEX_CONFIG}\n# 新项目\n${project}`, "下一张表前的注释属于那张表");
  const crowded = `${CODEX_CONFIG}${PLAN_TOOL_MARKER}\n[tools.update_plan]\n\nenabled = true\n\n\n${project}`;
  assert.ok(hasPlanTool(crowded));
  assert.equal(withoutPlanTool(crowded), `${CODEX_CONFIG}\n${project}`);
});

test("config.toml：用户自己配过 update_plan 或改过这张表，开关不碰", () => {
  for (const own of [
    `${CODEX_CONFIG}\n[tools.update_plan]\nenabled = false\n`,
    `${CODEX_CONFIG}\n${PLAN_TOOL_MARKER}\n[tools.update_plan]\nenabled = true\nextra = 1\n`,
    `${CODEX_CONFIG}\n${PLAN_TOOL_MARKER}\n[tools.update_plan]\nenabled = false\n`,
    `[tools]\nupdate_plan = { enabled = true }\n${CODEX_CONFIG}`,
    `tools = { web_search = true }\n${CODEX_CONFIG}`,
    `tools.web_search = true\n${CODEX_CONFIG}`
  ]) {
    assert.equal(hasPlanTool(own), false, own);
    assert.equal(userPlanTool(own), true, own);
    assert.equal(withPlanTool(own), own, own);
    assert.equal(withoutPlanTool(own), own, own);
  }
  for (const fine of [`[tools]\nweb_search = true\n${CODEX_CONFIG}`, `# 以后试试 update_plan\n${CODEX_CONFIG}`]) {
    assert.equal(userPlanTool(fine), false, fine);
    assert.equal(withoutPlanTool(withPlanTool(fine)), fine);
  }
});

test("config.toml 开关：保留原内容与 0600 权限、跟随符号链接；用户自己配置的不改；写不了时提示仍生效并报错", async (t) => {
  const codexHome = await withDir(t);
  const hint = createPlanHint({ codexHome });
  const real = join(codexHome, "dotfiles-config.toml");
  await writeFile(real, CODEX_CONFIG, { mode: 0o600 });
  await symlink(real, join(codexHome, "config.toml"));
  assert.equal(await hint.set(true), true);
  assert.equal(await readFile(real, "utf8"), `${CODEX_CONFIG}\n${BLOCK}`);
  assertMode(await stat(real), 0o600);
  assert.equal((await hint.status()).planTool, "companion");
  await hint.set(false);
  assert.equal(await readFile(real, "utf8"), CODEX_CONFIG);
  assert.equal((await hint.status()).planTool, "off");

  const own = `${CODEX_CONFIG}\n[tools.update_plan]\nenabled = false\n`;
  await writeFile(real, own);
  await hint.set(true);
  assert.equal(await readFile(real, "utf8"), own, "以用户的设置为准");
  assert.equal((await hint.status()).planTool, "user");
  await hint.set(false);
  assert.equal(await readFile(real, "utf8"), own);

  const fresh = await withDir(t);
  const created = createPlanHint({ codexHome: fresh });
  await created.set(true);
  assertMode(await stat(join(fresh, "config.toml")), 0o600);

  const broken = await withDir(t);
  await symlink(join(broken, "missing.toml"), join(broken, "config.toml"));
  const partial = createPlanHint({ codexHome: broken });
  await assert.rejects(partial.set(true), { code: "PLAN_TOOL_CONFIG" });
  assert.ok(hasHint(await readFile(join(broken, "AGENTS.md"), "utf8")), "提示照常写入");
});

test("任务看板服务：只在配置明确给出开关时动文件，看板或 Companion 停用时删除；平台把配置转给卡片服务", async () => {
  const calls = [];
  const service = createService({ planHint: { set: async (value) => { calls.push(value); return true; } } });
  await service.applyConfig({ enabled: true, cards: { tasks: { enabled: true, settings: {} } } });
  assert.deepEqual(calls, [], "没碰过开关不读不写");
  await service.applyConfig({ enabled: true, cards: { tasks: { enabled: true, settings: { planHint: true } } } });
  await service.applyConfig({ enabled: true, cards: { tasks: { enabled: true, settings: { planHint: true, switcher: false } } } });
  await service.applyConfig({ enabled: true, cards: { tasks: { enabled: false, settings: { planHint: true } } } });
  await service.applyConfig({ enabled: false, cards: { tasks: { enabled: true, settings: { planHint: true } } } });
  await service.applyConfig({ enabled: true, cards: { tasks: { enabled: true, settings: { planHint: true } } } });
  assert.deepEqual(calls, [true, false, true], "期望值不变时不重复改写");

  const seen = [];
  const warnings = [];
  const registry = new ServiceRegistry({
    manifests: [{ id: "broken", defaultEnabled: true }, { id: "fine", defaultEnabled: true }],
    modules: {
      broken: { createService: () => ({ applyConfig: async () => { throw Object.assign(new Error("x"), { code: "EACCES" }); } }) },
      fine: { createService: () => ({ applyConfig: async (config) => seen.push(config.revision) }) }
    },
    loadConfig: async () => ({}), logger: { warn: (message) => warnings.push(message) }
  });
  await registry.applyConfig({ revision: 7, enabled: true, cards: {} });
  assert.deepEqual(seen, [7], "一张卡失败不影响其它卡");
  assert.match(warnings[0], /broken.*EACCES/);
});

test("卸载时删掉提示，只动带标记的那一段", async (t) => {
  const home = await withDir(t);
  await mkdir(join(home, ".codex"), { recursive: true });
  await writeFile(join(home, ".codex", "AGENTS.md"), withHint("我的规则\n"));
  const result = await uninstallAgent({ hostPlatform: "darwin", home, env: {}, helperPath: null, uid: 501, label: "local.test.agent",
    runtimeState: { load: async () => null }, execFileImpl: async () => {} });
  assert.equal(result.planHintRemoved, true);
  assert.equal(await readFile(join(home, ".codex", "AGENTS.md"), "utf8"), "我的规则\n");
});
