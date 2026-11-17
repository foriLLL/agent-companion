import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { changelogSection } from "./changelog.mjs";
import { companionDataDir } from "./platform/paths.mjs";

// 自动更新：版本以 GitHub 上打了 vX.Y.Z tag 的正式 Release 为准。
// - Homebrew（macOS）：发现新版本后在后台 brew update + brew upgrade，等卡片里没有媒体在播时
//   以非零退出码结束 agent，由 launchd（KeepAlive.SuccessfulExit=false）拉起新版本；不重启 Codex。
// - 源码安装：只提醒并给出更新命令，不替用户 git pull，避免冲掉本地改动。
// - 其它（打包的 .app、Linux 单文件后端）：只提醒，指向 Release 页面。

export const REPOSITORY = "foriLLL/codex_companion";
export const RELEASE_API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
export const RELEASES_PAGE = `https://github.com/${REPOSITORY}/releases`;
export const FORMULA = "codex-companion";
// launchd 只在非零退出时重新拉起 agent；75 即 EX_TEMPFAIL，日志里能和崩溃区分开。
export const RESTART_EXIT_CODE = 75;
export const CHECK_DELAY_MS = 2 * 60_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60_000;
export const RESTART_POLL_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const BREW_UPDATE_TIMEOUT_MS = 5 * 60_000;
const BREW_UPGRADE_TIMEOUT_MS = 20 * 60_000;
const NOTES_LIMIT = 8000;
const MESSAGE_LIMIT = 300;
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const execFileAsync = promisify(execFile);

export const defaultUpdateStatePath = (home = homedir()) => join(companionDataDir(home), "update-state.json");

/** 只认正式版 X.Y.Z（可带 v 前缀）；预发布与构建元数据一律不当作可更新版本。 */
export function parseVersion(text) {
  const match = /^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.exec(String(text ?? "").trim());
  return match ? match.slice(1).map(Number) : null;
}

/** a 比 b 新返回正数，旧返回负数，相同返回 0；任一无法解析时返回 NaN。 */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return Number.NaN;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

const isNewer = (candidate, current) => compareVersions(candidate, current) > 0;
const trimMessage = text => {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > MESSAGE_LIMIT ? `${value.slice(0, MESSAGE_LIMIT - 1)}…` : value;
};

async function exists(path, accessImpl) {
  try { await accessImpl(path); return true; } catch { return false; }
}

/**
 * 判断当前代码是怎么装的。Homebrew 的启动脚本会声明渠道和 brew 路径；没有声明时按源码真实路径是否在
 * Cellar/codex-companion 下判断。源码安装以仓库根目录有 .git 为准。
 */
export async function detectInstall({ env = process.env, root = PACKAGE_ROOT, hostPlatform = process.platform,
  realpathImpl = realpath, accessImpl = access } = {}) {
  let real = root;
  try { real = await realpathImpl(root); } catch {}
  const cellar = /\/Cellar\/codex-companion\/([^/]+)(?:\/|$)/.exec(real);
  if (hostPlatform === "darwin" && (env.CODEX_COMPANION_INSTALL_CHANNEL === "homebrew" || cellar)) {
    const prefix = cellar ? real.slice(0, cellar.index) : env.CODEX_COMPANION_BREW ? dirname(dirname(env.CODEX_COMPANION_BREW)) : null;
    let brew = env.CODEX_COMPANION_BREW || (prefix ? join(prefix, "bin", "brew") : null);
    if (!brew || !await exists(brew, accessImpl)) {
      brew = null;
      for (const candidate of ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]) {
        if (await exists(candidate, accessImpl)) { brew = candidate; break; }
      }
    }
    return { channel: "homebrew", brew, prefix: prefix ?? (brew ? dirname(dirname(brew)) : null),
      head: Boolean(cellar?.[1]?.startsWith("HEAD")) };
  }
  if (await exists(join(root, ".git"), accessImpl)) return { channel: "source", root };
  return { channel: "release" };
}

/** 读取最新正式 Release；还没有任何 Release 时返回 null。只信任指向本仓库的链接。 */
export async function fetchLatestRelease({ fetchImpl = globalThis.fetch, signal, userAgent = "codex-companion", dispatcher } = {}) {
  const init = (headers = {}) => ({ headers: { "user-agent": userAgent, ...headers }, signal, ...(dispatcher ? { dispatcher } : {}) });
  const response = await fetchImpl(RELEASE_API, init({ accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" }));
  if (response.status === 404) return null;
  // 未登录的 API 每个出口 IP 每小时只有 60 次，公司或运营商 NAT 后面常被别人用完。
  if (response.status === 403 || response.status === 429) return fetchLatestFromPage({ fetchImpl, init });
  if (!response.ok) throw new Error(`GitHub 返回 HTTP ${response.status}`);
  const body = await response.json();
  if (!body || typeof body !== "object" || body.draft || body.prerelease || !parseVersion(body.tag_name)) return null;
  const url = typeof body.html_url === "string" && body.html_url.startsWith(`https://github.com/${REPOSITORY}/releases/`)
    ? body.html_url : RELEASES_PAGE;
  const publishedAt = Date.parse(body.published_at);
  return {
    version: String(body.tag_name).trim().replace(/^v/, ""),
    notes: typeof body.body === "string" ? body.body.slice(0, NOTES_LIMIT) : "",
    url, publishedAt: Number.isFinite(publishedAt) ? publishedAt : null
  };
}

// API 被限流时的兜底：github.com 的 releases/latest 跳到最新正式版的 tag 页（没有 Release 时跳回列表），
// 说明取该 tag 上 CHANGELOG 的对应一节，与 CI 生成的 Release 说明同源；说明拿不到不影响更新。
async function fetchLatestFromPage({ fetchImpl, init }) {
  const page = await fetchImpl(`${RELEASES_PAGE}/latest`, { ...init(), method: "HEAD", redirect: "follow" });
  if (!page.ok) throw new Error(`GitHub 返回 HTTP ${page.status}`);
  const tag = String(page.url ?? "").startsWith(`${RELEASES_PAGE}/tag/`) ? decodeURIComponent(page.url.slice(RELEASES_PAGE.length + 5)) : "";
  if (!parseVersion(tag)) return null;
  const version = tag.replace(/^v/, "");
  let notes = "";
  try {
    const changelog = await fetchImpl(`https://raw.githubusercontent.com/${REPOSITORY}/${tag}/CHANGELOG.md`, init());
    if (changelog.ok) notes = changelogSection(await changelog.text(), version);
  } catch { /* 说明是附带的 */ }
  return { version, notes: notes.slice(0, NOTES_LIMIT), url: `${RELEASES_PAGE}/tag/${tag}`, publishedAt: null };
}

function proxyUrl(config) {
  const proxy = config?.launch?.proxy;
  return proxy?.enabled && Number.isInteger(proxy.port) ? `http://127.0.0.1:${proxy.port}` : null;
}

// 默认 fetch：设置里开了「通过代理启动」时，检查更新也走同一个本机代理。
async function defaultFetchRelease({ config, signal, userAgent }) {
  const proxy = proxyUrl(config);
  if (!proxy) return fetchLatestRelease({ signal, userAgent });
  const { fetch, ProxyAgent } = await import("undici");
  const dispatcher = new ProxyAgent(proxy);
  try { return await fetchLatestRelease({ fetchImpl: fetch, signal, userAgent, dispatcher }); }
  finally { await dispatcher.close().catch(() => {}); }
}

function sanitizeRelease(value) {
  if (!value || typeof value !== "object" || !parseVersion(value.version)) return null;
  return {
    version: value.version,
    notes: typeof value.notes === "string" ? value.notes.slice(0, NOTES_LIMIT) : "",
    url: typeof value.url === "string" && value.url.startsWith(`https://github.com/${REPOSITORY}/`) ? value.url : RELEASES_PAGE,
    publishedAt: Number.isFinite(value.publishedAt) ? value.publishedAt : null
  };
}

function sanitizeState(raw) {
  const state = { lastCheckAt: null, latest: null, error: null, pending: null, installed: null };
  if (!raw || typeof raw !== "object") return state;
  if (Number.isFinite(raw.lastCheckAt)) state.lastCheckAt = raw.lastCheckAt;
  state.latest = sanitizeRelease(raw.latest);
  if (raw.error && typeof raw.error.message === "string" && Number.isFinite(raw.error.at)) {
    state.error = { message: trimMessage(raw.error.message), at: raw.error.at };
  }
  for (const key of ["pending", "installed"]) {
    const value = raw[key];
    if (value && parseVersion(value.from) && parseVersion(value.to)) {
      state[key] = { from: value.from, to: value.to, notes: typeof value.notes === "string" ? value.notes.slice(0, NOTES_LIMIT) : "",
        at: Number.isFinite(value.at) ? value.at : 0, ...(key === "installed" ? { seen: value.seen === true } : {}) };
    }
  }
  return state;
}

export function createUpdater({
  currentVersion, install, statePath = defaultUpdateStatePath(), getConfig = () => null,
  logger = console, now = Date.now, env = process.env, hostPlatform = process.platform,
  fetchRelease = defaultFetchRelease, execFileImpl = execFileAsync, readFileImpl = readFile,
  writeFileImpl = writeFile, setTimer = setTimeout, clearTimer = clearTimeout,
  isMediaPlaying = async () => false, restart = () => {},
  checkDelayMs = CHECK_DELAY_MS, checkIntervalMs = CHECK_INTERVAL_MS, restartPollMs = RESTART_POLL_MS
} = {}) {
  if (!parseVersion(currentVersion)) throw new Error(`当前版本号无效：${currentVersion}`);
  const canApply = install?.channel === "homebrew" && hostPlatform === "darwin" && Boolean(install.brew);
  let state = sanitizeState(null);
  let phase = "idle";
  let checking = null;
  let applying = null;
  let stopped = false;
  let checkTimer = null;
  let restartTimer = null;
  let writes = Promise.resolve();
  const warn = message => logger.warn?.(`[codex-companion] 更新：${message}`);
  const info = message => logger.info?.(`[codex-companion] 更新：${message}`);

  const autoEnabled = () => getConfig()?.updates?.auto !== false;
  const available = () => Boolean(state.latest && isNewer(state.latest.version, currentVersion));

  function persist() {
    const snapshot = JSON.stringify(state, null, 2);
    const operation = writes.then(async () => {
      await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
      const temporary = `${statePath}.${randomUUID()}.tmp`;
      try {
        await writeFileImpl(temporary, `${snapshot}\n`, { mode: 0o600, flag: "wx" });
        await chmod(temporary, 0o600);
        await rename(temporary, statePath);
      } finally { await unlink(temporary).catch(() => {}); }
    });
    writes = operation.catch(error => warn(`保存状态失败：${error.message}`));
    return writes;
  }

  function manualCommand() {
    if (install?.channel === "homebrew") return `brew upgrade ${install.head ? "--fetch-HEAD " : ""}${FORMULA}`;
    if (install?.channel === "source") return `cd ${JSON.stringify(install.root)} && git pull && npm ci && npm start`;
    return null;
  }

  function status() {
    const latest = available() ? state.latest : null;
    const notice = state.installed && !state.installed.seen
      ? { from: state.installed.from, to: state.installed.to, notes: state.installed.notes } : null;
    return {
      current: currentVersion, channel: install?.channel ?? "release", canApply, auto: autoEnabled(),
      phase, available: Boolean(latest), latest, lastCheckAt: state.lastCheckAt, error: state.error,
      pending: state.pending ? { version: state.pending.to } : null, notice,
      command: manualCommand(), releasesUrl: latest?.url ?? RELEASES_PAGE
    };
  }

  function brewEnv() {
    const proxy = proxyUrl(getConfig());
    return {
      ...env, HOME: env.HOME || homedir(),
      PATH: [...new Set([dirname(install.brew), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":"),
      // 已显式 brew update；保留旧版本文件，正在运行的 agent 还会懒加载自己目录里的模块。
      HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_INSTALL_CLEANUP: "1",
      HOMEBREW_NO_ENV_HINTS: "1", HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK: "1",
      ...(proxy ? { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, ALL_PROXY: proxy, https_proxy: proxy, http_proxy: proxy, all_proxy: proxy } : {})
    };
  }

  async function brew(args, timeout) {
    try {
      await execFileImpl(install.brew, args, { env: brewEnv(), timeout, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" });
    } catch (error) {
      const detail = String(error.stderr ?? "").trim().split("\n").filter(Boolean).at(-1) ?? error.message;
      throw new Error(`brew ${args[0]} 失败：${trimMessage(detail)}`);
    }
  }

  async function installedVersion() {
    const raw = await readFileImpl(join(install.prefix, "opt", FORMULA, "libexec", "package.json"), "utf8");
    const version = JSON.parse(raw)?.version;
    if (!parseVersion(version)) throw new Error(`升级后读到的版本号无效：${version}`);
    return version;
  }

  function scheduleCheck(delay) {
    clearTimer(checkTimer);
    if (stopped) return;
    checkTimer = setTimer(() => {
      checkTimer = null;
      void check().finally(() => scheduleCheck(checkIntervalMs));
    }, delay);
    checkTimer?.unref?.();
  }

  // 等卡片里没有媒体在播再重启：重新注入会卸载正在播放的卡片。读不到播放状态（例如 Codex 没开）就当作空闲。
  function scheduleRestart(delay = 0) {
    clearTimer(restartTimer);
    if (stopped) return;
    restartTimer = setTimer(async () => {
      restartTimer = null;
      if (stopped) return;
      const playing = await Promise.resolve().then(isMediaPlaying).catch(() => false);
      if (stopped) return;
      if (playing === true) { scheduleRestart(restartPollMs); return; }
      phase = "restarting";
      info(`已安装 ${state.pending?.to}，重启后台服务`);
      await writes;
      restart();
    }, delay);
  }

  function check({ manual = false } = {}) {
    if (stopped) return Promise.resolve(status());
    if (checking) return checking;
    checking = (async () => {
      if (phase === "idle") phase = "checking";
      try {
        const latest = await fetchRelease({ config: getConfig(), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          userAgent: `codex-companion/${currentVersion}` });
        state.latest = sanitizeRelease(latest);
        state.lastCheckAt = now();
        state.error = null;
        if (available()) info(`发现新版本 ${state.latest.version}`);
      } catch (error) {
        state.lastCheckAt = now();
        state.error = { message: `检查更新失败：${trimMessage(error.message ?? error)}`, at: now() };
        if (manual) info(state.error.message); else warn(state.error.message);
      } finally {
        if (phase === "checking") phase = "idle";
      }
      await persist();
      if (!stopped && available() && canApply && autoEnabled() && !state.pending) void apply();
      return status();
    })().finally(() => { checking = null; });
    return checking;
  }

  /** 开始升级并立即返回；brew 跑完前 phase 为 updating，界面轮询 status。 */
  function apply() {
    if (!canApply) throw Object.assign(new Error("当前安装方式不支持自动更新"), { code: "UPDATE_UNSUPPORTED" });
    if (stopped || applying || state.pending || !available()) return status();
    const target = state.latest;
    phase = "updating";
    state.error = null;
    applying = (async () => {
      try {
        info(`开始更新到 ${target.version}`);
        await brew(["update", "--quiet"], BREW_UPDATE_TIMEOUT_MS);
        await brew(install.head ? ["upgrade", "--fetch-HEAD", FORMULA] : ["upgrade", FORMULA], BREW_UPGRADE_TIMEOUT_MS);
        const version = await installedVersion();
        if (!isNewer(version, currentVersion)) {
          throw new Error(`Homebrew 里还是 ${version}，新版本可能还没同步到 Formula，稍后会自动重试`);
        }
        state.pending = { from: currentVersion, to: version, notes: target.notes, at: now() };
        await persist();
        // 先记下待重启再改状态：看到 waiting-restart 时重启检查已经排上。
        phase = "waiting-restart";
        scheduleRestart();
      } catch (error) {
        phase = "idle";
        state.error = { message: `更新失败：${trimMessage(error.message ?? error)}`, at: now() };
        warn(state.error.message);
        await persist();
      } finally { applying = null; }
    })();
    return status();
  }

  async function start() {
    try {
      const raw = await readFileImpl(statePath, "utf8");
      state = sanitizeState(JSON.parse(raw));
    } catch (error) {
      if (error.code !== "ENOENT") warn(`读取状态失败，已重置：${error.message}`);
    }
    // 上一个进程装好新版本后重启：已换上新代码就转成一次性的「已更新」提示。
    if (state.pending) {
      if (compareVersions(currentVersion, state.pending.to) >= 0) {
        state.installed = { from: state.pending.from, to: currentVersion, notes: state.pending.notes, at: now(), seen: false };
        info(`已更新到 ${currentVersion}`);
      } else warn(`重启后仍是 ${currentVersion}，未换上 ${state.pending.to}`);
      state.pending = null;
      await persist();
    }
    scheduleCheck(checkDelayMs);
    return status();
  }

  return {
    start, status, check, apply,
    async acknowledge() {
      if (state.installed && !state.installed.seen) {
        state.installed.seen = true;
        await persist();
      }
      return status();
    },
    // 自动更新从关到开时，已发现的新版本立即开始安装。
    applyConfig() {
      if (!stopped && autoEnabled() && canApply && available() && !state.pending && !applying) void apply();
    },
    async stop() {
      stopped = true;
      clearTimer(checkTimer);
      clearTimer(restartTimer);
      checkTimer = restartTimer = null;
      await checking?.catch(() => {});
      await writes;
    }
  };
}
