import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HongguoListStorage } from "../src/hongguo-list-storage.mjs";

async function listStorage(testContext) {
  const directory = await mkdtemp(join(tmpdir(), "hongguo-list-test-"));
  testContext.after(() => rm(directory, { recursive: true, force: true }));
  return new HongguoListStorage({ path: join(directory, "list.json") });
}

test("多个存储实例并发收藏同一文件，所有新增条目均保留", async testContext => {
  const storage = await listStorage(testContext);
  const other = new HongguoListStorage({ path: storage.path });
  const ids = Array.from({ length: 20 }, (_, index) => String(index + 1));
  await Promise.all(ids.map((id, index) => (index % 2 ? storage : other).add({ id, name: `短剧 ${id}` })));
  assert.deepEqual(new Set((await storage.load()).map(item => item.id)), new Set(ids));
});

test("并发移除和收藏不会恢复已删除项或覆盖新增项", async testContext => {
  const storage = await listStorage(testContext);
  await storage.save([{ id: "1", name: "保留" }, { id: "2", name: "删除" }]);
  await Promise.all([storage.remove("2"), storage.add({ id: "3", name: "新增" })]);
  assert.deepEqual((await storage.load()).map(item => item.id), ["3", "1"]);
});

test("写入失败后释放串行队列，下一次收藏仍可正常保存", async testContext => {
  const storage = await listStorage(testContext);
  storage.randomUUIDImpl = () => "missing/subdirectory";
  await assert.rejects(storage.add({ id: "1" }), { code: "ENOENT" });
  storage.randomUUIDImpl = () => "next";
  await storage.add({ id: "2" });
  assert.deepEqual((await storage.load()).map(item => item.id), ["2"]);
});
