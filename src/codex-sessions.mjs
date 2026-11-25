import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { applyPlanEvents, createPlanState, currentPlan, parsePlanEvents, planFromMessage } from "./codex-plan.mjs";

// 只读 Codex 本机会话数据：session_index.jsonl 里的会话名，以及 rollout 尾部的回合事件。
// 为了在看板上显示「正在做什么」，会返回一行截短的进度：工具与命令首行、修改的文件名、
// Codex 的进度说明或最后一句回复。只经 loopback 交给本机 Codex 页面里的看板，不落盘。

export const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{7,127}$/;
const TAIL_BYTES = [128 * 1024, 2 * 1024 * 1024];
const INDEX_FILE_LIMIT = 16 * 1024 * 1024;
const STATE_FILE_LIMIT = 32 * 1024 * 1024;
const CLIENT_PREFIX = "client-new-thread:";
// 回合开始后长时间没有任何写入（进程退出、崩溃），不再当作进行中。
export const STALLED_AFTER_MS = 15 * 60_000;
const MISS_CACHE_MS = 60_000;
const LIFECYCLE = { task_started: "running", task_complete: "idle", turn_aborted: "interrupted" };
// turn_aborted 的 reason：interrupted 是用户自己点停止 / 按 Esc，replaced 是发了新消息顶掉正在跑的回合，
// 都是用户主动的，记为 stopped（已停止，不算需要处理）；没有 reason 或其它原因仍按异常中断。
const USER_STOP_REASONS = new Set(["interrupted", "replaced"]);
export const abortStatus = (payload) => (USER_STOP_REASONS.has(payload?.reason) ? "stopped" : "interrupted");
// 计划快照可能远在尾部窗口之前（一步就能写出几 MB 输出）：首次按 2MB → 16MB 往前找到回合开头，之后只读新增部分。
const PLAN_WINDOWS = [2 * 1024 * 1024, 16 * 1024 * 1024];
const PLAN_CACHE_LIMIT = 64;
const MAX_TURN_NOTES = 20;
// session_meta 第一行带完整的 base_instructions，一般几十 KB；超过这个长度仍没有换行就当作读不出来。
const META_LINE_LIMIT = 4 * 1024 * 1024;
const DAY_MS = 86_400_000;

export function defaultCodexHome({ env = process.env, home = homedir() } = {}) {
  return env.CODEX_HOME && isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : join(home, ".codex");
}

// UUIDv7 前 48 位是毫秒时间戳，对应 sessions/YYYY/MM/DD 的本地日期目录。
export function threadCreatedAt(id) {
  const hex = String(id).replaceAll("-", "").slice(0, 12);
  if (!/^[0-9a-f]{12}$/i.test(hex)) return null;
  const ms = Number.parseInt(hex, 16);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

const pad = (value) => String(value).padStart(2, "0");
const dayDir = (root, ms) => {
  const date = new Date(ms);
  return join(root, String(date.getFullYear()), pad(date.getMonth() + 1), pad(date.getDate()));
};

/**
 * 新会话自动加入看板用：session_meta 是否是用户在 Codex 桌面端自己新开的会话。
 * - thread_source 缺省或为 user（自动化、子代理等其它来源不算）；
 * - source 是字符串且不是 exec / mcp（子代理的 source 是对象）；桌面端的 source 本身就是 "vscode"；
 * - 不是侧边对话（attached_thread 为 true 的分叉会话挂在原会话旁边）；
 * - originator 不是终端或其它客户端（桌面端为 "Codex Desktop"，终端为 "codex-tui"）。
 */
export function isDesktopUserSession(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.thread_source !== undefined && payload.thread_source !== null && payload.thread_source !== "user") return false;
  if (typeof payload.source !== "string" || payload.source === "exec" || payload.source === "mcp") return false;
  if (payload.attached_thread === true) return false;
  return !/tui|exec|cli|vscode/i.test(String(payload.originator ?? ""));
}

async function findIn(directory, suffix) {
  try {
    const name = (await readdir(directory)).find((entry) => entry.startsWith("rollout-") && entry.endsWith(suffix));
    return name ? join(directory, name) : null;
  } catch { return null; }
}

async function walk(directory, suffix, depth) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(suffix)) return join(directory, entry.name);
  }
  if (depth === 0) return null;
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
    const found = await walk(join(directory, entry.name), suffix, depth - 1);
    if (found) return found;
  }
  return null;
}

// 最后一个非空行（去掉收尾的标点装饰）以问号结束，视为在等用户回答。
export function endsWithQuestion(text) {
  if (typeof text !== "string") return false;
  const line = text.trimEnd().split("\n").at(-1).replace(/[\s*_`'"’”」』)）\]】~～。.!！:：]+$/u, "");
  return /[?？]$/u.test(line);
}

const LINE_LIMIT = 80;

// request_user_input 参数里的第一个问题标题。
function questionTitle(args) {
  try {
    const input = typeof args === "string" ? JSON.parse(args) : args;
    const question = input?.questions?.[0];
    return firstLine(question?.title ?? question?.question ?? question?.header ?? null);
  } catch {
    return null;
  }
}

// 取第一行有内容的文字，去掉 Markdown 记号并截短。
export function firstLine(text, limit = LINE_LIMIT) {
  if (typeof text !== "string") return null;
  const line = text.split("\n").map((item) => item.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[`*_#>]+/g, "").replace(/^\s*[-•]\s*/, "").trim()).find(Boolean);
  if (!line) return null;
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

// 问句收尾时取最后一个非空行作为问题，否则取第一行作为回复摘要。
function replySummary(text, asking) {
  if (typeof text !== "string") return null;
  return asking ? firstLine(text.trimEnd().split("\n").at(-1)) : firstLine(text);
}

const fileName = (path) => path.trim().split(/[\\/]/).filter(Boolean).at(-1) ?? path.trim();
const unescape = (value) => { try { return JSON.parse(`"${value}"`); } catch { return value; } };

// 工具调用 → 一行人话。exec 是 Codex 的 JS 编排工具，参数里的 tools.xxx(...) 才是真正的动作。
export function describeTool(name, input) {
  const text = typeof input === "string" ? input : JSON.stringify(input ?? "");
  const patch = text.match(/\*\*\* (Update|Add|Delete) File: ([^\n\\]+)/);
  if (patch) return `${{ Update: "修改", Add: "新建", Delete: "删除" }[patch[1]]} ${fileName(patch[2])}`;
  const calls = [...text.matchAll(/tools\.(\w+)\(/g)].map((match) => match[1]);
  const action = calls[0] ?? name;
  if (action === "exec_command" || action === "shell" || action === "local_shell") {
    const commands = [...text.matchAll(/\bcmd\\?"?\s*:\s*\\?"((?:[^"\\]|\\.)*)\\?"/g)].map((match) => unescape(match[1]));
    const command = firstLine(commands[0] ?? (Array.isArray(input?.command) ? input.command.join(" ") : ""), 60);
    if (calls.length > 1 || commands.length > 1) return `运行 ${Math.max(calls.length, commands.length)} 条命令${command ? ` · ${command}` : ""}`;
    return command ? `运行 ${command}` : "运行命令";
  }
  const labels = {
    update_plan: "更新计划", apply_patch: "修改文件", view_image: "查看图片", spawn_agent: "派出子代理",
    wait_agent: "等待子代理", wait: "等待子代理", send_message: "给子代理发消息", followup_task: "给子代理追加任务",
    list_agents: "查看子代理", interrupt_agent: "打断子代理", sleep: "等待中", js: "运行脚本", web_search: "搜索网页"
  };
  if (/request_user_input/.test(action)) return "在等你回答";
  return labels[action] ?? `调用 ${action}`;
}

/**
 * 解析 rollout 尾部文本，返回最后一个回合生命周期事件。首行可能被截断，解析失败的行直接跳过。
 * 回合以问句结束，或回合中有尚未得到回答的 request_user_input 调用时，状态为 asking。
 * 异步提问不阻塞回合：Codex 问完可能再补一句再结束回合，问题卡仍挂着等回答，所以回合结束后照样算 asking。
 * activity：进行中时最近的动作；summary：回合结束时的回复摘要（提问时是问题本身）。
 */
// inTurn：调用方确认这段文字只是文件尾部窗口。窗口里有回合内条目却没有任何回合事件，
// 说明回合开始在窗口之前且尚未结束（长回合的 task_started 可能在几 MB 之前）。
export function lastLifecycle(text, { inTurn = false } = {}) {
  let last = null;
  let sawItem = false;
  let activity = null;
  // 本回合 Codex 最近一次的进度说明；思考间隙显示它，比「思考中」更能看出做到哪了。
  let note = null;
  const pending = new Set();
  // 异步提问（request_user_input_async）的工具输出立即返回 accepted，
  // 要等用户回答（send_user_message_question_reply 消息里带着 call_id）才算答完。
  // call_id → 问题标题，用作摘要。
  const asking = new Map();
  // 还没回答的提问各自是什么时候问的（call_id → 毫秒）。回合中途提问时，「这次结果」的时间是提问时间，
  // 不是回合开始时间，否则加入看板或看过会话之后的新提问永远算不上未读。
  const askedAt = new Map();
  for (const line of text.split("\n")) {
    if (line.includes("\"response_item\"")) {
      sawItem = true;
      if (asking.size && line.includes("send_user_message_question_reply")) {
        for (const callId of asking.keys()) if (line.includes(callId)) { asking.delete(callId); askedAt.delete(callId); }
      }
      // 工具输出可能很大，只抠 call_id，不整行解析。
      if (line.includes("_call_output\"")) {
        const callId = line.match(/"call_id":"([^"]+)"/)?.[1];
        if (callId && pending.delete(callId)) askedAt.delete(callId);
        activity = "思考中";
        continue;
      }
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const payload = record.payload ?? {};
      if (payload.type === "reasoning") activity = "思考中";
      else if (payload.type === "message" && payload.role === "assistant") {
        const plan = planFromMessage(payload);
        const progress = plan && (plan.steps.find(step => step.status === "in_progress")?.text
          || `计划 ${plan.steps.filter(step => step.status === "completed").length}/${plan.steps.length} 步`);
        note = (plan ? progress : firstLine((payload.content ?? []).map((part) => part?.text ?? "").join("\n"))) ?? note;
        activity = note ?? activity;
      } else if (payload.type === "function_call" || payload.type === "custom_tool_call") {
        const asked = /request_user_input_async/.test(payload.name ?? "") ? "async" : /request_user_input/.test(payload.name ?? "") ? "sync" : null;
        if (asked === "async") asking.set(payload.call_id, questionTitle(payload.arguments));
        else if (asked === "sync") pending.add(payload.call_id);
        if (asked) askedAt.set(payload.call_id, Date.parse(record.timestamp));
        activity = describeTool(payload.name, payload.arguments ?? payload.input);
      }
      continue;
    }
    if (!line.includes("\"event_msg\"")) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const payload = record?.payload;
    let status = record?.type === "event_msg" ? LIFECYCLE[payload?.type] : undefined;
    if (!status) continue;
    if (payload.type === "turn_aborted") status = abortStatus(payload);
    if (status === "running") { pending.clear(); asking.clear(); askedAt.clear(); activity = "思考中"; note = null; }
    if (status === "idle" && endsWithQuestion(payload.last_agent_message)) status = "asking";
    const at = Date.parse(record.timestamp);
    last = { status, at: Number.isFinite(at) ? at : null, summary: replySummary(payload.last_agent_message, status === "asking") };
  }
  if (!last && inTurn && sawItem) last = { status: "running", at: null, summary: null };
  if (last && !["running", "interrupted", "stopped"].includes(last.status) && asking.size) {
    last.status = "asking";
    last.summary = [...asking.values()].findLast(Boolean) ?? last.summary;
  }
  if (last?.status === "running") {
    const waiting = pending.size + asking.size > 0;
    if (waiting) last.status = "asking";
    last.activity = waiting ? "在等你回答" : activity === "思考中" && note ? note : activity;
  }
  // 回合中途提问：结果时间取最近一次还没回答的提问（回合结束后才算 asking 的，回合结束时间本来就更晚）。
  if (last?.status === "asking") {
    const latest = Math.max(...[...askedAt.values()].filter(Number.isFinite));
    if (Number.isFinite(latest) && !(last.at >= latest)) last.at = latest;
  }
  return last;
}

// 工具归到哪条泳道：命令、改文件、子代理、等你回答，其余归「其它」。
export function toolLane(name, input) {
  const text = typeof input === "string" ? input : JSON.stringify(input ?? "");
  if (/request_user_input/.test(name ?? "") || /request_user_input/.test(text)) return "you";
  if (/\*\*\* (Update|Add|Delete) File:/.test(text) || name === "apply_patch") return "edit";
  const action = text.match(/tools\.(\w+)\(/)?.[1] ?? name;
  if (/^(exec_command|shell|local_shell|js|write_stdin)$/.test(action)) return "shell";
  if (/agent|send_message|followup_task|^wait$/.test(action)) return "agent";
  return "other";
}

const stampOf = (line) => Date.parse(line.match(/"timestamp":"([^"]+)"/)?.[1]);
const MAX_TRACE_TURNS = 6;

/**
 * 单个会话的 Trace：把最近几个回合切成首尾相接的段。
 * 模型段（think 思考 / reply 回复 / call 组织工具调用）以上一个事件为起点、条目写入时刻为终点；
 * 工具段以调用与输出配对（call_id），一次响应结束（token_count）前工具不会真正开始。
 * token 只在一次模型响应结束后写入，挂在这次响应的最后一段上。进行中的回合最后一段 end 为 null。
 */
export function parseTrace(text) {
  const turns = [];
  let model = null;
  let contextWindow = null;
  let turn = null;
  let cursor = 0;
  let group = [];
  const pending = new Map();
  const push = (segment) => { turn.segments.push(segment); return segment; };
  const modelSegment = (kind, at, label) => {
    if (at - cursor < 1) { cursor = Math.max(cursor, at); return null; }
    // 连续几段思考（多条推理摘要）合成一段。
    const previous = turn.segments.at(-1);
    if (kind === "think" && previous?.kind === "think" && previous.end === cursor && group.includes(previous)) {
      previous.end = at;
      cursor = at;
      return previous;
    }
    const segment = push({ kind, lane: "model", start: cursor, end: at, label });
    group.push(segment);
    cursor = at;
    return segment;
  };
  for (const line of text.split("\n")) {
    if (line.includes("\"turn_context\"")) { model = line.match(/"model":"([^"]+)"/)?.[1] ?? model; continue; }
    const at = stampOf(line);
    if (!Number.isFinite(at)) continue;
    const event = line.includes("\"event_msg\"") && line.match(/"payload":\{"type":"(\w+)"/)?.[1];
    if (event === "task_started") {
      if (turn && turn.end === null) { turn.end = at; turn.status = "interrupted"; }
      turn = { start: at, end: null, status: "running", ttftMs: null, asking: false, segments: [], notes: [], tokens: { input: 0, output: 0, reasoning: 0 } };
      turns.push(turn);
      cursor = at;
      group = [];
      pending.clear();
      continue;
    }
    if (!turn || turn.end !== null) continue;
    if (event === "task_complete" || event === "turn_aborted") {
      let record;
      try { record = JSON.parse(line); } catch { record = null; }
      turn.end = at;
      turn.status = event === "turn_aborted" ? abortStatus(record?.payload) : "done";
      turn.ttftMs = Number.isFinite(record?.payload?.time_to_first_token_ms) ? record.payload.time_to_first_token_ms : null;
      turn.asking = event === "task_complete" && endsWithQuestion(record?.payload?.last_agent_message);
      for (const segment of pending.values()) segment.end = at;
      pending.clear();
      continue;
    }
    if (event === "token_count") {
      let usage;
      try { usage = JSON.parse(line).payload?.info; } catch { continue; }
      contextWindow = usage?.model_context_window ?? contextWindow;
      const last = usage?.last_token_usage;
      if (!last) continue;
      turn.tokens.input = last.input_tokens ?? turn.tokens.input;
      turn.tokens.output += last.output_tokens ?? 0;
      turn.tokens.reasoning += last.reasoning_output_tokens ?? 0;
      const tail = group.at(-1);
      if (tail) {
        const busy = group.reduce((sum, segment) => sum + (segment.end - segment.start), 0);
        tail.tokens = { output: last.output_tokens ?? 0, reasoning: last.reasoning_output_tokens ?? 0, perSecond: busy > 0 ? Math.round(((last.output_tokens ?? 0) * 1000) / busy) : null };
      }
      group = [];
      // 工具在整次响应结束后才执行。
      for (const segment of pending.values()) segment.start = Math.max(segment.start, at);
      cursor = Math.max(cursor, at);
      continue;
    }
    if (!line.includes("\"response_item\"")) continue;
    if (line.includes("_call_output\"")) {
      const callId = line.match(/"call_id":"([^"]+)"/)?.[1];
      const segment = pending.get(callId);
      if (!segment) continue;
      pending.delete(callId);
      segment.end = at;
      const head = line.slice(line.indexOf("\"output\""), line.indexOf("\"output\"") + 200);
      segment.failed = /Script (failed|error)|Process exited with code [1-9]|"exit_code":\s*[1-9]/.test(head);
      if (!pending.size) cursor = Math.max(cursor, at);
      continue;
    }
    let payload;
    try { payload = JSON.parse(line).payload ?? {}; } catch { continue; }
    if (payload.type === "reasoning") modelSegment("think", at, "思考");
    else if (payload.type === "message" && payload.role === "assistant") {
      const plan = planFromMessage(payload);
      const text = plan ? "更新计划" : firstLine((payload.content ?? []).map((part) => part?.text ?? "").join("\n"));
      modelSegment("reply", at, text ?? "回复");
      // Codex 干活途中的进度说明（commentary）；没列计划时，Trace 用它们推断做过哪些阶段。
      if (text && !plan && payload.phase !== "final_answer") turn.notes = [...turn.notes, { at, text }].slice(-MAX_TURN_NOTES);
    } else if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      const input = payload.arguments ?? payload.input;
      const label = describeTool(payload.name, input);
      modelSegment("call", at, `准备${label}`);
      const lane = toolLane(payload.name, input);
      const segment = push({ kind: "tool", lane, start: at, end: null, label, failed: false });
      if (payload.call_id) pending.set(payload.call_id, segment);
    }
  }
  if (turn && turn.end === null) {
    // 最后一段还在进行：等工具，或模型正在思考/输出。
    if ([...pending.values()].some((segment) => segment.lane === "you")) turn.asking = true;
    if (!pending.size) push({ kind: "think", lane: "model", start: cursor, end: null, label: "思考中" });
  }
  return { model, contextWindow, turns: turns.slice(-MAX_TRACE_TURNS) };
}

async function readRange(path, start, end) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(Math.max(0, end - start));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

// 只取完整的行：窗口中途开始时丢掉第一段残行，末尾没写完的半行留到下次。used 为消费到的字节数。
function completeLines(buffer, skipFirst) {
  const from = skipFirst ? buffer.indexOf(10) + 1 : 0;
  if (skipFirst && from === 0) return { text: "", used: 0 };
  const last = buffer.lastIndexOf(10);
  if (last < from) return { text: "", used: from };
  return { text: buffer.subarray(from, last + 1).toString("utf8"), used: last + 1 };
}

async function readTail(path, size, bytes) {
  const handle = await open(path, "r");
  try {
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally { await handle.close(); }
}

export class CodexSessions {
  constructor({ codexHome = defaultCodexHome(), now = Date.now } = {}) {
    this.codexHome = codexHome;
    this.now = now;
    this.paths = new Map();
    this.misses = new Map();
    this.index = { mtimeMs: -1, size: -1, titles: new Map() };
    this.state = { mtimeMs: -1, size: -1, real: new Map(), client: new Map(), projects: new Map() };
    // rollout 路径 → { offset: 已读到的字节, state: 计划状态 }；多个长轮询并发时排队读，避免重复计入事件。
    this.plans = new Map();
    this.planQueue = Promise.resolve();
  }


  // 新会话自动加入看板用，与 AntigravitySessions 同一接口：是否是用户在桌面端自己新开的会话、创建时间。
  isUserSession(meta) { return isDesktopUserSession(meta); }
  createdAt(meta) { return threadCreatedAt(meta?.id); }
  /**
   * 新建会话在本次运行中，侧栏条目一直用客户端临时 id（local:client-new-thread:<uuid>），
   * 真实会话 id 在发出第一条消息后才分配；两者的绑定由 Codex 存在 .codex-global-state.json 的
   * client-thread-bindings-v1 里。旧版放在 electron-persisted-atom-state 下，26.1111 起按窗口放在
   * electron-owner-atoms:<hash> 下；这里在根和每个顶层对象里都找一遍，换命名空间时不至于失效。
   * 同一个文件里还有 thread-project-assignments（会话 id → { projectId }），侧栏按这个不透明的项目 id 分组。
   * 返回 { real: 客户端 id → 真实 id, client: 真实 id → 客户端 id, projects: 会话 id → 项目 id }，按文件变化缓存。
   */
  async bindings() {
    const path = join(this.codexHome, ".codex-global-state.json");
    let info;
    try { info = await stat(path); } catch { return this.state; }
    if (info.mtimeMs === this.state.mtimeMs && info.size === this.state.size) return this.state;
    if (info.size > STATE_FILE_LIMIT) return this.state;
    const real = new Map();
    const client = new Map();
    const projects = new Map();
    try {
      const root = JSON.parse(await readFile(path, "utf8"));
      const scopes = [root, ...Object.values(root ?? {})].filter((value) => value && typeof value === "object" && !Array.isArray(value));
      const entriesOf = (key) => scopes.flatMap((scope) => {
        const value = scope[key];
        return value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value) : [];
      });
      for (const [key, value] of entriesOf("client-thread-bindings-v1")) {
        const clientId = key.startsWith(CLIENT_PREFIX) ? key.slice(CLIENT_PREFIX.length) : null;
        if (!THREAD_ID_PATTERN.test(clientId ?? "") || typeof value !== "string" || !THREAD_ID_PATTERN.test(value)) continue;
        real.set(clientId, value);
        client.set(value, clientId);
      }
      for (const [key, value] of entriesOf("thread-project-assignments")) {
        const projectId = value?.projectId;
        if (!THREAD_ID_PATTERN.test(key) || typeof projectId !== "string" || !projectId || projectId.length > 1024) continue;
        projects.set(key, projectId);
      }
    } catch { return this.state; }
    this.state = { mtimeMs: info.mtimeMs, size: info.size, real, client, projects };
    return this.state;
  }

  /** 客户端临时 id 换成真实会话 id；没有绑定时原样返回。 */
  async canonicalId(id) {
    return (await this.bindings()).real.get(id) ?? id;
  }

  /** 同一会话的另一个 id（真实 id ↔ 客户端临时 id），侧栏可能用任一个。 */
  async aliases(id) {
    const { real, client } = await this.bindings();
    return [real.get(id), client.get(id)].filter(Boolean);
  }

  /** 会话在 Codex 侧栏里所属的项目 id（真实 id 与客户端临时 id 都查）；没有分配时为 null。 */
  async projectOf(id) {
    const { real, client, projects } = await this.bindings();
    return projects.get(id) ?? projects.get(real.get(id)) ?? projects.get(client.get(id)) ?? null;
  }

  /**
   * 今天和昨天两个日期目录里的会话记录文件（跨零点时昨天新建的也在内），目录不存在时为空。
   * 目录在但一时读不出来（如句柄用尽）时抛出：调用方靠「列表里没有」判断文件已不在，不能把读失败当成空目录。
   */
  async recentRollouts() {
    const sessions = join(this.codexHome, "sessions");
    const now = this.now();
    const paths = [];
    for (const directory of new Set([dayDir(sessions, now - DAY_MS), dayDir(sessions, now)])) {
      let names;
      try { names = await readdir(directory); }
      catch (error) {
        if (error?.code === "ENOENT" || error?.code === "ENOTDIR") continue;
        throw error;
      }
      for (const name of names) if (name.startsWith("rollout-") && name.endsWith(".jsonl")) paths.push(join(directory, name));
    }
    return paths;
  }

  /**
   * 会话记录第一行的 session_meta.payload。第一行还没写完或解析失败时为 null（调用方稍后再读）；
   * 第一行完整但不是 session_meta 时为空对象。
   */
  async sessionMeta(path) {
    const handle = await open(path, "r");
    try {
      const chunks = [];
      let total = 0;
      for (;;) {
        const buffer = Buffer.alloc(Math.min(64 * 1024, META_LINE_LIMIT - total));
        if (!buffer.length) return null;
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
        if (!bytesRead) return null;
        const chunk = buffer.subarray(0, bytesRead);
        const end = chunk.indexOf(10);
        chunks.push(end < 0 ? chunk : chunk.subarray(0, end));
        total += bytesRead;
        if (end >= 0) break;
      }
      const line = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      return line?.type === "session_meta" && line.payload && typeof line.payload === "object" && !Array.isArray(line.payload) ? line.payload : {};
    } catch { return null; } finally { await handle.close(); }
  }

  async locate(rawId) {
    const id = await this.canonicalId(rawId);
    const cached = this.paths.get(id);
    if (cached) {
      try { await stat(cached); return cached; } catch { this.paths.delete(id); }
    }
    if ((this.misses.get(id) ?? 0) > this.now()) return null;
    const suffix = `-${id}.jsonl`;
    const sessions = join(this.codexHome, "sessions");
    const created = threadCreatedAt(id);
    let found = null;
    if (created) {
      for (const offset of [0, -86_400_000, 86_400_000]) {
        found = await findIn(dayDir(sessions, created + offset), suffix);
        if (found) break;
      }
    }
    found ??= await walk(sessions, suffix, 3);
    if (found) this.paths.set(id, found);
    else this.misses.set(id, this.now() + MISS_CACHE_MS);
    return found;
  }

  async isArchived(rawId) {
    const id = await this.canonicalId(rawId);
    try {
      return (await readdir(join(this.codexHome, "archived_sessions"))).some((name) => name.includes(`-${id}.jsonl`));
    } catch { return false; }
  }

  /**
   * 会话当前状态：running / asking / idle / stopped / interrupted / stalled / archived / missing。
   * turnAt 为最后一个回合事件的时间，用来判断用户是否已经看过这次结果。
   */
  async status(id) {
    const path = await this.locate(id);
    if (!path) return { status: (await this.isArchived(id)) ? "archived" : "missing", updatedAt: null, turnAt: null, activity: null, summary: null };
    const info = await stat(path);
    let last = null;
    for (const [index, bytes] of TAIL_BYTES.entries()) {
      const final = index === TAIL_BYTES.length - 1;
      last = lastLifecycle(await readTail(path, info.size, bytes), { inTurn: final && bytes < info.size });
      if (last || bytes >= info.size) break;
    }
    const updatedAt = Math.round(info.mtimeMs);
    const base = { updatedAt, activity: last?.activity ?? null, summary: last?.summary ?? null };
    if (!last) return { ...base, status: "idle", turnAt: updatedAt };
    if (last.status === "running" && this.now() - updatedAt > STALLED_AFTER_MS) return { ...base, status: "stalled", turnAt: updatedAt };
    return { ...base, status: last.status, turnAt: last.at ?? updatedAt };
  }

  /** 单个会话最近几个回合的 Trace；长回合开头可能早于尾部窗口，按 2MB → 8MB 逐步加大。 */
  async trace(id) {
    const path = await this.locate(id);
    if (!path) return { model: null, contextWindow: null, turns: [], updatedAt: null };
    const info = await stat(path);
    let trace = null;
    for (const bytes of [2 * 1024 * 1024, 8 * 1024 * 1024]) {
      trace = parseTrace(await readTail(path, info.size, bytes));
      if (trace.turns.length >= MAX_TRACE_TURNS || bytes >= info.size) break;
    }
    const updatedAt = Math.round(info.mtimeMs);
    const last = trace.turns.at(-1);
    // 很久没有写入的「进行中」回合当作已中断，和看板的 stalled 判断一致。
    if (last?.end === null && this.now() - updatedAt > STALLED_AFTER_MS) {
      last.end = updatedAt;
      last.status = "stalled";
      for (const segment of last.segments) segment.end ??= updatedAt;
    }
    return { ...trace, updatedAt };
  }

  /** 会话当前的计划（Codex 自带 update_plan 的最新快照，带每步起止时间）；没有或已过期时为 null。 */
  plan(id) {
    const run = this.planQueue.then(() => this.readPlan(id));
    this.planQueue = run.catch(() => {});
    return run;
  }

  async readPlan(id) {
    const path = await this.locate(id);
    if (!path) return null;
    let size;
    try { size = (await stat(path)).size; } catch { return null; }
    let entry = this.plans.get(path);
    // 文件被截短，或新增内容比最大窗口还多：从尾部重新找起。
    if (entry && (size < entry.offset || size - entry.offset > PLAN_WINDOWS.at(-1))) entry = null;
    if (!entry) {
      for (const window of PLAN_WINDOWS) {
        const start = Math.max(0, size - window);
        const { text, used } = completeLines(await readRange(path, start, size), start > 0);
        const events = parsePlanEvents(text);
        if (start === 0 || window === PLAN_WINDOWS.at(-1) || events.some((event) => event.type === "turn")) {
          entry = { offset: start + used, state: applyPlanEvents(createPlanState(), events) };
          break;
        }
      }
      this.plans.set(path, entry);
      while (this.plans.size > PLAN_CACHE_LIMIT) this.plans.delete(this.plans.keys().next().value);
    } else if (size > entry.offset) {
      const { text, used } = completeLines(await readRange(path, entry.offset, size), false);
      applyPlanEvents(entry.state, parsePlanEvents(text));
      entry.offset += used;
    }
    return currentPlan(entry.state);
  }

  /** 单个会话记录文件的指纹，Trace 长轮询用。 */
  async stamp(id) {
    const path = await this.locate(id);
    if (!path) return "-";
    try { const info = await stat(path); return `${info.mtimeMs}:${info.size}`; } catch { return "x"; }
  }

  /** 看板涉及文件的 mtime/size 指纹；长轮询据此判断是否需要重新计算。 */
  async fingerprint(ids) {
    const parts = [];
    for (const path of [join(this.codexHome, "session_index.jsonl"), ...await Promise.all(ids.map((id) => this.locate(id)))]) {
      if (!path) { parts.push("-"); continue; }
      try { const info = await stat(path); parts.push(`${info.mtimeMs}:${info.size}`); } catch { parts.push("x"); }
    }
    return parts.join("|");
  }


  /** session_index.jsonl 中每个会话最新的名字（Codex 智能起名或用户 rename）。 */
  async titles() {
    const path = join(this.codexHome, "session_index.jsonl");
    let info;
    try { info = await stat(path); } catch { return new Map(); }
    if (info.mtimeMs === this.index.mtimeMs && info.size === this.index.size) return this.index.titles;
    if (info.size > INDEX_FILE_LIMIT) return this.index.titles;
    const titles = new Map();
    for (const line of (await readFile(path, "utf8")).split("\n")) {
      if (!line) continue;
      try {
        const { id, thread_name: name } = JSON.parse(line);
        if (typeof id === "string" && typeof name === "string" && name.trim()) titles.set(id, name.trim().slice(0, 200));
      } catch {}
    }
    this.index = { mtimeMs: info.mtimeMs, size: info.size, titles };
    return titles;
  }
}
