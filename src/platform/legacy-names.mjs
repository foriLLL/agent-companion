import { lstat, mkdir, readdir, readFile, rename, rmdir, symlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { companionDataDir } from "./paths.mjs";

// 0.4.0 起项目从 Codex Companion 改名为 Agent Companion。老安装留下的名字集中在这里，
// 只用于识别与迁移，新代码不要再写入这些名字。
export const LEGACY_NAME = "codex-companion";
export const LEGACY_ENV_PREFIX = "CODEX_COMPANION_";
export const ENV_PREFIX = "AGENT_COMPANION_";

/**
 * 把老版本的 CODEX_COMPANION_* 环境变量映射成 AGENT_COMPANION_*：老 launchd plist、systemd 单元和
 * 用户自己的 shell 配置里还写着旧名字。新名字已设置时以新名字为准。原地修改并返回 env。
 */
export function normalizeLegacyEnv(env = process.env) {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(LEGACY_ENV_PREFIX) || value === undefined) continue;
    const next = ENV_PREFIX + key.slice(LEGACY_ENV_PREFIX.length);
    if (env[next] === undefined) env[next] = value;
  }
  return env;
}

export function legacyDataDir(home = homedir(), options = {}) {
  return companionDataDir(home, { ...options, name: LEGACY_NAME });
}

async function lstatOrNull(target) {
  try { return await lstat(target); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function sameFileContent(a, b, { lstatImpl, readFileImpl }) {
  const [left, right] = await Promise.all([lstatImpl(a), lstatImpl(b)]);
  if (!left?.isFile() || !right?.isFile() || left.size !== right.size) return false;
  const [x, y] = await Promise.all([readFileImpl(a), readFileImpl(b)]);
  return Buffer.compare(x, y) === 0;
}

/**
 * 首次以新名字启动时把旧数据目录整体改名过去（同一文件系统内是原子的），并在旧位置留一个指向新目录的
 * 软链：回退到老版本或其它还认旧路径的程序仍能读到同一份数据。
 *
 * 新目录已经存在时（比如开发时用新名字跑过一次，只留下零星文件）逐项合并：新目录没有的搬过去，
 * 两边内容完全相同的删掉旧副本，真有冲突的以新目录为准、旧目录原样保留并在结果里列出，不覆盖任何一方。
 * 旧目录搬空后再换成软链。旧位置已经是软链说明迁移过了，不再处理。
 * 返回 { migrated, merged?, conflicts?, from, to, reason? }。
 */
export async function migrateLegacyDataDir({ home = homedir(), platform = process.platform, env,
  lstatImpl = lstatOrNull, renameImpl = rename, symlinkImpl = symlink, mkdirImpl = mkdir,
  readdirImpl = readdir, readFileImpl = readFile, unlinkImpl = unlink, rmdirImpl = rmdir } = {}) {
  const to = companionDataDir(home, { platform, env });
  const from = legacyDataDir(home, { platform, env });
  const paths = platform === "win32" ? path.win32 : path.posix;
  const source = await lstatImpl(from);
  if (!source) return { migrated: false, from, to, reason: "no-legacy" };
  if (source.isSymbolicLink()) return { migrated: false, from, to, reason: "already-migrated" };
  if (!source.isDirectory()) return { migrated: false, from, to, reason: "legacy-not-directory" };
  const linkLegacy = async () => {
    try {
      // 同一父目录内用相对链接；Windows 的 junction 只接受绝对路径。
      await symlinkImpl(platform === "win32" ? to : paths.basename(to), from, platform === "win32" ? "junction" : "dir");
    } catch {
      // 软链只是给回退留的后路，建不了不影响迁移结果。
    }
  };

  const target = await lstatImpl(to);
  if (!target) {
    await mkdirImpl(paths.dirname(to), { recursive: true });
    await renameImpl(from, to);
    await linkLegacy();
    return { migrated: true, from, to };
  }
  if (!target.isDirectory()) return { migrated: false, from, to, reason: "target-not-directory" };

  const conflicts = [];
  let moved = 0;
  for (const name of await readdirImpl(from)) {
    const legacyEntry = paths.join(from, name);
    const targetEntry = paths.join(to, name);
    if (!await lstatImpl(targetEntry)) {
      await renameImpl(legacyEntry, targetEntry);
      moved += 1;
    } else if (await sameFileContent(legacyEntry, targetEntry, { lstatImpl, readFileImpl })) {
      await unlinkImpl(legacyEntry);
    } else {
      conflicts.push(name);
    }
  }
  if (conflicts.length > 0) return { migrated: moved > 0, merged: true, conflicts, from, to, reason: "conflicts" };
  await rmdirImpl(from);
  await linkLegacy();
  return { migrated: true, merged: true, from, to };
}
