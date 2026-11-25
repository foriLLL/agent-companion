import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { AntigravitySessions } from "../../antigravity-sessions.mjs";
import { createPlanHint } from "../../codex-plan-hint.mjs";
import { CodexSessions, THREAD_ID_PATTERN } from "../../codex-sessions.mjs";
import { buildCodexLaunchEnvironment, detectCodexProxy } from "../../launcher.mjs";
import { registerMediaInterceptPort, toMediaInterceptUrl } from "../media/media-intercept.mjs";
import { companionDataDir } from "../paths.mjs";
import { CARD_API_VERSION } from "../registry/manifest.mjs";
import { rpcError } from "./errors.mjs";

export { CARD_API_VERSION };

const execFileAsync = promisify(execFile);

// Codex 的会话深链由 ChatGPT.app 注册，只在 macOS 可用；侧栏里找不到条目时作为兜底。
async function openCodexThread(id, { platform = process.platform, execFileImpl = execFileAsync } = {}) {
  if (platform !== "darwin") throw rpcError("UNSUPPORTED", "此系统暂不支持从看板打开会话");
  await execFileImpl("/usr/bin/open", [`codex://threads/${id}`], { timeout: 5000 });
}

// Antigravity 的会话由页面里的路由直接打开（ctx.threads.reveal），没有可用的深链。
async function unsupportedOpen() {
  throw rpcError("UNSUPPORTED", "请在 Antigravity 侧栏里打开这个会话");
}

/**
 * 一个宿主会话（Codex 或 Antigravity）共享的平台能力，所有卡片拿到同一份：
 * - sessions：当前宿主的会话数据源。source 的接口在两个宿主上相同（canonicalId / aliases / projectOf /
 *   titles / status / trace / plan / stamp / fingerprint / recentRollouts / sessionMeta / isUserSession / createdAt），
 *   首次访问时才创建；open(id) 从后台打开会话；isValidId(id) 校验会话 id 形状。
 * - codex：本机 Codex 的信息与集成——启动代理（inspectProxy）、带代理的子进程环境（launchEnvironment）、
 *   「长任务先列计划」写入 Codex 全局指令（createPlanHint，卸载时由平台清理）。
 * - media.interceptor：CDP 媒体拦截的端口登记表。全局只有一份，卡片打包的媒体库要通过它登记代理端口。
 */
export function createHostApi({
  host = "codex", inspectCodexProxy, platform = process.platform, execFileImpl,
  sessionsFactory = host === "antigravity" ? () => new AntigravitySessions() : () => new CodexSessions()
} = {}) {
  let source = null;
  const sessions = Object.freeze({
    get source() { return source ??= sessionsFactory(); },
    isValidId: (id) => typeof id === "string" && THREAD_ID_PATTERN.test(id),
    open: host === "antigravity" ? unsupportedOpen : (id) => openCodexThread(id, { platform, execFileImpl })
  });
  const codex = Object.freeze({
    inspectProxy: inspectCodexProxy ?? (() => detectCodexProxy()),
    launchEnvironment: (proxyPort, env) => buildCodexLaunchEnvironment(proxyPort, env),
    createPlanHint: (options) => createPlanHint(options)
  });
  const media = Object.freeze({
    interceptor: Object.freeze({ register: registerMediaInterceptPort, toUrl: toMediaInterceptUrl })
  });
  return Object.freeze({ host, sessions, codex, media });
}

/**
 * 某张卡片的后台服务拿到的运行时接口：createService(api)。
 * - apiVersion、card（id、version、包目录 dir、本卡专用数据目录 dataDir）；
 * - host：当前宿主 id；logger；config.load()：读取完整配置（只读）；
 * - sessions / codex / media：见 createHostApi。
 * extras 只用于测试替换内部引擎，不属于公开接口。
 */
export function createCardApi({ manifest, packageDir = null, hostApi = createHostApi(), logger = console, loadConfig, dataRoot, extras = {} }) {
  const id = manifest.id;
  return Object.freeze({
    ...extras,
    apiVersion: CARD_API_VERSION,
    card: Object.freeze({
      id, version: manifest.version ?? null, dir: packageDir,
      dataDir: join(dataRoot ?? companionDataDir(), "card-data", id)
    }),
    host: hostApi.host,
    logger,
    config: Object.freeze({ load: typeof loadConfig === "function" ? () => loadConfig() : async () => null }),
    sessions: hostApi.sessions,
    codex: hostApi.codex,
    media: hostApi.media
  });
}
