import { lstat, mkdir, rename, symlink } from "node:fs/promises";
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

/**
 * 首次以新名字启动时把旧数据目录整体改名过去（同一文件系统内是原子的），并在旧位置留一个指向新目录的
 * 软链：回退到老版本或其它还认旧路径的程序仍能读到同一份数据。新目录已存在时什么都不做，
 * 避免两份数据互相覆盖。返回 { migrated, from, to, reason }。
 */
export async function migrateLegacyDataDir({ home = homedir(), platform = process.platform, env,
  lstatImpl = lstatOrNull, renameImpl = rename, symlinkImpl = symlink, mkdirImpl = mkdir } = {}) {
  const to = companionDataDir(home, { platform, env });
  const from = legacyDataDir(home, { platform, env });
  if (await lstatImpl(to)) return { migrated: false, from, to, reason: "target-exists" };
  const source = await lstatImpl(from);
  if (!source) return { migrated: false, from, to, reason: "no-legacy" };
  if (!source.isDirectory()) return { migrated: false, from, to, reason: "legacy-not-directory" };
  const paths = platform === "win32" ? path.win32 : path.posix;
  await mkdirImpl(paths.dirname(to), { recursive: true });
  await renameImpl(from, to);
  try {
    // 同一父目录内用相对链接；Windows 的 junction 只接受绝对路径。
    await symlinkImpl(platform === "win32" ? to : paths.basename(to), from, platform === "win32" ? "junction" : "dir");
  } catch {
    // 软链只是给回退留的后路，建不了不影响迁移结果。
  }
  return { migrated: true, from, to };
}
