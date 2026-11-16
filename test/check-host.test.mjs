import assert from "node:assert/strict";
import test from "node:test";
import { HOST_HOOKS, summarize } from "../scripts/check-host.mjs";

const hooks = (missing = []) => HOST_HOOKS.map(({ selector }) => ({ selector, total: missing.includes(selector) ? 0 : 1, visible: 1 }));
const adapter = (overrides = {}) => ({ entry: "summary", thread: "hooks", room: "native", roomFallbacks: 0, layoutSource: "runtime", visible: true, ...overrides });

test("宿主自检：全部命中原生钩子时没有降级项", () => {
  const { lines, degraded } = summarize({ injected: true, artifactHash: "abc", adapter: adapter(), errors: 0, composer: true, hooks: hooks() }, { expectedHash: "abc" });
  assert.deepEqual(degraded, []);
  assert.ok(lines.some((line) => line.includes("原生平移")));
  assert.ok(lines.every((line) => !line.includes("✗") && !line.includes("不一致")));
});

test("宿主自检：逐项说明降级到了哪一级", () => {
  const { lines, degraded } = summarize({
    injected: true, artifactHash: "old", errors: 0, composer: true,
    adapter: adapter({ entry: "floating", thread: "composer", room: "pad", roomFallbacks: 1, layoutSource: "builtin" }),
    hooks: hooks(['[class*="shiftWithTranscript"]', "[data-app-action-sidebar-thread-row]"])
  }, { expectedHash: "new" });
  assert.equal(degraded.length, 5);
  assert.ok(degraded.some((item) => item.includes("悬浮按钮")));
  assert.ok(degraded.some((item) => item.includes("输入框")));
  assert.ok(degraded.some((item) => item.includes("通用让位")));
  assert.ok(degraded.some((item) => item.includes("内置公式")));
  assert.ok(degraded.some((item) => item.includes("任务看板")));
  assert.ok(lines.some((line) => line.includes("不一致")));
  assert.ok(lines.some((line) => line.includes('✗ [class*="shiftWithTranscript"]')));
  assert.ok(lines.some((line) => line.includes("1 次让位方式实测不生效")));
});

test("宿主自检：抽屉没打开时不把「未让位」算作降级；没注入时直接说明", () => {
  const closed = summarize({ injected: true, artifactHash: "abc", adapter: adapter({ room: null, visible: false }), errors: 0, composer: true, hooks: hooks() });
  assert.deepEqual(closed.degraded, []);
  assert.ok(closed.lines.some((line) => line.includes("抽屉未打开")));
  assert.deepEqual(summarize({ injected: false, adapter: null, hooks: [] }).degraded, ["未注入"]);
});
