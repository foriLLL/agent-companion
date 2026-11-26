import { createCardRuntime } from "./runtime/card-runtime.mjs";

const BRIDGE_KEY = "__AGENT_COMPANION__";
let pending = null;
// 送到这个页面的卡片界面：id → { hash, module }。平台代码里不含任何卡片，
// 每张卡片的 renderer.js 由注入器包上 register / defineCard 调用后单独送来。
const cards = new Map();

function validCard(id, hash, module) {
  return typeof id === "string" && /^[a-z][a-z0-9-]*$/.test(id) && (hash === null || typeof hash === "string")
    && typeof module?.mount === "function";
}

// 随整页注入一起送来的卡片：只登记，由随后的 bootstrap 一并交给新建的运行时。
function register(id, hash, module) {
  if (!validCard(id, hash, module)) return { status: "invalid", id };
  cards.set(id, { hash, module });
  return { status: "registered", id };
}

// 页面已挂载后补送的卡片（例如刚在设置里启用）：登记并交给正在运行的运行时挂载。
function defineCard(id, hash, module) {
  if (!validCard(id, hash, module)) return { status: "invalid", id };
  cards.set(id, { hash, module });
  const accepted = globalThis[BRIDGE_KEY]?.runtime?.defineCard?.(id, module, hash) ?? false;
  return { status: accepted ? "defined" : "registered", id };
}

function cleanupLegacy() {
  try { globalThis.__CODEX_HG__?.unmount?.(); } catch {}
  delete globalThis.__CODEX_HG__;
  for (const id of ["codex-hg-root", "codex-hg-rail"]) document.getElementById(id)?.remove();
  // 改名前（Codex Companion）注入的 runtime：自动更新只重启 agent、不重启 Codex，页面里可能还留着它。
  try { globalThis.__CODEX_COMPANION_RENDERER__?.cancelPending?.(); } catch {}
  try { globalThis.__CODEX_COMPANION__?.unmount?.(); } catch {}
  delete globalThis.__CODEX_COMPANION_RENDERER__;
  delete globalThis.__CODEX_COMPANION__;
  for (const id of ["codex-companion-root", "codex-companion-rail"]) document.getElementById(id)?.remove();
}

function bootstrap({ action = "mount", config = {}, host = "codex", artifactHash, version, manifests = [] } = {}) {
  const previous = globalThis[BRIDGE_KEY];
  if (action === "unmount") {
    pending?.();
    pending = null;
    previous?.unmount?.();
    delete globalThis[BRIDGE_KEY];
    cleanupLegacy();
    return { status: "unmounted", version };
  }
  if (!document.body) {
    pending?.();
    const ready = () => { pending = null; bootstrap({ action, config, host, artifactHash, version, manifests }); };
    document.addEventListener("DOMContentLoaded", ready, { once: true });
    pending = () => document.removeEventListener("DOMContentLoaded", ready);
    return { status: "scheduled", version };
  }
  cleanupLegacy();
  if (previous?.artifactHash === artifactHash && previous?.runtime?.isMounted()) {
    void previous.runtime.applyConfig(config);
    // 本轮随整页注入登记（register）的卡片也交给正在运行的运行时：它还没有的就地挂载，
    // 已有且哈希相同的由 defineCard 自行忽略。不能等注入器下一轮补送。
    for (const [id, { hash, module }] of cards) {
      try { previous.runtime.defineCard?.(id, module, hash); } catch {}
    }
    return { status: "already-mounted", version };
  }
  // 换注入产物（安装、卸载卡片等）时整体重建：先记下抽屉和设置是否开着，新运行时接着打开。
  let restoreUi = null;
  try { restoreUi = previous?.runtime?.getUiState?.() ?? null; } catch {}
  try { previous?.unmount?.(); } catch {}
  // 只清理本平台旧宿主，不访问原生 Summary。
  for (const id of ["agent-companion-root", "agent-companion-rail", "agent-companion-rail-backdrop"]) document.getElementById(id)?.remove();
  const renderers = Object.fromEntries([...cards].map(([id, { module }]) => [id, module]));
  const rendererHashes = Object.fromEntries([...cards].map(([id, { hash }]) => [id, hash]));
  const runtime = createCardRuntime({ manifests, renderers, rendererHashes, config, artifactHash, host, restoreUi });
  const bridge = {
    version, artifactHash, cardsKey: artifactHash, runtime, host,
    hostId: "agent-companion-root", railId: "agent-companion-rail",
    isMounted: runtime.isMounted, isPlaced: runtime.isPlaced, getPlacement: runtime.getPlacement,
    receiveRpc: runtime.receiveRpc,
    setOpen: runtime.setOpen,
    unmount() {
      if (globalThis[BRIDGE_KEY] === bridge) delete globalThis[BRIDGE_KEY];
      return runtime.dispose();
    },
    // 调试入口：卡片 mount 返回的 api（例如冒烟脚本驱动 Emby 卡片）。平台不认识具体卡片。
    card: (id) => runtime.getCardApi(id)
  };
  globalThis[BRIDGE_KEY] = bridge;
  return { status: config.enabled === false || runtime.getDiagnostics().shell.count === 0 ? "cards-disabled" : "mounted", placement: runtime.getPlacement(), version };
}

globalThis.__AGENT_COMPANION_RENDERER__?.cancelPending?.();
globalThis.__AGENT_COMPANION_RENDERER__ = {
  bootstrap,
  register,
  defineCard,
  cancelPending() { pending?.(); pending = null; }
};
