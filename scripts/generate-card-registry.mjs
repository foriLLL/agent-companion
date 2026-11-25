import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { discoverCards } from "../src/platform/registry/discovery.mjs";

/**
 * 生成内置卡片的 manifest 快照 card-registry.mjs（CARD_MANIFESTS）。
 *
 *   node scripts/generate-card-registry.mjs
 *     [--cards-dir <dir>] [--out-dir <dir>] [--require-entries]
 *
 * --cards-dir  默认 <repo>/cards
 * --out-dir    默认 <repo>/src，其下写出 card-registry.mjs
 * --require-entries  每张卡必须已有 renderer.mjs。默认关闭（metadata-only）。
 *
 * 运行时不靠这份快照加载卡片：平台从卡片目录发现内置与用户安装的卡片（src/platform/cards/catalog.mjs），
 * 界面代码与后台服务都从卡片自己的目录读取。快照只作为没有卡片目录时的缺省值（一次性命令、测试）。
 * 产物不含时间戳与绝对路径。
 */

const VALIDATOR_PATH = fileURLToPath(new URL("../src/platform/registry/manifest.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashCatalog(cards) {
  return createHash("sha256").update(canonicalJson(cards)).digest("hex");
}

function realpathExisting(path) {
  try {
    return realpathSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return join(realpathSync(dirname(path)), basename(path));
  }
}

function catalogCard(card) {
  const manifest = card.manifest;
  return {
    id: manifest.id,
    title: manifest.title,
    version: manifest.version,
    defaultEnabled: manifest.defaultEnabled,
    defaultOrder: manifest.defaultOrder,
    layout: {
      height: manifest.layout.height,
      minHeight: manifest.layout.minHeight,
      scroll: manifest.layout.scroll
    },
    lifecycle: {
      hidden: manifest.lifecycle.hidden,
      start: manifest.lifecycle.start
    },
    state: {
      scope: manifest.state.scope,
      version: manifest.state.version
    },
    capabilities: [...manifest.capabilities],
    ...(manifest.hosts ? { hosts: [...manifest.hosts] } : {}),
    ...(manifest.apiVersion ? { apiVersion: manifest.apiVersion } : {}),
    ...(manifest.description ? { description: manifest.description } : {}),
    ...(manifest.homepage ? { homepage: manifest.homepage } : {}),
    entries: {
      renderer: card.entries.renderer,
      service: card.entries.service
    }
  };
}

function manifestRecord(card) {
  const record = catalogCard(card);
  delete record.entries;
  return record;
}

function renderCardRegistry({ cards, hash, fromFile }) {
  const raw = relative(dirname(realpathExisting(fromFile)), realpathExisting(VALIDATOR_PATH));
  const specifier = isAbsolute(raw) ? pathToFileURL(VALIDATOR_PATH).href : raw.split(sep).join("/").replace(/^(?!\.)/, "./");
  const manifests = cards.map((card) => manifestRecord(card));
  return [
    "// 由 scripts/generate-card-registry.mjs 生成。请勿手改。",
    "// 内置卡片的 manifest 快照：运行时从卡片目录发现卡片，这里只作缺省值（一次性命令、测试）。",
    `import { validateCatalog } from ${JSON.stringify(specifier)};`,
    "",
    `export const CARD_REGISTRY_HASH = ${JSON.stringify(hash)};`,
    "",
    `export const CARD_MANIFESTS = validateCatalog(${JSON.stringify(manifests, null, 2)});`,
    "",
    "const CARD_MANIFESTS_BY_ID = new Map(CARD_MANIFESTS.map((manifest) => [manifest.id, manifest]));",
    "",
    "export function getCardManifest(id) {",
    "  return CARD_MANIFESTS_BY_ID.get(id) ?? null;",
    "}",
    ""
  ].join("\n");
}

/**
 * @param {{ cardsDir: string, outDir: string, requireEntries?: boolean }} options
 */
export async function generateCardRegistry({ cardsDir, outDir, requireEntries = false } = {}) {
  if (typeof cardsDir !== "string" || typeof outDir !== "string") {
    throw new Error("cardsDir 与 outDir 必须是字符串");
  }
  const resolvedCardsDir = resolve(cardsDir);
  const resolvedOutDir = resolve(outDir);
  const discovered = await discoverCards({ cardsDir: resolvedCardsDir, requireEntries });
  const cards = discovered.cards.map((card) => catalogCard(card)).map((record, index) => ({
    ...discovered.cards[index],
    catalog: record
  }));
  const catalogCards = cards.map((card) => card.catalog);
  const hash = hashCatalog(catalogCards);
  const registryPath = join(resolvedOutDir, "card-registry.mjs");
  await mkdir(resolvedOutDir, { recursive: true });
  await writeFile(registryPath, renderCardRegistry({
    cards: discovered.cards,
    hash,
    fromFile: registryPath
  }));
  return { hash, cards: discovered.cards, files: { registry: registryPath } };
}

function parseArgs(argv) {
  const options = { cardsDir: null, outDir: null, requireEntries: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--require-entries") options.requireEntries = true;
    else if (arg === "--cards-dir") options.cardsDir = readValue(argv, index += 1, arg);
    else if (arg === "--out-dir") options.outDir = readValue(argv, index += 1, arg);
    else throw new Error(`未知参数 ${arg}`);
  }
  return options;
}

function readValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} 需要路径参数`);
  return value;
}

const HELP = `用法: node scripts/generate-card-registry.mjs [--cards-dir <dir>] [--out-dir <dir>] [--require-entries]

默认 --cards-dir cards，--out-dir src。
metadata-only（默认）允许缺少 renderer.mjs；--require-entries 缺少前端入口时失败。`;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  const result = await generateCardRegistry({
    cardsDir: options.cardsDir ?? join(REPO_ROOT, "cards"),
    outDir: options.outDir ?? join(REPO_ROOT, "src"),
    requireEntries: options.requireEntries
  });
  process.stdout.write(`${result.hash} ${result.files.registry}\n`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
