import { EmbyService } from "./emby-service.mjs";
import { rpcError } from "../../sdk/service.mjs";

export const EMBY_OPERATIONS = Object.freeze([
  "connection.status", "auth.login", "auth.logout", "servers.list", "servers.switch", "servers.remove",
  "home.get", "library.get", "search", "series.get", "playback.open", "playback.progress", "playback.stop",
  "playback.direct.init", "playback.direct.next", "playback.direct.seek", "playback.subtitle.load", "playback.subtitle.select", "resource.load"
]);

// api.media.interceptor：平台的 CDP 媒体拦截，用于原生 MP4 直放。embyService 只供测试替换。
export function createService({ embyService, media, logger = console } = {}) {
  const engine = embyService ?? new EmbyService({ logger, interceptor: media?.interceptor ?? null });
  const owners = new Map();
  return {
    methods: Object.fromEntries(EMBY_OPERATIONS.map(operation => [operation, async (params, context) => {
      if (operation.startsWith("playback.") && operation !== "playback.open" && params.playbackId) {
        if (operation === "playback.stop" && !owners.has(params.playbackId)) return { playbackId: params.playbackId, stopped: false };
        if (!owners.has(params.playbackId) || owners.get(params.playbackId) !== context.targetId) throw rpcError("PLAYBACK_NOT_FOUND", "播放会话不属于当前卡片实例");
      }
      const result = await engine.handleRpc(operation, params, context);
      if (operation === "playback.open" && result?.playbackId) owners.set(result.playbackId, context.targetId);
      if (operation === "playback.stop" && result?.stopped) owners.delete(params.playbackId);
      return result;
    }])),
    aliases: Object.fromEntries(EMBY_OPERATIONS.map(operation => [operation, operation])),
    cleanupMethods: ["playback.stop"],
    async disposeTarget(targetId) {
      try { await engine.disposeTarget?.(targetId); }
      finally { for (const [id, owner] of owners) if (owner === targetId) owners.delete(id); }
    },
    async dispose() { try { await engine.dispose?.(); } finally { owners.clear(); } }
  };
}
