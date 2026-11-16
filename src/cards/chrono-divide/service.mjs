import { setTimeout as sleep } from "node:timers/promises";
import { launchGameBrowser } from "./game-browser.mjs";
import { createFrameFeed } from "./frames.mjs";
import { fitBattlefield } from "./viewport.mjs";
import { answerGameStream, gatherIce, loopbackDescription } from "./stream.mjs";

const GAME_URL = "https://game.chronodivide.com/";
const POINTER_TYPES = new Set(["mouseMoved", "mousePressed", "mouseReleased", "mouseWheel"]);
const BUTTONS = new Set(["none", "left", "middle", "right"]);
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

function sizeOf({ width, height }) {
  if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error("游戏画面尺寸无效。");
  return { width: clamp(Math.round(width), 800, 2560), height: clamp(Math.round(height), 600, 1600) };
}

export function inputCommand(event, size) {
  const { type } = event;
  const modifiers = Number.isInteger(event.modifiers) ? event.modifiers & 15 : 0;
  if (POINTER_TYPES.has(type)) {
    if (!Number.isFinite(event.x) || !Number.isFinite(event.y) || !BUTTONS.has(event.button)) throw new Error("鼠标参数无效。");
    const params = { type, x: Math.round(clamp(event.x, 0, 1) * (size.width - 1)),
      y: Math.round(clamp(event.y, 0, 1) * (size.height - 1)), button: event.button,
      buttons: (event.buttons ?? 0) & 7, modifiers, clickCount: clamp(event.clickCount || 0, 0, 3) };
    if (type === "mouseWheel") {
      params.deltaX = clamp(Number(event.deltaX) || 0, -3000, 3000);
      params.deltaY = clamp(Number(event.deltaY) || 0, -3000, 3000);
    }
    return ["Input.dispatchMouseEvent", params];
  }
  if (type === "keyDown" || type === "keyUp") {
    if (typeof event.key !== "string" || event.key.length > 48 || typeof event.code !== "string" || event.code.length > 48) {
      throw new Error("键盘参数无效。");
    }
    const keyCode = clamp(Number(event.keyCode) || 0, 0, 255);
    return ["Input.dispatchKeyEvent", { type, key: event.key, code: event.code, windowsVirtualKeyCode: keyCode,
      modifiers, autoRepeat: !!event.repeat,
      ...(type === "keyDown" && event.key.length === 1 && !(modifiers & 7) ? { text: event.key } : {}) }];
  }
  throw new Error("不支持的游戏输入。");
}

export function createService({ loadConfig = async () => ({}), launchBrowser = launchGameBrowser } = {}) {
  // 一个专用资料目录保存游戏资源。同一时刻只由一张卡片持有。
  let active;
  function owned(targetId) {
    if (active?.owner !== targetId || !active.sessionId || active.stopping) throw new Error("游戏未启动。");
    return active;
  }
  async function stop(targetId) {
    const game = active;
    if (!game || game.owner !== targetId) return;
    if (!game.stopping) {
      game.abort.abort();
      game.stopping = (async () => {
        try {
          try { await game.frames?.close(); }
          finally { await (await game.starting)?.close(); }
        }
        finally { if (active === game) active = null; }
      })();
    }
    await game.stopping;
  }
  async function resize(game, size) {
    await game.send("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 1, mobile: false });
    game.size = size;
  }

  function displaySize({ displayWidth, displayHeight }, size) {
    return {
      width: Number.isFinite(displayWidth) ? clamp(Math.ceil(displayWidth), 1, size.width) : size.width,
      height: Number.isFinite(displayHeight) ? clamp(Math.ceil(displayHeight), 1, size.height) : size.height
    };
  }
  async function open({ offer, ...dimensions }, { targetId, signal, mediaTransport }) {
    if (offer?.type !== "offer" || typeof offer.sdp !== "string" || offer.sdp.length > 100_000) throw new Error("无效的游戏连接请求。");
    const size = sizeOf(dimensions);
    if (active?.stopping) await active.stopping;
    signal.throwIfAborted();
    if (active) throw new Error("已有红警卡片正在运行。请先在那张卡片里结束游戏。");
    const game = { owner: targetId, abort: new AbortController() };
    active = game;
    const lifetime = AbortSignal.any([game.abort.signal, signal]);
    game.starting = (async () => {
      const config = await loadConfig();
      lifetime.throwIfAborted();
      return launchBrowser({ proxy: config?.launch?.proxy });
    })();
    try {
      const browser = await game.starting;
      lifetime.throwIfAborted();
      const { targetId: page } = await browser.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await browser.send("Target.attachToTarget", { targetId: page, flatten: true });
      game.sessionId = sessionId;
      game.send = (method, params) => browser.send(method, params, sessionId);
      await resize(game, size);
      await game.send("Page.enable");
      await game.send("Page.addScriptToEvaluateOnNewDocument", { source:
        `if (location.origin === "https://game.chronodivide.com") addEventListener("DOMContentLoaded", () => (${fitBattlefield.toString()})(window), {once:true});` });
      const nav = await game.send("Page.navigate", { url: GAME_URL });
      if (nav.errorText) throw new Error("游戏页面加载失败：" + nav.errorText);
      const deadline = Date.now() + 20_000;
      while (true) {
        lifetime.throwIfAborted();
        const { result } = await game.send("Runtime.evaluate", {
          expression: 'location.origin === "https://game.chronodivide.com" && !!document.getElementById("ra2web-root")'
        });
        if (result.value) break;
        if (Date.now() >= deadline) throw new Error("载入游戏超时，请检查网络或 Companion 代理。");
        await sleep(100, undefined, { signal: lifetime });
      }
      const { frameTree } = await game.send("Page.getFrameTree");
      const { executionContextId } = await game.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "companion-game-stream" });
      const response = await game.send("Runtime.evaluate", {
        expression: `(${answerGameStream.toString()})(${JSON.stringify(loopbackDescription(offer))}, ${gatherIce.toString()})`,
        contextId: executionContextId, awaitPromise: true, returnByValue: true, userGesture: true
      });
      if (response.exceptionDetails) throw new Error("游戏画面连接失败：" + (response.exceptionDetails.exception?.description ?? response.exceptionDetails.text));
      lifetime.throwIfAborted();
      if (mediaTransport === "intercept") {
        // 本机媒体入口不可用时，已协商好的 WebRTC 视频可独立工作。
        const frames = await createFrameFeed({
          browser, sessionId, send: game.send, initialSize: displaySize(dimensions, size),
          setVideoEnabled: enabled => game.send("Runtime.evaluate", { contextId: executionContextId, awaitPromise: true,
            expression: `window.__companionSetGameVideo(${enabled ? "true" : "false"})` })
        }).catch(() => null);
        if (lifetime.aborted) { await frames?.close(); lifetime.throwIfAborted(); }
        game.frames = frames;
      }
      return { answer: loopbackDescription(response.result.value), framesUrl: game.frames?.url };
    } catch (error) {
      await stop(targetId).catch(() => {});
      throw error;
    }
  }
  return {
    methods: {
      open,
      resize: async (params, ctx) => {
        const game = owned(ctx.targetId), size = sizeOf(params);
        if (game.size.width !== size.width || game.size.height !== size.height) await resize(game, size);
        await game.frames?.resize(displaySize(params, size));
        return {};
      },
      input: async ({ events }, ctx) => {
        if (!Array.isArray(events) || events.length > 128) throw new Error("游戏输入批次无效。");
        const game = owned(ctx.targetId);
        const commands = events.map(event => inputCommand(event, game.size));
        // 写入管道的顺序与用户按下、移动、放开的顺序一致。
        await Promise.all(commands.map(([method, params]) => game.send(method, params)));
        return {};
      },
      stop: async (_params, ctx) => { await stop(ctx.targetId); return {}; }
    },
    cleanupMethods: ["stop"], disposeTarget: stop,
    dispose: () => active ? stop(active.owner) : undefined
  };
}
