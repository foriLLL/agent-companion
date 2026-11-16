import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { companionDataDir, searchPathCandidates } from "../../platform/paths.mjs";

async function executable() {
  const candidates = [
    process.env.CODEX_COMPANION_CHROME,
    ...(process.platform === "darwin" ? [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium"
    ] : []),
    ...searchPathCandidates(["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"])
  ];
  for (const path of candidates.filter(Boolean)) {
    try { await access(path, constants.X_OK); return path; } catch {}
  }
  throw new Error("卡内游戏需要本机 Chrome 或 Chromium。可用 CODEX_COMPANION_CHROME 指定路径。");
}

// 调试协议只走父子进程专用管道。Chrome 退出或父进程关掉管道时，双方一起释放。
export async function launchGameBrowser({ proxy, profile = join(companionDataDir(), "chrono-divide-profile") } = {}) {
  const path = await executable();
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const child = spawn(path, ["--headless=new", "--remote-debugging-pipe", "--no-first-run",
    "--no-default-browser-check", "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
    "--autoplay-policy=no-user-gesture-required", "--auto-accept-this-tab-capture",
    "--allow-loopback-in-peer-connection", `--user-data-dir=${profile}`,
    ...(proxy?.enabled && Number.isInteger(proxy.port) ? [`--proxy-server=http://127.0.0.1:${proxy.port}`] : []),
    "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const input = child.stdio[3], output = child.stdio[4];
  const pending = new Map(), frameListeners = new Map();
  let serial = 0, stopped = false, buffer = "";
  const exited = new Promise(resolve => child.once("close", resolve));
  function fail(error) {
    stopped = true;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }
  child.on("error", fail);
  input.on("error", fail);
  output.on("error", fail);
  child.once("close", () => fail(new Error("游戏浏览器已退出，请重新启动游戏。")));
  output.setEncoding("utf8");
  output.on("data", chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\0")) !== -1) {
      const message = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!message) continue;
      // 管道里出现无法解析的消息时丢弃这一条，不能让异常冒到事件循环把后台服务带崩。
      let response;
      try { response = JSON.parse(message); } catch { continue; }
      if (response.method === "Page.screencastFrame") frameListeners.get(response.sessionId)?.(response.params);
      const request = pending.get(response.id);
      if (!request) continue;
      pending.delete(response.id);
      if (response.error) request.reject(new Error(response.error.message));
      else request.resolve(response.result);
    }
  });
  function send(method, params = {}, sessionId) {
    if (stopped) return Promise.reject(new Error("游戏浏览器已关闭。"));
    const id = ++serial;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error("游戏浏览器响应超时，请重新启动游戏。"));
      }, 20_000);
      pending.set(id, {
        resolve(value) { clearTimeout(timeout); resolve(value); },
        reject(error) { clearTimeout(timeout); reject(error); }
      });
      input.write(JSON.stringify({ id, method, params, sessionId }) + "\0");
    });
  }
  let closing;
  function close() {
    if (!closing) closing = (async () => {
      if (!stopped) void send("Browser.close").catch(() => {});
      const timer = setTimeout(() => { input.destroy(); child.kill("SIGTERM"); }, 1500);
      try { await exited; } finally { clearTimeout(timer); }
    })();
    return closing;
  }
  function onFrame(sessionId, listener) {
    frameListeners.set(sessionId, listener);
    return () => frameListeners.delete(sessionId);
  }
  return { send, close, onFrame };
}
