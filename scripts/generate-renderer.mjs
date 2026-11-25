import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { generateCardRegistry } from "./generate-card-registry.mjs";
import { buildCardRenderer } from "../src/platform/cards/build.mjs";

const exec = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * 构建页面代码：
 * - 平台：src/renderer/entry.mjs → src/renderer-embedded.generated.mjs（不含任何卡片）；
 * - 内置卡片：cards/<id>/renderer.mjs → cards/<id>/renderer.js，和用户安装的卡片是同一种包，运行时从目录读取。
 * 同时刷新内置卡片的 manifest 快照 src/card-registry.mjs。
 */
export async function generateRenderer({ repoRoot = root, requireEntries = true } = {}) {
  const bun = join(repoRoot, "node_modules", "bun", "bin", "bun.exe");
  const registry = await generateCardRegistry({ cardsDir: join(repoRoot, "cards"), outDir: join(repoRoot, "src"), requireEntries });
  const temporary = await mkdtemp(join(tmpdir(), "companion-renderer-build-"));
  try {
    const output = join(temporary, "renderer.js");
    await exec(bun, ["build", join(repoRoot, "src/renderer/entry.mjs"), "--target=browser", "--format=iife", "--outfile", output], { cwd: repoRoot });
    const source = await readFile(output, "utf8");
    const hash = createHash("sha256").update(source).digest("hex");
    const module = `// 构建产物；由 npm run generate:renderer 更新。\nexport const RENDERER_ARTIFACT_HASH = ${JSON.stringify(hash)};\nexport const RENDERER_SOURCE = ${JSON.stringify(source)};\n`;
    await writeFile(join(repoRoot, "src/renderer-embedded.generated.mjs"), module);
    const cards = [];
    for (const card of registry.cards) {
      if (!card.entries.renderer) continue;
      const built = await buildCardRenderer({ dir: card.directory, bunExecutable: bun, header: `${card.manifest.title}（内置卡片）的界面，由 npm run generate:renderer 从 renderer.mjs 打包生成，请勿手改。` });
      cards.push({ id: card.manifest.id, bytes: built.bytes });
    }
    return { hash, bytes: Buffer.byteLength(source), cards };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await generateRenderer({ requireEntries: !process.argv.includes("--allow-missing") });
  console.log(`Renderer built: ${result.hash.slice(0, 16)} (${result.bytes} bytes)；卡片：${result.cards.map(({ id, bytes }) => `${id} ${Math.round(bytes / 1024)}KB`).join("，")}`);
}
