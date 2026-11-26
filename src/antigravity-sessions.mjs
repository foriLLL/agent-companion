import { execFile } from "node:child_process";
import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { STALLED_AFTER_MS, endsWithQuestion, firstLine } from "./codex-sessions.mjs";

// 只读 Antigravity 本机会话数据，接口与 CodexSessions 一致，任务看板换个数据源就能用：
// - conversation_summaries.db：Hub 侧栏用的会话摘要（标题、运行状态、等你处理的步骤、任务进度），
//   raw_summary 列是 exa.jetski_cortex_pb.CascadeTrajectorySummary（protobuf），这里按字段号容错解码；
// - brain/<id>/.system_generated/logs/transcript.jsonl：会话步骤记录，Trace 与回复摘要用。
// 不连语言服务器（要 CSRF token），不写任何文件。

const execFileAsync = promisify(execFile);
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRANSCRIPT_TAIL = [512 * 1024, 4 * 1024 * 1024];
const MAX_TRACE_TURNS = 6;
const DAY_MS = 86_400_000;
// CascadeRunStatus：IDLE 1 / RUNNING 2 / CANCELING 3 / BUSY 4。
const RUNNING_STATUS = new Set([2, 3, 4]);
const RUN_STATUS_NAMES = { CASCADE_RUN_STATUS_IDLE: 1, CASCADE_RUN_STATUS_RUNNING: 2, CASCADE_RUN_STATUS_CANCELING: 3, CASCADE_RUN_STATUS_BUSY: 4 };
// 回复没有结束时间：旧回合的最后一段回复按输出 token 估一个时长（只用于画 Trace）。
const ESTIMATED_TOKENS_PER_SECOND = 60;

export function defaultAntigravityDataDir({ env = process.env, home = homedir() } = {}) {
  const custom = env.AGENT_COMPANION_ANTIGRAVITY_DATA_DIR;
  return custom && isAbsolute(custom) ? custom : join(home, ".gemini", "antigravity");
}

// ---------- protobuf ----------

// 只认 varint / 64 位 / 长度前缀 / 32 位四种 wire type；任何越界或未知类型都当作这段数据坏了，返回已读出的部分。
function readVarint(buffer, offset) {
  let value = 0;
  let scale = 1;
  for (let index = offset; index < buffer.length && index < offset + 10; index += 1) {
    const byte = buffer[index];
    value += (byte & 0x7f) * scale;
    scale *= 128;
    if (byte < 0x80) return [value, index + 1];
  }
  return [null, buffer.length];
}

export function decodeMessage(buffer) {
  const fields = new Map();
  let offset = 0;
  while (offset < buffer.length) {
    const [key, next] = readVarint(buffer, offset);
    if (key === null) break;
    const field = Math.floor(key / 8);
    const wire = key % 8;
    let value;
    offset = next;
    if (wire === 0) {
      [value, offset] = readVarint(buffer, offset);
      if (value === null) break;
    } else if (wire === 2) {
      const [length, start] = readVarint(buffer, offset);
      if (length === null || start + length > buffer.length) break;
      value = buffer.subarray(start, start + length);
      offset = start + length;
    } else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4;
      if (offset + size > buffer.length) break;
      value = buffer.subarray(offset, offset + size);
      offset += size;
    } else break;
    if (!fields.has(field)) fields.set(field, []);
    fields.get(field).push(value);
  }
  return message(fields);
}

const EMPTY = message(new Map());
function message(fields) {
  const last = (field) => fields.get(field)?.at(-1);
  return {
    has: (field) => fields.has(field),
    int: (field) => (typeof last(field) === "number" ? last(field) : null),
    bool: (field) => last(field) === 1,
    str: (field) => (Buffer.isBuffer(last(field)) ? last(field).toString("utf8") : null),
    msg: (field) => (Buffer.isBuffer(last(field)) ? decodeMessage(last(field)) : EMPTY),
    msgs: (field) => (fields.get(field) ?? []).filter(Buffer.isBuffer).map(decodeMessage),
    // google.protobuf.Timestamp { 1 seconds, 2 nanos } → 毫秒
    time: (field) => {
      const value = last(field);
      if (!Buffer.isBuffer(value)) return null;
      const stamp = decodeMessage(value);
      const seconds = stamp.int(1);
      return seconds ? seconds * 1000 + Math.floor((stamp.int(2) ?? 0) / 1e6) : null;
    }
  };
}

const clip = (text, limit = 120) => firstLine(typeof text === "string" ? text : "", limit);
const pathName = (value) => {
  if (typeof value !== "string" || !value) return null;
  try { return basename(value.startsWith("file:") ? decodeURIComponent(new URL(value).pathname) : value) || null; } catch { return basename(value) || null; }
};

// 等你处理的那一步在等什么：RequestedInteraction 是 oneof，按字段号认几种常见的，其余给笼统说法。
function describeWaiting(step) {
  const interaction = step.msg(56);
  const call = step.msg(5).msg(4);
  let args = {};
  try { args = JSON.parse(call.str(3) ?? "{}") ?? {}; } catch {}
  if (interaction.has(22)) {
    const question = interaction.msg(22).msgs(1).map((entry) => entry.str(1)).find(Boolean);
    return clip(question) ?? "有问题要问你";
  }
  if (interaction.has(21)) {
    const spec = interaction.msg(21);
    return clip(spec.str(5) ?? spec.str(4)) ?? "需要你授权";
  }
  if (interaction.has(19)) return `要访问 ${pathName(interaction.msg(19).str(1)) ?? "文件"}，等你允许`;
  if (interaction.has(3)) return clip(args.CommandLine ?? args.command) ? `要运行 ${clip(args.CommandLine ?? args.command)}` : "要运行命令，等你确认";
  if (interaction.has(20)) return clip(interaction.msg(20).str(3)) ?? "MCP 需要你确认";
  if (interaction.has(18)) return "要调用 MCP 工具，等你确认";
  if ([4, 7, 8, 9, 13, 14, 15, 17].some((field) => interaction.has(field))) return "要操作浏览器，等你确认";
  const notify = step.msg(94);
  if (step.has(94)) return clip(notify.str(2)) ?? "在等你回复";
  return "在等你处理";
}

/** raw_summary（CascadeTrajectorySummary）里看板用得到的部分；解不出来的字段为 null。 */
export function decodeSummary(buffer) {
  const summary = decodeMessage(buffer);
  const stepOf = (entry) => entry.msg(1);
  const waiting = summary.msgs(8).map((entry) => {
    const step = stepOf(entry);
    return { index: entry.int(2), at: step.msg(5).time(1), text: describeWaiting(step) };
  });
  const boundaryStep = stepOf(summary.msg(14));
  const boundary = boundaryStep.msg(93);
  const notifyStep = stepOf(summary.msg(12));
  const notify = notifyStep.msg(94);
  const annotations = summary.msg(15);
  return {
    title: summary.str(1),
    steps: summary.int(2),
    modifiedAt: summary.time(3),
    status: summary.int(5),
    createdAt: summary.time(7),
    waiting,
    userInputAt: summary.time(10),
    notify: summary.has(12) ? { text: notify.str(2), blocking: notify.bool(3), askForFeedback: notify.bool(7), at: notifyStep.msg(5).time(1) } : null,
    task: summary.has(14) ? { name: boundary.str(1), status: boundary.str(2), summary: boundary.str(3), at: boundaryStep.msg(5).time(1) } : null,
    annotations: { title: annotations.str(1), archived: annotations.bool(4), unread: annotations.bool(8) },
    notFullyIdle: summary.bool(21),
    killed: summary.bool(23),
    interrupted: summary.bool(25),
    runningSubagents: summary.bool(30)
  };
}

// ---------- transcript ----------

function unquote(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

/** transcript 里 tool_calls 的参数值本身是 JSON 字符串；解开后取看板要的那一项。 */
export function describeAntigravityTool(name, rawArgs = {}) {
  const args = Object.fromEntries(Object.entries(rawArgs ?? {}).map(([key, value]) => [key, unquote(value)]));
  const file = pathName(args.AbsolutePath ?? args.TargetFile ?? args.Path ?? args.File ?? args.path);
  if (/^(run_command|send_command_input)$/.test(name)) return clip(args.CommandLine ?? args.command, 80) ? `运行 ${clip(args.CommandLine ?? args.command, 80)}` : "运行命令";
  if (/^(read_file|view_file|view_code_item|view_file_outline)$/.test(name)) return file ? `读取 ${file}` : "读取文件";
  if (/(edit|write|replace).*file|file.*(edit|write)/.test(name)) return file ? `修改 ${file}` : "修改文件";
  if (/^(grep_search|find_by_name|codebase_search|list_dir)$/.test(name)) return clip(args.Query ?? args.Pattern ?? args.SearchPath ?? args.DirectoryPath, 60) ? `搜索 ${clip(args.Query ?? args.Pattern ?? args.SearchPath ?? args.DirectoryPath, 60)}` : "搜索代码";
  if (/browser/.test(name)) return "操作浏览器";
  if (/^(search_web|read_url_content)$/.test(name)) return "查网页";
  if (/^(ask_question|notify_user)$/.test(name)) return "在等你回答";
  return `调用 ${name}`;
}

export function antigravityToolLane(name) {
  if (/^(run_command|send_command_input|command_status)$/.test(name)) return "shell";
  if (/(edit|write|replace).*file|file.*(edit|write)/.test(name)) return "edit";
  if (/subagent|agent/.test(name)) return "agent";
  if (/^(ask_question|notify_user)$/.test(name)) return "you";
  return "other";
}

const stepTime = (step) => Date.parse(step?.created_at);
// 工具结果（GENERIC）开头是本地时区的 Created At / Completed At，比步骤的 created_at 更准。
function toolTimes(step) {
  const head = String(step?.content ?? "").slice(0, 200);
  const created = Date.parse(head.match(/^Created At: (\S+)/m)?.[1]);
  const completed = Date.parse(head.match(/^Completed At: (\S+)/m)?.[1]);
  return { start: Number.isFinite(created) ? created : stepTime(step), end: Number.isFinite(completed) ? completed : null };
}
const userRequest = (content) => {
  const match = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(content ?? "");
  return (match ? match[1] : content ?? "").trim();
};

/**
 * 把 transcript 切成回合：用户输入开始一个回合；模型步骤带工具调用时，后面紧跟的 GENERIC 步骤按顺序是这些调用的结果。
 * 步骤时间只有秒级，模型步骤只有开始时间：模型段的结束取同回合下一段的开始；回合最后一段回复没有下一段，
 * 最新回合用会话的最后修改时间，旧回合按输出 token 估一个时长（只用于画图）。
 * 返回与 Codex 版 parseTrace 一样的结构。live：该会话当前状态 { running, waiting, activity, status, updatedAt }。
 */
export function parseAntigravityTrace(steps, { live = null } = {}) {
  const turns = [];
  let model = null;
  let turn = null;
  let pending = [];
  for (const step of steps) {
    const at = stepTime(step);
    if (!Number.isFinite(at)) continue;
    if (step.type === "USER_INPUT") {
      turn = { start: at, end: null, status: "running", ttftMs: null, asking: false, segments: [], notes: [], tokens: { input: 0, output: 0, reasoning: 0 } };
      turns.push(turn);
      pending = [];
      continue;
    }
    if (!turn) continue;
    if (step.type === "GENERIC" && pending.length) {
      const segment = pending.shift();
      const { start, end } = toolTimes(step);
      segment.start = Math.max(segment.start, start);
      segment.end = Math.max(segment.start, end ?? start);
      segment.failed = /exit code[: ]+[1-9]/i.test(String(step.content ?? "").slice(0, 400));
      continue;
    }
    if (step.type !== "PLANNER_RESPONSE") continue;
    model = step.model ?? model;
    pending = [];
    const output = Number(step.output_tokens) || 0;
    const input = (Number(step.input_tokens) || 0) + (Number(step.cache_read_tokens) || 0);
    if (input) turn.tokens.input = input;
    turn.tokens.output += output;
    const start = Math.max(at, turn.segments.at(-1)?.start ?? turn.start);
    const calls = Array.isArray(step.tool_calls) ? step.tool_calls.filter((call) => typeof call?.name === "string") : [];
    if (calls.length) {
      const labels = calls.map((call) => describeAntigravityTool(call.name, call.args));
      turn.segments.push({ kind: "call", lane: "model", start, end: null, label: `准备${labels[0]}`, tokens: { output, reasoning: 0, perSecond: null } });
      pending = calls.map((call, index) => {
        const segment = { kind: "tool", lane: antigravityToolLane(call.name), start, end: null, label: labels[index], failed: false };
        turn.segments.push(segment);
        return segment;
      });
    } else {
      const text = clip(step.content, 80);
      turn.segments.push({ kind: text ? "reply" : "think", lane: "model", start, end: null, label: text ?? "思考", tokens: { output, reasoning: 0, perSecond: null }, output });
      // 模型的进度说明：最后一句回复之外的中途说明，Trace 没有计划时用它推断阶段。
      if (text) turn.notes = [...turn.notes, { at, text }].slice(-20);
    }
  }

  const last = turns.at(-1);
  const running = Boolean(live?.running);
  for (const item of turns) {
    const latest = item === last;
    const segments = item.segments;
    segments.forEach((segment, index) => {
      if (segment.end !== null) return;
      // 工具调用段：到这批第一个工具开始为止；其余模型段：到下一段开始为止。
      const next = segment.kind === "call"
        ? segments.slice(index + 1).find((other) => other.kind === "tool" && other.end !== null)
        : segments.slice(index + 1).find((other) => other.start >= segment.start);
      if (next) segment.end = Math.max(segment.start, next.start);
    });
    // 没配上结果的工具：后面还有段就在那一段开始时结束，否则（最新回合进行中）仍在运行。
    segments.forEach((segment, index) => {
      if (segment.end !== null || segment.kind !== "tool") return;
      const next = segments.slice(index + 1).find((other) => other.kind !== "tool");
      if (next) segment.end = Math.max(segment.start, next.start);
    });
    if (!(latest && running)) {
      const fallbackEnd = (segment) => {
        const estimate = segment.start + Math.max(1000, ((segment.output ?? 0) / ESTIMATED_TOKENS_PER_SECOND) * 1000);
        const updatedAt = latest ? live?.updatedAt : null;
        return Number.isFinite(updatedAt) && updatedAt >= segment.start && updatedAt <= estimate * 2 - segment.start ? updatedAt : estimate;
      };
      for (const segment of segments) segment.end ??= fallbackEnd(segment);
      item.end = Math.max(item.start, ...segments.map((segment) => segment.end));
      item.status = latest && ["stopped", "interrupted"].includes(live?.status) ? live.status : "done";
      item.asking = latest && live?.status === "asking";
    } else {
      item.asking = Boolean(live?.waiting);
      if (!item.asking && !segments.some((segment) => segment.end === null)) {
        const cursor = Math.max(item.start, ...segments.map((segment) => segment.end ?? segment.start));
        segments.push({ kind: "think", lane: "model", start: cursor, end: null, label: live?.activity ?? "思考中" });
      }
    }
    for (const segment of segments) {
      if (segment.tokens && segment.end > segment.start) segment.tokens.perSecond = Math.round((segment.tokens.output * 1000) / (segment.end - segment.start));
      delete segment.output;
    }
  }
  return { model, contextWindow: null, turns: turns.slice(-MAX_TRACE_TURNS) };
}

// ---------- 数据源 ----------

async function readTailLines(path, bytes) {
  let handle;
  try {
    const info = await stat(path);
    const length = Math.min(info.size, bytes);
    handle = await open(path, "r");
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, info.size - length);
    const lines = buffer.toString("utf8").split("\n");
    if (length < info.size) lines.shift();
    return { lines: lines.filter(Boolean), complete: length >= info.size };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { lines: [], complete: true };
    throw error;
  } finally { await handle?.close(); }
}

const parseLines = (lines) => lines.flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });

async function fileStamp(path) {
  try { const info = await stat(path); return `${info.mtimeMs}:${info.size}`; } catch { return "-"; }
}

function sqliteBinary(platform = process.platform) {
  return platform === "darwin" ? "/usr/bin/sqlite3" : "sqlite3";
}

// 库是 WAL 模式；Hub 关着、没有 -wal/-shm 时，只读连接建不了 shm 会报 CANTOPEN(14)，退回 immutable=1 快照读。
export async function querySqlite(path, sql, { execFileImpl = execFileAsync, binary = sqliteBinary() } = {}) {
  const run = (target) => execFileImpl(binary, ["-readonly", "-json", target, sql], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
  let stdout;
  try { ({ stdout } = await run(path)); }
  catch (error) {
    if (!/\(14\)|unable to open/i.test(String(error?.stderr ?? error?.message ?? error))) throw error;
    ({ stdout } = await run(`file:${encodeURI(path)}?mode=ro&immutable=1`));
  }
  return stdout.trim() ? JSON.parse(stdout) : [];
}

const SUMMARY_SQL = `SELECT conversation_id AS id, title, status, source, workspace_uris AS workspaces,
  last_modified_time AS modifiedAt, hex(raw_summary) AS raw
  FROM conversation_summaries WHERE nesting_depth = 0 AND parent_conversation_id = ''`;

const parseTime = (value) => {
  const ms = Date.parse(String(value ?? "").replace(" ", "T"));
  return Number.isFinite(ms) ? ms : null;
};

export class AntigravitySessions {
  constructor({ dataDir = defaultAntigravityDataDir(), now = Date.now, query = (path, sql) => querySqlite(path, sql) } = {}) {
    this.dataDir = dataDir;
    this.now = now;
    this.query = query;
    this.dbPath = join(dataDir, "conversation_summaries.db");
    this.cache = { stamp: null, rows: new Map() };
    this.loading = null;
  }

  transcriptPath(id) {
    return join(this.dataDir, "brain", id, ".system_generated", "logs", "transcript.jsonl");
  }

  async dbStamp() {
    return `${await fileStamp(this.dbPath)}|${await fileStamp(`${this.dbPath}-wal`)}`;
  }

  /** 全部顶层会话（id → 摘要），按库文件指纹缓存；并发调用只查一次。 */
  async rows() {
    const stamp = await this.dbStamp();
    if (stamp === this.cache.stamp) return this.cache.rows;
    // 库文件还没建（没用过 Antigravity 的会话）：直接当作没有会话，不去起 sqlite3（它找不到文件时退出码是 1，不是 ENOENT）。
    if (stamp.startsWith("-|")) return new Map();
    this.loading ??= (async () => {
      try {
        const rows = new Map();
        for (const row of await this.query(this.dbPath, SUMMARY_SQL)) {
          if (!CONVERSATION_ID.test(row?.id ?? "")) continue;
          let summary = null;
          try { summary = row.raw ? decodeSummary(Buffer.from(row.raw, "hex")) : null; } catch {}
          let workspaces = [];
          try { workspaces = JSON.parse(row.workspaces ?? "[]").filter((value) => typeof value === "string"); } catch {}
          rows.set(row.id.toLowerCase(), {
            id: row.id.toLowerCase(),
            title: row.title || null,
            runStatus: summary?.status ?? RUN_STATUS_NAMES[row.status] ?? null,
            cli: /CLI/.test(row.source ?? ""),
            workspaces,
            modifiedAt: summary?.modifiedAt ?? parseTime(row.modifiedAt),
            summary
          });
        }
        this.cache = { stamp, rows };
        return rows;
      } catch (error) {
        if (error?.code === "ENOENT" && !this.cache.stamp) return this.cache.rows;
        throw error;
      } finally { this.loading = null; }
    })();
    return this.loading;
  }

  async row(id) {
    return (await this.rows()).get(String(id).toLowerCase()) ?? null;
  }

  async canonicalId(id) { return id; }
  async aliases() { return []; }

  /** 会话的工作区（第一个 workspace URI）当作项目 id，Antigravity 页面按它显示项目名。 */
  async projectOf(id) {
    return (await this.row(id))?.workspaces[0] ?? null;
  }

  async titles() {
    const titles = new Map();
    for (const row of (await this.rows()).values()) {
      const title = row.summary?.annotations.title || row.summary?.title || row.title;
      if (title?.trim()) titles.set(row.id, title.trim().slice(0, 200));
    }
    return titles;
  }

  async lastSteps(id, count = 40) {
    if (!CONVERSATION_ID.test(id ?? "")) return [];
    return parseLines((await readTailLines(this.transcriptPath(id.toLowerCase()), TRANSCRIPT_TAIL[0])).lines).slice(-count);
  }

  /** 与 CodexSessions.status 同一套状态：running / asking / idle / stopped / interrupted / stalled / archived / missing。 */
  async status(id) {
    const row = await this.row(id);
    if (!row) return { status: "missing", updatedAt: null, turnAt: null, activity: null, summary: null };
    const summary = row.summary;
    const updatedAt = row.modifiedAt;
    if (summary?.annotations.archived) return { status: "archived", updatedAt, turnAt: updatedAt, activity: null, summary: null };
    const waiting = summary?.waiting.at(-1);
    if (waiting) return { status: "asking", updatedAt, turnAt: waiting.at ?? updatedAt, activity: "在等你处理", summary: waiting.text };
    const task = summary?.task;
    const taskText = clip(task?.status) ?? clip(task?.name);
    if (RUNNING_STATUS.has(row.runStatus)) {
      const status = Number.isFinite(updatedAt) && this.now() - updatedAt > STALLED_AFTER_MS ? "stalled" : "running";
      let activity = taskText;
      if (!activity) {
        const last = (await this.lastSteps(row.id, 8)).findLast((step) => step.type === "PLANNER_RESPONSE");
        const call = last?.tool_calls?.at(-1);
        activity = call ? describeAntigravityTool(call.name, call.args) : "思考中";
      }
      return { status, updatedAt, turnAt: updatedAt, activity, summary: null };
    }
    const reply = clip((await this.lastSteps(row.id)).findLast((step) => step.type === "PLANNER_RESPONSE" && step.content)?.content);
    const notify = summary?.notify?.at && summary.notify.at >= (summary.userInputAt ?? 0) ? summary.notify : null;
    const text = clip(notify?.text) ?? reply ?? clip(task?.summary);
    const base = { updatedAt, turnAt: updatedAt, activity: null, summary: text };
    if (summary?.killed) return { ...base, status: "stopped" };
    if (summary?.interrupted) return { ...base, status: "interrupted" };
    if (notify?.askForFeedback || notify?.blocking || endsWithQuestion(text ?? "")) return { ...base, status: "asking" };
    return { ...base, status: "idle" };
  }

  async trace(id) {
    const row = await this.row(id);
    if (!row) return { model: null, contextWindow: null, turns: [], updatedAt: null };
    const path = this.transcriptPath(row.id);
    let steps = [];
    for (const bytes of TRANSCRIPT_TAIL) {
      const { lines, complete } = await readTailLines(path, bytes);
      steps = parseLines(lines);
      if (complete || steps.filter((step) => step.type === "USER_INPUT").length >= MAX_TRACE_TURNS) break;
    }
    const state = await this.status(row.id);
    const running = ["running", "stalled"].includes(state.status) || Boolean(row.summary?.waiting.length && RUNNING_STATUS.has(row.runStatus));
    const trace = parseAntigravityTrace(steps, {
      live: { running: running && state.status !== "stalled", waiting: Boolean(row.summary?.waiting.length), activity: state.activity, status: state.status, updatedAt: row.modifiedAt }
    });
    return { ...trace, updatedAt: row.modifiedAt };
  }

  // Antigravity 的任务进度（task_boundary）没有分步列表，不画计划区。
  async plan() { return null; }

  async stamp(id) {
    return `${await this.dbStamp()}#${CONVERSATION_ID.test(id ?? "") ? await fileStamp(this.transcriptPath(id.toLowerCase())) : "-"}`;
  }

  async fingerprint(ids) {
    return [await this.dbStamp(), ...await Promise.all(ids.map((id) => (CONVERSATION_ID.test(id ?? "") ? fileStamp(this.transcriptPath(id.toLowerCase())) : "-")))].join("|");
  }

  // ---------- 新会话自动加入（createSessionWatcher 用） ----------

  /** 最近两天新建、在 Hub 里新开的顶层会话；返回会话 id（看板的 watcher 把它当作「路径」去重）。 */
  async recentRollouts() {
    const since = this.now() - 2 * DAY_MS;
    return [...(await this.rows()).values()]
      .filter((row) => !row.cli && (row.summary?.createdAt ?? row.modifiedAt ?? 0) >= since)
      .map((row) => row.id);
  }

  async sessionMeta(id) {
    const row = await this.row(id);
    return row ? { id: row.id, createdAt: row.summary?.createdAt ?? null, cli: row.cli } : null;
  }

  isUserSession(meta) { return Boolean(meta?.id) && !meta.cli; }
  createdAt(meta) { return Number.isFinite(meta?.createdAt) ? meta.createdAt : null; }
}
