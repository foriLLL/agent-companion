import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { searchPathCandidates } from "../paths.mjs";
import { RENDERER_BUNDLE, RENDERER_SOURCE } from "./catalog.mjs";

const execFileAsync = promisify(execFile);

/**
 * 把卡片的 renderer.mjs（ESM，导出 mount 与可选的 settings）打包成页面里运行的 renderer.js：
 * 一个自执行脚本，结尾调用 __companionDefine(模块)。平台注入时用自己的函数包住它，
 * 卡片代码因此不接触任何页面全局，也不需要知道自己的 id。
 *
 * 打包器依次找：当前就是 Bun 运行时（单文件后端）→ 仓库开发依赖里的 bun → PATH 里的 bun。
 */
export const DEFINE_FUNCTION = "__companionDefine";

// 包装入口放在卡片目录里、以卡片目录为工作目录打包：产物里的路径注释都是相对路径，同样的源码打出同样的字节。
const WRAPPER = ".companion-entry.mjs";
const wrapperSource = () => `import * as card from "./${RENDERER_SOURCE}";\n${DEFINE_FUNCTION}(card);\n`;

export function findBunExecutable({ env = process.env, platform = process.platform, moduleUrl = import.meta.url } = {}) {
  if (env.AGENT_COMPANION_BUN && existsSync(env.AGENT_COMPANION_BUN)) return env.AGENT_COMPANION_BUN;
  const candidates = [];
  try { candidates.push(fileURLToPath(new URL("../../../node_modules/bun/bin/bun.exe", moduleUrl))); } catch {}
  candidates.push(...searchPathCandidates([platform === "win32" ? "bun.exe" : "bun"], { platform, env }));
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function bundle(entry, { cwd, bunExecutable }) {
  if (typeof globalThis.Bun?.build === "function") {
    const result = await globalThis.Bun.build({ entrypoints: [resolve(cwd, entry)], root: cwd, target: "browser", format: "iife" });
    if (!result.success) throw new Error(result.logs.map((log) => String(log.message ?? log)).join("\n") || "打包失败");
    return result.outputs[0].text();
  }
  const bun = bunExecutable ?? findBunExecutable();
  if (!bun) {
    throw Object.assign(new Error("找不到 Bun，无法打包 renderer.mjs：请安装 Bun（https://bun.sh），或在插件仓库里提交打包好的 renderer.js"),
      { code: "BUNDLER_UNAVAILABLE" });
  }
  const temporary = await mkdtemp(join(tmpdir(), "companion-card-out-"));
  try {
    const output = join(temporary, RENDERER_BUNDLE);
    await execFileAsync(bun, ["build", entry, "--target=browser", "--format=iife", "--outfile", output], { cwd, maxBuffer: 16 * 1024 * 1024 });
    return await readFile(output, "utf8");
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

/** 打包 <dir>/renderer.mjs，写出 <dir>/renderer.js（或 outFile）。返回 { outFile, bytes }。 */
export async function buildCardRenderer({ dir, outFile, bunExecutable, header } = {}) {
  const cardDir = resolve(dir);
  const entry = join(cardDir, RENDERER_SOURCE);
  if (!existsSync(entry)) throw Object.assign(new Error(`${cardDir} 里没有 renderer.mjs`), { code: "MISSING_RENDERER_SOURCE" });
  const wrapper = join(cardDir, WRAPPER);
  try {
    await writeFile(wrapper, wrapperSource());
    const code = await bundle(`./${WRAPPER}`, { cwd: cardDir, bunExecutable });
    if (!code.includes(DEFINE_FUNCTION)) throw new Error("打包结果里没有卡片注册调用");
    const target = outFile ?? join(cardDir, RENDERER_BUNDLE);
    const text = `// ${header ?? "卡片界面，由 agent-companion cards build 从 renderer.mjs 打包生成，请勿手改。"}\n${code}`;
    await writeFile(target, text);
    return { outFile: target, bytes: Buffer.byteLength(text) };
  } finally { await rm(wrapper, { force: true }); }
}
