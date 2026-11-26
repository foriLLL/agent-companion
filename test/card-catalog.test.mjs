import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { AgentCompanionService } from "../src/agent-companion-service.mjs";
import { CardCatalog, builtinCardsDir, userCardsDir } from "../src/platform/cards/catalog.mjs";
import { installCard, linkCard, parseCardSource, readInstallRecords, removeCard, updateCard } from "../src/platform/cards/manage.mjs";
import { CARD_API_VERSION } from "../src/platform/registry/manifest.mjs";
import { cardsArtifact } from "../src/agent/session.mjs";
import { cardDefineSource } from "../src/injection.mjs";
import { parseCardsArgs, runCardsCommand } from "../src/cards-command.mjs";

const execute = promisify(execFile);
const quiet = { warn() {}, info() {} };

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), "companion-cards-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function manifest(id, extra = {}) {
  return {
    id, title: id.toUpperCase(), version: 1, defaultEnabled: true, defaultOrder: 10,
    layout: { height: "content", minHeight: 0, scroll: "outer" },
    lifecycle: { hidden: "retain", start: "first-visible" },
    state: { scope: "target", version: 1 }, capabilities: ["rpc"], ...extra
  };
}

// 一张最小的卡片包：manifest + 打包好的 renderer.js（+ 可选 service.mjs）。
async function writeCard(root, id, { extra, renderer = `__companionDefine({ mount() { return {}; }, marker: ${JSON.stringify(id)} });`, service } = {}) {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest(id, extra)));
  if (renderer !== null) await writeFile(join(dir, "renderer.js"), renderer);
  if (service) await writeFile(join(dir, "service.mjs"), service);
  return dir;
}

test("卡片目录：内置 + 用户目录，用户卡片缺省关闭、可覆盖内置版本；有问题的卡片跳过并记录原因", async t => {
  const root = await temporary(t);
  const builtin = join(root, "builtin"), user = join(root, "user");
  await writeCard(builtin, "alpha");
  await writeCard(builtin, "beta", { extra: { hosts: ["codex"] } });
  await writeCard(user, "beta", { extra: { title: "我的 Beta" } });
  await writeCard(user, "gamma");
  await writeCard(user, "future", { extra: { apiVersion: CARD_API_VERSION + 1 } });
  await writeCard(user, "nobundle", { renderer: null });
  await writeFile(join(user, "nobundle", "renderer.mjs"), "export function mount() {}");
  await writeCard(user, "wrongdir");
  await writeFile(join(user, "wrongdir", "manifest.json"), JSON.stringify(manifest("other")));
  await mkdir(join(user, ".staging-x"), { recursive: true });
  await writeFile(join(user, ".installs.json"), "{}");
  const catalog = new CardCatalog({ roots: [{ dir: builtin, source: "builtin" }, { dir: user, source: "user" }], logger: quiet });
  await catalog.load();
  assert.deepEqual(catalog.list().map(card => [card.id, card.source, card.overrides]), [["alpha", "builtin", null], ["beta", "user", "builtin"], ["gamma", "user", null]]);
  assert.equal(catalog.get("beta").manifest.title, "我的 Beta");
  assert.deepEqual(catalog.manifests().map(m => [m.id, m.defaultEnabled]), [["alpha", true], ["beta", false], ["gamma", false]]);
  assert.deepEqual(catalog.manifests("antigravity").map(m => m.id), ["alpha", "beta", "gamma"], "用户版本没写 hosts，按全部宿主");
  assert.deepEqual(catalog.problems.map(p => [p.id, p.code]).sort(), [["future", "API_TOO_NEW"], ["nobundle", "MISSING_RENDERER"], ["wrongdir", "ID_DIRECTORY_MISMATCH"]]);
  assert.match(catalog.problems.find(p => p.id === "nobundle").message, /cards build/);
  assert.equal(catalog.isBuiltin("alpha"), true);
  assert.equal(catalog.isBuiltin("beta"), false);
  assert.equal(catalog.renderer("alpha").hash.length, 64);
});

test("卡片目录：refresh 只在入口文件变化时重读并通知订阅者，签名随界面代码变化", async t => {
  const root = await temporary(t);
  await writeCard(root, "alpha");
  const catalog = new CardCatalog({ roots: [{ dir: root, source: "user" }], logger: quiet });
  await catalog.load();
  const before = catalog.signature("codex");
  let notified = 0;
  const unsubscribe = catalog.subscribe(() => { notified++; });
  assert.equal(await catalog.refresh(), false);
  await writeFile(join(root, "alpha", "renderer.js"), "__companionDefine({ mount() { return { v: 2 }; } });");
  const later = new Date(Date.now() + 5000);
  await utimes(join(root, "alpha", "renderer.js"), later, later);
  assert.equal(await catalog.refresh(), true);
  assert.equal(notified, 1);
  assert.notEqual(catalog.signature("codex"), before);
  await writeCard(root, "beta");
  assert.equal(await catalog.refresh(), true);
  assert.deepEqual(catalog.list().map(card => card.id), ["alpha", "beta"]);
  unsubscribe();
  await rm(join(root, "beta"), { recursive: true });
  assert.equal(await catalog.refresh(), true);
  assert.equal(notified, 2, "取消订阅后不再通知");
  assert.deepEqual(catalog.list().map(card => card.id), ["alpha"]);
});

test("注入产物：界面代码包在平台的登记函数里，卡片看不到页面全局", async t => {
  const root = await temporary(t);
  await writeCard(root, "alpha", { renderer: "__companionDefine({ mount() {}, seen: typeof __AGENT_COMPANION_RENDERER__ });" });
  const catalog = new CardCatalog({ roots: [{ dir: root, source: "builtin" }], logger: quiet });
  await catalog.load();
  const artifact = cardsArtifact(catalog, "codex");
  assert.deepEqual(artifact.manifests.map(m => m.id), ["alpha"]);
  const calls = [];
  const fake = { register: (...args) => (calls.push(["register", ...args]), { status: "registered" }), defineCard: (...args) => (calls.push(["define", ...args]), { status: "defined" }) };
  const result = new Function("globalThis", `return ${cardDefineSource(artifact.renderers.get("alpha"))};`)({ __AGENT_COMPANION_RENDERER__: fake });
  assert.deepEqual(result, { status: "defined" });
  assert.equal(calls[0][0], "define");
  assert.equal(calls[0][1], "alpha");
  assert.equal(calls[0][2], catalog.renderer("alpha").hash);
  assert.equal(typeof calls[0][3].mount, "function");
});

test("用户卡片的后台服务只在启用后才加载；内置卡片随启动加载；卸载后撤下", async t => {
  const root = await temporary(t);
  const builtin = join(root, "builtin"), user = join(root, "user");
  const counter = `globalThis.__cardLoads = (globalThis.__cardLoads ?? 0) + 1;`;
  await writeCard(builtin, "alpha", { service: `export function createService(api) { return { methods: { who: () => ({ id: api.card.id, dataDir: api.card.dataDir, api: api.apiVersion }) } }; }` });
  await writeCard(user, "plugin", { service: `${counter}\nexport function createService() { return { methods: { ping: () => "pong" }, dispose() { globalThis.__pluginDisposed = true; } }; }` });
  const catalog = new CardCatalog({ roots: [{ dir: builtin, source: "builtin" }, { dir: user, source: "user" }], logger: quiet });
  await catalog.load();
  let config = { enabled: true, cards: {} };
  const service = new AgentCompanionService({ cards: catalog, configStore: { loadV2: async () => config }, logger: quiet });
  t.after(() => service.dispose());
  await service.syncCards(config);
  const context = card => ({ cardId: card, generation: 1, targetId: "t", executionContextId: 1 });
  const who = await service.handleRpc("alpha.who", {}, context("alpha"));
  assert.equal(who.id, "alpha");
  assert.equal(who.api, CARD_API_VERSION);
  assert.match(who.dataDir, /card-data[\\/]alpha$/);
  assert.equal(globalThis.__cardLoads, undefined, "关闭的插件不 import");
  await assert.rejects(service.handleRpc("plugin.ping", {}, context("plugin")), { code: "RPC_METHOD_NOT_FOUND" });
  assert.equal(globalThis.__cardLoads, undefined);
  assert.deepEqual(service.catalog.map(card => [card.id, card.source, card.defaultEnabled]), [["alpha", "builtin", true], ["plugin", "user", false]]);
  config = { enabled: true, cards: { plugin: { enabled: true, settings: {} } } };
  assert.equal(await service.handleRpc("plugin.ping", {}, context("plugin")), "pong", "启用后第一次调用时加载");
  assert.equal(globalThis.__cardLoads, 1);
  await service.applyConfig(config);
  assert.equal(globalThis.__cardLoads, 1, "只加载一次");
  await rm(join(user, "plugin"), { recursive: true });
  await catalog.refresh();
  await service.syncCards(config);
  assert.equal(globalThis.__pluginDisposed, true, "卸载后撤下服务");
  await assert.rejects(service.handleRpc("plugin.ping", {}, context("plugin")), { code: "RPC_METHOD_NOT_FOUND" });
  delete globalThis.__cardLoads;
  delete globalThis.__pluginDisposed;
});

test("安装来源：owner/repo[@ref]、git 地址与本地目录", async t => {
  const root = await temporary(t);
  assert.deepEqual(await parseCardSource("someone/agent-companion-card-x"), { kind: "git", url: "https://github.com/someone/agent-companion-card-x.git", ref: null });
  assert.deepEqual(await parseCardSource("someone/x@v1.2.0"), { kind: "git", url: "https://github.com/someone/x.git", ref: "v1.2.0" });
  assert.deepEqual(await parseCardSource("https://example.com/x.git", { ref: "main" }), { kind: "git", url: "https://example.com/x.git", ref: "main" });
  assert.deepEqual(await parseCardSource(".", { cwd: root }), { kind: "path", path: root });
  await assert.rejects(parseCardSource("http://example.com/x.git"), { code: "INVALID_SOURCE" });
  await assert.rejects(parseCardSource("./missing", { cwd: root }), { code: "INVALID_SOURCE" });
  await assert.rejects(parseCardSource("someone/x@a", { ref: "b" }), { code: "INVALID_SOURCE" });
});

test("安装 / 覆盖 / 更新 / 卸载本地卡片；内置卡片不能卸载，同 id 的用户卡片卸载后恢复内置版本", async t => {
  const root = await temporary(t);
  const source = await writeCard(join(root, "src"), "hello");
  await mkdir(join(source, "node_modules", "dep"), { recursive: true });
  const userDir = join(root, "user");
  const installed = await installCard({ source: source, userDir, builtinIds: ["tasks"], now: () => new Date(0) });
  assert.equal(installed.id, "hello");
  assert.equal(installed.replaced, false);
  assert.equal(await readFile(join(userDir, "hello", "renderer.js"), "utf8"), await readFile(join(source, "renderer.js"), "utf8"));
  await assert.rejects(readFile(join(userDir, "hello", "node_modules", "dep")), { code: "ENOENT" }, "不复制 node_modules");
  assert.deepEqual(await readInstallRecords(userDir), { hello: { source, kind: "path", installedAt: "1970-01-01T00:00:00.000Z" } });
  await assert.rejects(installCard({ source, userDir }), { code: "ALREADY_INSTALLED" });
  await writeFile(join(source, "renderer.js"), "__companionDefine({ mount() {}, v: 2 });");
  const updated = await updateCard({ id: "hello", userDir });
  assert.equal(updated.replaced, true);
  assert.match(await readFile(join(userDir, "hello", "renderer.js"), "utf8"), /v: 2/);
  await mkdir(join(root, "data", "card-data", "hello"), { recursive: true });
  const removed = await removeCard({ id: "hello", userDir, dataRoot: join(root, "data"), purgeData: true });
  assert.equal(removed.linked, false);
  await assert.rejects(readFile(join(userDir, "hello", "manifest.json")), { code: "ENOENT" });
  await assert.rejects(readFile(join(root, "data", "card-data", "hello")), { code: "ENOENT" });
  assert.deepEqual(await readInstallRecords(userDir), {});
  await assert.rejects(removeCard({ id: "tasks", userDir, builtinIds: ["tasks"] }), { code: "BUILTIN" });
  const override = await writeCard(join(root, "fork"), "tasks");
  assert.equal((await installCard({ source: override, userDir, builtinIds: ["tasks"] })).overridesBuiltin, true);
  assert.equal((await removeCard({ id: "tasks", userDir, builtinIds: ["tasks"] })).restoresBuiltin, true);
  const broken = await writeCard(join(root, "broken"), "broken", { renderer: null });
  await assert.rejects(installCard({ source: broken, userDir }), { code: "MISSING_RENDERER" });
  await writeFile(join(broken, "renderer.mjs"), "export function mount() {}");
  await assert.rejects(installCard({ source: broken, userDir, build: async () => { throw Object.assign(new Error("no bun"), { code: "BUNDLER_UNAVAILABLE" }); } }), { code: "BUNDLER_UNAVAILABLE" });
  let built = 0;
  await installCard({ source: broken, userDir, build: async ({ dir }) => { built++; await writeFile(join(dir, "renderer.js"), "__companionDefine({ mount() {} });"); } });
  assert.equal(built, 1, "只有源码时安装前先打包");
});

test("开发链接：符号链接进用户目录，卡片目录读到原目录的改动；卸载只删链接", async t => {
  const root = await temporary(t);
  const source = await writeCard(join(root, "dev"), "devcard");
  const userDir = join(root, "user");
  const linked = await linkCard({ dir: source, userDir });
  assert.equal(linked.id, "devcard");
  const catalog = new CardCatalog({ roots: [{ dir: userDir, source: "user" }], logger: quiet });
  await catalog.load();
  assert.ok(catalog.get("devcard").linked.endsWith("devcard"));
  assert.equal((await updateCard({ id: "devcard", userDir })).skipped, "linked");
  assert.equal((await removeCard({ id: "devcard", userDir })).linked, true);
  assert.ok(await readFile(join(source, "manifest.json"), "utf8"), "原目录保留");
});

test("从 git 仓库安装：固定 tag 时更新仍停在该 tag，跟随默认分支时更新到最新提交", async t => {
  const root = await temporary(t);
  const repo = await writeCard(join(root, "repo"), "gitcard");
  const git = (...args) => execute("git", args, { cwd: repo });
  try { await git("init", "-q", "-b", "main"); } catch { t.skip("没有 git"); return; }
  await git("add", "-A");
  await git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "one");
  await git("tag", "v1");
  const userDir = join(root, "user");
  const url = pathToFileURL(repo).href;
  const pinned = await installCard({ source: url, ref: "v1", userDir });
  await writeFile(join(repo, "renderer.js"), "__companionDefine({ mount() {}, v: 2 });");
  await git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "two");
  const stay = await updateCard({ id: "gitcard", userDir });
  assert.equal(stay.commit, pinned.commit, "固定 tag 不跟随新提交");
  const latest = await updateCard({ id: "gitcard", ref: "main", userDir });
  assert.notEqual(latest.commit, pinned.commit);
  assert.match(await readFile(join(userDir, "gitcard", "renderer.js"), "utf8"), /v: 2/);
  assert.equal((await readInstallRecords(userDir)).gitcard.ref, "main");
  await assert.rejects(readFile(join(userDir, "gitcard", ".git", "HEAD")), { code: "ENOENT" }, "不保留 .git");
});

test("cards 命令：参数解析、JSON 列表保持 manifest 数组形状、内置目录与用户目录位置", async t => {
  assert.deepEqual(parseCardsArgs([]), { subcommand: "list", args: [] });
  assert.deepEqual(parseCardsArgs(["install", "a/b", "--ref", "v1", "--force"]), { subcommand: "install", args: ["a/b"], ref: "v1", force: true });
  assert.throws(() => parseCardsArgs(["install"]), /参数个数/);
  assert.throws(() => parseCardsArgs(["remove", "x", "--bogus"]), /不支持参数/);
  assert.throws(() => parseCardsArgs(["nuke"]), /子命令无效/);
  const root = await temporary(t);
  await writeCard(join(root, "builtin"), "alpha");
  await writeCard(join(root, "user"), "plugin");
  const lines = [];
  const manifests = await runCardsCommand(["list", "--json"], {
    builtinDir: join(root, "builtin"), userDir: join(root, "user"), home: root, env: {}, isTTY: false,
    configStore: { loadV2: async () => ({ cards: { plugin: { enabled: true } } }) }, out: { log: line => lines.push(line), error() {} }
  });
  assert.deepEqual(manifests.map(m => m.id), ["alpha", "plugin"]);
  const listed = JSON.parse(lines[0]);
  assert.deepEqual(listed.map(item => [item.id, item.title, item.defaultEnabled, item.source, item.enabled]),
    [["alpha", "ALPHA", true, "builtin", true], ["plugin", "PLUGIN", false, "user", true]]);
  assert.equal(userCardsDir({ dataDir: "/data", env: {} }), join("/data", "cards"));
  assert.equal(userCardsDir({ dataDir: "/data", env: { AGENT_COMPANION_CARDS_DIR: "/elsewhere" } }), "/elsewhere");
  assert.match(builtinCardsDir({ env: {} }), /cards[\\/]?$/);
  assert.equal(builtinCardsDir({ env: {}, execPath: "/App/Resources/agent-companion", moduleUrl: "file:///$bunfs/root/agent-companion" }), join("/App/Resources", "cards"));
});

// 设置页卸载用的配置存储：按 revision 合并卡片开关，记下每次补丁。
function memoryConfig(cards) {
  const store = { patches: [], config: { version: 2, revision: 3, enabled: true, cards } };
  store.loadV2 = async () => store.config;
  store.patch = async (patch, { expectedRevision }) => {
    if (expectedRevision !== store.config.revision) throw Object.assign(new Error("conflict"), { code: "CONFIG_CONFLICT" });
    store.patches.push(patch);
    const next = { ...store.config.cards };
    for (const [id, card] of Object.entries(patch.cards ?? {})) next[id] = { ...next[id], ...card };
    store.config = { ...store.config, revision: expectedRevision + 1, cards: next };
    return store.config;
  };
  return store;
}

test("设置页卸载插件：列出来源；卸载删除目录、可选删除数据、关掉开关并立即撤下服务；内置卡片拒绝", async t => {
  const root = await temporary(t);
  const builtin = join(root, "builtin"), user = join(root, "user"), dataRoot = join(root, "data");
  await writeCard(builtin, "alpha");
  await writeCard(builtin, "beta");
  await writeCard(user, "beta", { extra: { title: "我的 Beta" } });
  await writeCard(user, "plugin", { service: "export function createService() { return { methods: { ping: () => \"pong\" }, dispose() { globalThis.__removedPluginDisposed = true; } }; }" });
  const source = await writeCard(join(root, "src"), "linked");
  await symlink(source, join(user, "linked"), "junction");
  await writeFile(join(user, ".installs.json"), JSON.stringify({ plugin: { source: "https://github.com/someone/agent-companion-card-plugin.git", kind: "git", ref: "v1.0.0" } }));
  await mkdir(join(dataRoot, "card-data", "plugin"), { recursive: true });
  await writeFile(join(dataRoot, "card-data", "plugin", "state.json"), "{}");
  const catalog = new CardCatalog({ roots: [{ dir: builtin, source: "builtin" }, { dir: user, source: "user" }], logger: quiet });
  await catalog.load();
  const configStore = memoryConfig({ plugin: { enabled: true, settings: { keep: 1 } }, beta: { enabled: true, settings: {} } });
  const service = new AgentCompanionService({ cards: catalog, configStore, dataRoot, logger: quiet });
  t.after(() => service.dispose());
  await service.syncCards(configStore.config);
  const platform = { cardId: "companion" };
  const call = (method, params) => service.handleRpc(method, params, { ...platform });
  assert.equal(await service.handleRpc("plugin.ping", {}, { cardId: "plugin", generation: 1, targetId: "t", executionContextId: 1 }), "pong");

  const { catalog: entries } = await call("companion.settings.get", {});
  const plugins = Object.fromEntries(entries.filter(entry => entry.source === "user").map(entry => [entry.id, entry.plugin]));
  assert.deepEqual(plugins.plugin, { kind: "git", from: "someone/agent-companion-card-plugin@v1.0.0", overridesBuiltin: false });
  assert.deepEqual(plugins.beta, { kind: "manual", from: null, overridesBuiltin: true });
  assert.equal(plugins.linked.kind, "link");
  assert.equal(entries.find(entry => entry.id === "alpha").plugin, undefined, "内置卡片不带插件来源");

  await assert.rejects(call("companion.cards.remove", { id: "alpha" }), { code: "BUILTIN" });
  await assert.rejects(call("companion.cards.remove", { id: "missing" }), { code: "NOT_INSTALLED" });
  for (const params of [{ id: "../alpha" }, { id: "plugin", purgeData: "yes" }, { id: "plugin", force: true }, {}]) {
    await assert.rejects(call("companion.cards.remove", params), { code: "RPC_INVALID_PARAMS" });
  }
  assert.equal(configStore.patches.length, 0, "被拒绝的请求不改配置");

  const changes = [];
  catalog.subscribe(() => changes.push(catalog.list().map(card => card.id)));
  assert.deepEqual(await call("companion.cards.remove", { id: "plugin", purgeData: true }),
    { id: "plugin", title: "PLUGIN", linked: false, restoresBuiltin: false, purged: true });
  await assert.rejects(lstat(join(user, "plugin")), { code: "ENOENT" });
  await assert.rejects(lstat(join(dataRoot, "card-data", "plugin")), { code: "ENOENT" });
  assert.deepEqual(await readInstallRecords(user), {});
  assert.deepEqual(configStore.patches, [{ cards: { plugin: { enabled: false } } }], "重新安装时仍然缺省关闭");
  assert.deepEqual(configStore.config.cards.plugin.settings, { keep: 1 });
  assert.equal(changes.length, 1, "立即刷新卡片目录");
  assert.equal(catalog.has("plugin"), false);
  assert.equal(globalThis.__removedPluginDisposed, true, "返回前已撤下服务");
  await assert.rejects(service.handleRpc("plugin.ping", {}, { cardId: "plugin", generation: 1, targetId: "t", executionContextId: 1 }), { code: "RPC_METHOD_NOT_FOUND" });
  delete globalThis.__removedPluginDisposed;

  // 覆盖内置版本的卡片：卸载后恢复内置版本，开关属于内置卡片，不动。
  assert.equal((await call("companion.cards.remove", { id: "beta" })).restoresBuiltin, true);
  assert.equal(catalog.get("beta").source, "builtin");
  assert.equal(configStore.config.cards.beta.enabled, true);
  // 开发链接只删链接，源码目录保留。
  assert.equal((await call("companion.cards.remove", { id: "linked" })).linked, true);
  assert.ok((await lstat(join(source, "manifest.json"))).isFile());
  assert.equal(configStore.patches.length, 1);
  assert.deepEqual((await call("companion.settings.get", {})).catalog.map(entry => [entry.id, entry.source]), [["alpha", "builtin"], ["beta", "builtin"]]);
});

test("卸载后关开关遇到配置冲突会重读重试；没有开着的卡片不写配置", async t => {
  const root = await temporary(t);
  const user = join(root, "user");
  await writeCard(user, "plugin");
  await writeCard(user, "quiet");
  const catalog = new CardCatalog({ roots: [{ dir: user, source: "user" }], logger: quiet });
  await catalog.load();
  const configStore = memoryConfig({ plugin: { enabled: true, settings: {} } });
  const patch = configStore.patch;
  let conflicts = 1;
  configStore.patch = async (value, options) => {
    if (conflicts-- > 0) {
      configStore.config = { ...configStore.config, revision: configStore.config.revision + 1 };
      throw Object.assign(new Error("conflict"), { code: "CONFIG_CONFLICT" });
    }
    return patch(value, options);
  };
  const service = new AgentCompanionService({ cards: catalog, configStore, dataRoot: join(root, "data"), logger: quiet });
  t.after(() => service.dispose());
  await service.handleRpc("companion.cards.remove", { id: "plugin" }, { cardId: "companion" });
  assert.equal(configStore.config.cards.plugin.enabled, false);
  await service.handleRpc("companion.cards.remove", { id: "quiet" }, { cardId: "companion" });
  assert.equal(configStore.patches.length, 1);
});
