import { mount as mountEmby } from "/emby.js";
import { mount as mountHongguo } from "/hongguo.js";
import { createEffects } from "/effects.js";

const errors = [];
window.addEventListener("error", (event) => errors.push(event.message));
window.addEventListener("unhandledrejection", (event) => errors.push(String(event.reason)));
const calls = [];
const checks = [];
const assert = (value, label) => { if (!value) throw new Error(label); checks.push(label); };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const wait = async (predicate, label) => {
  const until = Date.now() + 10000;
  while (Date.now() < until) { if (predicate()) return; await delay(30); }
  throw new Error(`等待超时：${label}`);
};
const movie = { id: "movie", name: "媒体夹具", type: "Movie" };
const drama = { id: "123", name: "短剧夹具第一季", totalEpisodes: 2, seasonIndex: 1, posterUrl: "https://p6-novel.byteimg.com/fixture.png" };
const secondSeason = { id: "124", name: "短剧夹具第二季", totalEpisodes: 3, seasonIndex: 2, posterUrl: drama.posterUrl };
const dramaDetail = series => ({ ...series, accessibleEpisodeCount: series.totalEpisodes, fullEpisodeCount: series.totalEpisodes, episodeIds: Array.from({ length: series.totalEpisodes }, (value, index) => String(201 + index)), seasons: [drama, secondSeason] });
const fixture = await fetch("/fixture.json").then((response) => response.json());
let mode = "hls";
let id = 0;
const requested = new Map();
const hongguoSearches = new Map();
let pendingHongguoPlayback = null;
let holdHongguoPlayback = false;
let holdHongguoDetail = false;
let failHongguoDetail = false;
const pendingHongguoDetails = new Map();
let hongguoHomeMode = "normal";
let pendingHongguoHome = null;
const base = location.origin;
async function handle(method, params) {
  if (method === "emby.connection.status") return { connected: true, baseUrl: "https://fixture.invalid", username: "fixture" };
  if (method === "emby.servers.list") return { servers: [{ key: "fixture", name: "夹具" }] };
  if (method === "emby.home.get") return { views: [], resume: [], latest: [movie] };
  if (method === "emby.search") return { items: [movie] };
  if (method === "emby.playback.open") return { playbackId: "emby-play", itemId: params.itemId, streamMode: mode.startsWith("native") ? "direct-mp4" : mode, directMediaUrl: mode.startsWith("native") ? `https://agent-companion.invalid/${location.port}/hls/11111111-1111-4111-8111-111111111111/${mode === "native" ? "clip.mp4" : "missing.mp4"}` : undefined, hlsUrl: `${base}/stream.m3u8`, subtitles: [{ index: 0, language: "chi", label: "中文", isExternal: true }], selectedSubtitleIndex: 0, subtitleMode: "external-vtt", initialBufferSeconds: 0.5 };
  if (method === "emby.playback.subtitle.load") return { data: "WEBVTT\n\n00:00:00.000 --> 00:00:10.000\n字幕夹具\n" };
  if (method === "emby.playback.subtitle.select") return { selectedSubtitleIndex: params.subtitleStreamIndex, subtitleMode: params.subtitleStreamIndex === null ? "off" : "external-vtt" };
  if (method === "emby.resource.load") {
    const response = await fetch(params.url);
    if (params.responseType === "text") return { data: await response.text(), url: params.url };
    return { data: await response.arrayBuffer(), url: params.url };
  }
  if (method === "hongguo.home") {
    if (hongguoHomeMode === "fail") throw Object.assign(new Error("推荐暂不可用"), { code: "HONGGUO_NETWORK", retryable: true });
    if (hongguoHomeMode === "hold") return new Promise((resolve, reject) => { pendingHongguoHome = { resolve, reject }; });
    return { items: [drama], hasMore: false };
  }
  if (method === "hongguo.search") return new Promise((resolve, reject) => hongguoSearches.set(params.cursor ? `${params.query}:${params.cursor}` : params.query, { resolve, reject }));
  if (method === "hongguo.image.load") return { contentType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=", encoding: "base64" };
  if (method === "hongguo.list.get") return { items: hongguoHomeMode === "fail" ? [drama] : [] };
  if (method === "hongguo.list.add") return { items: [drama] };
  if (method === "hongguo.detail") {
    if (failHongguoDetail) { failHongguoDetail = false; throw new Error("详情暂时失败"); }
    if (holdHongguoDetail) return new Promise(resolve => pendingHongguoDetails.set(params.dramaId, resolve));
    return dramaDetail(params.dramaId === secondSeason.id ? secondSeason : drama);
  }
  if (method === "hongguo.playback.open") {
    if (holdHongguoPlayback) return new Promise(resolve => { pendingHongguoPlayback = resolve; });
    return { playbackId: "hg-play", episode: params.episode, streamMode: "ffmpeg-fmp4" };
  }
  if (method.endsWith("playback.direct.init")) return { tracks: [{ id: 1, mime: 'video/mp4; codecs="avc1.42c01e"', codec: "avc1.42c01e", initData: fixture.init }], durationSeconds: 8, keyframeTimesSeconds: [0, 1, 2, 3, 4, 5, 6, 7], keyframeIntervalSeconds: 1 };
  if (method.endsWith("playback.direct.next")) return { segments: [{ trackId: 1, data: fixture.media }], end: true };
  if (method.endsWith("playback.direct.seek")) return { timestampOffsetSeconds: 0 };
  if (method.endsWith("playback.progress") || method.endsWith("playback.stop")) return {};
  throw new Error(`未实现夹具方法 ${method}`);
}
function context(card) {
  const controller = new AbortController();
  const effects = createEffects({ signal: controller.signal, onError: (error) => errors.push(error.message) });
  const host = document.createElement("div");
  host.style.cssText = "width:360px;height:520px;margin:8px;display:inline-block;vertical-align:top";
  document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  const rpc = (method, params, options) => rpc.request(method, params, options).promise;
  rpc.request = (method, params = {}, options = {}) => {
    const fullMethod = method.startsWith(`${card}.`) ? method : `${card}.${method}`;
    calls.push({ method: fullMethod, params });
    const requestId = String(++id);
    let cancel;
    const promise = new Promise((resolve, reject) => {
      const abort = () => reject(Object.assign(new Error("aborted"), { code: "ABORTED" }));
      cancel = abort;
      options.signal?.addEventListener("abort", abort, { once: true });
      Promise.resolve().then(() => handle(fullMethod, params)).then(resolve, reject).finally(() => options.signal?.removeEventListener("abort", abort));
    });
    requested.set(requestId, cancel);
    promise.then(() => requested.delete(requestId), () => requested.delete(requestId));
    return { id: requestId, promise, cancel };
  };
  rpc.cancel = (requestId) => requested.get(requestId)?.();
  return { root, signal: controller.signal, effects, rpc, settings: {}, reportError: (error) => errors.push(error.message), isVisible: () => !host.hidden, requestOpen: () => { host.hidden = false; }, controller, host };
}

async function run() {
  const embyContext = context("emby");
  const hgContext = context("hongguo");
  const emby = mountEmby(embyContext);
  const hg = mountHongguo(hgContext);
  await wait(() => emby.api.getState().view === "home", "首页");
  await wait(() => hg.api.getState().view === "home", "红果首页");
  assert(hg.api.getState().featuredCount === 1, "红果首页数据通过平台 RPC 加载");
  assert(emby.api.getState().latestCount === 1, "Emby 首页数据通过平台 RPC 加载");
  assert(getComputedStyle(embyContext.root.querySelector(".panel")).boxShadow === "none", "外框阴影由平台独占");

  emby.api.dispatch("showSearch", { query: "媒体", items: [] });
  embyContext.root.querySelector(".emby-search-wrap").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await wait(() => emby.api.getState().searchCount === 1, "搜索结果");
  assert(calls.some((call) => call.method === "emby.search"), "Emby 搜索走平台 RPC");
  embyContext.root.querySelector(".emby-list-button").click();
  await wait(() => embyContext.root.querySelector("video")?.readyState >= 2, "HLS 首帧");
  const video = embyContext.root.querySelector("video");
  video.pause();
  await wait(() => video.querySelector("track")?.track?.cues?.length > 0, "字幕");
  assert(video.readyState >= 2 && emby.api.getState().playing, "Emby 本地 hls.js 实际解码 RPC 媒体");
  assert(video.querySelector("track").track.cues[0].text === "字幕夹具", "外挂 VTT 字幕保持可用");
  const time = video.currentTime;
  const stopCount = calls.filter((call) => call.method.endsWith("playback.stop")).length;
  embyContext.host.hidden = true;
  emby.visibilityChanged({ visible: false, reason: "inline-collapse" });
  await delay(80);
  embyContext.host.hidden = false;
  emby.visibilityChanged({ visible: true });
  assert(embyContext.root.querySelector("video") === video && video.currentTime === time, "Emby inline 隐藏重开保留视频身份和进度");
  assert(calls.filter((call) => call.method.endsWith("playback.stop")).length === stopCount, "Emby 隐藏不发送停止请求");

  const submitHongguoSearch = query => {
    hgContext.root.querySelector(".hg-search-input").value = query;
    hgContext.root.querySelector(".hg-search-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  };
  for (const outcome of ["success", "error"]) {
    const oldQuery = `旧搜索-${outcome}`;
    const newQuery = `新搜索-${outcome}`;
    submitHongguoSearch(oldQuery);
    await wait(() => hongguoSearches.has(oldQuery), "旧搜索请求");
    hgContext.root.querySelector('[aria-label="返回"]').click();
    submitHongguoSearch(newQuery);
    await wait(() => hongguoSearches.has(newQuery), "新搜索请求");
    hongguoSearches.get(newQuery).resolve({ items: [{ ...drama, name: "新搜索结果" }] });
    await wait(() => hgContext.root.textContent.includes("新搜索结果"), "新搜索结果");
    if (outcome === "success") hongguoSearches.get(oldQuery).resolve({ items: [{ ...drama, name: "过期搜索结果" }] });
    else hongguoSearches.get(oldQuery).reject(new Error("过期搜索错误"));
    await delay(50);
    assert(hgContext.root.querySelector("h2").textContent === `搜索：${newQuery}`
      && hgContext.root.textContent.includes("新搜索结果")
      && !hgContext.root.textContent.includes("过期搜索结果")
      && !hgContext.root.textContent.includes("过期搜索错误"), `红果迟到搜索 ${outcome} 不覆盖新搜索`);
    await hg.api.openDrama(drama);
    hgContext.root.querySelector('[aria-label="返回"]').click();
    assert(hg.api.getState().view === "search" && hgContext.root.textContent.includes("新搜索结果"), "红果详情返回保留搜索结果");
    hgContext.root.querySelector('[aria-label="返回"]').click();
  }

  submitHongguoSearch("多季搜索");
  await wait(() => hongguoSearches.has("多季搜索"), "多季搜索请求");
  hongguoSearches.get("多季搜索").resolve({ items: [drama], cursor: "20", hasMore: true });
  await wait(() => hgContext.root.querySelector(".hg-result-poster img")?.naturalWidth > 0, "搜索封面显示");
  assert(hgContext.root.querySelector(".hg-result-poster img").src.startsWith("blob:"), "红果搜索结果经 RPC 显示实际封面");
  hgContext.root.querySelector('[data-search-more="true"]').click();
  await wait(() => hongguoSearches.has("多季搜索:20"), "搜索下一页");
  const failedSearchPage = hongguoSearches.get("多季搜索:20");
  failedSearchPage.reject(new Error("分页暂时失败"));
  await wait(() => hgContext.root.textContent.includes("加载失败，点击重试"), "分页失败重试入口");
  assert(hgContext.root.querySelectorAll(".hg-result").length === 1, "搜索下一页失败不清空已有结果");
  hgContext.root.querySelector('[data-search-more="true"]').click();
  await wait(() => hongguoSearches.get("多季搜索:20") !== failedSearchPage, "搜索下一页重试");
  hongguoSearches.get("多季搜索:20").resolve({ items: [drama, secondSeason], hasMore: false });
  await wait(() => hgContext.root.querySelectorAll(".hg-result").length === 2, "下一季搜索结果");
  assert(hgContext.root.textContent.includes(secondSeason.name) && !hgContext.root.querySelector('[data-search-more="true"]'), "红果搜索分页保留不同季并去重");
  failHongguoDetail = true;
  hgContext.root.querySelector(".hg-result").click();
  await wait(() => hg.api.getState().view === "error", "详情失败");
  hgContext.root.querySelector(".hg-error-actions .primary").click();
  await wait(() => hg.api.getState().view === "detail", "第一季详情");
  const seasonPicker = hgContext.root.querySelector('[aria-label="切换季"]');
  assert(seasonPicker.options.length === 2 && seasonPicker.value === drama.id, "详情显示真实季选择器并选中当前季");
  seasonPicker.value = secondSeason.id;
  seasonPicker.dispatchEvent(new Event("change", { bubbles: true }));
  await wait(() => hg.api.getState().selectedDramaId === secondSeason.id, "第二季详情");
  assert(hgContext.root.querySelectorAll(".hg-episode").length === 3 && hgContext.root.querySelector('[aria-label="切换季"]').value === secondSeason.id, "切换季刷新季 ID 与对应选集");
  await hg.api.playEpisode(1);
  await wait(() => hgContext.root.querySelector("video")?.readyState >= 2, "第二季第一集首帧");
  hgContext.root.querySelector("video").pause();
  assert(calls.some(call => call.method === "hongguo.playback.open" && call.params.dramaId === secondSeason.id), "切换季后使用新季 ID 播放");
  hgContext.root.querySelector('[aria-label="返回选集"]').click();
  hgContext.root.querySelector('[aria-label="返回"]').click();
  assert(hg.api.getState().view === "search" && hgContext.root.querySelectorAll(".hg-result").length === 2, "切换季与播放后返回原搜索结果");
  hgContext.root.querySelector('[aria-label="返回"]').click();

  holdHongguoDetail = true;
  const firstDetail = hg.api.openById(drama.id);
  await wait(() => pendingHongguoDetails.has(drama.id), "旧季详情请求");
  const latestDetail = hg.api.openById(secondSeason.id);
  await wait(() => pendingHongguoDetails.has(secondSeason.id), "新季详情请求");
  pendingHongguoDetails.get(secondSeason.id)(dramaDetail(secondSeason));
  await latestDetail;
  pendingHongguoDetails.get(drama.id)(dramaDetail(drama));
  await firstDetail;
  assert(hg.api.getState().selectedDramaId === secondSeason.id, "迟到的旧季详情不覆盖新季");
  holdHongguoDetail = false;

  await hg.api.openById("123");
  assert(hg.api.getState().selectedDramaId === "123", "红果 ID 直达和详情 API");
  holdHongguoPlayback = true;
  const cancelledPlayback = hg.api.playEpisode(1);
  await wait(() => pendingHongguoPlayback, "在途播放请求");
  const beforeCancelledInit = calls.filter(call => call.method === "hongguo.playback.direct.init").length;
  hg.api.clearVideo();
  pendingHongguoPlayback({ playbackId: "cancelled-hg", episode: 1, streamMode: "ffmpeg-fmp4" });
  await cancelledPlayback;
  await delay(50);
  assert(hg.api.getState().view === "detail" && !hg.api.getState().playing
    && calls.filter(call => call.method === "hongguo.playback.direct.init").length === beforeCancelledInit, "红果取消的迟到播放不复活视图或启动 MSE");
  holdHongguoPlayback = false;
  await hg.api.playEpisode(1);
  await wait(() => hgContext.root.querySelector("video")?.readyState >= 2, "红果 MSE 首帧");
  const hgVideo = hgContext.root.querySelector("video");
  hgVideo.pause();
  assert(hg.api.getState().diagnostics.streamMode === "ffmpeg-fmp4", "红果 MSE 播放保留原管线");
  hgContext.host.hidden = true;
  hg.visibilityChanged({ visible: false, reason: "inline-collapse" });
  await delay(80);
  hgContext.host.hidden = false;
  hg.visibilityChanged({ visible: true });
  assert(hgContext.root.querySelector("video") === hgVideo && hg.api.getState().playing, "红果 inline 隐藏重开保留播放实例");
  const beforeNextEpisode = calls.filter(call => call.method === "hongguo.playback.open").length;
  hgVideo.dispatchEvent(new Event("ended"));
  hgVideo.dispatchEvent(new Event("ended"));
  assert(calls.filter(call => call.method === "hongguo.playback.open").length === beforeNextEpisode + 1
    && hg.api.getState().view === "loading", "红果零等待自动续播且重复 ended 不重复切集");
  await wait(() => calls.some((call) => call.method === "hongguo.playback.open" && call.params.episode === 2), "红果下一集");
  await wait(() => hgContext.root.querySelector("video")?.readyState >= 2, "红果第二集首帧");
  hgContext.root.querySelector("video").pause();
  const beforeLastEpisode = calls.filter(call => call.method === "hongguo.playback.open").length;
  hgContext.root.querySelector("video").dispatchEvent(new Event("ended"));
  assert(hgContext.root.querySelector(".hg-autoplay").textContent.includes("已经是最后一集")
    && calls.filter(call => call.method === "hongguo.playback.open").length === beforeLastEpisode, "最后一集不续播不存在的选集");
  hgContext.root.querySelector("video").dispatchEvent(new Event("error"));
  assert(hg.api.getState().view === "error", "红果 MSE 失败不依赖 Emby 状态");

  hongguoHomeMode = "fail";
  const failedHomeContext = context("hongguo");
  const failedHome = mountHongguo(failedHomeContext);
  await wait(() => failedHomeContext.root.querySelector('[data-home-error="true"]'), "推荐局部失败提示");
  assert(failedHome.api.getState().view === "home" && failedHomeContext.root.querySelector(".hg-search-form")
    && failedHomeContext.root.textContent.includes("我的片单"), "推荐失败仍保留搜索与片单，不显示整卡错误页");
  failedHomeContext.root.querySelector(".hg-search-input").value = "推荐失败后搜索";
  failedHomeContext.root.querySelector(".hg-search-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await wait(() => hongguoSearches.has("推荐失败后搜索"), "推荐失败后的独立搜索");
  hongguoSearches.get("推荐失败后搜索").resolve({ items: [drama], hasMore: false });
  await wait(() => failedHomeContext.root.querySelector(".hg-result"), "推荐失败后搜索结果");
  assert(failedHome.api.getState().view === "search", "推荐失败不阻止独立搜索");
  await failedHome.api.openDrama(drama);
  await failedHome.api.playEpisode(1);
  await wait(() => failedHomeContext.root.querySelector("video")?.readyState >= 2, "推荐失败后播放首帧");
  const survivingVideo = failedHomeContext.root.querySelector("video");
  survivingVideo.pause();
  const beforeHomeRetry = calls.filter(call => call.method === "hongguo.home").length;
  await delay(1700);
  assert(failedHome.api.getState().playing && failedHomeContext.root.querySelector("video") === survivingVideo
    && calls.filter(call => call.method === "hongguo.home").length === beforeHomeRetry, "离开首页取消推荐后台重试，不打断搜索或播放");
  failedHome.api.clearVideo();
  failedHomeContext.root.querySelector('[aria-label="返回"]').click();
  failedHomeContext.root.querySelector('[aria-label="返回"]').click();
  hongguoHomeMode = "normal";
  failedHomeContext.root.querySelector('[data-home-error="true"] button').click();
  await wait(() => failedHome.api.getState().featuredCount === 1 && !failedHomeContext.root.querySelector('[data-home-error="true"]'), "推荐重试成功");
  assert(failedHome.api.getState().view === "home", "局部重试恢复推荐并保持首页可用");

  hongguoHomeMode = "hold";
  const lateHomeContext = context("hongguo");
  const lateHome = mountHongguo(lateHomeContext);
  await wait(() => pendingHongguoHome, "在途推荐请求");
  assert(lateHomeContext.root.querySelector(".hg-search-form"), "推荐尚未返回时搜索入口即可使用");
  await lateHome.api.openDrama(drama);
  await lateHome.api.playEpisode(1);
  await wait(() => lateHomeContext.root.querySelector("video")?.readyState >= 2, "推荐在途时播放首帧");
  lateHomeContext.root.querySelector("video").pause();
  pendingHongguoHome.reject(new Error("迟到推荐失败"));
  await delay(50);
  assert(lateHome.api.getState().view === "playback" && lateHome.api.getState().playing, "迟到推荐失败不会复活首页或销毁播放");
  hongguoHomeMode = "normal";

  emby.api.dispatch("back");
  mode = "direct-mp4";
  emby.api.dispatch("showSearch", { query: "媒体", items: [movie] });
  embyContext.root.querySelector(".emby-list-button").click();
  await wait(() => embyContext.root.querySelector("video")?.readyState >= 2, "Emby MSE 首帧");
  assert(calls.some((call) => call.method === "emby.playback.direct.init"), "Emby MSE 播放保留原管线");
  const secondContext = context("emby");
  const second = mountEmby(secondContext);
  await wait(() => second.api.getState().view === "home", "第二个 Emby");
  assert(second.api.getState().playing === false && emby.api.getState().playing, "同一卡片两个实例状态独立");

  embyContext.root.querySelector("video").dispatchEvent(new Event("error"));
  assert(emby.api.getState().view === "error" && emby.api.getState().mseDiagnostics !== null, "Emby MSE 失败保留诊断并显示重试界面");

  mode = "ffmpeg-fmp4";
  emby.api.dispatch("showSearch", { query: "媒体", items: [movie] });
  embyContext.root.querySelector(".emby-list-button").click();
  await wait(() => embyContext.root.querySelector("video")?.readyState >= 2, "FFmpeg fMP4 首帧");
  assert(emby.api.getState().playing, "FFmpeg fMP4 模式仍走完整 MSE 管线");
  emby.api.dispatch("back");
  mode = "native";
  emby.api.dispatch("showSearch", { query: "媒体", items: [movie] });
  embyContext.root.querySelector(".emby-list-button").click();
  await wait(() => embyContext.root.querySelector("video")?.readyState >= 2, "CDP 拦截原生直放首帧");
  const nativeVideo = embyContext.root.querySelector("video");
  assert(nativeVideo.currentSrc.startsWith("https://agent-companion.invalid/"), "原生直放不经 MSE/RPC");
  emby.visibilityChanged({ visible: false, reason: "inline-collapse" });
  emby.visibilityChanged({ visible: true });
  assert(embyContext.root.querySelector("video") === nativeVideo, "原生直放隐藏后保留同一视频元素");
  emby.api.dispatch("back");
  mode = "native-missing";
  emby.api.dispatch("showSearch", { query: "媒体", items: [movie] });
  embyContext.root.querySelector(".emby-list-button").click();
  await wait(() => embyContext.root.querySelector("video")?.currentSrc.startsWith("blob:") && embyContext.root.querySelector("video").readyState >= 2, "原生加载失败回退 MSE");

  embyContext.controller.abort();
  hgContext.controller.abort();
  secondContext.controller.abort();
  failedHomeContext.controller.abort();
  lateHomeContext.controller.abort();
  await Promise.all([emby.dispose(), hg.dispose(), second.dispose(), failedHome.dispose(), lateHome.dispose()]);
  assert(embyContext.root.childNodes.length === 0, "卸载移除业务 DOM");
  assert(hgContext.root.childNodes.length === 0, "红果卸载移除业务 DOM");
  assert(embyContext.effects.diagnostics().active === 0, "卸载回收平台副作用");
  assert(hgContext.effects.diagnostics().active === 0, "红果卸载回收平台副作用");
  const afterDispose = calls.length;
  hg.api.setVideoSource(`${base}/clip.mp4`);
  emby.api.dispatch("previewPlayback");
  await delay(100);
  assert(calls.length === afterDispose && embyContext.root.childNodes.length === 0, "旧 API 不复活已卸载实例");
  assert(errors.length === 0, `没有未隔离异常：${errors.join(", ")}`);
  return { checks, rpcCalls: calls.length, errors };
}
globalThis.__mediaResult = run().then((result) => ({ ok: true, ...result }), (error) => ({ ok: false, error: error.stack, calls: calls.slice(-12), errors, checks }));
