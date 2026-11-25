// 任务看板 → 播放提醒：从相邻两次看板快照里找出值得打断播放的变化。
// 设置项（卡片 settings）：alertAttention 对应需要你处理（提问、中断、长时间没动静），alertDone 对应回合结束；
// 取值 off 不提醒 / notify 只提醒 / pause 提醒并暂停正在播放的媒体。
export const ALERT_LEVELS = Object.freeze(["off", "notify", "pause"]);
export const ALERT_DEFAULTS = Object.freeze({ alertAttention: "pause", alertDone: "notify" });

const HUMAN = new Set(["asking", "interrupted", "stalled"]);
export const ALERT_TEXT = Object.freeze({
  asking: "在等你回答",
  interrupted: "已中断，需要你处理",
  stalled: "长时间没有动静",
  idle: "已完成"
});

export function alertLevel(settings, key) {
  const value = settings?.[key];
  return ALERT_LEVELS.includes(value) ? value : ALERT_DEFAULTS[key];
}

/**
 * previous / next 为看板快照（{ tasks: [{ threadId, status, turnAt, unread }] }）。
 * - 第一次快照（previous 为空）只作基线，不提醒；刚加入看板的任务也不提醒；
 * - 需要你处理：状态变成 asking / interrupted / stalled，或同一状态下又结束了一个回合；
 * - 完成：从 running 变成 idle，或两次快照之间整个回合跑完（没赶上 running）；
 * - 只提醒还没看过（unread）的结果。
 * 返回 [{ kind: "attention" | "done", task }]。
 */
export function taskAlerts(previous, next) {
  if (!previous?.tasks || !next?.tasks) return [];
  const before = new Map(previous.tasks.map((task) => [task.threadId, task]));
  const alerts = [];
  for (const task of next.tasks) {
    const was = before.get(task.threadId);
    if (!was || !task.unread) continue;
    const changed = task.status !== was.status;
    const advanced = Number.isFinite(task.turnAt) && task.turnAt !== was.turnAt;
    if (HUMAN.has(task.status) && (changed || advanced)) alerts.push({ kind: "attention", task });
    else if (task.status === "idle" && ((changed && was.status === "running") || advanced)) alerts.push({ kind: "done", task });
  }
  return alerts;
}
