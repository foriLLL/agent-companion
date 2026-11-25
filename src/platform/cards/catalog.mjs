import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { companionDataDir } from "../paths.mjs";
import { CARD_API_VERSION, compareManifests, validateManifest } from "../registry/manifest.mjs";

/**
 * 卡片目录：平台在运行时从磁盘发现卡片，内置卡片与用户安装的卡片是同一种包。
 *
 * 一张卡片是一个目录（目录名即 manifest id）：
 *   manifest.json   必需，见 platform/registry/manifest.mjs
 *   renderer.js     必需，页面里运行的卡片界面；由 renderer.mjs 经 `agent-companion cards build` 打包
 *   service.mjs     可选，后台服务；导出 createService(api)，只能 import 自身目录里的文件与 node: 内置模块
 *
 * 发现顺序：内置目录 → 用户目录（数据目录下的 cards/）。用户目录里与内置卡片同 id 的卡片覆盖内置版本，
 * 方便用户 fork 一张内置卡片自己改。用户安装的卡片一律缺省关闭，由用户在设置里打开。
 * 有问题的卡片（manifest 不合法、面向更新的平台接口、缺少 renderer.js）不加载，记在 problems 里。
 */

export const RENDERER_BUNDLE = "renderer.js";
export const RENDERER_SOURCE = "renderer.mjs";
export const SERVICE_ENTRY = "service.mjs";
export const MANIFEST_FILE = "manifest.json";
// 注入页面的卡片界面上限；超过多半是把不该打包的东西打了进去。
export const MAX_RENDERER_BYTES = 16 * 1024 * 1024;

export function builtinCardsDir({ env = process.env, execPath = process.execPath, moduleUrl = import.meta.url } = {}) {
  if (env.AGENT_COMPANION_BUILTIN_CARDS) return env.AGENT_COMPANION_BUILTIN_CARDS;
  // bun --compile 的单文件后端：模块位于虚拟文件系统，内置卡片随包放在可执行文件同级的 cards/。
  if (/\$bunfs|~BUN/.test(moduleUrl)) return join(dirname(execPath), "cards");
  return fileURLToPath(new URL("../../../cards/", moduleUrl));
}

export function userCardsDir({ dataDir, env = process.env, ...options } = {}) {
  if (env.AGENT_COMPANION_CARDS_DIR) return env.AGENT_COMPANION_CARDS_DIR;
  return join(dataDir ?? companionDataDir(undefined, { env, ...options }), "cards");
}

export function defaultCardRoots(options = {}) {
  return [
    { dir: builtinCardsDir(options), source: "builtin" },
    { dir: userCardsDir(options), source: "user" }
  ];
}

class CardProblem extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function fileInfo(path) {
  try {
    const info = await stat(path);
    return info.isFile() ? info : null;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

/** 读取并校验一个卡片目录。失败时抛出带 code 的 CardProblem。 */
export async function readCardPackage(dir, { source = "user", expectedId = basename(dir) } = {}) {
  let text;
  try { text = await readFile(join(dir, MANIFEST_FILE), "utf8"); } catch (error) {
    if (error?.code === "ENOENT") throw new CardProblem("MISSING_MANIFEST", "缺少 manifest.json");
    throw new CardProblem("MANIFEST_UNREADABLE", `无法读取 manifest.json：${error.message}`);
  }
  let json;
  try { json = JSON.parse(text); } catch (error) {
    throw new CardProblem("INVALID_JSON", `manifest.json 不是合法 JSON：${error.message}`);
  }
  let manifest;
  try { manifest = validateManifest(json); } catch (error) {
    throw new CardProblem("INVALID_MANIFEST", `manifest.json 无效：${error.message}`);
  }
  if (expectedId !== null && manifest.id !== expectedId) {
    throw new CardProblem("ID_DIRECTORY_MISMATCH", `目录名 ${expectedId} 与 manifest id "${manifest.id}" 不一致`);
  }
  const apiVersion = manifest.apiVersion ?? 1;
  if (apiVersion > CARD_API_VERSION) {
    throw new CardProblem("API_TOO_NEW", `卡片需要平台接口 v${apiVersion}，当前为 v${CARD_API_VERSION}，请先更新 Agent Companion`);
  }
  const rendererPath = join(dir, RENDERER_BUNDLE);
  const rendererInfo = await fileInfo(rendererPath);
  if (!rendererInfo) {
    const hasSource = Boolean(await fileInfo(join(dir, RENDERER_SOURCE)));
    throw new CardProblem("MISSING_RENDERER", hasSource
      ? "缺少 renderer.js，请先运行 agent-companion cards build 打包 renderer.mjs"
      : "缺少 renderer.js");
  }
  if (rendererInfo.size > MAX_RENDERER_BYTES) throw new CardProblem("RENDERER_TOO_LARGE", "renderer.js 超过 16 MiB");
  const code = await readFile(rendererPath, "utf8");
  const servicePath = join(dir, SERVICE_ENTRY);
  const serviceInfo = await fileInfo(servicePath);
  return {
    id: manifest.id, dir, source, manifest,
    renderer: { path: rendererPath, code, hash: createHash("sha256").update(code).digest("hex"), bytes: rendererInfo.size },
    service: serviceInfo ? { path: servicePath, mtimeMs: serviceInfo.mtimeMs } : null
  };
}

// 目录指纹：只看各卡片目录里三个入口文件的大小与修改时间，用于便宜地判断是否需要重新读取。
async function rootFingerprint(root) {
  let entries;
  try { entries = await readdir(root.dir, { withFileTypes: true }); } catch (error) {
    if (error?.code === "ENOENT") return `${root.dir}:-`;
    throw error;
  }
  const parts = [root.dir];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    if (entry.name.startsWith(".") || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
    const dir = join(root.dir, entry.name);
    const files = [];
    for (const name of [MANIFEST_FILE, RENDERER_BUNDLE, SERVICE_ENTRY]) {
      const info = await fileInfo(join(dir, name)).catch(() => null);
      files.push(info ? `${info.size}:${info.mtimeMs}` : "-");
    }
    parts.push(`${entry.name}=${files.join(",")}`);
  }
  return parts.join("|");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export class CardCatalog {
  #roots;
  #logger;
  #cards = new Map();
  #problems = [];
  #fingerprint = null;
  #services = new Map();
  #listeners = new Set();

  /** roots：[{ dir, source }]，靠后的覆盖靠前的同 id 卡片；缺省为内置目录 + 用户目录。 */
  constructor({ roots = defaultCardRoots(), logger = console } = {}) {
    this.#roots = roots.map((root) => Object.freeze({ dir: root.dir, source: root.source ?? "user" }));
    this.#logger = logger;
  }

  get roots() { return this.#roots; }
  get fingerprint() { return this.#fingerprint; }
  get problems() { return [...this.#problems]; }

  /** 重新读取全部卡片；返回目录内容是否变化。 */
  async load() {
    const fingerprint = (await Promise.all(this.#roots.map(rootFingerprint))).join("\n");
    const cards = new Map();
    const problems = [];
    for (const root of this.#roots) {
      let entries;
      try { entries = await readdir(root.dir, { withFileTypes: true }); } catch (error) {
        if (error?.code !== "ENOENT") problems.push({ dir: root.dir, source: root.source, code: "CARDS_DIR_UNREADABLE", message: error.message });
        continue;
      }
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
        if (entry.name.startsWith(".") || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
        const dir = join(root.dir, entry.name);
        try {
          if (entry.isSymbolicLink() && !(await stat(dir)).isDirectory()) continue;
          const card = await readCardPackage(dir, { source: root.source });
          const linked = (await lstat(dir)).isSymbolicLink() ? await realpath(dir) : null;
          const previous = cards.get(card.id);
          cards.set(card.id, { ...card, linked, overrides: previous ? previous.source : null });
        } catch (error) {
          if (!(error instanceof CardProblem) && error?.code !== "ENOENT") throw error;
          problems.push({ dir, source: root.source, id: entry.name, code: error.code ?? "UNREADABLE", message: error.message });
        }
      }
    }
    const changed = fingerprint !== this.#fingerprint;
    this.#cards = new Map([...cards.values()].sort((left, right) => compareManifests(left.manifest, right.manifest)).map((card) => [card.id, card]));
    this.#problems = problems;
    this.#fingerprint = fingerprint;
    for (const problem of problems) this.#logger.warn?.(`[agent-companion] 卡片 ${problem.id ?? problem.dir} 未加载：${problem.message}`);
    return changed;
  }

  /**
   * 目录指纹变化时才重新读取，并通知订阅者；返回是否变化。
   * 常驻进程定期调用，用来发现安装、卸载、更新与开发中的改动。
   */
  async refresh() {
    const fingerprint = (await Promise.all(this.#roots.map(rootFingerprint))).join("\n");
    if (fingerprint === this.#fingerprint) return false;
    await this.load();
    await Promise.allSettled([...this.#listeners].map((listener) => Promise.resolve().then(() => listener(this))));
    return true;
  }

  /** 订阅目录变化；返回取消订阅的函数。 */
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  list() { return [...this.#cards.values()]; }
  get(id) { return this.#cards.get(id) ?? null; }
  has(id) { return this.#cards.has(id); }
  isBuiltin(id) { return this.#cards.get(id)?.source === "builtin"; }

  /** 某个宿主里出现的卡片 manifest；用户安装的卡片缺省关闭。 */
  manifests(host) {
    return this.list()
      .filter(({ manifest }) => !host || !manifest.hosts || manifest.hosts.includes(host))
      .map(({ manifest, source }) => (source === "builtin" || !manifest.defaultEnabled ? manifest : Object.freeze({ ...manifest, defaultEnabled: false })));
  }

  /** 某个宿主里全部卡片的签名：manifest 或界面代码变化时变化，用作注入产物身份的一部分。 */
  signature(host) {
    const cards = this.manifests(host).map((manifest) => [manifest, this.#cards.get(manifest.id).renderer.hash]);
    return createHash("sha256").update(canonicalJson(cards)).digest("hex");
  }

  renderer(id) {
    const card = this.#cards.get(id);
    return card ? { id, hash: card.renderer.hash, code: card.renderer.code } : null;
  }

  /** 加载卡片后台服务模块。service.mjs 改动后（修改时间变化）重新 import 入口文件。 */
  async importService(id) {
    const card = this.#cards.get(id);
    if (!card?.service) return null;
    const key = `${card.service.path}#${card.service.mtimeMs}`;
    let loading = this.#services.get(id);
    if (loading?.key !== key) {
      const url = pathToFileURL(card.service.path);
      url.search = `v=${Math.trunc(card.service.mtimeMs)}`;
      loading = { key, promise: import(url.href) };
      this.#services.set(id, loading);
      loading.promise.catch(() => { if (this.#services.get(id) === loading) this.#services.delete(id); });
    }
    return loading.promise;
  }
}
