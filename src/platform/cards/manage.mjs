import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { replaceFile } from "../replace-file.mjs";
import { buildCardRenderer } from "./build.mjs";
import { RENDERER_BUNDLE, RENDERER_SOURCE, readCardPackage } from "./catalog.mjs";

const execFileAsync = promisify(execFile);

/**
 * 用户卡片的安装、更新、卸载与开发链接，全部只动用户卡片目录（数据目录下的 cards/）。
 *
 * 来源：
 *   owner/repo[@ref]           GitHub 仓库（https://github.com/owner/repo.git）
 *   https://… / git@… [--ref]  任意 git 仓库
 *   本地目录                    复制一份；开发时用 link 改为符号链接，改动即时生效
 * 仓库根目录就是卡片（manifest.json 在根目录）；一个仓库放多张卡片时用 --path 指定子目录。
 * 安装来源记在 cards/.installs.json，update 按原来源重新获取：指定过 ref 的保持在那个 ref，
 * 没指定的跟随默认分支。安装与更新都先在临时目录准备好、校验通过后再整体替换，失败不留半成品。
 * 卡片缺少 renderer.js 但有 renderer.mjs 时，尝试在本机打包（需要 Bun）。
 */

export const INSTALLS_FILE = ".installs.json";
const GITHUB_SHORTHAND = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})(?:@([^\s@]+))?$/;
const COMMIT = /^[0-9a-f]{7,40}$/i;

export class CardManageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CardManageError";
    this.code = code;
  }
}

/** 解析安装来源。返回 { kind: "git", url, ref } 或 { kind: "path", path }。 */
export async function parseCardSource(input, { ref = null, cwd = process.cwd(), statImpl = stat } = {}) {
  if (typeof input !== "string" || input.trim() === "") throw new CardManageError("INVALID_SOURCE", "需要指定安装来源：owner/repo、git 地址或本地目录");
  const value = input.trim();
  const local = value.startsWith(".") || value.startsWith("~") || isAbsolute(value);
  if (local || !GITHUB_SHORTHAND.test(value) && !/^(https:\/\/|git@|ssh:\/\/|file:\/\/)/.test(value)) {
    const path = resolve(cwd, value.startsWith("~") ? value.replace(/^~(?=$|\/)/, process.env.HOME ?? "~") : value);
    const info = await statImpl(path).catch(() => null);
    if (!info?.isDirectory()) throw new CardManageError("INVALID_SOURCE", `找不到目录 ${path}；GitHub 仓库请写成 owner/repo`);
    return { kind: "path", path };
  }
  if (/^http:\/\//.test(value)) throw new CardManageError("INVALID_SOURCE", "只支持 https 的 git 地址");
  const shorthand = value.match(GITHUB_SHORTHAND);
  if (shorthand && !value.includes("://")) {
    const [, owner, repo, inlineRef] = shorthand;
    if (inlineRef && ref && inlineRef !== ref) throw new CardManageError("INVALID_SOURCE", "@ref 与 --ref 不一致");
    return { kind: "git", url: `https://github.com/${owner}/${repo.replace(/\.git$/, "")}.git`, ref: inlineRef ?? ref };
  }
  return { kind: "git", url: value, ref };
}

async function readInstalls(dir) {
  try {
    const value = JSON.parse(await readFile(join(dir, INSTALLS_FILE), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return {};
    throw error;
  }
}

async function writeInstalls(dir, installs) {
  await mkdir(dir, { recursive: true });
  const path = join(dir, INSTALLS_FILE);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(installs, null, 2)}\n`, { mode: 0o600 });
  await replaceFile(temporary, path);
}

async function git(args, { cwd, execFileImpl = execFileAsync } = {}) {
  try {
    const { stdout } = await execFileImpl("git", args, { cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    return String(stdout).trim();
  } catch (error) {
    if (error?.code === "ENOENT") throw new CardManageError("GIT_UNAVAILABLE", "找不到 git，请先安装 git");
    const detail = String(error?.stderr ?? error?.message ?? "").trim().split("\n").at(-1);
    throw new CardManageError("GIT_FAILED", `git ${args[0]} 失败：${detail}`);
  }
}

// 把来源取到一个临时目录；返回 { dir, commit, cleanup }。
async function fetchSource(source, { execFileImpl } = {}) {
  const temporary = await mkdtemp(join(tmpdir(), "companion-card-fetch-"));
  const cleanup = () => rm(temporary, { recursive: true, force: true });
  try {
    const dir = join(temporary, "src");
    if (source.kind === "path") {
      await cp(source.path, dir, { recursive: true, filter: (path) => !/[\\/](\.git|node_modules)$/.test(path) });
      return { dir, commit: null, cleanup };
    }
    if (source.ref && COMMIT.test(source.ref)) {
      await git(["clone", "--quiet", "--no-checkout", source.url, dir], { execFileImpl });
      await git(["checkout", "--quiet", source.ref], { cwd: dir, execFileImpl });
    } else {
      await git(["clone", "--quiet", "--depth", "1", ...(source.ref ? ["--branch", source.ref] : []), source.url, dir], { execFileImpl });
    }
    const commit = await git(["rev-parse", "HEAD"], { cwd: dir, execFileImpl });
    await rm(join(dir, ".git"), { recursive: true, force: true });
    return { dir, commit, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function preparePackage(dir, { subpath = null, build = buildCardRenderer } = {}) {
  const cardDir = subpath ? resolve(dir, subpath) : dir;
  if (subpath && !cardDir.startsWith(resolve(dir))) throw new CardManageError("INVALID_SOURCE", "--path 不能指向仓库之外");
  const hasBundle = Boolean(await stat(join(cardDir, RENDERER_BUNDLE)).catch(() => null));
  const hasSource = Boolean(await stat(join(cardDir, RENDERER_SOURCE)).catch(() => null));
  if (!hasBundle && hasSource) await build({ dir: cardDir });
  try { return { dir: cardDir, card: await readCardPackage(cardDir, { source: "user", expectedId: null }) }; } catch (error) {
    throw new CardManageError(error.code ?? "INVALID_CARD", `不是有效的卡片：${error.message}`);
  }
}

// 用准备好的目录整体替换 <userDir>/<id>：先放进同盘的临时位置，再两次 rename。
async function placePackage(userDir, id, preparedDir) {
  await mkdir(userDir, { recursive: true });
  const staging = join(userDir, `.staging-${id}-${process.pid}`);
  const trash = join(userDir, `.trash-${id}-${process.pid}`);
  await rm(staging, { recursive: true, force: true });
  await cp(preparedDir, staging, { recursive: true });
  const target = join(userDir, id);
  const existing = await lstat(target).catch(() => null);
  if (existing) await rename(target, trash);
  try { await rename(staging, target); } catch (error) {
    if (existing) await rename(trash, target).catch(() => {});
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  if (existing) await rm(trash, { recursive: true, force: true });
  return target;
}

/**
 * 安装一张卡片。返回 { id, dir, card, replaced, overridesBuiltin, commit }。
 * 已安装同 id 的卡片时需要 force；内置卡片同 id 时安装的版本会覆盖内置版本（卸载即恢复）。
 */
export async function installCard({ source: input, ref = null, path: subpath = null, force = false, userDir, builtinIds = [],
  cwd, now = () => new Date(), execFileImpl, build } = {}) {
  const source = typeof input === "string" ? await parseCardSource(input, { ref, cwd }) : input;
  const fetched = await fetchSource(source, { execFileImpl });
  try {
    const { dir, card } = await preparePackage(fetched.dir, { subpath, build });
    const target = join(userDir, card.id);
    const existing = await lstat(target).catch(() => null);
    if (existing && !force) throw new CardManageError("ALREADY_INSTALLED", `已安装 ${card.id}；更新请用 update，覆盖请加 --force`);
    await placePackage(userDir, card.id, dir);
    const installs = await readInstalls(userDir);
    installs[card.id] = {
      source: source.kind === "git" ? source.url : source.path, kind: source.kind,
      ...(source.ref ? { ref: source.ref } : {}), ...(subpath ? { path: subpath } : {}),
      ...(fetched.commit ? { commit: fetched.commit } : {}), installedAt: now().toISOString()
    };
    await writeInstalls(userDir, installs);
    return { id: card.id, dir: target, card, replaced: Boolean(existing), overridesBuiltin: builtinIds.includes(card.id), commit: fetched.commit };
  } finally { await fetched.cleanup(); }
}

/** 按安装记录重新获取。ref 传入时改用新的 ref。返回 installCard 的结果，加上 previous（旧 commit）。 */
export async function updateCard({ id, ref, userDir, builtinIds, execFileImpl, build, now } = {}) {
  const installs = await readInstalls(userDir);
  const record = installs[id];
  const target = join(userDir, id);
  const info = await lstat(target).catch(() => null);
  if (!info) throw new CardManageError("NOT_INSTALLED", `没有安装 ${id}`);
  if (info.isSymbolicLink()) return { id, linked: await readlink(target), skipped: "linked" };
  if (!record) throw new CardManageError("UNKNOWN_SOURCE", `${id} 没有安装记录，无法更新；请重新 install --force`);
  const source = record.kind === "path" ? { kind: "path", path: record.source } : { kind: "git", url: record.source, ref: ref ?? record.ref ?? null };
  const result = await installCard({ source, path: record.path ?? null, force: true, userDir, builtinIds, execFileImpl, build, now });
  if (result.id !== id) throw new CardManageError("ID_CHANGED", `来源里的卡片 id 变成了 ${result.id}`);
  return { ...result, previous: record.commit ?? null };
}

/** 卸载用户卡片（链接只删链接本身）。purgeData 同时删除它在 card-data/ 下的数据。 */
export async function removeCard({ id, userDir, dataRoot = null, purgeData = false, builtinIds = [] } = {}) {
  const target = join(userDir, id);
  const info = await lstat(target).catch(() => null);
  if (!info) {
    if (builtinIds.includes(id)) throw new CardManageError("BUILTIN", `${id} 是内置卡片，不能卸载；可以在设置里关闭它`);
    throw new CardManageError("NOT_INSTALLED", `没有安装 ${id}`);
  }
  if (info.isSymbolicLink()) await rm(target, { force: true });
  else await rm(target, { recursive: true, force: true });
  const installs = await readInstalls(userDir);
  if (installs[id]) {
    delete installs[id];
    await writeInstalls(userDir, installs);
  }
  if (purgeData && dataRoot) await rm(join(dataRoot, "card-data", id), { recursive: true, force: true });
  return { id, linked: info.isSymbolicLink(), restoresBuiltin: builtinIds.includes(id) };
}

/** 开发用：把本地卡片目录链接进用户卡片目录，改动（重新打包 renderer.js）几秒内生效。 */
export async function linkCard({ dir, userDir, force = false, platform = process.platform, build } = {}) {
  const source = resolve(dir);
  const { card } = await preparePackage(source, { build });
  const target = join(userDir, card.id);
  const existing = await lstat(target).catch(() => null);
  if (existing && !force) throw new CardManageError("ALREADY_INSTALLED", `已有 ${card.id}；替换为链接请加 --force`);
  await mkdir(userDir, { recursive: true });
  if (existing) await rm(target, { recursive: true, force: true });
  await symlink(source, target, platform === "win32" ? "junction" : "dir");
  const installs = await readInstalls(userDir);
  if (installs[card.id]) {
    delete installs[card.id];
    await writeInstalls(userDir, installs);
  }
  return { id: card.id, dir: target, source, card };
}

export async function readInstallRecords(userDir) {
  return readInstalls(userDir);
}
