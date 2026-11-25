import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { companionDataDir } from "../../src/platform/paths.mjs";

// openhongguo 的 Node 绑定把 Go 编译的 wasm 一起发布，包内用相对自身的路径
// 读取 dist/openhongguo.wasm，所以必须从真实文件位置 import：bun --compile 出来的
// 单文件二进制把源码打进可执行文件后没有稳定的包目录，只能在运行时由
// runtimeDir() 指向随应用分发的 Resources/openhongguo。
const PACKAGE_ENTRY = "index.js";

let modulePromise = null;
let runtimeDirOverride = null;

// 打包后的可执行文件在 .app/Contents/Resources/agent-companion，运行时目录
// 随包放在同级 Resources/openhongguo（见 scripts/build-app.mjs）。开发态则用
// 仓库内的 node_modules/openhongguo。
function packagedRuntimeDir() {
  const candidates = [
    join(dirname(process.execPath), "openhongguo"),
    join(dirname(process.execPath), "..", "Resources", "openhongguo")
  ];
  return candidates.find((dir) => existsSync(join(dir, PACKAGE_ENTRY))) ?? null;
}

function developmentRuntimeDir() {
  let here;
  try { here = fileURLToPath(import.meta.url); } catch { return null; }
  // 开发态模块位于 <仓库>/cards/hongguo/，依赖在仓库根的 node_modules。
  const dir = join(dirname(here), "..", "..", "node_modules", "openhongguo");
  return existsSync(join(dir, PACKAGE_ENTRY)) ? dir : null;
}

/** runtimeDir 返回 openhongguo 包（含 index.js 与 dist/openhongguo.wasm）所在目录。 */
export function runtimeDir() {
  if (runtimeDirOverride) return runtimeDirOverride;
  const override = process.env.AGENT_COMPANION_HONGGUO_RUNTIME;
  if (override && existsSync(join(override, PACKAGE_ENTRY))) return override;
  return packagedRuntimeDir() ?? developmentRuntimeDir();
}

export function setRuntimeDir(dir) {
  runtimeDirOverride = dir ?? null;
  modulePromise = null;
}

async function loadModule() {
  const dir = runtimeDir();
  if (!dir) {
    throw new HongguoError("SDK_UNAVAILABLE", "红果 SDK 运行时尚未配置，无法读取短剧目录", { retryable: false });
  }
  modulePromise ??= import(pathToFileURL(join(dir, PACKAGE_ENTRY)).href);
  return modulePromise;
}

export class HongguoError extends Error {
  constructor(code, message, { retryable = false, cause, status = null } = {}) {
    super(message);
    this.name = "HongguoError";
    this.code = code;
    this.retryable = retryable;
    this.status = status;
    if (cause) this.cause = cause;
  }
}

// SDK 的哨兵错误码映射到卡片自己的错误码，前端据此决定是否显示重试。
const SDK_ERRORS = {
  ANONYMOUS_LIMITED: ["HONGGUO_LIMITED", "红果暂未向匿名设备返回这项内容，可稍后重试或选择其他短剧", false],
  DEVICE_REJECTED: ["HONGGUO_DEVICE_REJECTED", "红果拒绝了当前匿名设备，请重试", true],
  RATE_LIMITED: ["HONGGUO_RATE_LIMITED", "请求过于频繁，请稍后再试", true],
  TRANSPORT: ["HONGGUO_NETWORK", "无法连接红果服务", true],
  CONTENT_UNAVAILABLE: ["HONGGUO_UNAVAILABLE", "这部短剧已下架或不可访问", false],
  ALBUM_UNAVAILABLE: ["HONGGUO_UNAVAILABLE", "这部短剧已下架或不可访问", false],
  PARAM_INVALID: ["HONGGUO_INVALID", "红果认为请求参数无效", false],
  AUTHENTICATION_REQUIRED: ["HONGGUO_AUTH_REQUIRED", "这集需要登录红果才能观看", false],
  CHALLENGE_REQUIRED: ["HONGGUO_CHALLENGE", "红果要求验证，匿名设备无法继续", false],
  SIGNATURE_REJECTED: ["HONGGUO_SIGNATURE", "红果拒绝了请求签名", false],
  DRM_PROTECTED: ["HONGGUO_DRM", "这集是加密的，需要内容密钥", false],
  NOT_PROTECTED: ["HONGGUO_NOT_PROTECTED", "这集不是加密内容", false],
  PROFILE_NOT_FOUND: ["HONGGUO_PROFILE", "还没有匿名设备档案", true],
  SIGNER_UNAVAILABLE: ["HONGGUO_SIGNER", "SDK 缺少可用的签名器", false],
  END_OF_LIST: ["HONGGUO_END", "列表已经没有更多内容", false],
  INVALID_OPTIONS: ["HONGGUO_INVALID", "参数无效", false],
};

function translateError(error, operation) {
  if (error instanceof HongguoError) return error;
  const sdkCode = typeof error?.code === "string" ? error.code : "";
  const mapped = SDK_ERRORS[sdkCode];
  if (sdkCode === "ANONYMOUS_LIMITED") {
    const messages = {
      discover: "红果暂未返回推荐内容，搜索和片单仍可使用",
      listEpisodes: "红果暂未向匿名设备开放这部短剧的分集列表，可稍后重试或选择其他短剧",
      resolvePlayback: "红果暂未向匿名设备返回这一集的播放地址，可稍后重试或选择其他剧集"
    };
    return new HongguoError(mapped[0], messages[operation] || mapped[1], { retryable: mapped[2], cause: error });
  }
  if (mapped) return new HongguoError(mapped[0], mapped[1], { retryable: mapped[2], cause: error });
  return new HongguoError("HONGGUO_ERROR", error?.message || "红果请求失败", {
    retryable: error?.retryable === true,
    cause: error
  });
}

// 设备档案放在 Companion 自己的数据目录（hongguo/anonymous.json），后续请求复用同一台
// 匿名设备，避免每次启动都重新注册；不与 ohg CLI 的默认档案共用。
function defaultProfilePath() {
  return join(companionDataDir(), "hongguo", "anonymous.json");
}

export class HongguoSdkClient {
  #clientPromise;
  #createClient;

  constructor({ createClientImpl = null, profilePath = defaultProfilePath() } = {}) {
    this.profilePath = profilePath;
    this.#createClient = createClientImpl;
    this.#clientPromise = null;
  }

  async #client() {
    this.#clientPromise ??= (async () => {
      let mod;
      let createClient;
      if (this.#createClient) {
        createClient = this.#createClient;
        mod = { defaultProfilePath };
      } else {
        mod = await loadModule();
        createClient = mod.createClient;
      }
      const profile = typeof mod.fileProfileStore === "function"
        ? mod.fileProfileStore(this.profilePath)
        : this.profilePath;
      return createClient({
        profile,
        // SDK 默认换 2 台，这里放宽到 3 台：播放接口按设备概率性返回空结果，换设备能显著提高成功率。
        deviceResets: 3,
        retryAttempts: 3
      });
    })();
    try {
      return await this.#clientPromise;
    } catch (error) {
      // 初始化失败（如 wasm 无法启动）不缓存，下次调用可以重试。
      this.#clientPromise = null;
      throw translateError(error);
    }
  }

  async #call(name, ...args) {
    const client = await this.#client();
    try {
      return await client[name](...args);
    } catch (error) {
      throw translateError(error, name);
    }
  }

  async discover({ cursor = "", channel } = {}) {
    return this.#call("discover", { cursor, ...(channel ? { channel } : {}) });
  }

  async search(query, { pageSize = 20, cursor = "", tab = "剧集" } = {}) {
    return this.#call("search", query, { pageSize, cursor, tab });
  }

  async getSeries(seriesId) {
    return this.#call("getSeries", String(seriesId));
  }

  async getSeriesBatch(seriesIds) {
    return this.#call("getSeriesBatch", seriesIds.map(seriesId => String(seriesId)));
  }

  async seasons(seriesId) {
    return this.#call("seasons", String(seriesId));
  }

  async listEpisodes(seriesId, { pageSize = 500 } = {}) {
    return this.#call("listEpisodes", String(seriesId), { pageSize });
  }

  async resolvePlayback(episodeId) {
    return this.#call("resolvePlayback", String(episodeId));
  }

  async resetDevice() {
    return this.#call("resetDevice");
  }

  dispose() {
    this.#clientPromise = null;
  }
}
