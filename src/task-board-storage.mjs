import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { THREAD_ID_PATTERN } from "./codex-sessions.mjs";
import { companionDataDir } from "./platform/paths.mjs";
import { replaceFile } from "./platform/replace-file.mjs";

const FILE_LIMIT = 1024 * 1024;
export const MAX_TASKS = 100;
export const MAX_RECENT = 100;
export const NAME_LIMIT = 120;
export const COLOR_COUNT = 8;

// 每个宿主一份看板：Codex 沿用原来的文件名，其它宿主（如 antigravity）加后缀。
const hostSuffix = (host) => (host && host !== "codex" ? `-${host}` : "");

export function defaultTaskBoardPath(home = homedir(), host = "codex") {
  return join(companionDataDir(home), `task-board${hostSuffix(host)}.json`);
}

export function defaultTaskRecentPath(home = homedir(), host = "codex") {
  return join(companionDataDir(home), `task-recent${hostSuffix(host)}.json`);
}

// 数据目录下 0600 原子写：先写同目录临时文件再替换，失败时删掉临时文件。
async function writePrivateJson(path, data, randomUUIDImpl, prefix) {
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${prefix}-${process.pid}-${randomUUIDImpl()}.tmp`);
  try {
    await writeFile(temporary, serialized, { mode: 0o600, flag: "wx" });
    await replaceFile(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export function normalizeName(value) {
  if (typeof value !== "string") return null;
  const name = value.replace(/\s+/g, " ").trim().slice(0, NAME_LIMIT);
  return name || null;
}

/** 只保留白名单字段；无效项返回 null。 */
export function normalizeTask(value) {
  if (!value || typeof value !== "object") return null;
  const threadId = String(value.threadId ?? "");
  if (!THREAD_ID_PATTERN.test(threadId)) return null;
  const color = Number.isInteger(value.color) && value.color >= 0 && value.color < COLOR_COUNT ? value.color : 0;
  const projectId = typeof value.projectId === "string" && value.projectId.length <= 1024 ? value.projectId : null;
  const addedAt = Number.isSafeInteger(value.addedAt) && value.addedAt > 0 ? value.addedAt : Date.now();
  // 用户最后一次在 Codex 里看过这个会话的时间；加入时用户正看着它，缺省取加入时间。
  const seenAt = Number.isSafeInteger(value.seenAt) && value.seenAt > 0 ? value.seenAt : addedAt;
  // keepArchived：会话在 Codex 归档后被自动移出、用户又撤销放回的，以后不再自动移出。
  return { threadId, suggestedName: normalizeName(value.suggestedName), customName: normalizeName(value.customName), color, projectId, addedAt, seenAt,
    ...(value.keepArchived === true ? { keepArchived: true } : {}) };
}

function normalizeTasks(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const tasks = [];
  for (const raw of value) {
    const task = normalizeTask(raw);
    if (!task || seen.has(task.threadId)) continue;
    seen.add(task.threadId);
    tasks.push(task);
    if (tasks.length >= MAX_TASKS) break;
  }
  return tasks;
}

/** 新任务取当前最少使用的颜色，颜色相同时取下标小的，避免相邻任务撞色。 */
export function pickColor(tasks) {
  const used = new Array(COLOR_COUNT).fill(0);
  for (const task of tasks) used[task.color] += 1;
  return used.indexOf(Math.min(...used));
}

/**
 * 任务看板：数据目录下 0600 原子写。任务只由用户加入和移除，不按时间或状态自动清理。
 * 同一进程内的修改串行执行；文件缺失或损坏时回退为空看板。
 */
export class TaskBoardStorage {
  constructor({ path = defaultTaskBoardPath(), randomUUIDImpl = randomUUID } = {}) {
    this.path = path;
    this.randomUUIDImpl = randomUUIDImpl;
    this.queue = Promise.resolve();
  }

  async load() {
    let contents;
    try { contents = await readFile(this.path, "utf8"); } catch { return { revision: 0, tasks: [] }; }
    if (Buffer.byteLength(contents) > FILE_LIMIT) return { revision: 0, tasks: [] };
    try {
      const data = JSON.parse(contents);
      return { revision: Number.isSafeInteger(data?.revision) && data.revision >= 0 ? data.revision : 0, tasks: normalizeTasks(data?.tasks) };
    } catch { return { revision: 0, tasks: [] }; }
  }

  async save(board) {
    await writePrivateJson(this.path, { version: 1, revision: board.revision, tasks: board.tasks }, this.randomUUIDImpl, "task-board");
  }

  /** update(tasks) 返回新数组，或返回 null 表示无改动（不写盘、不增加 revision）。 */
  mutate(update) {
    const run = this.queue.then(async () => {
      const board = await this.load();
      const next = update(board.tasks.map((task) => ({ ...task })));
      if (!next) return board;
      const saved = { revision: board.revision + 1, tasks: normalizeTasks(next) };
      await this.save(saved);
      return saved;
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

/** 只保留合法会话 id，去重并限长；不是数组时为空。 */
function normalizeRecent(value) {
  if (!Array.isArray(value)) return [];
  const recent = [];
  for (const id of value) {
    if (typeof id !== "string" || !THREAD_ID_PATTERN.test(id) || recent.includes(id)) continue;
    recent.push(id);
    if (recent.length >= MAX_RECENT) break;
  }
  return recent;
}

/**
 * 最近在 Codex 里打开过的会话（Option+Tab 的顺序），越近越前。单独存一个文件：
 * 看板文件的 mtime 驱动看板长轮询，写进去会让每次切换会话都触发看板整体重绘。
 * id 原样保存（可能是看板任务的 id，也可能是侧栏里不在看板上的会话），文件缺失或损坏时回退为空。
 */
export class TaskRecentStorage {
  constructor({ path = defaultTaskRecentPath(), randomUUIDImpl = randomUUID } = {}) {
    this.path = path;
    this.randomUUIDImpl = randomUUIDImpl;
    this.queue = Promise.resolve();
  }

  async load() {
    let contents;
    try { contents = await readFile(this.path, "utf8"); } catch { return []; }
    if (Buffer.byteLength(contents) > FILE_LIMIT) return [];
    try { return normalizeRecent(JSON.parse(contents)?.recent); } catch { return []; }
  }

  /** 记一次打开：移到最前。已经在最前时不写盘。返回新的列表。 */
  visit(id) {
    const run = this.queue.then(async () => {
      const recent = await this.load();
      if (recent[0] === id) return recent;
      const next = normalizeRecent([id, ...recent.filter((item) => item !== id)]);
      await writePrivateJson(this.path, { version: 1, recent: next }, this.randomUUIDImpl, "task-recent");
      return next;
    });
    this.queue = run.catch(() => {});
    return run;
  }
}
