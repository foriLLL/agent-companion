// 发版用到的纯文本处理：CHANGELOG 段落、Formula 的 url/sha256。release.mjs 与 CI 共用，便于测试。
import { changelogSection } from "../src/changelog.mjs";

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const REPOSITORY = "foriLLL/agent-companion";

export function assertVersion(version) {
  if (!VERSION.test(String(version))) throw new Error(`版本号必须是 X.Y.Z：${version}`);
  return version;
}

/** 取出 CHANGELOG 里 `## <version>` 这一节的正文（不含标题），找不到或为空时报错。 */
export function extractReleaseNotes(changelog, version) {
  assertVersion(version);
  if (!new RegExp(`^## ${version.replaceAll(".", "\\.")}(?:\\s|$)`, "m").test(changelog)) throw new Error(`CHANGELOG 里没有 ${version} 这一节`);
  const notes = changelogSection(changelog, version);
  if (!notes) throw new Error(`CHANGELOG 的 ${version} 一节是空的`);
  return `${notes}\n`;
}

/** 把 Unreleased 一节改名为新版本，并在上面留一个空的 Unreleased。 */
export function releaseChangelog(changelog, version, date) {
  assertVersion(version);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`日期格式应为 YYYY-MM-DD：${date}`);
  const marker = "\n## Unreleased\n";
  const index = changelog.indexOf(marker);
  if (index < 0) throw new Error("CHANGELOG 里没有 ## Unreleased");
  if (new RegExp(`^## ${version.replaceAll(".", "\\.")}(?:\\s|$)`, "m").test(changelog)) throw new Error(`CHANGELOG 已有 ${version}`);
  const next = `${changelog.slice(0, index)}\n## Unreleased\n\n## ${version} - ${date}\n${changelog.slice(index + marker.length)}`;
  extractReleaseNotes(next, version);
  return next;
}

export const releaseAssetName = version => `agent-companion-${assertVersion(version)}.tar.gz`;
export const releaseAssetUrl = version =>
  `https://github.com/${REPOSITORY}/releases/download/v${version}/${releaseAssetName(version)}`;

/** Formula 指向某个 Release 的源码包：替换或按 Homebrew 的顺序在 homepage 后插入 url / sha256，保留 head。 */
export function updateFormula(formula, { version, sha256 }) {
  assertVersion(version);
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`sha256 无效：${sha256}`);
  const lines = formula.split("\n").filter(line => !/^ {2}(?:url|sha256) "/.test(line));
  const homepage = lines.findIndex(line => /^ {2}homepage "/.test(line));
  if (homepage < 0) throw new Error("Formula 里没有 homepage 行");
  lines.splice(homepage + 1, 0, `  url "${releaseAssetUrl(version)}"`, `  sha256 "${sha256}"`);
  return lines.join("\n");
}
