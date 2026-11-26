import assert from "node:assert/strict";
import test from "node:test";

test("同一产物重复注入（already-mounted）时，本轮登记的卡片交给正在运行的运行时", async (t) => {
  const originalDocument = globalThis.document;
  globalThis.document = { body: {}, getElementById: () => null, addEventListener() {}, removeEventListener() {} };
  t.after(() => {
    delete globalThis.__AGENT_COMPANION__;
    delete globalThis.__AGENT_COMPANION_RENDERER__;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });
  await import("../src/renderer/entry.mjs");
  const renderer = globalThis.__AGENT_COMPANION_RENDERER__;
  const calls = [];
  globalThis.__AGENT_COMPANION__ = {
    artifactHash: "artifact-1",
    runtime: {
      isMounted: () => true,
      applyConfig: (config) => { calls.push(["applyConfig", config.revision]); return Promise.resolve(true); },
      defineCard: (id, module, hash) => { calls.push(["defineCard", id, hash, typeof module.mount]); return true; }
    }
  };
  const module = { mount() {} };
  assert.deepEqual(renderer.register("alpha", "hash-a", module), { status: "registered", id: "alpha" });
  assert.deepEqual(renderer.register("beta", "hash-b", module), { status: "registered", id: "beta" });
  const result = renderer.bootstrap({ action: "mount", config: { revision: 7 }, artifactHash: "artifact-1", version: "v" });
  assert.deepEqual(result, { status: "already-mounted", version: "v" });
  assert.deepEqual(calls, [
    ["applyConfig", 7],
    ["defineCard", "alpha", "hash-a", "function"],
    ["defineCard", "beta", "hash-b", "function"]
  ]);
});
