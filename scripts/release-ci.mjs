#!/usr/bin/env node
// CI 发版用：
//   node scripts/release-ci.mjs notes <X.Y.Z>                    打印 CHANGELOG 中该版本的说明
//   node scripts/release-ci.mjs formula <X.Y.Z> <sha256>          把 Formula 指向该版本的源码包
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractReleaseNotes, updateFormula } from "./release-tools.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [command, version, sha256] = process.argv.slice(2);
if (command === "notes") {
  process.stdout.write(extractReleaseNotes(readFileSync(join(root, "CHANGELOG.md"), "utf8"), version));
} else if (command === "formula") {
  const path = join(root, "Formula", "codex-companion.rb");
  writeFileSync(path, updateFormula(readFileSync(path, "utf8"), { version, sha256 }));
} else {
  console.error("用法：release-ci.mjs notes <X.Y.Z> | formula <X.Y.Z> <sha256>");
  process.exit(2);
}
