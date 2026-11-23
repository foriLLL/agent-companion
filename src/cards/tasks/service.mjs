import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { createPlanHint } from "../../codex-plan-hint.mjs";
import { planSummary } from "../../codex-plan.mjs";
import { CodexSessions, THREAD_ID_PATTERN } from "../../codex-sessions.mjs";
import { rpcError } from "../../platform/services/errors.mjs";
import { createSessionWatcher } from "../../task-auto-add.mjs";
import { COLOR_COUNT, MAX_TASKS, TaskBoardStorage, TaskRecentStorage, normalizeName, normalizeTask, pickColor } from "../../task-board-storage.mjs";

const execFileAsync = promisify(execFile);
// 长轮询：每 300ms 只比较文件指纹，有变化才重新解析；最多挂起 25 秒后照常返回。
const WATCH_POLL_MS = 300;
const WATCH_MAX_MS = 25_000;

function params(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw rpcError("RPC_INVALID_PARAMS", "参数无效");
  }
  return value;
}

function threadId(value) {
  if (typeof value !== "string" || !THREAD_ID_PATTERN.test(value)) throw rpcError("RPC_INVALID_PARAMS", "会话 id 无效");
  return value;
}

// 深链由 ChatGPT.app 注册；只在侧栏里找不到条目时作为兜底。
async function openThreadLink(id, { platform = process.platform } = {}) {
  if (platform !== "darwin") throw rpcError("UNSUPPORTED", "此系统暂不支持从看板打开会话");
  await execFileAsync("/usr/bin/open", [`codex://threads/${id}`], { timeout: 5000 });
}

// 「长任务先列计划」开关：只在配置里明确给出 planHint 时才动 Codex 指令文件，从没碰过开关的配置不读不写。
// 任务看板或整个 Companion 被停用时也删掉提示。
function wantPlanHint(config) {
  const value = config?.cards?.tasks?.settings?.planHint;
  if (typeof value !== "boolean") return null;
  return value && config?.enabled !== false && config?.cards?.tasks?.enabled !== false;
}

// 「新会话自动加入看板」开关：缺省关闭；任务看板或整个 Companion 被停用时也停止。
function wantAutoAdd(config) {
  return config?.cards?.tasks?.settings?.autoAdd === true && config?.enabled !== false && config?.cards?.tasks?.enabled !== false;
}

export function createService({
  taskBoard = new TaskBoardStorage(), recentStorage = new TaskRecentStorage(), codexSessions = new CodexSessions(),
  openThread = openThreadLink, planHint = null, logger = console, autoAddIntervalMs
} = {}) {
  let hint = planHint;
  let hintApplied = null;

  // 加入看板：客户端临时 id 已绑定时存真实 id，两个 id 都算同一任务；已在看板上返回 null（不改动）。
  // 满了抛 TASK_BOARD_FULL。新任务放最前，颜色取最少使用的。
  function insertTask(id, aliases, { title = null, projectId = null } = {}) {
    return taskBoard.mutate((tasks) => {
      if (tasks.some((task) => aliases.has(task.threadId))) return null;
      if (tasks.length >= MAX_TASKS) throw rpcError("TASK_BOARD_FULL", `看板最多保留 ${MAX_TASKS} 个任务，请先完成一些`);
      const task = normalizeTask({ threadId: id, suggestedName: title, customName: null, color: pickColor(tasks), projectId, addedAt: Date.now() });
      return [task, ...tasks];
    });
  }
  async function resolveIds(rawId) {
    const id = await codexSessions.canonicalId(rawId);
    return { id, aliases: new Set([id, ...await codexSessions.aliases(id)]) };
  }

  // 自动加入：名字留空（view 从 session_index 补），项目 id 从 Codex 的项目分配里读；看板满了只记日志。
  const watcher = createSessionWatcher({
    codexSessions, logger, ...(autoAddIntervalMs ? { intervalMs: autoAddIntervalMs } : {}),
    async onSession({ threadId: rawId }) {
      const { id, aliases } = await resolveIds(rawId);
      const projectId = await codexSessions.projectOf(id).catch(() => null);
      try { await insertTask(id, aliases, { projectId }); }
      catch (error) {
        if (error?.code !== "TASK_BOARD_FULL") throw error;
        logger.warn?.(`[codex-companion] 看板已满（${MAX_TASKS} 个），新会话没有自动加入`);
      }
    }
  });

  // 同一个会话可能在看板上有两条：先用客户端临时 id 手动加入，发出第一条消息后又被自动加入用真实 id 加了一次
  // （Codex 写 id 绑定可能比会话记录晚，自动加入当时认不出是同一个）。绑定出现后只留先加入的那条，多的从看板文件删掉。
  async function dedupe(board) {
    const canonical = await Promise.all(board.tasks.map((task) => codexSessions.canonicalId(task.threadId)));
    const keep = new Map();
    board.tasks.forEach((task, index) => {
      const kept = keep.get(canonical[index]);
      if (kept === undefined || task.addedAt < board.tasks[kept].addedAt) keep.set(canonical[index], index);
    });
    if (keep.size === board.tasks.length) return board;
    const drop = new Set(board.tasks.filter((_, index) => keep.get(canonical[index]) !== index).map((task) => task.threadId));
    return taskBoard.mutate((tasks) => {
      const next = tasks.filter((task) => !drop.has(task.threadId));
      return next.length === tasks.length ? null : next;
    });
  }

  async function view(loaded, signal) {
    const board = await dedupe(loaded);
    const titles = await codexSessions.titles();
    const tasks = await Promise.all(board.tasks.map(async (task) => {
      const { status, updatedAt, turnAt, activity = null, summary = null } = await codexSessions.status(task.threadId)
        .catch(() => ({ status: "missing", updatedAt: null, turnAt: null }));
      const plan = planSummary(await codexSessions.plan?.(task.threadId).catch(() => null));
      const suggestedName = titles.get(await codexSessions.canonicalId(task.threadId)) ?? task.suggestedName;
      // unread：回合结束（回复、提问、中断）之后用户还没在 Codex 里看过。
      const unread = status !== "running" && Number.isFinite(turnAt) && turnAt > task.seenAt;
      // 侧栏条目可能用真实 id，也可能用新建时的客户端临时 id，看板两个都认。
      const aliases = await codexSessions.aliases(task.threadId);
      // 自动加入时 Codex 可能还没写项目分配：没存项目 id 的按 Codex 当前的分配补上（只补返回值，不写盘）。
      const projectId = task.projectId ?? await codexSessions.projectOf?.(task.threadId).catch(() => null) ?? null;
      return { ...task, projectId, aliases, suggestedName, name: task.customName ?? suggestedName ?? "未命名会话", status, updatedAt, turnAt, unread, activity, summary, plan };
    }));
    signal?.throwIfAborted();
    // sig 只覆盖界面上会变的内容；mtime 每次写入都变，不放进来，免得进行中的任务每次都触发重绘。
    const visible = tasks.map(({ updatedAt, ...task }) => task);
    const sig = createHash("sha1").update(JSON.stringify([board.revision, visible])).digest("hex").slice(0, 16);
    return { revision: board.revision, tasks, sig };
  }

  return {
    // 平台在启动和配置变化时调用；只在期望值变化时改写文件，失败的下次配置变化再试。
    async applyConfig(config) {
      if (wantAutoAdd(config)) void watcher.start();
      else watcher.stop();
      const want = wantPlanHint(config);
      if (want === null || want === hintApplied) return;
      hint ??= createPlanHint();
      await hint.set(want);
      hintApplied = want;
    },
    dispose() {
      watcher.stop();
    },
    // 测试用：直接驱动一轮扫描，不等定时器。
    autoAdd: watcher,
    methods: {
      async list(input, { signal }) {
        params(input, []);
        return view(await taskBoard.load(), signal);
      },
      // 实时刷新：内容与 since 不同就立即返回，否则等到会话记录或看板文件变化再返回。
      async watch(input, { signal }) {
        const { since = null, waitMs = 20_000 } = params(input, ["since", "waitMs"]);
        if (since !== null && typeof since !== "string") throw rpcError("RPC_INVALID_PARAMS", "since 无效");
        const deadline = Date.now() + Math.min(Math.max(Number(waitMs) || 0, 0), WATCH_MAX_MS);
        const boardStamp = async () => { try { const info = await stat(taskBoard.path); return `${info.mtimeMs}:${info.size}`; } catch { return "-"; } };
        let boardMark = await boardStamp();
        let board = await taskBoard.load();
        const sessionsMark = () => codexSessions.fingerprint(board.tasks.map((task) => task.threadId));
        let stamp = `${boardMark}#${await sessionsMark()}`;
        let current = await view(board, signal);
        while (current.sig === since && Date.now() < deadline) {
          await delay(WATCH_POLL_MS, undefined, { signal });
          const nextBoardMark = await boardStamp();
          if (nextBoardMark !== boardMark) {
            boardMark = nextBoardMark;
            board = await taskBoard.load();
          }
          const next = `${boardMark}#${await sessionsMark()}`;
          if (next === stamp) continue;
          stamp = next;
          current = await view(board, signal);
        }
        return current;
      },
      // 单个会话的 Trace，长轮询：since 与当前内容不同立即返回，否则等会话记录变化或超时。
      async trace(input, { signal }) {
        const { threadId: rawId, since = null, waitMs = 0 } = params(input, ["threadId", "since", "waitMs"]);
        const id = threadId(rawId);
        if (since !== null && typeof since !== "string") throw rpcError("RPC_INVALID_PARAMS", "since 无效");
        const deadline = Date.now() + Math.min(Math.max(Number(waitMs) || 0, 0), WATCH_MAX_MS);
        const read = async () => {
          const [trace, plan] = await Promise.all([codexSessions.trace(id), codexSessions.plan?.(id).catch(() => null) ?? null]);
          const sig = createHash("sha1").update(JSON.stringify(trace)).digest("hex").slice(0, 16);
          return { threadId: id, ...trace, plan, sig };
        };
        let stamp = await codexSessions.stamp(id);
        let current = await read();
        while (current.sig === since && Date.now() < deadline) {
          await delay(WATCH_POLL_MS, undefined, { signal });
          const next = await codexSessions.stamp(id);
          if (next === stamp) continue;
          stamp = next;
          current = await read();
        }
        signal?.throwIfAborted();
        return { ...current, now: Date.now() };
      },
      async add(input, { signal }) {
        const { threadId: rawId, title, projectId } = params(input, ["threadId", "title", "projectId"]);
        // 新建会话的侧栏条目给的是客户端临时 id，已绑定真实 id 时存真实 id。
        const { id, aliases } = await resolveIds(threadId(rawId));
        return view(await insertTask(id, aliases, { title, projectId }), signal);
      },
      // 最近在 Codex 里打开过的会话，越近越前（Option+Tab 的顺序）；后台服务重启、页面重新注入后仍在。
      async recent(input, { signal } = {}) {
        params(input, []);
        const recent = await recentStorage.load();
        signal?.throwIfAborted();
        return { recent };
      },
      // 记一次打开：id 原样保存（看板任务的 id，或侧栏里不在看板上的会话），已在最前时不写盘。
      async visit(input, { signal } = {}) {
        const id = threadId(params(input, ["threadId"]).threadId);
        signal?.throwIfAborted();
        return { recent: await recentStorage.visit(id) };
      },
      // name 为空时回到推荐名（Codex 智能起名或 rename 的名字）。只改看板，不改 Codex 会话名。
      async rename(input, { signal }) {
        const { threadId: rawId, name } = params(input, ["threadId", "name"]);
        const id = threadId(rawId);
        if (name !== null && typeof name !== "string") throw rpcError("RPC_INVALID_PARAMS", "名字无效");
        const customName = normalizeName(name);
        const board = await taskBoard.mutate((tasks) => {
          const task = tasks.find((item) => item.threadId === id);
          if (!task || task.customName === customName) return null;
          task.customName = customName;
          return tasks;
        });
        return view(board, signal);
      },
      async recolor(input, { signal }) {
        const { threadId: rawId, color } = params(input, ["threadId", "color"]);
        const id = threadId(rawId);
        if (!Number.isInteger(color) || color < 0 || color >= COLOR_COUNT) throw rpcError("RPC_INVALID_PARAMS", "颜色无效");
        const board = await taskBoard.mutate((tasks) => {
          const task = tasks.find((item) => item.threadId === id);
          if (!task || task.color === color) return null;
          task.color = color;
          return tasks;
        });
        return view(board, signal);
      },
      // 用户在 Codex 里看过这个会话；只会往后推，避免旧轮询覆盖新的已读时间。
      async seen(input, { signal }) {
        const { threadId: rawId, at } = params(input, ["threadId", "at"]);
        const id = threadId(rawId);
        if (!Number.isSafeInteger(at) || at <= 0 || at > Date.now() + 60_000) throw rpcError("RPC_INVALID_PARAMS", "时间无效");
        const board = await taskBoard.mutate((tasks) => {
          const task = tasks.find((item) => item.threadId === id);
          if (!task || task.seenAt >= at) return null;
          task.seenAt = at;
          return tasks;
        });
        return view(board, signal);
      },
      async remove(input, { signal }) {
        const id = threadId(params(input, ["threadId"]).threadId);
        let removed = null;
        const board = await taskBoard.mutate((tasks) => {
          const index = tasks.findIndex((task) => task.threadId === id);
          if (index < 0) return null;
          removed = { task: tasks[index], index };
          return tasks.toSpliced(index, 1);
        });
        return { ...(await view(board, signal)), removed };
      },
      // 撤销「完成」：按原位置放回，保留原颜色与自定义名字。
      async restore(input, { signal }) {
        const { task: raw, index } = params(input, ["task", "index"]);
        const task = normalizeTask(raw);
        if (!task || !Number.isSafeInteger(index) || index < 0) throw rpcError("RPC_INVALID_PARAMS", "任务无效");
        const board = await taskBoard.mutate((tasks) => {
          if (tasks.some((item) => item.threadId === task.threadId) || tasks.length >= MAX_TASKS) return null;
          return tasks.toSpliced(Math.min(index, tasks.length), 0, task);
        });
        return view(board, signal);
      },
      async open(input) {
        await openThread(await codexSessions.canonicalId(threadId(params(input, ["threadId"]).threadId)));
        return { opened: true };
      }
    }
  };
}
