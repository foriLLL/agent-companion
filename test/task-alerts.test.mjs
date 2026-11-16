import assert from "node:assert/strict";
import test from "node:test";
import { ALERT_DEFAULTS, alertLevel, taskAlerts } from "../src/cards/tasks/alerts.mjs";

const task = (threadId, status, turnAt, unread = true) => ({ threadId, status, turnAt, unread });
const board = (...tasks) => ({ tasks });
const kinds = (alerts) => alerts.map(({ kind, task: { threadId } }) => `${threadId}:${kind}`);

test("播放提醒档位：默认需要你时暂停、完成时只提醒，非法值回到默认", () => {
  assert.deepEqual(ALERT_DEFAULTS, { alertAttention: "pause", alertDone: "notify" });
  assert.equal(alertLevel({}, "alertAttention"), "pause");
  assert.equal(alertLevel(undefined, "alertDone"), "notify");
  assert.equal(alertLevel({ alertDone: "off" }, "alertDone"), "off");
  assert.equal(alertLevel({ alertAttention: "loud" }, "alertAttention"), "pause");
});

test("第一次快照只作基线；刚加入看板的任务不提醒", () => {
  assert.deepEqual(taskAlerts(null, board(task("a", "asking", 5))), []);
  assert.deepEqual(taskAlerts(board(), board(task("a", "asking", 5))), []);
});

test("进行中变成需要你（提问、中断、没动静）或完成时提醒，只提醒没看过的", () => {
  const before = board(task("a", "running", 1), task("b", "running", 1), task("c", "running", 1), task("d", "running", 1), task("e", "running", 1));
  const after = board(task("a", "asking", 2), task("b", "interrupted", 2), task("c", "stalled", 2), task("d", "idle", 2), task("e", "idle", 2, false));
  assert.deepEqual(kinds(taskAlerts(before, after)), ["a:attention", "b:attention", "c:attention", "d:done"]);
});

test("状态没变不重复提醒；同一状态下又结束一个回合（两次快照之间整回合跑完）照样提醒", () => {
  const asking = board(task("a", "asking", 2), task("b", "idle", 2));
  assert.deepEqual(taskAlerts(asking, asking), []);
  assert.deepEqual(kinds(taskAlerts(asking, board(task("a", "asking", 3), task("b", "idle", 3)))), ["a:attention", "b:done"]);
});

test("不是从进行中结束的状态改判（如中断改判为已回复）不算完成；回到进行中不提醒", () => {
  assert.deepEqual(taskAlerts(board(task("a", "interrupted", 2)), board(task("a", "idle", 2))), []);
  assert.deepEqual(taskAlerts(board(task("a", "asking", 2)), board(task("a", "running", 2, false))), []);
  assert.deepEqual(taskAlerts(board(task("a", "running", 2)), board(task("a", "archived", 2))), []);
});
