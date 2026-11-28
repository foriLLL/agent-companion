import test from "node:test";
import assert from "node:assert/strict";
import { createThemeMirror } from "../src/renderer/shell/mirror-theme.mjs";

function fakeStyle(initial = {}) {
  const map = new Map(Object.entries(initial));
  let colorScheme = "";
  const style = {
    get length() { return map.size; },
    get colorScheme() { return colorScheme; },
    set colorScheme(value) { colorScheme = String(value ?? ""); },
    getPropertyValue(name) { return map.get(name) ?? ""; },
    setProperty(name, value, _priority) {
      if (name === "color-scheme") { colorScheme = String(value ?? ""); return; }
      map.set(name, String(value));
    },
    removeProperty(name) {
      if (name === "color-scheme") { colorScheme = ""; return; }
      map.delete(name);
    }
  };
  return new Proxy(style, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && /^\d+$/.test(prop)) return [...map.keys()][Number(prop)];
      return Reflect.get(target, prop, receiver);
    }
  });
}

function fakeElement(initial = {}) {
  return { isConnected: true, style: fakeStyle(initial) };
}

function fakeDoc(byId = {}) {
  const observers = [];
  class FakeMutationObserver {
    constructor(cb) {
      this.cb = cb;
      this.target = null;
      this.options = null;
      this.disconnected = false;
      observers.push(this);
    }
    observe(target, options) { this.target = target; this.options = options; this.disconnected = false; }
    disconnect() { this.disconnected = true; }
    trigger() { if (!this.disconnected) this.cb([]); }
  }
  return {
    observers,
    getElementById: (id) => byId[id] ?? null,
    defaultView: { MutationObserver: FakeMutationObserver }
  };
}

test("createThemeMirror 镜像全部 --cc-*、遗留 token 与 color-scheme，并在主题变更时实时同步与清理", () => {
  const source = fakeElement({
    "--cc-card-bg": "#ffffff",
    "--cc-card-surface": "rgba(255,255,255,.92)",
    "--cc-card-fg": "#1f1f1f",
    "--cc-section-title-size": "11.5px",
    "--hg-panel-radius": "14px",
    "--hg-font-family": "Inter, sans-serif",
    "--unrelated-var": "ignored"
  });
  source.style.colorScheme = "light";
  const target = fakeElement();
  const doc = fakeDoc();

  const mirror = createThemeMirror({ doc, source });
  mirror.attach(target);

  assert.equal(target.style.getPropertyValue("--cc-card-bg"), "#ffffff");
  assert.equal(target.style.getPropertyValue("--cc-card-surface"), "rgba(255,255,255,.92)");
  assert.equal(target.style.getPropertyValue("--cc-section-title-size"), "11.5px");
  assert.equal(target.style.getPropertyValue("--hg-panel-radius"), "14px");
  assert.equal(target.style.getPropertyValue("--hg-font-family"), "Inter, sans-serif");
  assert.equal(target.style.getPropertyValue("--unrelated-var"), "", "不镜像非 --cc-* 的无关变量");
  assert.equal(target.style.colorScheme, "light");
  assert.equal(doc.observers.length, 1);
  assert.equal(doc.observers[0].target, source);

  // 主题切换并移除一个旧变量：MutationObserver 触发后同步更新并清掉已删除的变量。
  source.style.setProperty("--cc-card-bg", "#1e1f22");
  source.style.removeProperty("--cc-section-title-size");
  source.style.colorScheme = "dark";
  doc.observers[0].trigger();

  assert.equal(target.style.getPropertyValue("--cc-card-bg"), "#1e1f22");
  assert.equal(target.style.getPropertyValue("--cc-section-title-size"), "", "源上移除的变量应从目标清掉");
  assert.equal(target.style.colorScheme, "dark");

  // disconnect 后不再响应变更。
  mirror.disconnect();
  assert.equal(doc.observers[0].disconnected, true);
  source.style.setProperty("--cc-card-bg", "#000000");
  doc.observers[0].trigger();
  assert.equal(target.style.getPropertyValue("--cc-card-bg"), "#1e1f22");
});

test("createThemeMirror 支持按 sourceId 回退，且找不到源节点时不抛错", () => {
  const byIdSource = fakeElement({ "--cc-card-fg": "#111111" });
  const target = fakeElement();
  const doc = fakeDoc({ "agent-companion-root": byIdSource });

  const mirror = createThemeMirror({ doc });
  mirror.attach(target);
  assert.equal(target.style.getPropertyValue("--cc-card-fg"), "#111111");
  mirror.disconnect();

  const emptyDoc = fakeDoc({});
  const orphanTarget = fakeElement();
  const orphanMirror = createThemeMirror({ doc: emptyDoc });
  assert.doesNotThrow(() => orphanMirror.attach(orphanTarget));
  assert.equal(orphanTarget.style.length, 0);
  orphanMirror.disconnect();
});
