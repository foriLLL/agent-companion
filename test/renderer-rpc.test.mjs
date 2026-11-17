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

test("超时、直接返回与已中止上下文均正确结束 pending", async (t) => {
  const client = createRpcClient({ binding: () => () => undefined, timeoutMs: 5, checkTimeoutMs: 5 });
  t.after(() => client.dispose());
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

test("请求超时后发 ping 确认：不通标记断开并定时复查，收到任何回包即恢复", async () => {
  const frames = [];
  const changes = [];
  const client = createRpcClient({ binding: () => raw => { frames.push(JSON.parse(raw)); }, recheckMs: 5, checkTimeoutMs: 5 });
  client.connection.subscribe(value => changes.push(value));
  assert.equal(client.connection.isConnected(), true);
  await assert.rejects(client.scoped("alpha", 1)("load", {}, { timeoutMs: 5 }), { code: "RPC_TIMEOUT" });
  await client.connection.check();
  assert.equal(client.connection.isConnected(), false);
  assert.deepEqual(changes, [false]);
  // 断开期间每隔 recheckMs 自动复查。
  const pings = () => frames.filter(frame => frame.method === "rpc.ping").length;
  const before = pings();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.ok(pings() > before, "断开期间持续复查");
  // 后台恢复：任意一个本客户端的回包（例如后台自己发起的探活）就算恢复。
  client.receiveRpc({ id: frames.at(-1).id, ok: true, result: { pong: true } });
  assert.equal(client.connection.isConnected(), true);
  assert.deepEqual(changes, [false, true]);
  const settled = pings();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(pings(), settled, "恢复后停止复查");
  client.dispose();
});

test("业务方法慢但 ping 通时不算断开；迟到回包、卸载中止与外部 id 的处理", async () => {
  const frames = [];
  const changes = [];
  const client = createRpcClient({ binding: () => raw => {
    const frame = JSON.parse(raw);
    frames.push(frame);
    if (frame.method === "rpc.ping") queueMicrotask(() => client.receiveRpc({ id: frame.id, ok: true, result: { pong: true } }));
  } });
  client.connection.subscribe(value => changes.push(value));
  await assert.rejects(client.scoped("alpha", 1)("slow", {}, { timeoutMs: 5 }), { code: "RPC_TIMEOUT" });
  assert.equal(await client.connection.check(), true);
  assert.deepEqual(changes, []);

  const offline = createRpcClient({ binding: () => () => undefined, recheckMs: 60_000, checkTimeoutMs: 5 });
  await offline.connection.check();
  assert.equal(offline.connection.isConnected(), false);
  assert.equal(offline.receiveRpc({ id: "someone-else-1", ok: true }), false);
  assert.equal(offline.connection.isConnected(), false, "不是本客户端的 id 不算恢复");
  const late = offline.scoped("alpha", 1).request("load", {}, { timeoutMs: 5 });
  await assert.rejects(late.promise, { code: "RPC_TIMEOUT" });
  assert.equal(offline.receiveRpc({ id: late.id, ok: true }), false, "超时后的回包不再交给调用方");
  assert.equal(offline.connection.isConnected(), true, "但迟到回包说明链路已恢复");

  const disposed = createRpcClient({ binding: () => () => undefined });
  const checking = disposed.connection.check();
  disposed.dispose();
  assert.equal(await checking, true, "卸载中止的 ping 不把状态改成断开");
  offline.dispose();
  client.dispose();
});

test("binding 缺失立即标记断开", async () => {
  const client = createRpcClient({ binding: () => undefined, recheckMs: 60_000 });
  await assert.rejects(client.scoped("alpha", 1)("load"), { code: "BRIDGE_UNAVAILABLE" });
  assert.equal(client.connection.isConnected(), false);
  client.dispose();
});
