import assert from "node:assert/strict";
import test from "node:test";
import { HongguoService, jpegCoverUrl } from "../src/hongguo-service.mjs";
import { HongguoError } from "../src/hongguo-sdk-client.mjs";
import { ServiceRegistry } from "../src/platform/services/registry.mjs";
import { createService as createHongguoService } from "../src/cards/hongguo/service.mjs";

const HEIC = "https://p3-reading-sign.fqnovelpic.com/novel-pic/abc123~tplv-81nmtwyey9-superreso-aifit:400:0.heic?lk3s=1&x-signature=x";

function fakeSdk(overrides = {}) {
  const series = {
    id: "100",
    title: "测试短剧",
    description: "简介",
    cover_url: HEIC,
    episode_count: 3
  };
  const episodes = [
    { id: "201", number: 1, title: "第1集" },
    { id: "202", number: 2, title: "第2集" },
    { id: "203", number: 3, title: "第3集" }
  ];
  return {
    discover: async () => ({ items: [series] }),
    search: async () => ({ items: [series], has_more: false }),
    getSeries: async () => series,
    listEpisodes: async () => ({ items: episodes }),
    resolvePlayback: async () => ({
      playback: {
        protected: true,
        duration_seconds: 120,
        streams: [
          { definition: "360p", codec: "bytevc1", bitrate: 500000, width: 360, height: 640, url: "https://cdn/360.mp4" },
          { definition: "720p", codec: "bytevc1", bitrate: 1500000, width: 720, height: 1280, url: "https://cdn/720.mp4" }
        ]
      },
      contentKey: { key: "00112233" }
    }),
    resetDevice: async () => {},
    dispose: () => {},
    ...overrides
  };
}

function fakeListStorage(initial = []) {
  let items = [...initial];
  return {
    load: async () => items,
    add: async (entry) => { items = [entry, ...items.filter((item) => item.id !== entry.id)]; return items; },
    remove: async (id) => { items = items.filter((item) => item.id !== id); return items; }
  };
}

function createService({ sdk = fakeSdk(), sessions = [], list = [], imageLoader = { load: async () => ({ bytes: new Uint8Array([1, 2, 3]), contentType: "image/jpeg" }) } } = {}) {
  const created = [];
  const service = new HongguoService({
    client: sdk,
    listStorage: fakeListStorage(list),
    randomImpl: () => 0.5,
    imageLoader,
    ffmpegSessionFactory: (options) => {
      const session = {
        options,
        destroyed: false,
        initialize: async () => ({ durationSeconds: options.durationSeconds, tracks: [] }),
        next: async () => ({ segments: [], end: false }),
        seek: async (seconds) => ({ timeSeconds: seconds }),
        destroy() { this.destroyed = true; }
      };
      created.push(session);
      sessions.push(session);
      return session;
    }
  });
  return { service, created };
}

test("jpegCoverUrl 把 HEIC 模板换成可用的 JPEG 模板", () => {
  assert.equal(
    jpegCoverUrl(HEIC),
    "https://p6-novel.byteimg.com/novel-pic/abc123~tplv-shrink:640:0.image"
  );
  assert.equal(jpegCoverUrl("https://x/y.jpg"), "https://x/y.jpg");
  assert.equal(jpegCoverUrl(""), "");
});

test("home 映射成渲染层契约并打乱推荐", async () => {
  const { service } = createService();
  const result = await service.handleRpc("hongguo.home", { limit: 20 }, { targetId: "t1" });
  assert.equal(result.items.length, 1);
  const item = result.items[0];
  assert.equal(item.id, "100");
  assert.equal(item.name, "测试短剧");
  assert.equal(item.totalEpisodes, 3);
  assert.match(item.posterUrl, /byteimg\.com.*\.image$/);
});

test("search 返回映射后的结果", async () => {
  const { service } = createService();
  const result = await service.handleRpc("hongguo.search", { query: "测试" }, { targetId: "t1" });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].name, "测试短剧");
});

test("搜索只查询剧集，批量补齐缺失封面，去重并传回下一页游标", async () => {
  const searches = [];
  const batches = [];
  const sdk = fakeSdk({
    search: async (query, options) => {
      searches.push({ query, options });
      return {
        items: [{ id: "100", title: "第一季" }, { id: "100", title: "重复" }, { id: "200", title: "第二季", cover_url: HEIC }, { id: "invalid", title: "无效" }],
        cursor: "40", has_more: true
      };
    },
    getSeriesBatch: async ids => {
      batches.push(ids);
      return [{ series: { id: "100", title: "第一季", cover_url: HEIC, episode_count: 100, season_index: 1, related_album_id: "300" } }];
    }
  });
  const { service } = createService({ sdk });
  const result = await service.handleRpc("hongguo.search", { query: "持械入宋", cursor: "20" });
  assert.deepEqual(searches, [{ query: "持械入宋", options: { cursor: "20", pageSize: 20, tab: "剧集" } }]);
  assert.deepEqual(batches, [["100"]]);
  assert.deepEqual(result.items.map(item => item.id), ["100", "200"]);
  assert.equal(result.items[0].posterUrl, jpegCoverUrl(HEIC));
  assert.equal(result.items[0].seasonIndex, 1);
  assert.equal(result.items[0].totalEpisodes, 100);
  assert.equal(result.cursor, "40");
  assert.equal(result.hasMore, true);
  const image = await service.handleRpc("hongguo.image.load", { url: result.items[0].posterUrl });
  assert.equal(image.contentType, "image/jpeg");
});

test("搜索封面批量缺项不串图，上游循环游标不会继续分页", async () => {
  const { service } = createService({ sdk: fakeSdk({
    search: async () => ({ items: [{ id: "100", title: "第一季" }, { id: "200", title: "第二季" }], cursor: "20", has_more: true }),
    getSeriesBatch: async () => [{ series: { id: "200", cover_url: HEIC } }]
  }) });
  const result = await service.handleRpc("hongguo.search", { query: "测试", cursor: "20" });
  assert.equal(result.items[0].posterUrl, "");
  assert.equal(result.items[1].posterUrl, jpegCoverUrl(HEIC));
  assert.equal(result.hasMore, false);
  assert.equal(result.cursor, null);
});

test("搜索取消后不继续批量补齐封面", async () => {
  const controller = new AbortController();
  let batches = 0;
  const { service } = createService({ sdk: fakeSdk({
    search: async () => { controller.abort(); return { items: [{ id: "100" }] }; },
    getSeriesBatch: async () => { batches += 1; return []; }
  }) });
  await assert.rejects(service.handleRpc("hongguo.search", { query: "测试" }, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(batches, 0);
});

test("detail 并行取详情与分集，暴露可播放集数", async () => {
  const { service } = createService();
  const detail = await service.handleRpc("hongguo.detail", { dramaId: "100" }, { targetId: "t1" });
  assert.equal(detail.totalEpisodes, 3);
  assert.equal(detail.accessibleEpisodeCount, 3);
  assert.deepEqual(detail.episodeIds, ["201", "202", "203"]);
});

test("多季详情加载真实季列表，按季排序且白名单包含各季封面", async () => {
  const calls = [];
  const { service } = createService({ sdk: fakeSdk({
    getSeries: async () => ({ id: "100", title: "第一季", cover_url: HEIC, season_index: 1, is_multi_season: true, related_album_id: "300" }),
    seasons: async id => {
      calls.push(id);
      return { id: "300", seasons: [
        { series_id: "200", title: "第二季", index: 2, episode_count: 20, cover_url: "https://p6-novel.byteimg.com/novel-pic/second.image" },
        { series_id: "100", title: "第一季", index: 1, episode_count: 10, cover_url: HEIC },
        { series_id: "200", title: "重复", index: 2 },
        { series_id: "", index: 3 }
      ] };
    }
  }) });
  const detail = await service.handleRpc("hongguo.detail", { dramaId: "100" });
  assert.deepEqual(calls, ["100"]);
  assert.equal(detail.seasonIndex, 1);
  assert.equal(detail.albumId, "300");
  assert.deepEqual(detail.seasons.map(season => [season.id, season.seasonIndex, season.totalEpisodes]), [["100", 1, 10], ["200", 2, 20]]);
  await service.handleRpc("hongguo.image.load", { url: detail.seasons[1].posterUrl });
});

test("季列表临时失败仍保留当前季选集并返回可重试错误", async () => {
  const { service } = createService({ sdk: fakeSdk({
    getSeries: async () => ({ id: "100", title: "第一季", is_multi_season: true, episode_count: 3 }),
    seasons: async () => { throw new HongguoError("HONGGUO_NETWORK", "季列表暂不可用", { retryable: true }); }
  }) });
  const detail = await service.handleRpc("hongguo.detail", { dramaId: "100" });
  assert.equal(detail.accessibleEpisodeCount, 3);
  assert.deepEqual(detail.seasons, []);
  assert.deepEqual(detail.seasonError, { message: "季列表暂不可用", retryable: true });
});

test("playback.open 选最高码率流并下传解密密钥", async () => {
  const { service, created } = createService();
  const playback = await service.handleRpc(
    "hongguo.playback.open",
    { dramaId: "100", episode: 2 },
    { targetId: "t1" }
  );
  assert.equal(playback.streamMode, "ffmpeg-fmp4");
  assert.equal(playback.episode, 2);
  const session = created[0];
  assert.equal(session.options.inputUrl, "https://cdn/720.mp4");
  assert.equal(session.options.decryptionKey, "00112233");
  assert.equal(session.options.mediaSource.MediaStreams[0].Codec, "hevc");
});

test("加密内容缺密钥时报错而不是静默播空", async () => {
  const sdk = fakeSdk({
    resolvePlayback: async () => ({ playback: { protected: true, streams: [{ url: "https://cdn/a.mp4", bitrate: 1 }] } })
  });
  const { service } = createService({ sdk });
  await assert.rejects(
    () => service.handleRpc("hongguo.playback.open", { dramaId: "100", episode: 1 }, { targetId: "t1" }),
    (error) => error instanceof HongguoError && error.code === "CONTENT_KEY_UNAVAILABLE"
  );
});

test("超出集数时报 EPISODE_NOT_AVAILABLE", async () => {
  const { service } = createService();
  await assert.rejects(
    () => service.handleRpc("hongguo.playback.open", { dramaId: "100", episode: 9 }, { targetId: "t1" }),
    (error) => error.code === "EPISODE_NOT_AVAILABLE"
  );
});

test("切集销毁同一目标的旧播放会话", async () => {
  const { service, created } = createService();
  await service.handleRpc("hongguo.playback.open", { dramaId: "100", episode: 1 }, { targetId: "t1" });
  await service.handleRpc("hongguo.playback.open", { dramaId: "100", episode: 2 }, { targetId: "t1" });
  assert.equal(created.length, 2);
  assert.equal(created[0].destroyed, true);
  assert.equal(created[1].destroyed, false);
});

test("image.load 拒绝白名单外的封面地址", async () => {
  const { service } = createService();
  await assert.rejects(
    () => service.handleRpc("hongguo.image.load", { url: "https://evil/x.jpg" }, { targetId: "t1" }),
    (error) => error.code === "UNSAFE_IMAGE_URL"
  );
});

test("list.get / add / remove 走片单存储", async () => {
  const { service } = createService({ list: [{ id: "1", name: "旧剧", posterUrl: "" }] });
  let result = await service.handleRpc("hongguo.list.get", {}, { targetId: "t1" });
  assert.equal(result.items.length, 1);
  result = await service.handleRpc("hongguo.list.add", { id: "2", name: "新剧", posterUrl: "" }, { targetId: "t1" });
  assert.equal(result.items[0].id, "2");
  result = await service.handleRpc("hongguo.list.remove", { id: "2" }, { targetId: "t1" });
  assert.deepEqual(result.items.map((item) => item.id), ["1"]);
});

test("片单输入不能把本机或未知封面加入白名单，旧片单的不安全地址也不会被加载", async () => {
  const loaded = [];
  const local = "http://127.0.0.1:12345/private";
  const { service } = createService({
    list: [{ id: "1", name: "旧剧", posterUrl: local }],
    imageLoader: { load: async url => { loaded.push(url); return { bytes: new Uint8Array(), contentType: "image/jpeg" }; } }
  });
  for (const url of [local, "https://p6-novel.byteimg.com/unknown.jpg"]) {
    await assert.rejects(service.handleRpc("hongguo.list.add", { id: "2", posterUrl: url }), { code: "UNSAFE_IMAGE_URL" });
  }
  const list = await service.handleRpc("hongguo.list.get");
  assert.equal(list.items[0].posterUrl, "");
  await assert.rejects(service.handleRpc("hongguo.image.load", { url: local }), { code: "UNSAFE_IMAGE_URL" });
  assert.deepEqual(loaded, []);
});

test("SDK 返回的封面可加入片单并由安全加载器读取", async () => {
  const { service } = createService();
  const home = await service.handleRpc("hongguo.home");
  const entry = home.items[0];
  const list = await service.handleRpc("hongguo.list.add", { id: entry.id, name: entry.name, posterUrl: entry.posterUrl });
  assert.equal(list.items[0].posterUrl, entry.posterUrl);
  const image = await service.handleRpc("hongguo.image.load", { url: entry.posterUrl });
  assert.equal(image.contentType, "image/jpeg");
  assert.deepEqual([...Buffer.from(image.data, "base64")], [1, 2, 3]);
});

test("推荐流推进 SDK 游标，保留本页剩余项并去掉跨页重复内容", async () => {
  const cursors = [];
  const pages = {
    "": { items: [{ id: "1" }, { id: "2" }], has_more: true, cursor: "second" },
    second: { items: [{ id: "2" }, { id: "3" }], has_more: true, cursor: "last" },
    last: { items: [{ id: "4" }], has_more: false }
  };
  const { service } = createService({ sdk: fakeSdk({ discover: async ({ cursor }) => { cursors.push(cursor); return pages[cursor]; } }) });
  const context = { targetId: "t1" };
  const home = await service.handleRpc("hongguo.home", { limit: 1 }, context);
  assert.equal(home.hasMore, true);
  const ids = home.items.map(item => item.id);
  let page = home;
  while (page.hasMore) {
    page = await service.handleRpc("hongguo.feed.next", { cursor: page.cursor, limit: 1 }, context);
    ids.push(...page.items.map(item => item.id));
  }
  assert.deepEqual(ids, ["1", "2", "3", "4"]);
  assert.deepEqual(cursors, ["", "second", "last"]);
  assert.equal(page.total, 4);
  assert.equal(page.cursor, null);
});

test("重复页和循环游标不会令推荐流无限请求", async () => {
  const { service } = createService({ sdk: fakeSdk({ discover: async () => ({ items: [{ id: "1" }], has_more: true, cursor: "second" }) }) });
  const home = await service.handleRpc("hongguo.home", {}, { targetId: "t1" });
  await assert.rejects(service.handleRpc("hongguo.feed.next", { cursor: home.cursor }, { targetId: "t1" }), { code: "FEED_EXPIRED" });
  await assert.rejects(service.handleRpc("hongguo.feed.next", { cursor: home.cursor }, { targetId: "t2" }), { code: "FEED_EXPIRED" });
});

test("并发推荐请求串行消费同一游标，不重复返回内容", async () => {
  const { service } = createService({ sdk: fakeSdk({ discover: async () => ({ items: [1, 2, 3, 4].map(id => ({ id: String(id) })), has_more: false }) }) });
  const context = { targetId: "t1" };
  const home = await service.handleRpc("hongguo.home", { limit: 1 }, context);
  const pages = await Promise.all([1, 2].map(() => service.handleRpc("hongguo.feed.next", { cursor: home.cursor, limit: 1 }, context)));
  const ids = [...home.items, ...pages.flatMap(page => page.items)].map(item => item.id);
  assert.equal(new Set(ids).size, 3);
});

test("被取消的迟到播放不会创建资源，也不会破坏同一 generation 的新播放", async testContext => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const sdk = fakeSdk();
  const resolvePlayback = sdk.resolvePlayback;
  sdk.resolvePlayback = async episodeId => {
    if (episodeId === "201") { entered.resolve(); await release.promise; }
    return resolvePlayback(episodeId);
  };
  const { service, created } = createService({ sdk });
  const registry = new ServiceRegistry({
    manifests: [{ id: "hongguo", defaultEnabled: true }],
    modules: { hongguo: { createService: createHongguoService } },
    dependencies: { hongguoService: service },
    loadConfig: async () => ({ enabled: true, cards: { hongguo: { enabled: true } } })
  });
  testContext.after(() => registry.dispose());
  const context = { targetId: "t1", executionContextId: 1, cardId: "hongguo", generation: 1 };
  const controller = new AbortController();
  const first = registry.handleRpc("hongguo.playback.open", { dramaId: "100", episode: 1 }, { ...context, signal: controller.signal });
  const rejected = assert.rejects(first, { code: "RPC_CANCELLED" });
  await entered.promise;
  controller.abort(new HongguoError("RPC_CANCELLED", "请求已取消"));
  const second = await registry.handleRpc("hongguo.playback.open", { dramaId: "100", episode: 2 }, context);
  release.resolve();
  await rejected;
  assert.equal(created.length, 1);
  assert.equal(created[0].destroyed, false);
  await registry.handleRpc("hongguo.playback.direct.next", { playbackId: second.playbackId }, context);
});

test("新播放主动替换在途请求，目标清理阻止迟到会话复活", async () => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const sdk = fakeSdk();
  const resolvePlayback = sdk.resolvePlayback;
  sdk.resolvePlayback = async episodeId => {
    if (episodeId === "201") { entered.resolve(); await release.promise; }
    return resolvePlayback(episodeId);
  };
  const { service, created } = createService({ sdk });
  const context = { targetId: "t1" };
  const first = service.handleRpc("hongguo.playback.open", { dramaId: "100", episode: 1 }, context);
  const rejected = assert.rejects(first, { code: "CANCELLED" });
  await entered.promise;
  const second = await service.handleRpc("hongguo.playback.open", { dramaId: "100", episode: 2 }, context);
  release.resolve();
  await rejected;
  assert.equal(created.length, 1);
  assert.equal(created[0].destroyed, false);
  service.disposeTarget("t1");
  await assert.rejects(service.handleRpc("hongguo.playback.direct.next", { playbackId: second.playbackId }, context), { code: "PLAYBACK_NOT_FOUND" });
});

test("清理在途播放目标后，SDK 迟到返回不创建会话", async () => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const { service, created } = createService({ sdk: fakeSdk({ resolvePlayback: async () => { entered.resolve(); return release.promise; } }) });
  const opened = service.handleRpc("hongguo.playback.open", { dramaId: "100", episode: 1 }, { targetId: "t1" });
  const rejected = assert.rejects(opened, { code: "CANCELLED" });
  await entered.promise;
  service.disposeTarget("t1");
  release.resolve({ playback: { protected: false, streams: [{ url: "https://cdn/a.mp4" }] } });
  await rejected;
  assert.equal(created.length, 0);
});
