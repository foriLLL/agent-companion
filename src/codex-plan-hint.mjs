import { randomBytes } from "node:crypto";
import { chmod, lstat, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { defaultCodexHome } from "./codex-sessions.mjs";
import { PLAN_HINT_START, PLAN_HINT_END, PLAN_HINT_BODY, PLAN_TOOL_MARKER, PLAN_TOOL_SNIPPET } from "./codex-plan-hint-text.mjs";

export { PLAN_HINT_START, PLAN_HINT_END, PLAN_HINT_BODY, PLAN_TOOL_MARKER, PLAN_TOOL_SNIPPET } from "./codex-plan-hint-text.mjs";

// 「长任务先列计划」：在 Codex 全局指令文件里维护一段带标记的提示，让 Codex 用工具或专用进度消息
// 拆步骤、同步进度，任务看板据此显示计划；同时在 config.toml 里打开 Codex 自带的 update_plan 工具，
// 进度走工具调用，不再以代码块混进对话。只增删自己写的那一段，其它内容原样保留；
// 关闭开关或卸载 Companion 时删除。Codex 只在新会话开始时读取这些文件。

// 连同前面的空行一起匹配；标记行的说明文字以后可能改，只认固定前缀。
// 也认改名前写下的 codex-companion 标记：开启时换成新标记，关闭或卸载时一并删除。
// 用户的文件可能是 CRLF：换行一律按 \r?\n 认，否则认不出已有的提示段，每次都会再追加一段。
const BLOCK = /(?:\r?\n)*<!-- (agent|codex)-companion:plan-hint\b[^\r\n]*-->\r?\n[\s\S]*?<!-- \/\1-companion:plan-hint -->(?:\r?\n)?/;
const FILE_LIMIT = 1024 * 1024;
// Codex 的全局指令：AGENTS.override.md 非空时只读它，否则读 AGENTS.md。
const OVERRIDE = "AGENTS.override.md";
const DEFAULT = "AGENTS.md";
const CONFIG = "config.toml";

export function hasHint(text) {
  return BLOCK.test(text);
}

// config.toml 由 Codex 自己用 toml_edit 维护（例如信任新项目时在末尾追加 [projects."…"]），所以不用成对的
// 开始/结束标记：只认「标记注释 + [tools.update_plan] + enabled = true」，而且之后直到下一张表只有空行或注释。
// 用户在这张表里加了别的键、改了值，就不再算 Companion 写的，开关不再动它。
// 只认固定前缀，标记行的说明文字以后可能改。
const PLAN_TOOL_PREFIXES = ["# agent-companion:plan-tool", "# codex-companion:plan-tool"];

function findPlanTool(lines) {
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!PLAN_TOOL_PREFIXES.some(prefix => lines[index].startsWith(prefix)) || lines[index + 1].trim() !== "[tools.update_plan]") continue;
    let key = index + 2;
    while (key < lines.length && !lines[key].trim()) key += 1;
    if (key >= lines.length || !/^enabled\s*=\s*true$/.test(lines[key].trim())) continue;
    let next = key + 1;
    while (next < lines.length && (!lines[next].trim() || lines[next].trim().startsWith("#"))) next += 1;
    if (next < lines.length && !lines[next].trim().startsWith("[")) continue;
    return { start: index, end: key };
  }
  return null;
}

export function hasPlanTool(text) {
  return Boolean(findPlanTool(text.split("\n")));
}

export function withoutPlanTool(text) {
  let lines = text.split("\n");
  for (let found = findPlanTool(lines); found; found = findPlanTool(lines)) {
    let { start, end } = found;
    while (start > 0 && !lines[start - 1].trim()) start -= 1;
    end += 1;
    while (end < lines.length && !lines[end].trim()) end += 1;
    const before = lines.slice(0, start);
    const after = lines.slice(end);
    // 在中间时留一个空行隔开前后两张表；在末尾时保证以换行结束。
    lines = before.length && after.length ? [...before, "", ...after] : before.length ? [...before, ""] : after;
  }
  const result = lines.join("\n");
  return result === "\n" ? "" : result;
}

// 用户自己配置过 update_plan（任何写法），或在根上用内联表 / 点号键写了 tools，就以用户的为准不追加：
// 再加一张 [tools.update_plan] 可能重复定义，让 Codex 读不了配置。
export function userPlanTool(text) {
  let root = true;
  for (const raw of withoutPlanTool(text).split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (/\bupdate_plan\b/.test(line)) return true;
    if (line.startsWith("[")) { root = false; continue; }
    if (root && /^"?tools"?\s*[.=]/.test(line)) return true;
  }
  return false;
}

export function withPlanTool(text) {
  if (hasPlanTool(text) || userPlanTool(text)) return text;
  const base = text.replace(/\n+$/, "");
  return `${base ? `${base}\n\n` : ""}${PLAN_TOOL_MARKER}\n${PLAN_TOOL_SNIPPET}\n`;
}

const eolOf = (text) => (text.includes("\r\n") ? "\r\n" : "\n");

export function withoutHint(text) {
  const eol = eolOf(text);
  let result = text;
  for (let match = BLOCK.exec(result); match; match = BLOCK.exec(result)) {
    // 在文件中间时留一个空行隔开前后文字；在开头或末尾时直接去掉。
    const edge = match.index === 0 || match.index + match[0].length >= result.length;
    result = `${result.slice(0, match.index)}${edge ? "" : eol + eol}${result.slice(match.index + match[0].length)}`;
  }
  if (result === text) return text;
  return result && !result.endsWith("\n") ? `${result}${eol}` : result;
}

export function withHint(text) {
  const eol = eolOf(text);
  const base = withoutHint(text).replace(/(?:\r?\n)+$/, "");
  const block = `${PLAN_HINT_START}\n${PLAN_HINT_BODY}\n${PLAN_HINT_END}\n`;
  return `${base ? `${base}${eol}${eol}` : ""}${eol === "\n" ? block : block.replaceAll("\n", eol)}`;
}

async function readTarget(path, newMode = 0o644) {
  let real;
  try { real = await realpath(path); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    // 断开的符号链接：不替换用户的链接。
    const link = await lstat(path).catch(() => null);
    if (link) throw Object.assign(new Error(`${path} 是指向不存在文件的链接`), { code: "PLAN_HINT_BROKEN_LINK" });
    return { real: path, text: null, mode: newMode };
  }
  const info = await stat(real);
  if (!info.isFile()) throw Object.assign(new Error(`${path} 不是普通文件`), { code: "PLAN_HINT_NOT_FILE" });
  if (info.size > FILE_LIMIT) throw Object.assign(new Error(`${path} 太大`), { code: "PLAN_HINT_TOO_LARGE" });
  return { real, text: await readFile(real, "utf8"), mode: info.mode & 0o777 };
}

// 改写一个文件：符号链接写到它指向的文件，同目录临时文件 + rename，保留原权限；改完为空就删掉。
async function edit(path, transform, newMode) {
  const { real, text, mode } = await readTarget(path, newMode);
  const next = transform(text ?? "");
  if (next === (text ?? "")) return false;
  // 改完为空：普通文件直接删；符号链接（比如指向 dotfiles 仓库）只清空它指向的文件，不删用户的源文件。
  if (!next && !(await lstat(path).catch(() => null))?.isSymbolicLink()) {
    await unlink(real).catch((error) => { if (error.code !== "ENOENT") throw error; });
    return true;
  }
  const temporary = join(dirname(real), `.${basename(real)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, next, { mode, flag: "wx" });
    await chmod(temporary, mode);
    await rename(temporary, real);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return true;
}

async function nonEmptyFile(path) {
  try { const info = await stat(path); return info.isFile() && info.size > 0; } catch { return false; }
}

export function createPlanHint({ codexHome = defaultCodexHome() } = {}) {
  const paths = { override: join(codexHome, OVERRIDE), main: join(codexHome, DEFAULT), config: join(codexHome, CONFIG) };
  async function target() {
    return (await nonEmptyFile(paths.override)) ? paths.override : paths.main;
  }
  return {
    paths,
    /** 提示是否在 Codex 实际读取的那个文件里；planTool：companion（Companion 打开的）、user（用户自己配置的）、off。 */
    async status() {
      const path = await target();
      const { text } = await readTarget(path).catch(() => ({ text: null }));
      const { text: config } = await readTarget(paths.config).catch(() => ({ text: null }));
      const planTool = config && hasPlanTool(config) ? "companion" : config && userPlanTool(config) ? "user" : "off";
      return { enabled: Boolean(text && hasHint(text)), path, planTool };
    },
    /** 开启时写进 Codex 实际读取的文件并从另一个文件里去掉，并在 config.toml 打开 update_plan；
     *  关闭时都去掉。返回是否改动了文件。config.toml 写不了不影响提示，提示里有不用工具时的写法。 */
    async set(enabled) {
      const chosen = enabled ? await target() : null;
      let changed = false;
      for (const path of [paths.main, paths.override]) {
        if (path === chosen) changed = (await edit(path, withHint)) || changed;
        else if (path !== paths.override || await nonEmptyFile(path)) changed = (await edit(path, withoutHint)) || changed;
      }
      let configError = null;
      try { changed = (await edit(paths.config, enabled ? withPlanTool : withoutPlanTool, 0o600)) || changed; }
      catch (error) { configError = error; }
      if (configError) throw Object.assign(new Error(`已更新计划提示，但改不了 ${paths.config}：${configError.message}`), { code: "PLAN_TOOL_CONFIG", cause: configError, changed });
      return changed;
    }
  };
}
