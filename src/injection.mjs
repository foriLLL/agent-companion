import { createHash } from "node:crypto";
import { RENDERER_SOURCE, RENDERER_ARTIFACT_HASH } from "./renderer-embedded.generated.mjs";

export const INJECTION_VERSION = `0.0.1-platform-${RENDERER_ARTIFACT_HASH.slice(0, 16)}`;
export const HOST_ID = "agent-companion-root";
export const RAIL_ID = "agent-companion-rail";
export const BRIDGE_KEY = "__AGENT_COMPANION__";
const RENDERER_KEY = "__AGENT_COMPANION_RENDERER__";

/**
 * 注入产物：平台代码（不含任何卡片）+ 这个宿主里全部卡片的 manifest 与界面代码（renderer.js）。
 * hash 是产物身份：平台代码或卡片目录（manifest、界面代码）变化时才变，页面据此整体重建；
 * 只改配置不变，启用或关闭卡片也不变——没送过的卡片由注入器按需补送（cardDefineSource）。
 * renderers：[{ id, hash, code }]，来自卡片目录（platform/cards/catalog.mjs）。
 */
export function createInjectionArtifact({
  manifests = [], renderers = [], platformSource = RENDERER_SOURCE, platformHash = RENDERER_ARTIFACT_HASH
} = {}) {
  const byId = new Map(renderers.map(({ id, hash, code }) => [id, Object.freeze({ id, hash, code })]));
  const listed = manifests.filter((manifest) => byId.has(manifest.id));
  const hash = listed.length === 0 ? platformHash : createHash("sha256")
    .update(JSON.stringify([platformHash, listed, listed.map(({ id }) => byId.get(id).hash)])).digest("hex");
  return Object.freeze({ hash, platformHash, platformSource, manifests: Object.freeze([...listed]), renderers: byId });
}

// 只有平台、没有卡片的产物：一次性卸载、旧入口和测试用。
export const PLATFORM_ARTIFACT = createInjectionArtifact();
export const ARTIFACT_HASH = PLATFORM_ARTIFACT.hash;

/** 配置里启用、产物里有界面代码的卡片；总开关关闭时一张也不送。 */
export function enabledRenderers(artifact, config = {}) {
  if (config?.enabled === false) return [];
  return artifact.manifests
    .filter((manifest) => {
      const raw = config?.cards?.[manifest.id];
      const enabled = typeof raw === "boolean" ? raw : typeof raw?.enabled === "boolean" ? raw.enabled : manifest.defaultEnabled;
      return enabled === true;
    })
    .map(({ id }) => artifact.renderers.get(id));
}

/**
 * 把一张卡片的 renderer.js 包成在页面里执行的代码：卡片代码里的 __companionDefine 指向平台的登记函数，
 * 卡片看不到也不需要页面全局。mode 为 register 时只登记（随整页注入、由 bootstrap 交给新运行时），
 * define 时交给正在运行的运行时挂载（页面已挂载后补送）。表达式的值是登记结果。
 */
export function cardDefineSource(renderer, { mode = "define" } = {}) {
  const method = mode === "register" ? "register" : "defineCard";
  const call = `globalThis.${RENDERER_KEY}.${method}(${JSON.stringify(renderer.id)}, ${JSON.stringify(renderer.hash)}, module)`;
  return `(() => {\nlet result = { status: "missing", id: ${JSON.stringify(renderer.id)} };\n`
    + `(function (__companionDefine) {\n${renderer.code}\n})(function (module) { result = ${call}; return result; });\n`
    + "return result;\n})()";
}

// 注入身份只由构建产物决定。配置更新走 runtime.applyConfig，不重建业务实例。
// options：{ config, host, artifact }；旧调用方可直接把配置作为 options 传入。
export function buildInjectionSource(action = "mount", options = {}) {
  if (!["mount", "unmount"].includes(action)) throw new TypeError(`不支持的注入动作：${action}`);
  const host = options.host ?? "codex";
  const artifact = options.artifact ?? PLATFORM_ARTIFACT;
  const config = options.config ?? options;
  const value = {
    action, config, ...(host === "codex" ? {} : { host }), artifactHash: artifact.hash, version: INJECTION_VERSION,
    ...(action === "mount" ? { manifests: artifact.manifests } : {})
  };
  const cards = action === "mount" ? enabledRenderers(artifact, config).map((renderer) => `;${cardDefineSource(renderer, { mode: "register" })}\n`).join("") : "";
  return `${artifact.platformSource}\n${cards};globalThis.${RENDERER_KEY}.bootstrap(${JSON.stringify(value)})`;
}

export function buildConfigUpdateSource(config) {
  return `globalThis[${JSON.stringify(BRIDGE_KEY)}]?.runtime?.applyConfig(${JSON.stringify(config)})`;
}
