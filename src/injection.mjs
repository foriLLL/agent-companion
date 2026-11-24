import { RENDERER_SOURCE, RENDERER_ARTIFACT_HASH } from "./renderer-embedded.generated.mjs";

export const INJECTION_VERSION = `0.0.1-platform-${RENDERER_ARTIFACT_HASH.slice(0, 16)}`;
export const HOST_ID = "agent-companion-root";
export const RAIL_ID = "agent-companion-rail";
export const BRIDGE_KEY = "__AGENT_COMPANION__";
export const ARTIFACT_HASH = RENDERER_ARTIFACT_HASH;

// 注入身份只由构建产物决定。配置更新走 runtime.applyConfig，不重建业务实例。
export function buildInjectionSource(action = "mount", options = {}) {
  if (!["mount", "unmount"].includes(action)) throw new TypeError(`不支持的注入动作：${action}`);
  const host = options.host ?? "codex";
  const value = { action, config: options.config ?? options, ...(host === "codex" ? {} : { host }), artifactHash: ARTIFACT_HASH, version: INJECTION_VERSION };
  return `${RENDERER_SOURCE}\n;globalThis.__AGENT_COMPANION_RENDERER__.bootstrap(${JSON.stringify(value)})`;
}

export function buildConfigUpdateSource(config) {
  return `globalThis[${JSON.stringify(BRIDGE_KEY)}]?.runtime?.applyConfig(${JSON.stringify(config)})`;
}
