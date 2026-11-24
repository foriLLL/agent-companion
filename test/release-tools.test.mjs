import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { extractReleaseNotes, releaseAssetUrl, releaseChangelog, updateFormula } from "../scripts/release-tools.mjs";

const CHANGELOG = `# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/)。

## Unreleased

- 新增自动更新；
- 修复看板提醒。

## 0.0.1 - 2026-07-30

- 首个版本。
`;

test("发版：Unreleased 改名为新版本并留空的 Unreleased；说明只取该版本一节", () => {
  const next = releaseChangelog(CHANGELOG, "0.2.0", "2026-11-17");
  assert.match(next, /## Unreleased\n\n## 0\.2\.0 - 2026-11-17\n\n- 新增自动更新；/);
  assert.equal(extractReleaseNotes(next, "0.2.0"), "- 新增自动更新；\n- 修复看板提醒。\n");
  assert.equal(extractReleaseNotes(next, "0.0.1"), "- 首个版本。\n");
  assert.throws(() => releaseChangelog(next, "0.2.0", "2026-11-17"), /已有 0\.2\.0/);
  assert.throws(() => releaseChangelog(next, "0.3.0", "2026-11-18"), /0\.3\.0 一节是空的/, "Unreleased 为空时不能发版");
  assert.throws(() => releaseChangelog(CHANGELOG, "v0.2.0", "2026-11-17"), /X\.Y\.Z/);
  assert.throws(() => extractReleaseNotes(CHANGELOG, "9.9.9"), /没有 9\.9\.9/);
  assert.throws(() => extractReleaseNotes(CHANGELOG, "0.0.10"), /没有 0\.0\.10/, "版本号前缀不能误配");
});

test("Formula：url/sha256 按 Homebrew 顺序插在 homepage 后，重复更新只替换不叠加，head 保留", async () => {
  const formula = await readFile(new URL("../Formula/agent-companion.rb", import.meta.url), "utf8");
  assert.match(formula, /export AGENT_COMPANION_INSTALL_CHANNEL=homebrew/);
  assert.match(formula, /export AGENT_COMPANION_BREW="#\{HOMEBREW_PREFIX\}\/bin\/brew"/);
  const once = updateFormula(formula, { version: "0.2.0", sha256: "a".repeat(64) });
  const twice = updateFormula(once, { version: "0.2.1", sha256: "b".repeat(64) });
  const lines = twice.split("\n");
  const at = prefix => lines.findIndex(line => line.startsWith(prefix));
  assert.deepEqual([at("  homepage "), at("  url "), at("  sha256 "), at("  license ")].map((value, _, all) => value - all[0]), [0, 1, 2, 3]);
  assert.equal(lines[at("  url ")], `  url "${releaseAssetUrl("0.2.1")}"`);
  assert.equal(releaseAssetUrl("0.2.1"), "https://github.com/foriLLL/agent-companion/releases/download/v0.2.1/agent-companion-0.2.1.tar.gz");
  assert.equal(lines.filter(line => line.startsWith("  url ")).length, 1);
  assert.match(twice, /^ {2}head "https:\/\/github\.com\/foriLLL\/agent-companion\.git", branch: "main"$/m);
  assert.throws(() => updateFormula(formula, { version: "0.2.0", sha256: "xyz" }), /sha256 无效/);
});
