import { posixOnlyTest as test } from "./helpers/platform.mjs";
import assert from "node:assert/strict";
import { access, lstat, mkdir, readdir, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { migrateLegacyDataDir, normalizeLegacyEnv } from "../src/platform/legacy-names.mjs";
import { companionDataDir } from "../src/platform/paths.mjs";
import { AGENT_LABEL, handoffLegacyAgent, installAgent, LEGACY_AGENT_LABEL, runAgentCommand, uninstallAgent } from "../src/agent/launch-agent.mjs";
import { LEGACY_DESKTOP_MARKER, LEGACY_SYSTEMD_UNIT, linuxLocations, SYSTEMD_UNIT } from "../src/agent/linux-service.mjs";
import { hasHint, hasPlanTool, withHint, withoutHint, withoutPlanTool, withPlanTool, PLAN_HINT_START } from "../src/codex-plan-hint.mjs";
import { configStore, stateStore, temporary } from "./helpers/agent.mjs";

const macOnly = { skip: process.platform !== "darwin" && "LaunchAgent 仅适用于 macOS" };

test("旧环境变量映射到 AGENT_COMPANION_*，新名字已设置时不覆盖", () => {
  /** @type {Record<string, string>} */
  const env = {
    CODEX_COMPANION_FFMPEG: "/old/ffmpeg",
    CODEX_COMPANION_CONFIG_PATH: "/old/config.json",
    AGENT_COMPANION_CONFIG_PATH: "/new/config.json",
    UNRELATED: "x"
  };
  assert.equal(normalizeLegacyEnv(env), env);
  assert.equal(env.AGENT_COMPANION_FFMPEG, "/old/ffmpeg");
  assert.equal(env.AGENT_COMPANION_CONFIG_PATH, "/new/config.json");
  assert.equal(env.CODEX_COMPANION_FFMPEG, "/old/ffmpeg", "旧变量保留，老进程或子进程仍可读");
  assert.deepEqual(Object.keys(env).filter(key => key.startsWith("AGENT_")).sort(), ["AGENT_COMPANION_CONFIG_PATH", "AGENT_COMPANION_FFMPEG"]);
});

test("旧数据目录整体改名到新目录，并在旧位置留软链", async t => {
  const home = await temporary(t);
  for (const platform of ["darwin", "linux"]) {
    const legacy = companionDataDir(home, { platform, env: {}, name: "codex-companion" });
    const target = companionDataDir(home, { platform, env: {} });
    await mkdir(join(legacy, "hongguo"), { recursive: true });
    await writeFile(join(legacy, "config-v2.json"), "{\"revision\":7}");
    await writeFile(join(legacy, "hongguo", "anonymous.json"), "{}");

    const result = await migrateLegacyDataDir({ home, platform, env: {} });
    assert.deepEqual(result, { migrated: true, from: legacy, to: target });
    assert.equal(await readFile(join(target, "config-v2.json"), "utf8"), "{\"revision\":7}");
    await access(join(target, "hongguo", "anonymous.json"));
    assert.ok((await lstat(legacy)).isSymbolicLink());
    assert.equal(await readlink(legacy), "agent-companion");
    assert.equal(await readFile(join(legacy, "config-v2.json"), "utf8"), "{\"revision\":7}", "旧路径经软链仍能读到同一份数据");

    // 再次启动：旧位置已是软链，什么都不做。
    assert.equal((await migrateLegacyDataDir({ home, platform, env: {} })).reason, "already-migrated");
  }
});

test("新目录已存在时逐项合并：缺的搬过去、相同的去重、冲突的两边都保留", async t => {
  const home = await temporary(t);
  assert.equal((await migrateLegacyDataDir({ home, platform: "linux", env: {} })).reason, "no-legacy");

  const legacy = companionDataDir(home, { platform: "linux", env: {}, name: "codex-companion" });
  const target = companionDataDir(home, { platform: "linux", env: {} });
  await mkdir(join(legacy, "hongguo"), { recursive: true });
  await writeFile(join(legacy, "config-v2.json"), "old");
  await writeFile(join(legacy, "emby.json"), "same");
  await writeFile(join(legacy, "hongguo", "a.json"), "{}");
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "config-v2.json"), "new");
  await writeFile(join(target, "emby.json"), "same");

  const first = await migrateLegacyDataDir({ home, platform: "linux", env: {} });
  assert.deepEqual(first, { migrated: true, merged: true, conflicts: ["config-v2.json"], from: legacy, to: target, reason: "conflicts" });
  await access(join(target, "hongguo", "a.json"));
  assert.equal(await readFile(join(target, "config-v2.json"), "utf8"), "new");
  assert.equal(await readFile(join(legacy, "config-v2.json"), "utf8"), "old", "冲突项不覆盖，旧目录保留");
  assert.deepEqual((await readdir(legacy)).sort(), ["config-v2.json"], "相同内容的旧副本已删除");
  assert.equal((await lstat(legacy)).isDirectory(), true, "还有冲突时不换成软链");

  // 冲突解决后（用户删掉旧文件）再启动，旧目录搬空并换成软链。
  await rm(join(legacy, "config-v2.json"));
  const second = await migrateLegacyDataDir({ home, platform: "linux", env: {} });
  assert.deepEqual(second, { migrated: true, merged: true, from: legacy, to: target });
  assert.ok((await lstat(legacy)).isSymbolicLink());

  const other = await temporary(t);
  const file = companionDataDir(other, { platform: "darwin", env: {}, name: "codex-companion" });
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, "not a directory");
  assert.equal((await migrateLegacyDataDir({ home: other, platform: "darwin", env: {} })).reason, "legacy-not-directory");
});

function launchctlRecorder(calls, { loaded = new Set() } = {}) {
  return async (file, args) => {
    assert.equal(file, "/bin/launchctl");
    calls.push(args);
    const [verb, target] = args;
    if (verb === "bootout") {
      const label = target.split("/").pop();
      if (!loaded.has(label)) throw Object.assign(new Error("not loaded"), { code: 3 });
      loaded.delete(label);
    } else if (verb === "bootstrap") {
      loaded.add((await readFile(args[2], "utf8")).match(/<key>Label<\/key><string>([^<]+)</)[1]);
    }
    return { stdout: "" };
  };
}

test("install 卸掉改名前的旧服务并删除旧 plist，卸载时同样清理", macOnly, async t => {
  const home = await temporary(t);
  const plistDir = join(home, "Library/LaunchAgents");
  const legacyPlist = join(plistDir, `${LEGACY_AGENT_LABEL}.plist`);
  await mkdir(plistDir, { recursive: true });
  await writeFile(legacyPlist, "old plist");
  const loaded = new Set([LEGACY_AGENT_LABEL]);
  const calls = [];
  const base = { hostPlatform: "darwin", home, helperPath: null, env: {}, uid: 501, isBun: true, execPath: "/fake/companion",
    execFileImpl: launchctlRecorder(calls, { loaded }) };

  const result = await installAgent(base);
  assert.equal(result.legacyRemoved, LEGACY_AGENT_LABEL);
  assert.deepEqual(calls.map(args => args.slice(0, 2)), [
    ["bootout", `gui/501/${LEGACY_AGENT_LABEL}`],
    ["bootout", `gui/501/${AGENT_LABEL}`],
    ["bootstrap", "gui/501"]
  ]);
  await assert.rejects(access(legacyPlist), { code: "ENOENT" });
  assert.deepEqual([...loaded], [AGENT_LABEL]);

  // 自定义标签（测试或调试安装）不能顺手卸掉用户真实的服务。
  await writeFile(legacyPlist, "old plist");
  calls.length = 0;
  await installAgent({ ...base, label: "local.test.agent" });
  assert.equal(calls.some(args => args[1]?.endsWith(LEGACY_AGENT_LABEL)), false);
  await access(legacyPlist);

  calls.length = 0;
  const removed = await uninstallAgent({ ...base, configStore: configStore(), runtimeState: stateStore(),
    fallbackSnapshot: async () => ({ apps: [] }), planHint: { set: async () => false } });
  assert.equal(removed.legacyRemoved, LEGACY_AGENT_LABEL);
  await assert.rejects(access(legacyPlist), { code: "ENOENT" });
});

test("被旧标签拉起时先注册新服务，再删旧 plist、bootout 旧标签，不进入常驻流程", macOnly, async t => {
  const home = await temporary(t);
  const plistDir = join(home, "Library/LaunchAgents");
  const legacyPlist = join(plistDir, `${LEGACY_AGENT_LABEL}.plist`);
  await mkdir(plistDir, { recursive: true });
  await writeFile(legacyPlist, "old plist");
  const loaded = new Set([LEGACY_AGENT_LABEL]);
  const calls = [];
  const env = { XPC_SERVICE_NAME: LEGACY_AGENT_LABEL, AGENT_COMPANION_AGENT_PROGRAM: "/opt/homebrew/opt/agent-companion/bin/agent-companion" };
  const options = { hostPlatform: "darwin", home, helperPath: null, env, uid: 501, execFileImpl: launchctlRecorder(calls, { loaded }),
    logger: { info() {}, error() {} } };

  assert.equal(await handoffLegacyAgent(options), true);
  assert.deepEqual(calls.map(args => args[0]), ["bootstrap", "bootout"]);
  assert.deepEqual(calls[1], ["bootout", `gui/501/${LEGACY_AGENT_LABEL}`]);
  const plist = await readFile(join(plistDir, `${AGENT_LABEL}.plist`), "utf8");
  assert.ok(plist.includes("<string>/opt/homebrew/opt/agent-companion/bin/agent-companion</string><string>agent</string>"));
  await assert.rejects(access(legacyPlist), { code: "ENOENT" });
  assert.deepEqual([...loaded], [AGENT_LABEL]);

  // 交接成功后 agent 命令直接返回，不进入常驻流程。
  assert.deepEqual(await runAgentCommand(undefined, { ...options, handoffImpl: async () => true }), { running: false, reason: "handed-off" });
});

test("交接注册失败时撤回新 plist，继续以旧标签运行；不是旧标签或不在 macOS 时不交接", macOnly, async t => {
  const home = await temporary(t);
  const plistDir = join(home, "Library/LaunchAgents");
  const legacyPlist = join(plistDir, `${LEGACY_AGENT_LABEL}.plist`);
  await mkdir(plistDir, { recursive: true });
  await writeFile(legacyPlist, "old plist");
  const failure = Object.assign(new Error("bootstrap failed"), { code: 37 });
  const calls = [];
  const options = { hostPlatform: "darwin", home, helperPath: null, uid: 501, isBun: true, execPath: "/fake/companion",
    env: { XPC_SERVICE_NAME: LEGACY_AGENT_LABEL }, logger: { info() {}, error() {} },
    execFileImpl: async (_file, args) => { calls.push(args[0]); throw failure; } };

  assert.equal(await handoffLegacyAgent(options), false);
  assert.deepEqual(calls, ["bootstrap"]);
  await assert.rejects(access(join(plistDir, `${AGENT_LABEL}.plist`)), { code: "ENOENT" });
  assert.equal(await readFile(legacyPlist, "utf8"), "old plist");

  calls.length = 0;
  assert.equal(await handoffLegacyAgent({ ...options, env: { XPC_SERVICE_NAME: AGENT_LABEL } }), false);
  assert.equal(await handoffLegacyAgent({ ...options, env: {} }), false);
  assert.equal(await handoffLegacyAgent({ ...options, hostPlatform: "linux" }), false);
  assert.deepEqual(calls, []);
});

test("Linux install 停用并删除改名前的单元，接管旧标记的菜单入口", async t => {
  const home = await temporary(t);
  const env = { XDG_DATA_DIRS: join(home, "system") };
  await mkdir(join(home, "system", "applications"), { recursive: true });
  await writeFile(join(home, "system", "applications", "chatgpt.desktop"), "[Desktop Entry]\nName=ChatGPT\nExec=chatgpt %U\n");
  const locations = linuxLocations({ home, env });
  await mkdir(join(locations.unitPath, ".."), { recursive: true });
  await writeFile(locations.legacyUnitPath, "[Service]\nExecStart=\"/old\" \"agent\"\n");
  await mkdir(locations.applicationsDir, { recursive: true });
  await writeFile(locations.desktopPath, `[Desktop Entry]\n${LEGACY_DESKTOP_MARKER}\nExec=/old open-codex %U\n`);
  const calls = [];
  const options = { hostPlatform: "linux", home, env, execPath: "/fake/node", cliPath: "/repo/cli.mjs", isBun: false,
    execFileImpl: async (file, args) => { calls.push([file, ...args]); return { stdout: "" }; } };

  const result = await installAgent(options);
  assert.equal(result.legacyRemoved, LEGACY_SYSTEMD_UNIT);
  await assert.rejects(stat(locations.legacyUnitPath), { code: "ENOENT" });
  assert.deepEqual(calls.filter(call => call[0] === "systemctl").map(call => call.slice(2)), [
    ["disable", "--now", LEGACY_SYSTEMD_UNIT],
    ["daemon-reload"],
    ["enable", SYSTEMD_UNIT],
    ["restart", SYSTEMD_UNIT]
  ]);
  const desktop = await readFile(locations.desktopPath, "utf8");
  assert.ok(desktop.includes("Exec=/fake/node /repo/cli.mjs open-codex %U"));
  assert.equal(desktop.includes(LEGACY_DESKTOP_MARKER), false, "旧标记换成新标记");
});

test("计划提示认改名前的标记：开启时换成新标记，关闭时一并删除", () => {
  const legacyHint = "# 我的规则\n\n<!-- codex-companion:plan-hint 由 Codex Companion 维护 -->\n旧内容\n<!-- /codex-companion:plan-hint -->\n";
  assert.equal(hasHint(legacyHint), true);
  assert.equal(withoutHint(legacyHint), "# 我的规则\n");
  const upgraded = withHint(legacyHint);
  assert.equal(upgraded.includes("codex-companion:plan-hint"), false);
  assert.ok(upgraded.startsWith(`# 我的规则\n\n${PLAN_HINT_START}\n`));

  const mixed = "<!-- codex-companion:plan-hint x -->\na\n<!-- /agent-companion:plan-hint -->\n";
  assert.equal(hasHint(mixed), false, "开始和结束标记必须是同一个名字");

  const legacyTool = "model = \"x\"\n\n# codex-companion:plan-tool 由 Codex Companion 维护\n[tools.update_plan]\nenabled = true\n";
  assert.equal(hasPlanTool(legacyTool), true);
  assert.equal(withPlanTool(legacyTool), legacyTool, "已经打开时不重复追加");
  assert.equal(withoutPlanTool(legacyTool), "model = \"x\"\n");
});
