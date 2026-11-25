import { randomUUID } from "node:crypto";
import { FfmpegFmp4Session } from "../../sdk/media.mjs";
import { HongguoError, HongguoSdkClient } from "./hongguo-sdk-client.mjs";
import { HongguoListStorage, normalizeListEntry } from "./hongguo-list-storage.mjs";
import { HongguoImageLoader, isHongguoImageUrl } from "./hongguo-image-loader.mjs";

const DEFAULT_FEED_PAGE_SIZE = 20;
const MAX_FEED_PAGE_SIZE = 40;
// 封面白名单容量：滚动与片单会累积大量封面地址；太小会让早先的封面在
// 长会话里被 UNSAFE_IMAGE_URL 永久拒绝（渲染侧对非 retryable 不重试）。
const KNOWN_IMAGES_LIMIT = 4096;

function stringParam(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HongguoError("INVALID_ARGUMENT", `${name} 不能为空`);
  }
  return value.trim();
}

function feedPageSize(value) {
  return Math.min(MAX_FEED_PAGE_SIZE, Math.max(1, Math.round(Number(value) || DEFAULT_FEED_PAGE_SIZE)));
}

function shuffled(items, random) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const sampled = Number(random());
    const ratio = Number.isFinite(sampled) ? Math.max(0, Math.min(0.999999999, sampled)) : 0;
    const target = Math.min(index, Math.floor(ratio * (index + 1)));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

// 红果封面原图是 HEIC（Chromium 不能显示），同一图片在 novel-pic CDN 上有
// JPEG 模板。把 reading-sign 的 HEIC 模板换成 byteimg 的 shrink JPEG 模板。
const HEIC_COVER_PATTERN = /^https:\/\/[^/]*reading-sign[^/]*\/novel-pic\/([0-9a-fA-F]+)~[^/]*\.heic(?:\?.*)?$/;

export function jpegCoverUrl(url) {
  if (typeof url !== "string" || url.length === 0) return "";
  const match = HEIC_COVER_PATTERN.exec(url);
  if (!match) return url;
  return `https://p6-novel.byteimg.com/novel-pic/${match[1]}~tplv-shrink:640:0.image`;
}

function seriesSummary(item) {
  return {
    id: String(item?.id ?? ""),
    name: String(item?.title ?? ""),
    posterUrl: jpegCoverUrl(item?.cover_url),
    description: String(item?.description ?? ""),
    totalEpisodes: Number(item?.episode_count) || 0,
    seasonIndex: Number(item?.season_index) || 0,
    albumId: String(item?.related_album_id ?? "")
  };
}

function seriesDetail(series, episodes) {
  const totalEpisodes = Math.max(Number(series?.episode_count) || 0, episodes.length);
  return {
    id: String(series?.id ?? ""),
    name: String(series?.title ?? ""),
    posterUrl: jpegCoverUrl(series?.cover_url),
    description: String(series?.description ?? ""),
    totalEpisodes,
    fullEpisodeCount: totalEpisodes,
    accessibleEpisodeCount: episodes.length,
    episodeIds: episodes.map((episode) => String(episode.id)),
    seasonIndex: Number(series?.season_index) || 0,
    albumId: String(series?.related_album_id ?? ""),
    seasons: []
  };
}

function encodeBytes(bytes, contentType) {
  return { contentType, encoding: "base64", data: Buffer.from(bytes).toString("base64") };
}

// 每个播放会话持有独立的 ffmpeg 进程；同一目标只保留一个，避免快速切集时
// 旧进程继续转码浪费 CPU。
export class HongguoService {
  #client;
  #listStorage;
  #sessions = new Map();
  #pendingPlayback = new Map();
  #feeds = new Map();
  #knownImages = new Set();
  #random;
  #ffmpegSessionFactory;
  #imageLoader;
  #logger;
  #disposed = false;

  constructor({
    client = new HongguoSdkClient(),
    listStorage = new HongguoListStorage(),
    ffmpegSessionFactory = (options) => new FfmpegFmp4Session(options),
    randomImpl = Math.random,
    imageLoader = new HongguoImageLoader(),
    logger = null
  } = {}) {
    this.#client = client;
    this.#listStorage = listStorage;
    this.#ffmpegSessionFactory = ffmpegSessionFactory;
    this.#imageLoader = imageLoader;
    this.#logger = logger;
    if (typeof randomImpl !== "function") throw new TypeError("randomImpl 必须是函数");
    this.#random = randomImpl;
  }

  #rememberImages(items) {
    const result = items.map(item => {
      const url = jpegCoverUrl(item?.posterUrl);
      const posterUrl = isHongguoImageUrl(url) ? url : "";
      if (posterUrl) this.#knownImages.add(posterUrl);
      return { ...item, posterUrl };
    });
    while (this.#knownImages.size > KNOWN_IMAGES_LIMIT) {
      this.#knownImages.delete(this.#knownImages.values().next().value);
    }
    return result;
  }

  #clearTargetFeeds(targetId) {
    for (const [cursor, feed] of this.#feeds) {
      if (feed.targetId === targetId) this.#feeds.delete(cursor);
    }
  }

  #appendFeedPage(feed, page) {
    const sdkCursor = typeof page?.cursor === "string" ? page.cursor : null;
    const hasMore = page?.has_more === true;
    if (hasMore && (!sdkCursor || feed.requestedCursors.has(sdkCursor))) {
      throw new HongguoError("FEED_EXPIRED", "推荐流游标无效，请重新加载", { retryable: true });
    }
    const items = (page?.items ?? []).map(seriesSummary).filter(item => {
      if (!item.id || feed.seen.has(item.id)) return false;
      feed.seen.add(item.id);
      return true;
    });
    feed.items.push(...shuffled(items, this.#random));
    feed.sdkCursor = sdkCursor;
    feed.hasMore = hasMore;
  }

  #feedPage(feed, limit) {
    const items = this.#rememberImages(feed.items.splice(0, feedPageSize(limit)));
    const hasMore = feed.items.length > 0 || feed.hasMore;
    if (!hasMore) this.#feeds.delete(feed.cursor);
    return { items, cursor: hasMore ? feed.cursor : null, hasMore, total: feed.seen.size };
  }

  #assertFeed(feed, signal) {
    signal?.throwIfAborted();
    if (this.#disposed || this.#feeds.get(feed.cursor) !== feed) {
      throw new HongguoError("FEED_EXPIRED", "推荐流已更新，请重新加载", { retryable: true });
    }
  }

  async #startFeed(targetId, limit, signal) {
    this.#clearTargetFeeds(targetId);
    const feed = {
      targetId, cursor: randomUUID(), items: [], seen: new Set(), requestedCursors: new Set([""]),
      sdkCursor: null, hasMore: false, pending: Promise.resolve()
    };
    this.#feeds.set(feed.cursor, feed);
    try {
      const page = await this.#client.discover({ cursor: "" });
      this.#assertFeed(feed, signal);
      this.#appendFeedPage(feed, page);
      const result = this.#feedPage(feed, limit);
      return { ...result, featured: result.items };
    } catch (error) {
      this.#feeds.delete(feed.cursor);
      throw error;
    }
  }

  #nextFeed(cursorValue, targetId, limit, signal) {
    const cursor = stringParam(cursorValue, "推荐流游标");
    const feed = this.#feeds.get(cursor);
    if (!feed || feed.targetId !== targetId) {
      throw new HongguoError("FEED_EXPIRED", "推荐流已更新，请重新加载", { retryable: true });
    }
    const pending = feed.pending.catch(() => {}).then(async () => {
      this.#assertFeed(feed, signal);
      for (let pages = 0; feed.items.length === 0 && feed.hasMore && pages < 3; pages += 1) {
        const sdkCursor = feed.sdkCursor;
        const page = await this.#client.discover({ cursor: sdkCursor });
        this.#assertFeed(feed, signal);
        feed.requestedCursors.add(sdkCursor);
        this.#appendFeedPage(feed, page);
      }
      return this.#feedPage(feed, limit);
    });
    feed.pending = pending;
    return pending;
  }

  #session(playbackId, context) {
    const session = this.#sessions.get(playbackId);
    if (!session || session.targetId !== context.targetId) {
      throw new HongguoError("PLAYBACK_NOT_FOUND", "短剧播放会话已失效，请重新选择剧集", { retryable: true });
    }
    return session;
  }

  async #episodes(seriesId, signal) {
    signal?.throwIfAborted();
    const result = await this.#client.listEpisodes(seriesId, { pageSize: 500 });
    signal?.throwIfAborted();
    return Array.isArray(result?.items) ? result.items : [];
  }

  async #search(query, cursor, signal) {
    const page = await this.#client.search(query, { cursor, pageSize: 20, tab: "剧集" });
    signal?.throwIfAborted();
    const seen = new Set();
    const summaries = (page?.items ?? []).filter(item => {
      const id = String(item?.id ?? "");
      if (!/^[0-9]{1,32}$/.test(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    const missing = summaries.filter(item => !isHongguoImageUrl(jpegCoverUrl(item.cover_url)));
    const details = missing.length > 0 ? await this.#client.getSeriesBatch(missing.map(item => String(item.id))) : [];
    signal?.throwIfAborted();
    const metadata = new Map(details.map(detail => [String(detail.series?.id), detail.series]));
    const items = this.#rememberImages(summaries.map(item => seriesSummary({ ...item, ...metadata.get(String(item.id)) })));
    const nextCursor = typeof page?.cursor === "string" ? page.cursor : "";
    const hasMore = page?.has_more === true && Boolean(nextCursor) && nextCursor !== cursor;
    return { items, cursor: hasMore ? nextCursor : null, hasMore };
  }

  async #detail(seriesId, signal) {
    const [series, episodes] = await Promise.all([
      this.#client.getSeries(seriesId),
      this.#episodes(seriesId, signal)
    ]);
    signal?.throwIfAborted();
    const detail = seriesDetail(series, episodes);
    if (series?.is_multi_season || series?.related_album_id) {
      try {
        const album = await this.#client.seasons(seriesId);
        signal?.throwIfAborted();
        const seen = new Set();
        const seasons = (album?.seasons ?? []).filter(season => {
          const id = String(season?.series_id ?? "");
          if (!/^[0-9]{1,32}$/.test(id) || seen.has(id)) return false;
          seen.add(id);
          return true;
        }).map(season => ({
          ...seriesSummary({ id: season.series_id, title: season.title, cover_url: season.cover_url, episode_count: season.episode_count, season_index: season.index }),
          albumId: String(album?.id || detail.albumId)
        }));
        if (!seen.has(detail.id)) seasons.push({ ...seriesSummary(series), albumId: detail.albumId });
        detail.seasons = this.#rememberImages(seasons.sort((first, second) => first.seasonIndex - second.seasonIndex));
        detail.albumId = String(album?.id || detail.albumId);
      } catch (error) {
        signal?.throwIfAborted();
        detail.seasonError = { message: error?.message || "季列表加载失败", retryable: error?.retryable === true };
      }
    }
    return this.#rememberImages([detail])[0];
  }

  async #openPlayback({ seriesId, episode }, signal) {
    const index = Number(episode);
    if (!Number.isSafeInteger(index) || index < 1) {
      throw new HongguoError("INVALID_ARGUMENT", "集数无效");
    }
    const episodes = await this.#episodes(seriesId, signal);
    const target = episodes[index - 1];
    if (!target) {
      throw new HongguoError("EPISODE_NOT_AVAILABLE", `这部短剧只有 ${episodes.length} 集`, { retryable: false });
    }
    const resolved = await this.#client.resolvePlayback(target.id);
    signal?.throwIfAborted();
    const playback = resolved?.playback;
    const streams = Array.isArray(playback?.streams) ? playback.streams.filter((stream) => stream?.url) : [];
    if (streams.length === 0) {
      throw new HongguoError("VIDEO_SOURCE_UNAVAILABLE", "红果没有返回这一集的播放地址", { retryable: true });
    }
    // 优先选择最高的非 HLS/DASH 单文件流：直接喂 FFmpeg 最简单，也保留了它的
    // 原生协商能力。降级到任意可用流，避免因招牌档位缺失而整集失败。
    const direct = streams.filter((stream) => !stream.hls && !stream.dash);
    const chosen = (direct.length > 0 ? direct : streams)
      .reduce((best, current) => (Number(current.bitrate) || 0) > (Number(best.bitrate) || 0) ? current : best);
    const contentKey = resolved?.contentKey?.key ?? null;
    if (playback.protected && !contentKey) {
      throw new HongguoError("CONTENT_KEY_UNAVAILABLE", "这一集是加密的，但没有取到内容密钥", { retryable: true });
    }
    return { index, episodeId: String(target.id), stream: chosen, contentKey, durationSeconds: playback.duration_seconds ?? null };
  }

  #createDirectSession(source) {
    return this.#ffmpegSessionFactory({
      inputUrl: source.stream.url,
      decryptionKey: source.contentKey || null,
      // 描述来源编码，供 ffmpeg 策略决定是否复制视频轨/转码：
      // bytevc1(HEVC) 在 Chromium 里不稳定，统一走 VideoToolbox H.264。
      mediaSource: {
        MediaStreams: [
          {
            Type: "Video",
            Codec: /bytevc|hevc|h265/i.test(source.stream.codec ?? "") ? "hevc" : "h264",
            BitRate: Number(source.stream.bitrate) || undefined,
            Width: Number(source.stream.width) || undefined,
            Height: Number(source.stream.height) || undefined
          },
          { Type: "Audio", Codec: "aac" }
        ],
        BitRate: Number(source.stream.bitrate) || undefined
      },
      durationSeconds: source.durationSeconds
    });
  }

  async handleRpc(method, params = {}, context = {}) {
    if (this.#disposed) throw new HongguoError("RPC_UNAVAILABLE", "红果后台服务已关闭");
    context.signal?.throwIfAborted();
    if (method === "hongguo.home") {
      return this.#startFeed(context.targetId, params.limit, context.signal);
    }
    if (method === "hongguo.feed.next") {
      return this.#nextFeed(params.cursor, context.targetId, params.limit, context.signal);
    }
    if (method === "hongguo.list.get") {
      return { items: this.#rememberImages(await this.#listStorage.load()) };
    }
    if (method === "hongguo.list.add") {
      const entry = normalizeListEntry(params.entry ?? params);
      if (!entry) throw new HongguoError("INVALID_ARGUMENT", "片单条目无效");
      if (entry.posterUrl && (!isHongguoImageUrl(entry.posterUrl) || !this.#knownImages.has(entry.posterUrl))) {
        throw new HongguoError("UNSAFE_IMAGE_URL", "片单封面必须来自已加载的红果内容");
      }
      return { items: this.#rememberImages(await this.#listStorage.add(entry)) };
    }
    if (method === "hongguo.list.remove") {
      const id = stringParam(params.id, "短剧 ID");
      return { items: this.#rememberImages(await this.#listStorage.remove(id)) };
    }
    if (method === "hongguo.search") {
      const query = stringParam(params.query, "搜索词");
      const cursor = params.cursor ? stringParam(params.cursor, "搜索游标") : "";
      return this.#search(query, cursor, context.signal);
    }
    if (method === "hongguo.detail") {
      const seriesId = stringParam(params.dramaId, "短剧 ID");
      return this.#detail(seriesId, context.signal);
    }
    if (method === "hongguo.image.load") {
      const url = stringParam(params.url, "封面地址");
      if (!isHongguoImageUrl(url) || !this.#knownImages.has(url)) {
        throw new HongguoError("UNSAFE_IMAGE_URL", "拒绝加载未知的短剧封面地址");
      }
      const image = await this.#imageLoader.load(url, { signal: context.signal });
      return encodeBytes(image.bytes, image.contentType);
    }
    if (method === "hongguo.playback.open") {
      const seriesId = stringParam(params.dramaId, "短剧 ID");
      const controller = new AbortController();
      this.#pendingPlayback.get(context.targetId)?.abort(new HongguoError("CANCELLED", "播放请求已被替换"));
      this.#pendingPlayback.set(context.targetId, controller);
      const signal = context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal;
      try {
        const source = await this.#openPlayback({ seriesId, episode: params.episode }, signal);
        signal.throwIfAborted();
        const playbackId = randomUUID();
        const session = {
          targetId: context.targetId,
          seriesId,
          episode: source.index,
          source,
          directSession: null
        };
        try {
          session.directSession = this.#createDirectSession(source);
          signal.throwIfAborted();
        } catch (error) {
          session.directSession?.destroy();
          if (signal.aborted) throw signal.reason;
          throw error instanceof HongguoError ? error : new HongguoError(
            error?.code === "FFMPEG_UNAVAILABLE" ? "FFMPEG_UNAVAILABLE" : "PLAYBACK_UNAVAILABLE",
            error?.message || "无法启动本地播放器",
            { retryable: false, cause: error }
          );
        }
        for (const [oldId, oldSession] of this.#sessions) {
          if (oldSession.targetId !== context.targetId) continue;
          oldSession.directSession?.destroy();
          this.#sessions.delete(oldId);
        }
        this.#sessions.set(playbackId, session);
        return {
          playbackId,
          streamMode: "ffmpeg-fmp4",
          dramaId: seriesId,
          episode: source.index,
          durationSeconds: source.durationSeconds,
          mediaBitrate: Number(source.stream.bitrate) || null
        };
      } finally {
        if (this.#pendingPlayback.get(context.targetId) === controller) this.#pendingPlayback.delete(context.targetId);
      }
    }
    if (method === "hongguo.playback.direct.init") {
      const playbackId = stringParam(params.playbackId, "播放会话");
      return this.#session(playbackId, context).directSession.initialize({ signal: context.signal });
    }
    if (method === "hongguo.playback.direct.next") {
      const playbackId = stringParam(params.playbackId, "播放会话");
      return this.#session(playbackId, context).directSession.next({ signal: context.signal });
    }
    if (method === "hongguo.playback.direct.seek") {
      const playbackId = stringParam(params.playbackId, "播放会话");
      return this.#session(playbackId, context).directSession.seek(Number(params.timeSeconds) || 0, { signal: context.signal });
    }
    if (method === "hongguo.playback.stop") {
      const playbackId = stringParam(params.playbackId, "播放会话");
      const session = this.#sessions.get(playbackId);
      if (session?.targetId === context.targetId) {
        session.directSession?.destroy();
        this.#sessions.delete(playbackId);
      }
      return { stopped: true };
    }
    throw new HongguoError("RPC_METHOD_NOT_FOUND", `未知短剧方法：${method}`);
  }

  disposeTarget(targetId) {
    this.#pendingPlayback.get(targetId)?.abort(new HongguoError("CANCELLED", "短剧播放已关闭"));
    this.#pendingPlayback.delete(targetId);
    this.#clearTargetFeeds(targetId);
    for (const [playbackId, session] of this.#sessions) {
      if (session.targetId !== targetId) continue;
      session.directSession?.destroy();
      this.#sessions.delete(playbackId);
    }
  }

  dispose() {
    this.#disposed = true;
    for (const controller of this.#pendingPlayback.values()) controller.abort(new HongguoError("CANCELLED", "红果后台服务已关闭"));
    this.#pendingPlayback.clear();
    for (const session of this.#sessions.values()) session.directSession?.destroy();
    this.#sessions.clear();
    this.#feeds.clear();
    this.#knownImages.clear();
    this.#client.dispose?.();
    return this.#imageLoader.dispose?.();
  }
}
