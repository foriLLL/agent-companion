// 将主卡片根（#agent-companion-root）上的 `--cc-*` 主题变量与 color-scheme 镜像到顶层浮层宿主，
// 并监听样式变化以实时跟随宿主亮暗主题切换。
const LEGACY_TOKENS = ["--hg-panel-radius", "--hg-font-family"];

export function createThemeMirror({ doc, source: explicitSource = null, sourceId = "agent-companion-root" } = {}) {
  let target = null;
  let observedSource = null;
  let observer = null;
  const mirrored = new Set();

  function resolveSource() {
    if (explicitSource?.isConnected && explicitSource.style?.getPropertyValue) return explicitSource;
    const byId = doc?.getElementById?.(sourceId);
    if (byId?.style?.getPropertyValue) return byId;
    return explicitSource?.style?.getPropertyValue ? explicitSource : null;
  }

  function sync() {
    if (!target) return;
    const source = resolveSource();
    if (!source) return;
    const next = new Set();
    const length = Number(source.style.length) || 0;
    for (let index = 0; index < length; index += 1) {
      const name = source.style[index];
      if (typeof name === "string" && name.startsWith("--cc-")) next.add(name);
    }
    for (const name of LEGACY_TOKENS) next.add(name);
    for (const name of next) {
      const value = source.style.getPropertyValue(name);
      if (value) {
        target.style.setProperty(name, value);
        mirrored.add(name);
      } else if (mirrored.delete(name)) {
        target.style.removeProperty(name);
      }
    }
    for (const name of [...mirrored]) {
      if (next.has(name)) continue;
      target.style.removeProperty(name);
      mirrored.delete(name);
    }
    const scheme = source.style.colorScheme;
    if (scheme) target.style.setProperty("color-scheme", scheme, "important");
    else target.style.setProperty("color-scheme", "light dark", "important");
    if (source !== observedSource && typeof doc.defaultView?.MutationObserver === "function") {
      observer?.disconnect();
      observedSource = source;
      observer = new doc.defaultView.MutationObserver(sync);
      observer.observe(source, { attributes: true, attributeFilter: ["style"] });
    }
  }

  return Object.freeze({
    attach(nextTarget) {
      if (target !== nextTarget) {
        mirrored.clear();
        target = nextTarget;
      }
      sync();
    },
    sync,
    disconnect() {
      observer?.disconnect();
      observer = null;
      observedSource = null;
      target = null;
      mirrored.clear();
    }
  });
}
