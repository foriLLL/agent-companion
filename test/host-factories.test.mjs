import assert from "node:assert/strict";
import test from "node:test";
import { HOST_FACTORIES } from "../src/renderer/runtime/card-runtime.mjs";
import { createCodexAdapter } from "../src/renderer/adapters/codex.mjs";
import { createAntigravityAdapter } from "../src/renderer/adapters/antigravity.mjs";
import { createAntigravityThreads } from "../src/renderer/adapters/antigravity-threads.mjs";

test("每种宿主有自己的布局适配器和会话定位", () => {
  assert.deepEqual(Object.keys(HOST_FACTORIES).sort(), ["antigravity", "codex"]);
  assert.equal(HOST_FACTORIES.codex.adapterFactory, createCodexAdapter);
  assert.equal(HOST_FACTORIES.antigravity.adapterFactory, createAntigravityAdapter);
  assert.equal(HOST_FACTORIES.antigravity.threadsFactory, createAntigravityThreads);
});

test("Antigravity threads 从地址读当前会话，只接受合法会话 id", async () => {
  const listeners = new Map();
  const window = {
    location: { pathname: "/c/5F13E99E-F461-4309-9796-CE99E2B141EF" },
    history: { state: { __TSR_index: 4 }, pushState(state, _title, url) { this.state = state; window.location.pathname = url; } },
    PopStateEvent: class { constructor(type, init) { this.type = type; this.state = init.state; } },
    dispatchEvent(event) { listeners.get(event.type)?.forEach((listener) => listener(event)); },
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    setInterval: () => 1,
    clearInterval() {}
  };
  const threads = createAntigravityThreads({ document: { defaultView: window } });
  assert.deepEqual(threads.current(), { id: "5f13e99e-f461-4309-9796-ce99e2b141ef", title: null, projectId: null });
  assert.equal(threads.colors.length, 8);
  let changes = 0;
  const unsubscribe = threads.subscribe(() => { changes += 1; });
  assert.deepEqual(await threads.reveal("not-an-id"), { ok: false, reason: "invalid" });
  assert.deepEqual(await threads.reveal("0b0f5e0a-1111-4222-8333-944445555666"), { ok: true });
  assert.equal(window.location.pathname, "/c/0b0f5e0a-1111-4222-8333-944445555666");
  assert.equal(window.history.state.__TSR_index, 5);
  assert.equal(changes, 1);
  unsubscribe();
  threads.dispose();
  assert.deepEqual(await threads.reveal("0b0f5e0a-1111-4222-8333-944445555666"), { ok: false, reason: "invalid" });
});

test("Antigravity threads 从窗口标题读当前会话名，剥掉项目名和应用名", () => {
  const window = { location: { pathname: "/c/5f13e99e-f461-4309-9796-ce99e2b141ef" }, history: { state: null } };
  const document = { defaultView: window, title: "Pi 源码 - 目录 - 结构 - pi-src - Antigravity" };
  const threads = createAntigravityThreads({ document });
  assert.equal(threads.current().title, "Pi 源码 - 目录 - 结构");
  assert.equal(threads.title("5F13E99E-F461-4309-9796-CE99E2B141EF"), "Pi 源码 - 目录 - 结构");
  assert.equal(threads.title("0b0f5e0a-1111-4222-8333-944445555666"), null, "只知道当前会话的标题");
  document.title = "新会话 - Antigravity";
  assert.equal(threads.current().title, "新会话");
  document.title = "Antigravity";
  assert.equal(threads.current().title, null);
});

test("manifest 可选 hosts：限定卡片出现的宿主", async () => {
  const { validateManifest } = await import("../src/platform/registry/manifest.mjs");
  const { CARD_MANIFESTS } = await import("../src/card-registry.mjs");
  const base = { ...CARD_MANIFESTS.find((manifest) => manifest.id === "usage") };
  assert.equal(Object.hasOwn(validateManifest(base), "hosts"), false);
  assert.deepEqual(validateManifest({ ...base, hosts: ["codex"] }).hosts, ["codex"]);
  assert.throws(() => validateManifest({ ...base, hosts: [] }), /非空数组/);
  assert.throws(() => validateManifest({ ...base, hosts: ["vscode"] }), /codex \/ antigravity/);
  assert.throws(() => validateManifest({ ...base, hosts: ["codex", "codex"] }), /重复/);
  assert.deepEqual(CARD_MANIFESTS.find((manifest) => manifest.id === "proxy").hosts, ["codex"], "代理状态只对 Codex 有意义");
});
