import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveFfmpegPath } from "../src/ffmpeg-path.mjs";
import { searchPathCandidates } from "../src/platform/paths.mjs";
import { buildNative } from "./build-native.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const NATIVE_SOURCES = join(repoRoot, "packaging", "mac-app", "Native");

// 从源码安装（npm start）前的准备，让一条命令就能装好：
// - macOS 编译原生助手。没有它后台服务既不能识别刚打开的 Codex，也不能带调试参数重开，卡片不会出现；
// - 检查 FFmpeg。红果短剧必须用它，Emby 的 HEVC / MKV / 图形字幕也要用；macOS 上有 Homebrew 时自动安装。
// FFmpeg 装不上不阻止安装，只在最后说明哪些功能不可用。

async function newestMtime(directory) {
  let newest = 0;
  for (const name of await readdir(directory)) {
    if (name.endsWith(".swift")) newest = Math.max(newest, (await stat(join(directory, name))).mtimeMs);
  }
  return newest;
}

export async function ensureNativeHelper({
  platform = process.platform, arch = process.arch, root = repoRoot, sourcesDir = NATIVE_SOURCES,
  buildNativeImpl = buildNative, statImpl = stat, newestSourceImpl = newestMtime
} = {}) {
  if (platform !== "darwin") return { status: "not-needed" };
  const target = `darwin-${arch}`;
  const output = join(root, "dist", "native", target, "companion-native");
  const built = await statImpl(output).then((info) => info.mtimeMs, () => null);
  // 源码比产物新（拉了新代码）时重新编译，否则直接复用。
  if (built !== null && built >= await newestSourceImpl(sourcesDir)) return { status: "existing", path: output };
  try {
    await buildNativeImpl({ target, outputPath: output });
  } catch (error) {
    const missing = error?.code === "ENOENT" || /xcrun: error|no developer tools|command not found/i.test(`${error?.stderr ?? ""} ${error?.message ?? ""}`);
    throw Object.assign(new Error(missing
      ? "编译原生助手需要 Xcode Command Line Tools：先运行 xcode-select --install，装好后重新执行 npm start。"
      : `编译原生助手失败：${String(error?.stderr || error?.message || error).trim().split("\n").slice(-3).join(" ")}`), { code: "NATIVE_HELPER_BUILD_FAILED", cause: error });
  }
  return { status: "built", path: output };
}

function findBrew({ env = process.env, fileExists = existsSync } = {}) {
  return [...searchPathCandidates(["brew"], { platform: "darwin", env }), "/opt/homebrew/bin/brew", "/usr/local/bin/brew"]
    .find((candidate) => fileExists(candidate)) ?? null;
}

function runInherited(command, args) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", () => resolveRun(false));
    child.once("close", (code) => resolveRun(code === 0));
  });
}

export async function ensureFfmpeg({
  platform = process.platform, env = process.env, fileExists = existsSync,
  resolveImpl = resolveFfmpegPath, findBrewImpl = findBrew, runImpl = runInherited, log = console.log
} = {}) {
  const lookup = () => resolveImpl({ env, platform, fileExists });
  const found = lookup();
  if (found) return { status: "existing", path: found };
  if (env.CODEX_COMPANION_SKIP_FFMPEG === "1") return { status: "skipped" };
  if (platform !== "darwin") return { status: "missing" };
  const brew = findBrewImpl({ env, fileExists });
  if (!brew) return { status: "missing-homebrew" };
  log("[codex-companion] 未检测到 FFmpeg，正在通过 Homebrew 安装（设置 CODEX_COMPANION_SKIP_FFMPEG=1 可跳过）…");
  if (!await runImpl(brew, ["install", "ffmpeg"])) return { status: "install-failed" };
  const installed = lookup();
  return installed ? { status: "installed", path: installed } : { status: "install-failed" };
}

const WITHOUT_FFMPEG = "没有 FFmpeg 时红果短剧无法播放，Emby 的 HEVC、EC-3、MKV、超高码率媒体和图形字幕也不可用；Emby HLS、常规 MP4 与其它卡片不受影响。";

export function ffmpegSummary({ status, path }, platform = process.platform) {
  if (status === "existing") return [`FFmpeg：已就绪（${path}）。`];
  if (status === "installed") return [`FFmpeg：已通过 Homebrew 安装（${path}）。`];
  const install = platform === "darwin"
    ? (status === "missing-homebrew" ? "安装 Homebrew（https://brew.sh/）后运行 brew install ffmpeg" : "运行 brew install ffmpeg")
    : "运行 sudo apt install ffmpeg（Fedora：sudo dnf install ffmpeg-free）";
  const reason = status === "skipped" ? "已按 CODEX_COMPANION_SKIP_FFMPEG=1 跳过" : status === "install-failed" ? "自动安装失败" : "未检测到";
  return [`⚠️  FFmpeg：${reason}。${WITHOUT_FFMPEG}`, `    补装：${install}，装好后不用重新安装 Companion。`];
}

export async function prepareSourceInstall(options = {}) {
  const log = options.log ?? console.log;
  const native = await ensureNativeHelper(options);
  if (native.status === "built") log(`[codex-companion] 已编译原生助手：${native.path}`);
  const ffmpeg = await ensureFfmpeg(options);
  for (const line of ffmpegSummary(ffmpeg, options.platform ?? process.platform)) log(`[codex-companion] ${line}`);
  return { native, ffmpeg };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareSourceInstall().catch((error) => {
    console.error(`[codex-companion] ${error.message}`);
    process.exitCode = 1;
  });
}
