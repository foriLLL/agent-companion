// CHANGELOG.md 里 `## <version>` 一节的正文（不含标题，去掉首尾空行）；没有这一节时返回空串。
// 发版脚本用它生成 Release 说明，自动更新在 GitHub API 被限流时用它从 tag 上的 CHANGELOG 取说明，两边同源。
export function changelogSection(changelog, version) {
  const lines = String(changelog).split("\n");
  const heading = new RegExp(`^## ${String(version).replaceAll(".", "\\.")}(?:\\s|$)`);
  const start = lines.findIndex(line => heading.test(line));
  if (start < 0) return "";
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
}
