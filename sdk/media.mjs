// 卡片后台可用的媒体库：FFmpeg 转封装 / 转码、直连 MP4 重封装、HLS 本地代理、字幕提取、HDR 判断。
// 页面侧对应的 MSE 播放器在 sdk/renderer-media.mjs；两边随卡片一起打包，协议版本总是一致。
// 例外：CDP 媒体拦截的端口登记表全局只有一份，由 api.media.interceptor 提供，HlsProxy 要传它的 register。
export { MediaError } from "../src/platform/media/errors.mjs";
export { SECRET_QUERY_KEYS, isPrivateAddress, resolveExternalMediaAddress, validateExternalMediaUrl } from "../src/platform/media/net-guard.mjs";
export {
  DIRECT_VIDEO_BITRATE_LIMIT, FFMPEG_VIDEO_COPY_BITRATE_LIMIT, FfmpegFmp4Session, RangeProxy,
  buildFfmpegArguments, ffmpegStrategy, mediaSourceExceedsDirectBitrate, requireToneMappingSupport, videoBitrateFor
} from "../src/platform/media/ffmpeg-fmp4-session.mjs";
export {
  DIRECT_MP4_CHUNK_BYTES, DIRECT_MP4_MAX_BATCH_BYTES, DIRECT_MP4_MAX_QUEUE_BYTES, DIRECT_MP4_MAX_SEGMENT_BYTES,
  DIRECT_MP4_SEGMENT_BYTES, DirectMp4Session
} from "../src/platform/media/direct-mp4-session.mjs";
export { HlsProxy } from "../src/platform/media/hls-proxy.mjs";
export { DEFAULT_SUBTITLE_LIMIT, SUBTITLE_WINDOW_SECONDS, SubtitleLoader, extractSubtitleWindow, offsetWebVtt } from "../src/platform/media/subtitle-loader.mjs";
export { assToWebVtt } from "../src/platform/media/ass-to-vtt.mjs";
export { SDR_TONE_MAP_FILTER, videoColorInfo } from "../src/platform/media/video-color.mjs";
export { resolveFfmpegPath } from "../src/platform/media/ffmpeg-path.mjs";
export { MEDIA_INTERCEPT_ORIGIN } from "../src/platform/media/media-intercept.mjs";
