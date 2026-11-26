import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { reserveLoopbackPort } from "../launcher.mjs";
import { createAntigravitySnapshot, DEFAULT_ANTIGRAVITY_EXECUTABLE } from "./antigravity-host.mjs";

const execFileAsync = promisify(execFile);
export const DEFAULT_ANTIGRAVITY_APP = "/Applications/Antigravity.app";

/**
 * 以本机随机调试端口打开 Antigravity，后台服务看到后自动注入卡片。
 * - 已经带本机调试端口在运行：什么都不做；
 * - 在运行但没带端口（或端口开在非本机地址）：默认不动，restart 时先正常退出（和在菜单里点退出一样，绝不强杀）再打开；
 * 退出等不到（例如弹了「有未完成的任务」确认框）就报错，让用户自己处理。
 */
export async function openAntigravity({
  restart = false, appPath = DEFAULT_ANTIGRAVITY_APP, executable = DEFAULT_ANTIGRAVITY_EXECUTABLE,
  snapshot = createAntigravitySnapshot({ executable }), reservePort = reserveLoopbackPort,
  execFileImpl = execFileAsync, sleepImpl = (ms) => sleep(ms), quitTimeoutMs = 20_000, pollMs = 300, platform = process.platform
} = {}) {
  if (platform !== "darwin") throw Object.assign(new Error("目前只支持 macOS 版 Antigravity"), { code: "UNSUPPORTED" });
  const apps = await snapshot();
  const ready = apps.find((app) => app.port !== null && app.loopback);
  if (ready) return { launched: false, reason: "already-running", pid: ready.pid, port: ready.port };
  if (apps.length) {
    if (!restart) return { launched: false, reason: "needs-restart", pid: apps[0].pid };
    // 应用路径作为参数传给脚本，不拼进 AppleScript 源码。
    await execFileImpl("/usr/bin/osascript", ["-e", "on run argv\ntell application (item 1 of argv) to quit\nend run", appPath], { timeout: 10_000 });
    const deadline = Date.now() + quitTimeoutMs;
    while ((await snapshot()).length) {
      if (Date.now() >= deadline) throw Object.assign(new Error("Antigravity 没有退出，请手动退出后再试"), { code: "QUIT_TIMEOUT" });
      await sleepImpl(pollMs);
    }
  }
  const port = await reservePort();
  await execFileImpl("/usr/bin/open", ["-a", appPath, "--args", `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"], { timeout: 10_000 });
  return { launched: true, port, restarted: apps.length > 0 };
}
