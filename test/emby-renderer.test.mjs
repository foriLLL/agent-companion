import assert from "node:assert/strict";
import test from "node:test";
import { pendingPlaybackPosition } from "../cards/emby/renderer.mjs";

test("续播位置应用到 <video> 之前，进度与停止上报用待恢复的位置而不是 0", () => {
  // 慢启动 HLS：MANIFEST_PARSED 之前 mediaReady 还是 false，currentTime 仍为 0。
  assert.equal(pendingPlaybackPosition({ mediaReady: false, startPositionTicks: 600_000_000 }), 60);
  // 没有续播点时照常信 currentTime。
  assert.equal(pendingPlaybackPosition({ mediaReady: false, startPositionTicks: 0 }), null);
  // 初始位置已应用：之后都信 currentTime。
  assert.equal(pendingPlaybackPosition({ mediaReady: true, startPositionTicks: 600_000_000 }), null);
  // 字幕重启 / 缓存恢复：restore 落地前上报要恢复到的位置。
  assert.equal(pendingPlaybackPosition({
    mediaReady: false,
    initialPositionApplied: true,
    startPositionTicks: 600_000_000,
    restorePlaybackState: { currentTime: 125.5 }
  }), 125.5);
  // 已播过、正在重启但还没记下 restore（例如缓存恢复的 seek 请求进行中）：旧 <video> 的 currentTime 仍可信，
  // 不能退回到最初的续播点。
  assert.equal(pendingPlaybackPosition({
    mediaReady: false,
    initialPositionApplied: true,
    startPositionTicks: 600_000_000
  }), null);
  assert.equal(pendingPlaybackPosition(null), null);
});
