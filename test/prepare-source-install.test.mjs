import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { ensureFfmpeg, ensureNativeHelper, ffmpegSummary, prepareSourceInstall } from "../scripts/prepare-source-install.mjs";

const root = join("/repo");
const helper = join(root, "dist", "native", "darwin-arm64", "companion-native");

test("macOS 源码安装编译原生助手：缺失或源码更新时编译，已是最新则复用；其它平台不需要", async () => {
  const builds = [];
  const options = (built, source) => ({
    platform: "darwin", arch: "arm64", root,
    statImpl: async () => { if (built === null) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return { mtimeMs: built }; },
    newestSourceImpl: async () => source,
    buildNativeImpl: async (request) => { builds.push(request); }
  });
  assert.deepEqual(await ensureNativeHelper(options(null, 10)), { status: "built", path: helper });
  assert.deepEqual(await ensureNativeHelper(options(5, 10)), { status: "built", path: helper });
  assert.deepEqual(await ensureNativeHelper(options(10, 10)), { status: "existing", path: helper });
  assert.deepEqual(builds, [{ target: "darwin-arm64", outputPath: helper }, { target: "darwin-arm64", outputPath: helper }]);
  assert.deepEqual(await ensureNativeHelper({ platform: "linux", buildNativeImpl: async () => assert.fail("不应编译") }), { status: "not-needed" });
});

test("没有 swiftc 时给出安装 Command Line Tools 的提示，其它编译错误保留原因", async () => {
  const failing = (error) => ensureNativeHelper({
    platform: "darwin", arch: "x64", root, statImpl: async () => { throw new Error("missing"); },
    newestSourceImpl: async () => 1, buildNativeImpl: async () => { throw error; }
  });
  await assert.rejects(failing(Object.assign(new Error("spawn swiftc ENOENT"), { code: "ENOENT" })),
    (error) => error.code === "NATIVE_HELPER_BUILD_FAILED" && /xcode-select --install/.test(error.message));
  await assert.rejects(failing(Object.assign(new Error("failed"), { stderr: "main.swift:3: error: 类型不匹配\n" })),
    (error) => /类型不匹配/.test(error.message) && !/xcode-select/.test(error.message));
});

test("FFmpeg：已有则不动，可显式跳过，macOS 有 Homebrew 时自动安装，其余只提示", async () => {
  const runs = [];
  const base = { platform: "darwin", env: {}, log: () => {}, runImpl: async (...args) => { runs.push(args); return true; } };
  assert.deepEqual(await ensureFfmpeg({ ...base, resolveImpl: () => "/opt/homebrew/bin/ffmpeg", findBrewImpl: () => assert.fail("不应查找 brew") }),
    { status: "existing", path: "/opt/homebrew/bin/ffmpeg" });
  assert.deepEqual(await ensureFfmpeg({ ...base, env: { AGENT_COMPANION_SKIP_FFMPEG: "1" }, resolveImpl: () => null, findBrewImpl: () => "/brew" }),
    { status: "skipped" });
  assert.deepEqual(await ensureFfmpeg({ ...base, resolveImpl: () => null, findBrewImpl: () => null }), { status: "missing-homebrew" });
  assert.deepEqual(runs, []);

  let installed = false;
  assert.deepEqual(await ensureFfmpeg({ ...base, resolveImpl: () => installed ? "/opt/homebrew/bin/ffmpeg" : null, findBrewImpl: () => "/opt/homebrew/bin/brew",
    runImpl: async (...args) => { runs.push(args); installed = true; return true; } }), { status: "installed", path: "/opt/homebrew/bin/ffmpeg" });
  assert.deepEqual(runs, [["/opt/homebrew/bin/brew", ["install", "ffmpeg"]]]);
  assert.deepEqual(await ensureFfmpeg({ ...base, resolveImpl: () => null, findBrewImpl: () => "/brew", runImpl: async () => false }), { status: "install-failed" });
  // Linux 不自动 sudo 安装。
  assert.deepEqual(await ensureFfmpeg({ ...base, platform: "linux", resolveImpl: () => null, findBrewImpl: () => assert.fail("不应查找 brew") }), { status: "missing" });
});

test("FFmpeg 缺失的说明点名红果短剧不可用，并给出对应平台的补装命令", () => {
  assert.deepEqual(ffmpegSummary({ status: "existing", path: "/usr/bin/ffmpeg" }), ["FFmpeg：已就绪（/usr/bin/ffmpeg）。"]);
  const mac = ffmpegSummary({ status: "missing-homebrew" }, "darwin").join("\n");
  assert.match(mac, /红果短剧无法播放/);
  assert.match(mac, /brew\.sh.*brew install ffmpeg/);
  assert.match(ffmpegSummary({ status: "missing" }, "linux").join("\n"), /sudo apt install ffmpeg/);
  assert.match(ffmpegSummary({ status: "skipped" }, "darwin").join("\n"), /AGENT_COMPANION_SKIP_FFMPEG=1/);
});

test("FFmpeg 装不上不阻止安装；原生助手编译失败则中止", async () => {
  const lines = [];
  const result = await prepareSourceInstall({
    platform: "darwin", arch: "arm64", root, env: {}, log: (line) => lines.push(line),
    statImpl: async () => ({ mtimeMs: 2 }), newestSourceImpl: async () => 1,
    resolveImpl: () => null, findBrewImpl: () => null
  });
  assert.equal(result.native.status, "existing");
  assert.equal(result.ffmpeg.status, "missing-homebrew");
  assert.ok(lines.some((line) => line.includes("红果短剧无法播放")));
  await assert.rejects(prepareSourceInstall({
    platform: "darwin", arch: "arm64", root, log: () => {}, statImpl: async () => { throw new Error("missing"); },
    newestSourceImpl: async () => 1, buildNativeImpl: async () => { throw Object.assign(new Error("x"), { code: "ENOENT" }); },
    resolveImpl: () => assert.fail("不应继续检查 FFmpeg")
  }), /xcode-select/);
});
