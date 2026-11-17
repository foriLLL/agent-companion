import test from "node:test";
import assert from "node:assert/strict";
import { createRpcClient } from "../src/renderer/platform/rpc-client.mjs";

test("RPC 按卡片限定命名空间，响应只匹配自己的请求", async () => {
  const frames = [];
  const client = createRpcClient({ binding: () => raw => { frames.push(JSON.parse(raw)); } });
  const a = client.scoped("alpha", 1).request("load", { n: 1 });
  const b = client.scoped("beta", 1).request("beta.load");
  assert.equal(frames[0].method, "alpha.load");
  assert.equal(frames[1].method, "beta.load");
  assert.equal(client.receiveRpc({ id: "unknown", ok: true }), false);
  client.receiveRpc({ id: b.id, ok: true, result: "b" });
  client.receiveRpc({ id: a.id, ok: true, result: "a" });
  assert.deepEqual(await Promise.all([a.promise, b.promise]), ["a", "b"]);
  assert.equal(client.diagnostics().pending, 0);
});

test("卸载只取消自己代的请求，旧代不能取消新代请求", async () => {
  const frames = [];
  const client = createRpcClient({ binding: () => raw => { frames.push(JSON.parse(raw)); } });
  const controller = new AbortController();
  const old = client.scoped("alpha", 1, controller.signal);
  const oldRequest = old.request("load");
  const next = client.scoped("alpha", 2).request("load");
  old.cancel(next.id);
  const rejected = assert.rejects(oldRequest.promise, { code: "ABORTED" });
  controller.abort();
  await rejected;
  assert.equal(client.diagnostics().pending, 1);
  assert.equal(client.receiveRpc({ id: oldRequest.id, ok: true, result: "late" }), false);
  client.receiveRpc({ id: next.id, ok: true, result: "new" });
  assert.equal(await next.promise, "new");
  assert.ok(frames.some(frame => frame.method === "rpc.cancel" && frame.params.requestId === oldRequest.id));
});

test("超时、直接返回与已中止上下文均正确结束 pending", async () => {
  const client = createRpcClient({ binding: () => () => undefined, timeoutMs: 5 });
  await assert.rejects(client.scoped("alpha", 1)("load"), { code: "RPC_TIMEOUT" });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.scoped("alpha", 1, controller.signal)("load"), { code: "ABORTED" });
  assert.equal(client.diagnostics().pending, 0);
  const direct = createRpcClient({ binding: () => () => Promise.resolve(42) });
  assert.equal(await direct.scoped("alpha", 1)("load"), 42);
  assert.equal(direct.diagnostics().pending, 0);
});

test("ping 不带卡片命名空间，回包到达即通；超时、无 binding、卸载都只返回不通", async () => {
  const frames = [];
  const client = createRpcClient({ binding: () => raw => { frames.push(JSON.parse(raw)); } });
  const ok = client.ping(1000);
  assert.deepEqual(frames[0], { id: frames[0].id, method: "rpc.ping", params: {} });
  assert.equal(client.receiveRpc({ id: frames[0].id, ok: true, result: { pong: true } }), true);
  assert.deepEqual(await ok, { ok: true });
  assert.equal(client.diagnostics().pending, 0);

  assert.deepEqual(await client.ping(5), { ok: false, reason: "RPC_TIMEOUT" });
  assert.equal(client.receiveRpc({ id: frames[1].id, ok: true }), false, "超时后迟到的回包被丢弃");

  const failed = client.ping(1000);
  client.receiveRpc({ id: frames[2].id, ok: false, error: { code: "RPC_DELIVERY_FAILED", message: "x" } });
  assert.deepEqual(await failed, { ok: false, reason: "RPC_DELIVERY_FAILED" });

  const missing = createRpcClient({ binding: () => undefined });
  assert.deepEqual(await missing.ping(1000), { ok: false, reason: "BRIDGE_UNAVAILABLE" });

  const disposed = client.ping(1000);
  client.dispose();
  assert.deepEqual(await disposed, { ok: false, reason: "ABORTED" });
  assert.equal(client.diagnostics().pending, 0);
});
