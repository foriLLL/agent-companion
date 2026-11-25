// 卡片页面（renderer.mjs）可用的媒体库：资源作用域、播放器控件、MSE 直连播放器。
// 与 sdk/media.mjs 的后台会话配套使用，随卡片一起打包。
export { createMediaScope } from "../src/renderer/media/scope.mjs";
export { createMediaUi } from "../src/renderer/media/ui.mjs";
export { createDirectMp4Stream } from "../src/renderer/media/direct-mp4.mjs";
export { waitForMediaSourceOpen } from "../src/renderer/media/source-open.mjs";
export { MEDIA_INTERCEPT_ORIGIN } from "../src/platform/media/media-intercept.mjs";
