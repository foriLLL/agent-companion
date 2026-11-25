import { execFile } from "node:child_process";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MANIFEST_FILE, RENDERER_BUNDLE, SERVICE_ENTRY, readCardPackage } from "../src/platform/cards/catalog.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const BUILTIN_CARDS_DIR = join(repoRoot, "cards");
// 随应用分发的卡片目录里每张卡片只有这几个文件；Linux install.sh 的归属检查与此一致。
export const PACKAGED_CARD_FILES = Object.freeze([MANIFEST_FILE, RENDERER_BUNDLE, SERVICE_ENTRY]);

/**
 * 把内置卡片打成随应用分发的目录：<outDir>/<id>/{manifest.json, renderer.js, service.mjs}，
 * 单文件后端从可执行文件同级的 cards/ 发现它们（platform/cards/catalog.mjs 的 builtinCardsDir）。
 * 单文件后端不带仓库与 node_modules，后台服务在这里打成自包含的单个 ESM 文件（sdk/ 与依赖一并打进去），
 * 运行时从磁盘 import。renderer.js 由 generate-renderer 先生成。
 */
export async function packageBuiltinCards({
  cardsDir = BUILTIN_CARDS_DIR, outDir, bunExecutable = join(repoRoot, "node_modules", "bun", "bin", "bun.exe"),
  execFileImpl = execFileAsync
} = {}) {
  if (!outDir) throw new TypeError("需要 outDir");
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const entries = (await readdir(cardsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  const packaged = [];
  for (const entry of entries) {
    const card = await readCardPackage(join(cardsDir, entry.name), { source: "builtin" });
    const target = join(outDir, card.id);
    await mkdir(target);
    await cp(join(card.dir, MANIFEST_FILE), join(target, MANIFEST_FILE));
    await cp(card.renderer.path, join(target, RENDERER_BUNDLE));
    if (card.service) {
      await execFileImpl(bunExecutable, ["build", card.service.path, "--target=node", "--format=esm", "--outfile", join(target, SERVICE_ENTRY)],
        { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 });
    }
    packaged.push({ id: card.id, service: Boolean(card.service) });
  }
  return packaged;
}
