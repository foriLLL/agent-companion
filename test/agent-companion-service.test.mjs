import assert from "node:assert/strict";
import test from "node:test";
import { createServiceWithClips } from "./helpers/clips-card.mjs";

test("统一 RPC Service 按命名空间隔离两张媒体卡", async () => {
  const calls = [];
  const embyService = {
    async handleRpc(method) { calls.push(["emby", method]); return "emby"; },
    disposeTarget(target) { calls.push(["emby:disposeTarget", target]); },
    dispose() { calls.push(["emby:dispose"]); }
  };
  const clipsService = {
    async handleRpc(method) { calls.push(["clips", method]); return "clips"; },
    disposeTarget(target) { calls.push(["clips:disposeTarget", target]); },
    dispose() { calls.push(["clips:dispose"]); }
  };
  const service = createServiceWithClips({ embyService, clipsService, configStore: { loadV2: async () => ({ version: 2, enabled: true, cards: {} }) } });
  assert.equal(await service.handleRpc("clips.home", {}, {}), "clips");
  assert.equal(await service.handleRpc("connection.status", {}, {}), "emby");
  await service.disposeTarget("renderer");
  await service.dispose();
  assert.deepEqual(calls, [
    ["clips", "clips.home"],
    ["emby", "connection.status"],
    ["clips:disposeTarget", "renderer"],
    ["emby:disposeTarget", "renderer"],
    ["clips:dispose"],
    ["emby:dispose"]
  ]);
});


