import { CARD_MANIFESTS } from "../../src/card-registry.mjs";
import { SERVICE_REGISTRY } from "../../src/cards/service-registry.generated.mjs";
import { CodexCompanionService } from "../../src/codex-companion-service.mjs";

// 平台隔离测试用的第二张媒体卡：只把 RPC 与清理转发给注入的 clipsService，不含业务逻辑。
// 真实红果卡片会随构建产物演进而变，这里用固定的合成卡保证隔离测试不受业务实现影响。
export const CLIPS_OPERATIONS = Object.freeze(["home", "playback.open", "playback.stop"]);

const CLIPS_MANIFEST = Object.freeze({
  id: "clips",
  title: "片段夹具",
  version: 1,
  defaultEnabled: true,
  defaultOrder: 20,
  layout: { height: "viewport", minHeight: 320, scroll: "inner" },
  lifecycle: { hidden: "retain", start: "first-visible" },
  state: { scope: "target", version: 1 },
  capabilities: ["rpc", "storage"]
});

export function createServiceWithClips({ clipsService = {}, ...options } = {}) {
  const manifests = [
    ...CARD_MANIFESTS.filter((manifest) => manifest.defaultOrder < CLIPS_MANIFEST.defaultOrder),
    CLIPS_MANIFEST,
    ...CARD_MANIFESTS.filter((manifest) => manifest.defaultOrder >= CLIPS_MANIFEST.defaultOrder)
  ];
  const clips = {
    createService: () => ({
      methods: Object.fromEntries(CLIPS_OPERATIONS.map((operation) => [
        operation,
        (params, context) => clipsService.handleRpc(`clips.${operation}`, params, context)
      ])),
      cleanupMethods: ["playback.stop"],
      disposeTarget: (targetId) => clipsService.disposeTarget?.(targetId),
      dispose: () => clipsService.dispose?.()
    })
  };
  return new CodexCompanionService({ ...options, manifests, modules: { ...SERVICE_REGISTRY, clips } });
}
