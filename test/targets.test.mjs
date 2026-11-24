import assert from "node:assert/strict";
import test from "node:test";
import { filterCodexTargets, isCodexAppTarget } from "../src/targets.mjs";

test("只选择带本机调试地址的 app:// 页面 target", () => {
  const targets = filterCodexTargets([
    { id: "main", type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://127.0.0.1:9000/devtools/page/main" },
    { id: "overlay", type: "page", url: "app://-/index.html?initialRoute=%2Favatar-overlay", webSocketDebuggerUrl: "ws://127.0.0.1:9000/devtools/page/overlay" },
    { id: "pet", type: "page", url: "app://-/avatar-overlay-composition-surface.html?surfaceId=mascot-badge", webSocketDebuggerUrl: "ws://127.0.0.1:9000/devtools/page/pet" },
    { id: "sandbox", type: "page", url: "https://web-sandbox.oaiusercontent.com/", webSocketDebuggerUrl: "ws://127.0.0.1:9000/devtools/page/sandbox" },
    { id: "worker", type: "worker", url: "app://codex/worker", webSocketDebuggerUrl: "ws://127.0.0.1:9000/devtools/page/worker" },
    { id: "missing-socket", type: "page", url: "app://codex/settings" }
  ]);

  assert.deepEqual(targets.map((target) => target.id), ["main"]);
});

test("识别 Codex 辅助 app renderer，但不把它当作主界面", () => {
  const pet = {
    id: "pet",
    type: "page",
    url: "app://-/avatar-overlay-composition-surface.html?surfaceId=mascot-badge",
    webSocketDebuggerUrl: "ws://127.0.0.1:9000/devtools/page/pet"
  };
  assert.equal(isCodexAppTarget(pet), true);
  assert.deepEqual(filterCodexTargets([pet]), []);
});

test("Antigravity 只认本机 http(s) 带端口的 Hub 页面", async () => {
  const { filterAntigravityTargets, hostTargets, isAntigravityHubTarget } = await import("../src/targets.mjs");
  const ws = (id) => `ws://127.0.0.1:9339/devtools/page/${id}`;
  const targets = filterAntigravityTargets([
    { id: "hub", type: "page", url: "https://127.0.0.1:53121/c/5f13e99e-f461-4309-9796-ce99e2b141ef", webSocketDebuggerUrl: ws("hub") },
    { id: "hub-http", type: "page", url: "http://localhost:53121/", webSocketDebuggerUrl: ws("hub-http") },
    { id: "remote", type: "page", url: "https://antigravity.google/", webSocketDebuggerUrl: ws("remote") },
    { id: "no-port", type: "page", url: "https://127.0.0.1/", webSocketDebuggerUrl: ws("no-port") },
    { id: "devtools", type: "page", url: "devtools://devtools/bundled/inspector.html", webSocketDebuggerUrl: ws("devtools") },
    { id: "worker", type: "service_worker", url: "https://127.0.0.1:53121/sw.js", webSocketDebuggerUrl: ws("worker") },
    { id: "missing-socket", type: "page", url: "https://127.0.0.1:53121/" }
  ]);
  assert.deepEqual(targets.map((target) => target.id), ["hub", "hub-http"]);
  assert.equal(isAntigravityHubTarget({ type: "page", url: "not a url", webSocketDebuggerUrl: ws("x") }), false);
  assert.equal(hostTargets().id, "codex");
  assert.equal(hostTargets("antigravity").name, "Antigravity");
  assert.throws(() => hostTargets("vscode"), /未知宿主/);
});

test("等待 target 时按宿主筛选", async () => {
  const { waitForCodexTargets } = await import("../src/targets.mjs");
  const listTargets = async () => [
    { id: "codex", type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/page/codex" },
    { id: "hub", type: "page", url: "https://127.0.0.1:53121/", webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/page/hub" }
  ];
  assert.deepEqual((await waitForCodexTargets(1, { listTargets })).map((target) => target.id), ["codex"]);
  assert.deepEqual((await waitForCodexTargets(1, { listTargets, host: "antigravity" })).map((target) => target.id), ["hub"]);
});
