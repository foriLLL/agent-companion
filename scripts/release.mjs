#!/usr/bin/env node
// 本地发版：node scripts/release.mjs <X.Y.Z>
// 在干净的 main 上改 package.json / package-lock.json 版本号，把 CHANGELOG 的 Unreleased 改名为该版本，
// 提交并打 vX.Y.Z tag。不推送：确认无误后执行脚本最后打印的 git push，CI 会发布 Release 并更新 Formula。
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertVersion, releaseChangelog } from "./release-tools.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const dryRun = process.argv.includes("--dry-run");

const compare = (a, b) => {
  const [x, y] = [a, b].map(value => value.split(".").map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

try {
  const version = assertVersion(process.argv[2]);
  if (git("rev-parse", "--abbrev-ref", "HEAD") !== "main") throw new Error("请在 main 分支上发版");
  if (git("status", "--porcelain")) throw new Error("工作区有未提交的改动");
  if (git("tag", "--list", `v${version}`)) throw new Error(`tag v${version} 已存在`);

  const packagePath = join(root, "package.json");
  const lockPath = join(root, "package-lock.json");
  const changelogPath = join(root, "CHANGELOG.md");
  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  if (compare(version, pkg.version) <= 0) throw new Error(`新版本 ${version} 必须大于当前 ${pkg.version}`);
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const today = new Date().toISOString().slice(0, 10);
  const changelog = releaseChangelog(readFileSync(changelogPath, "utf8"), version, today);

  pkg.version = version;
  lock.version = version;
  if (lock.packages?.[""]) lock.packages[""].version = version;
  if (dryRun) {
    console.log(`将发布 v${version}（${today}），未写入任何文件。`);
  } else {
    writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    writeFileSync(changelogPath, changelog);
    git("add", "package.json", "package-lock.json", "CHANGELOG.md");
    git("commit", "-m", `chore: 发布 v${version}`);
    git("tag", "-a", `v${version}`, "-m", `v${version}`);
    console.log(`已提交并打 tag v${version}。确认无误后推送：\n  git push origin main v${version}`);
  }
} catch (error) {
  console.error(`发版中止：${error.message}`);
  process.exitCode = 1;
}
