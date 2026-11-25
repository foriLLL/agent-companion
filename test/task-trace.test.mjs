import assert from "node:assert/strict";
import test from "node:test";
import { packLaneSegments } from "../cards/tasks/trace.mjs";

const toX = (ms) => ms / 100; // 10px/秒

test("顺次不重叠的段留在同一子行", () => {
  const a = { start: 0, end: 1000 };
  const b = { start: 1000, end: 2500 };
  const c = { start: 3000, end: 4000 };
  const packed = packLaneSegments([a, b, c], toX, 5000);
  assert.equal(packed.rows, 1);
  assert.equal(packed.rowOfSegment.get(a), 0);
  assert.equal(packed.rowOfSegment.get(b), 0);
  assert.equal(packed.rowOfSegment.get(c), 0);
});

test("并发重叠的段分排到不同子行，结束后复用空出的子行", () => {
  const a = { start: 1000, end: 5000 };
  const b = { start: 1200, end: 4800 };
  const c = { start: 1500, end: 2500 };
  const d = { start: 2600, end: 4000 }; // c 结束后空出第 2 行，d 复用
  const packed = packLaneSegments([a, b, c, d], toX, 6000);
  assert.equal(packed.rows, 3);
  assert.equal(packed.rowOfSegment.get(a), 0);
  assert.equal(packed.rowOfSegment.get(b), 1);
  assert.equal(packed.rowOfSegment.get(c), 2);
  assert.equal(packed.rowOfSegment.get(d), 2);
});

test("同时发起的零时长段和进行中的并发段互不重叠", () => {
  const z1 = { start: 1000, end: 1000 };
  const z2 = { start: 1000, end: 1000 };
  const packedZero = packLaneSegments([z1, z2], toX, 2000);
  assert.equal(packedZero.rows, 2);
  assert.notEqual(packedZero.rowOfSegment.get(z1), packedZero.rowOfSegment.get(z2));

  const live1 = { start: 1000, end: null };
  const live2 = { start: 1200, end: null };
  const packedLive = packLaneSegments([live1, live2], toX, 3000);
  assert.equal(packedLive.rows, 2);
  assert.notEqual(packedLive.rowOfSegment.get(live1), packedLive.rowOfSegment.get(live2));
});
