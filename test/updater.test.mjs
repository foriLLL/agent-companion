import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { posixOnlyTest as test } from "./helpers/platform.mjs";
import { clock, flush, logger } from "./helpers/agent.mjs";
import {
  compareVersions, createUpdater, detectInstall, fetchLatestRelease, parseVersion, RELEASE_API, RELEASES_PAGE
} from "../src/updater.mjs";

const release = (version, extra = {}) => ({ version, notes: `## ${version}\n- 新功能`, url: `${RELEASES_PAGE}/tag/v${version}`, publishedAt: 1, ...extra });
const brewInstall = (extra = {}) => ({ channel: "homebrew", brew: "/opt/homebrew/bin/brew", prefix: "/opt/homebrew", head: false, ...extra });
// 状态落盘是真实文件 I/O，等条件成立而不是固定轮数。
async function until(predicate, message = "条件超时") {
  for (let index = 0; index < 400; index += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

async function fixture(t, { install = brewInstall(), current = "0.2.0", latest = release("0.2.1"), installed = "0.2.1",
  config = {}, playing = [], state, execFail } = {}) {
  const home = await mkdtemp(join(tmpdir(), "companion-updater-test-"));
  const statePath = join(home, "update-state.json");
  if (state) await writeFile(statePath, JSON.stringify(state));
  const timer = clock();
  const execCalls = [];
  const restarts = [];
  const playingQueue = [...playing];
  const holder = { latest, config };
  const updater = createUpdater({
    currentVersion: current, install, statePath, getConfig: () => holder.config, logger, now: timer.now,
    env: { HOME: home, PATH: "/usr/bin" }, hostPlatform: "darwin",
    fetchRelease: async ({ config: seen }) => {
      holder.seenConfig = seen;
      if (holder.latest instanceof Error) throw holder.latest;
      return holder.latest;
    },
    execFileImpl: async (file, args, options) => {
      execCalls.push({ file, args, env: options.env });
      if (execFail && args[0] === execFail) throw Object.assign(new Error("exit 1"), { stderr: "Warning: something\nError: 网络不通\n" });
      return { stdout: "", stderr: "" };
    },
    readFileImpl: async (path, encoding) => {
      if (path === statePath) return readFile(path, encoding);
      assert.equal(path, "/opt/homebrew/opt/codex-companion/libexec/package.json");
      return JSON.stringify({ version: installed });
    },
    setTimer: timer.setTimeoutImpl, clearTimer: timer.clearTimeoutImpl,
    isMediaPlaying: async () => playingQueue.shift() ?? false,
    restart: () => restarts.push(timer.now())
  });
  // 先停 updater 等写完，再删临时目录。
  t.after(async () => { await updater.stop(); await rm(home, { recursive: true, force: true }); });
  return { updater, timer, execCalls, restarts, holder, statePath, home };
}

test("版本号只认正式版 X.Y.Z，可带 v；比较按数值逐段", () => {
  assert.deepEqual(parseVersion("v1.2.3"), [1, 2, 3]);
  for (const bad of ["1.2", "1.2.3-beta.1", "01.2.3", "1.2.3+build", "", null, "v"]) assert.equal(parseVersion(bad), null, String(bad));
  assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
  assert.ok(compareVersions("1.0.0", "v1.0.1") < 0);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.ok(Number.isNaN(compareVersions("1.0", "1.0.0")));
});

test("识别安装方式：Cellar 真实路径与声明的 Homebrew、HEAD 安装、源码 .git、其它为发布版", async () => {
  const access = existing => async path => { if (!existing.includes(path)) throw Object.assign(new Error("no"), { code: "ENOENT" }); };
  const cellar = "/opt/homebrew/Cellar/codex-companion/0.2.0/libexec";
  assert.deepEqual(await detectInstall({ env: {}, root: "/opt/homebrew/opt/codex-companion/libexec", hostPlatform: "darwin",
    realpathImpl: async () => cellar, accessImpl: access(["/opt/homebrew/bin/brew"]) }),
  { channel: "homebrew", brew: "/opt/homebrew/bin/brew", prefix: "/opt/homebrew", head: false });
  const head = await detectInstall({ env: { CODEX_COMPANION_BREW: "/usr/local/bin/brew" }, root: "/x", hostPlatform: "darwin",
    realpathImpl: async () => "/usr/local/Cellar/codex-companion/HEAD-de62245/libexec", accessImpl: access(["/usr/local/bin/brew"]) });
  assert.deepEqual(head, { channel: "homebrew", brew: "/usr/local/bin/brew", prefix: "/usr/local", head: true });
  const declared = await detectInstall({ env: { CODEX_COMPANION_INSTALL_CHANNEL: "homebrew" }, root: "/somewhere", hostPlatform: "darwin",
    realpathImpl: async path => path, accessImpl: access(["/usr/local/bin/brew"]) });
  assert.equal(declared.brew, "/usr/local/bin/brew");
  assert.equal(declared.prefix, "/usr/local");
  assert.deepEqual(await detectInstall({ env: {}, root: "/repo", hostPlatform: "darwin", realpathImpl: async path => path,
    accessImpl: access(["/repo/.git"]) }), { channel: "source", root: "/repo" });
  assert.deepEqual(await detectInstall({ env: {}, root: "/home/u/.linuxbrew/Cellar/codex-companion/1.0.0", hostPlatform: "linux",
    realpathImpl: async path => path, accessImpl: access([]) }), { channel: "release" });
});

test("读取最新 Release：没有发布返回 null，预发布与非本仓库链接不信任，其它 HTTP 错误抛出", async () => {
  const respond = (status, body) => async (url, init) => {
    assert.equal(url, RELEASE_API);
    assert.equal(init.headers["user-agent"], "codex-companion/0.2.0");
    return { status, ok: status >= 200 && status < 300, json: async () => body };
  };
  const options = { userAgent: "codex-companion/0.2.0" };
  assert.equal(await fetchLatestRelease({ ...options, fetchImpl: respond(404) }), null);
  assert.equal(await fetchLatestRelease({ ...options, fetchImpl: respond(200, { tag_name: "v0.3.0", prerelease: true }) }), null);
  assert.equal(await fetchLatestRelease({ ...options, fetchImpl: respond(200, { tag_name: "nightly" }) }), null);
  assert.deepEqual(await fetchLatestRelease({ ...options, fetchImpl: respond(200, {
    tag_name: "v0.3.0", body: "说明", html_url: "https://evil.example/releases/v0.3.0", published_at: "2026-11-17T00:00:00Z" }) }),
  { version: "0.3.0", notes: "说明", url: RELEASES_PAGE, publishedAt: Date.parse("2026-11-17T00:00:00Z") });
  await assert.rejects(fetchLatestRelease({ ...options, fetchImpl: respond(500, {}) }), /HTTP 500/);
});

test("API 被限流（403/429）时改看 releases/latest 的跳转，说明取 tag 上 CHANGELOG 的对应一节", async () => {
  const CHANGELOG = "# Changelog\n\n## Unreleased\n\n## 0.3.0 - 2026-11-18\n\n- 限流兜底\n\n## 0.2.0 - 2026-11-17\n\n- 自动更新\n";
  const site = ({ api = 403, page = 200, landing = `${RELEASES_PAGE}/tag/v0.3.0`, changelog = CHANGELOG } = {}) => {
    const requests = [];
    const fetchImpl = async (url, init) => {
      requests.push({ url, method: init.method ?? "GET", agent: init.headers["user-agent"] });
      if (url === RELEASE_API) return { status: api, ok: false, json: async () => ({ message: "API rate limit exceeded" }) };
      if (url === `${RELEASES_PAGE}/latest`) return { status: page, ok: page === 200, url: landing };
      if (changelog instanceof Error) throw changelog;
      return { status: 200, ok: true, text: async () => changelog };
    };
    return { requests, fetchImpl };
  };
  const options = { userAgent: "codex-companion/0.2.0" };
  const limited = site();
  assert.deepEqual(await fetchLatestRelease({ ...options, fetchImpl: limited.fetchImpl }),
    { version: "0.3.0", notes: "- 限流兜底", url: `${RELEASES_PAGE}/tag/v0.3.0`, publishedAt: null });
  assert.deepEqual(limited.requests, [
    { url: RELEASE_API, method: "GET", agent: "codex-companion/0.2.0" },
    { url: `${RELEASES_PAGE}/latest`, method: "HEAD", agent: "codex-companion/0.2.0" },
    { url: "https://raw.githubusercontent.com/foriLLL/codex_companion/v0.3.0/CHANGELOG.md", method: "GET", agent: "codex-companion/0.2.0" }
  ]);
  assert.equal(await fetchLatestRelease({ ...options, fetchImpl: site({ api: 429, landing: RELEASES_PAGE }).fetchImpl }), null, "还没有 Release 时跳回列表");
  assert.equal(await fetchLatestRelease({ ...options, fetchImpl: site({ landing: "https://evil.example/foriLLL/codex_companion/releases/tag/v9.9.9" }).fetchImpl }), null);
  assert.equal(await fetchLatestRelease({ ...options, fetchImpl: site({ landing: `${RELEASES_PAGE}/tag/nightly` }).fetchImpl }), null);
  assert.equal((await fetchLatestRelease({ ...options, fetchImpl: site({ changelog: new Error("offline") }).fetchImpl })).notes, "", "说明拿不到也照常返回版本");
  await assert.rejects(fetchLatestRelease({ ...options, fetchImpl: site({ page: 403 }).fetchImpl }), /HTTP 403/);
});

test("Homebrew 自动更新：发现新版本后 brew update + upgrade，等视频播完再以重启换上新版本", async t => {
  const f = await fixture(t, { playing: [true, true], config: { launch: { proxy: { enabled: true, port: 7891 } } } });
  await f.updater.start();
  assert.deepEqual(f.timer.delays(), [120_000], "启动后 2 分钟再检查");
  await f.timer.advance(120_000);
  await until(() => f.updater.status().phase === "waiting-restart");
  assert.deepEqual(f.execCalls.map(call => call.args), [["update", "--quiet"], ["upgrade", "codex-companion"]]);
  const env = f.execCalls[1].env;
  assert.equal(env.HOMEBREW_NO_AUTO_UPDATE, "1");
  assert.equal(env.HOMEBREW_NO_INSTALL_CLEANUP, "1", "保留旧版本文件，正在运行的进程还要用");
  assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:7891", "开了启动代理时 brew 也走代理");
  assert.equal(f.holder.seenConfig.launch.proxy.port, 7891);
  let status = f.updater.status();
  assert.equal(status.phase, "waiting-restart");
  assert.deepEqual(status.pending, { version: "0.2.1" });
  await f.timer.advance(0);
  assert.deepEqual(f.restarts, [], "视频还在播，不能重启");
  await f.timer.advance(60_000);
  assert.deepEqual(f.restarts, []);
  await f.timer.advance(60_000);
  await until(() => f.restarts.length === 1, "播放结束后应重启一次");
  const saved = JSON.parse(await readFile(f.statePath, "utf8"));
  assert.equal(saved.pending.to, "0.2.1");
  assert.equal((await stat(f.statePath)).mode & 0o777, 0o600);
  status = f.updater.status();
  assert.equal(status.phase, "restarting");
});

test("重启后换上新版本：转成一次性「已更新」提示，确认后不再提示", async t => {
  const f = await fixture(t, { current: "0.2.1", latest: release("0.2.1"),
    state: { pending: { from: "0.2.0", to: "0.2.1", notes: "说明", at: 5 } } });
  const status = await f.updater.start();
  assert.deepEqual(status.notice, { from: "0.2.0", to: "0.2.1", notes: "说明" });
  assert.equal(status.pending, null);
  assert.equal((await f.updater.acknowledge()).notice, null);
  const saved = JSON.parse(await readFile(f.statePath, "utf8"));
  assert.equal(saved.installed.seen, true);
  assert.equal(saved.pending, null);
});

test("Formula 还没同步新版本：记录错误、不重启，下个周期再试", async t => {
  const f = await fixture(t, { installed: "0.2.0" });
  await f.updater.start();
  await f.timer.advance(120_000);
  await until(() => f.updater.status().error);
  await flush();
  const status = f.updater.status();
  assert.equal(status.phase, "idle");
  assert.equal(status.available, true);
  assert.match(status.error.message, /Homebrew 里还是 0\.2\.0/);
  assert.deepEqual(f.restarts, []);
  assert.deepEqual(f.timer.delays(), [6 * 3600_000]);
});

test("brew 失败只记录最后一行错误；HEAD 安装用 --fetch-HEAD", async t => {
  const failed = await fixture(t, { execFail: "update" });
  await failed.updater.start();
  await failed.timer.advance(120_000);
  await until(() => failed.updater.status().error);
  assert.equal(failed.updater.status().error.message, "更新失败：brew update 失败：Error: 网络不通");
  assert.equal(failed.execCalls.length, 1);
  const head = await fixture(t, { install: brewInstall({ head: true }) });
  await head.updater.start();
  await head.timer.advance(120_000);
  await until(() => head.execCalls.length === 2);
  assert.deepEqual(head.execCalls[1].args, ["upgrade", "--fetch-HEAD", "codex-companion"]);
  assert.equal(head.updater.status().command, "brew upgrade --fetch-HEAD codex-companion");
});

test("关闭自动更新只提醒；重新打开后立即安装已发现的新版本", async t => {
  const f = await fixture(t, { config: { updates: { auto: false } } });
  await f.updater.start();
  const checked = await f.updater.check({ manual: true });
  assert.equal(checked.available, true);
  assert.equal(checked.auto, false);
  assert.equal(checked.latest.version, "0.2.1");
  await flush();
  assert.deepEqual(f.execCalls, []);
  f.holder.config = { updates: { auto: true } };
  f.updater.applyConfig();
  assert.equal(f.updater.status().phase, "updating");
  await until(() => f.updater.status().phase === "waiting-restart");
  assert.equal(f.execCalls.length, 2);
});

test("源码安装只提醒并给出命令；不支持的安装方式拒绝 apply；检查失败保留上次结果", async t => {
  const f = await fixture(t, { install: { channel: "source", root: "/Users/me/codex companion" } });
  await f.updater.start();
  const status = await f.updater.check({ manual: true });
  assert.equal(status.available, true);
  assert.equal(status.canApply, false);
  assert.equal(status.command, 'cd "/Users/me/codex companion" && git pull && npm ci && npm start');
  await flush();
  assert.deepEqual(f.execCalls, []);
  assert.throws(() => f.updater.apply(), { code: "UPDATE_UNSUPPORTED" });
  f.holder.latest = new Error("getaddrinfo ENOTFOUND api.github.com");
  const failed = await f.updater.check({ manual: true });
  assert.equal(failed.latest.version, "0.2.1");
  assert.match(failed.error.message, /检查更新失败：getaddrinfo ENOTFOUND/);
  f.holder.latest = release("0.2.0");
  const current = await f.updater.check({ manual: true });
  assert.equal(current.available, false);
  assert.equal(current.error, null);
});

test("损坏的状态文件不影响启动；预发布等无效记录被丢弃", async t => {
  const f = await fixture(t, { state: { latest: { version: "1.0.0-beta" }, error: { message: 1 }, pending: { from: "x", to: "y" } } });
  const status = await f.updater.start();
  assert.equal(status.latest, null);
  assert.equal(status.error, null);
  assert.equal(status.pending, null);
  await writeFile(f.statePath, "{oops");
  const again = await fixture(t, { state: undefined });
  await writeFile(again.statePath, "{oops");
  assert.equal((await again.updater.start()).current, "0.2.0");
});
