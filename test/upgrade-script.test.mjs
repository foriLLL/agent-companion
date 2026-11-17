import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// scripts/upgrade.sh：brew、npm、Homebrew 里的 codex-companion 都换成记录调用的桩；git 用真的，远程指向本地裸仓库。
const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../scripts/upgrade.sh", import.meta.url));
const REPO_URL = "https://github.com/foriLLL/codex_companion.git";
const darwinOnly = { skip: process.platform !== "darwin" && "后台服务登记在 launchd plist 里，只在 macOS 上能读" };
const posixOnly = { skip: process.platform === "win32" && "升级脚本只支持 macOS / Linux" };
// 只看会改动东西的调用；list / info / --prefix / trust --help 是查询。
const MUTATING = /^(?:brew (?:update|trust --formula|uninstall|install|upgrade)|codex-companion |npm |git )/;

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cc-upgrade-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const prefix = join(root, "brew-prefix");
  const log = join(root, "calls.log");
  await mkdir(home);
  await mkdir(bin);
  const stub = async (path, body = "") => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `#!/bin/bash\nprintf '%s\\n' "$(basename "$0") $*" >> "${log}"\n${body}\n`);
    await chmod(path, 0o755);
  };
  await stub(join(bin, "brew"), `case "$1" in
  list) [ -z "$STUB_BREW_VERSIONS" ] || echo "codex-companion $STUB_BREW_VERSIONS" ;;
  info) printf '{"formulae": [{"versions": {"stable": %s, "head": "HEAD"}}]}\\n' "\${STUB_BREW_STABLE:-null}" ;;
  --prefix) echo "${prefix}" ;;
  install) [ "$2" = --HEAD ] || [ -z "$STUB_BREW_INSTALL_FAIL" ] || { echo "Error: build failed" >&2; exit 1; } ;;
esac`);
  await stub(join(bin, "npm"), `printf '%s\\n' "npm-cwd $PWD" >> "${log}"`);
  await stub(join(prefix, "opt", "codex-companion", "bin", "codex-companion"));

  const gitEnv = {
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com"
  };
  const env = {
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home,
    CODEX_COMPANION_BREW: join(bin, "brew"), ...gitEnv
  };
  const git = (cwd, ...args) => execFileAsync("git", args, { cwd, env: { ...process.env, ...gitEnv } }).then(r => r.stdout.trim());

  return {
    root, home, bin,
    stub,
    git,
    async run(args = [], extra = {}) {
      try {
        const { stdout, stderr } = await execFileAsync("bash", [SCRIPT, ...args], { cwd: root, env: { ...env, ...extra } });
        return { code: 0, stdout, stderr };
      } catch (error) {
        return { code: error.code, stdout: error.stdout, stderr: error.stderr };
      }
    },
    async calls() {
      const text = await readFile(log, "utf8").catch(() => "");
      return text.split("\n").filter(line => MUTATING.test(line) || line.startsWith("npm-cwd "));
    },
    async registerLaunchAgent(programArguments) {
      const dir = join(home, "Library", "LaunchAgents");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "com.codexcompanion.agent.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.codexcompanion.agent</string>
  <key>ProgramArguments</key><array>${programArguments.map(arg => `<string>${arg}</string>`).join("")}</array>
</dict></plist>
`);
    },
    // 源码安装：裸仓库比克隆多一个提交（版本号 0.2.0）；克隆的 origin 写成 GitHub 地址，经 insteadOf 落到裸仓库。
    async sourceInstall() {
      const upstream = join(root, "upstream.git");
      const seed = join(root, "seed");
      const clone = join(root, "my repo");
      await git(root, "init", "-q", "--bare", "-b", "main", upstream);
      await git(root, "init", "-q", "-b", "main", seed);
      await mkdir(join(seed, "src"));
      await writeFile(join(seed, "package.json"), '{"version":"0.1.3"}\n');
      await writeFile(join(seed, "src", "renderer-embedded.generated.mjs"), "export default 1;\n");
      await git(seed, "add", ".");
      await git(seed, "commit", "-q", "-m", "v0.1.3");
      await git(seed, "push", "-q", upstream, "main");
      await git(root, "clone", "-q", upstream, clone);
      await git(clone, "remote", "set-url", "origin", REPO_URL);
      await writeFile(join(seed, "package.json"), '{"version":"0.2.0"}\n');
      await git(seed, "commit", "-q", "-am", "v0.2.0");
      await git(seed, "push", "-q", upstream, "main");
      // systemd 单元与 linux-service.mjs 写法一致：每个参数加引号。
      const unitDir = join(home, ".config", "systemd", "user");
      await mkdir(unitDir, { recursive: true });
      await writeFile(join(unitDir, "codex-companion-agent.service"),
        `[Service]\nExecStart="/usr/bin/node" "${join(clone, "src", "cli.mjs")}" "agent"\nRestart=on-failure\n`);
      await this.stub(join(bin, "uname"), "echo Linux");
      return {
        clone, upstream,
        gitEnv: {
          GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${upstream}.insteadOf`, GIT_CONFIG_VALUE_0: REPO_URL
        }
      };
    }
  };
}

test("升级脚本：--HEAD 装的 Homebrew 换成正式版并重新注册后台服务", darwinOnly, async t => {
  const f = await fixture(t);
  await f.registerLaunchAgent(["/opt/homebrew/opt/codex-companion/bin/codex-companion", "agent"]);
  const result = await f.run([], { STUB_BREW_VERSIONS: "HEAD-de62245", STUB_BREW_STABLE: '"0.2.0"' });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /换成正式版/);
  assert.deepEqual(await f.calls(), [
    "brew update",
    "brew trust --formula foriLLL/codex-companion/codex-companion",
    "brew uninstall --ignore-dependencies codex-companion",
    "brew install codex-companion",
    "codex-companion agent install"
  ]);
});

test("升级脚本：正式版 brew upgrade；正式版装不上时恢复 --HEAD 并报错", darwinOnly, async t => {
  const f = await fixture(t);
  await f.registerLaunchAgent(["/usr/local/opt/codex-companion/bin/codex-companion", "agent"]);
  const stable = await f.run([], { STUB_BREW_VERSIONS: "0.1.3", STUB_BREW_STABLE: '"0.2.0"' });
  assert.equal(stable.code, 0, stable.stderr);
  assert.deepEqual((await f.calls()).slice(2), ["brew upgrade codex-companion", "codex-companion agent install"]);

  const g = await fixture(t);
  await g.registerLaunchAgent(["/opt/homebrew/opt/codex-companion/bin/codex-companion", "agent"]);
  const failed = await g.run([], { STUB_BREW_VERSIONS: "HEAD-de62245", STUB_BREW_STABLE: '"0.2.0"', STUB_BREW_INSTALL_FAIL: "1" });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /安装正式版失败/);
  assert.deepEqual((await g.calls()).slice(2), [
    "brew uninstall --ignore-dependencies codex-companion",
    "brew install codex-companion",
    "brew install --HEAD codex-companion"
  ], "失败后不注册后台服务");
});

test("升级脚本：后台服务没注册时只升级 Homebrew 包，提示自己注册", darwinOnly, async t => {
  const f = await fixture(t);
  const result = await f.run([], { STUB_BREW_VERSIONS: "0.1.3", STUB_BREW_STABLE: '"0.2.0"' });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /还没注册，需要时执行：codex-companion agent install/);
  assert.deepEqual((await f.calls()).slice(2), ["brew upgrade codex-companion"]);
});

test("升级脚本：源码安装快进 main 并 npm ci / npm start，生成文件的改动先还原", posixOnly, async t => {
  const f = await fixture(t);
  const { clone, upstream, gitEnv } = await f.sourceInstall();
  const generated = join(clone, "src", "renderer-embedded.generated.mjs");
  await writeFile(generated, "export default 2;\n");
  const result = await f.run([], gitEnv);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /完成：Codex Companion 0\.2\.0/);
  assert.equal(await f.git(clone, "rev-parse", "HEAD"), await f.git(upstream, "rev-parse", "main"));
  assert.equal(await readFile(generated, "utf8"), "export default 1;\n");
  assert.deepEqual((await f.calls()).filter(line => /^(?:npm|brew)/.test(line)), [
    "npm ci", `npm-cwd ${clone}`, "npm start", `npm-cwd ${clone}`
  ]);
});

test("升级脚本：源码仓库有改动或不在 main 时不动仓库；--dry-run 只打印", posixOnly, async t => {
  const f = await fixture(t);
  const { clone, gitEnv } = await f.sourceInstall();
  const before = await f.git(clone, "rev-parse", "HEAD");

  await writeFile(join(clone, "package.json"), '{"version":"0.1.3-local"}\n');
  const dirty = await f.run([], gitEnv);
  assert.equal(dirty.code, 1);
  assert.match(dirty.stderr, /有未提交的改动.*package\.json/);
  await f.git(clone, "checkout", "--", "package.json");

  await f.git(clone, "checkout", "-q", "-b", "feature/x");
  const branch = await f.run([], gitEnv);
  assert.equal(branch.code, 1);
  assert.match(branch.stderr, /当前在 feature\/x 上，切回 main/);
  await f.git(clone, "checkout", "-q", "main");

  const dry = await f.run(["--dry-run"], gitEnv);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /\+ git pull --ff-only origin main\n\+ npm ci\n\+ npm start\n/);
  assert.equal(await f.git(clone, "rev-parse", "HEAD"), before);
  assert.deepEqual(await f.calls(), [], "三次都没有执行任何改动");
});

test("升级脚本：找不到安装时说明怎么带上仓库路径", posixOnly, async t => {
  const f = await fixture(t);
  await f.stub(join(f.bin, "uname"), "echo Linux");
  const result = await f.run([], { CODEX_COMPANION_BREW: join(f.root, "no-brew") });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /没找到已安装的 Codex Companion.*bash -s -- \/path\/to\/codex_companion/);
  assert.match((await f.run(["--bogus"])).stderr, /未知参数 --bogus/);
});
