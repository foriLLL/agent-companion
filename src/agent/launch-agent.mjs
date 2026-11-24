import { execFile } from "node:child_process";
import { access, chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createPlanHint } from "../codex-plan-hint.mjs";
import { defaultCodexHome } from "../codex-sessions.mjs";
import { CodexInjector } from "../injector.mjs";
import { createAgentAdapter } from "./adapter.mjs";
import { createAgentDependencies, readAgentStatus, runAgent } from "./main.mjs";
import { isCompanionDebugInstance, parseCodexDebugArgs } from "./codex-args.mjs";
import { resolveNativeHelperPath } from "./native-bridge.mjs";
import { installLinuxAgent, uninstallLinuxAgent } from "./linux-service.mjs";

const execFileAsync = promisify(execFile);
export const AGENT_LABEL = "com.agentcompanion.agent";
// 改名前的标签：老版本登记的服务用它，安装、卸载和自动交接时一并清掉。
export const LEGACY_AGENT_LABEL = "com.codexcompanion.agent";
export const AGENT_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";

export function agentProgramArguments({ execPath = process.execPath,
  cliPath = fileURLToPath(new URL("../cli.mjs", import.meta.url)), isBun = typeof Bun !== "undefined", program } = {}) {
  // Homebrew 等包管理器安装时，由启动脚本给出固定入口：node 与源码的真实路径带版本号，升级后会失效。
  if (program) return [resolve(program), "agent"];
  const compiled = isBun && !/^(?:node|nodejs|bun)(?:\.exe)?$/.test(basename(execPath));
  return compiled ? [resolve(execPath), "agent"] : [resolve(execPath), resolve(cliPath), "agent"];
}

// Linux 应用菜单入口执行的命令：与常驻 agent 同一程序，子命令换成 open-codex。
export function launcherProgramArguments(options = {}) {
  return [...agentProgramArguments(options).slice(0, -1), "open-codex"];
}

// 安装时显式指定的目标应用与配置路径要带给 agent 和菜单入口，否则它们会回到默认位置。
function linuxEnvironment(options, env) {
  const environment = {};
  if (env.AGENT_COMPANION_CODEX_EXECUTABLE) environment.AGENT_COMPANION_CODEX_EXECUTABLE = resolve(env.AGENT_COMPANION_CODEX_EXECUTABLE);
  if (options.configPath ?? env.AGENT_COMPANION_CONFIG_PATH) environment.AGENT_COMPANION_CONFIG_PATH = resolve(options.configPath ?? env.AGENT_COMPANION_CONFIG_PATH);
  return environment;
}

function location({ home = homedir(), plistDir = join(home, "Library", "LaunchAgents"), label = AGENT_LABEL,
  uid = process.getuid?.() ?? 0, logDir = join(home, "Library", "Logs", "agent-companion") } = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(label)) throw new Error("LaunchAgent label 无效");
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error("LaunchAgent uid 无效");
  return { plistDir: resolve(plistDir), label, uid, logDir: resolve(logDir), plistPath: resolve(plistDir, `${label}.plist`) };
}

const xml = text => String(text).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[char]));

export function buildAgentPlist({ label = AGENT_LABEL, programArguments, logDir, environment = {} }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key><array>${programArguments.map(arg => `<string>${xml(arg)}</string>`).join("")}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(join(logDir, "agent.out.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logDir, "agent.err.log"))}</string>
  <key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join("")}</dict>
</dict></plist>
`;
}

async function bootoutAgent(options, { uid, label }) {
  try {
    await (options.execFileImpl ?? execFileAsync)(options.launchctlPath ?? "/bin/launchctl", ["bootout", `gui/${uid}/${label}`]);
  } catch (error) {
    // launchctl 的 ESRCH 表示该 job 已不在域中；其他错误保留 plist 供重试。
    if (Number(error.code) !== 3 && error.code !== "ESRCH") throw error;
  }
}

// 启动脚本用 AGENT_COMPANION_AGENT_PROGRAM 声明后台服务该运行的固定入口。
function withProgram(options, env) {
  const program = options.program ?? env.AGENT_COMPANION_AGENT_PROGRAM;
  return program ? { ...options, program } : options;
}

// bootout 返回时旧进程可能还没退完，这时 bootstrap 会失败并返回 5（Input/output error）；稍等重试，最多约 10 秒。
async function bootstrapAgent(options, { uid, plistPath }) {
  const sleep = options.sleepImpl ?? (ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await (options.execFileImpl ?? execFileAsync)(options.launchctlPath ?? "/bin/launchctl", ["bootstrap", `gui/${uid}`, plistPath]);
    } catch (error) {
      if (Number(error.code) !== 5 || attempt >= 40) throw error;
      await sleep(250);
    }
  }
}

// 把当前进程环境里需要带给后台服务的设置写成 plist；只写文件，不注册。
async function writeAgentPlist(options) {
  const { plistDir, label, uid, logDir, plistPath } = location(options);
  const env = options.env ?? process.env;
  const helperPath = options.helperPath === undefined ? resolveNativeHelperPath({
    env, execPath: options.execPath, cwd: options.cwd, arch: options.arch
  }) : options.helperPath;
  const environment = { PATH: AGENT_PATH };
  if (helperPath) environment.AGENT_COMPANION_NATIVE_HELPER = resolve(helperPath);
  if (env.AGENT_COMPANION_CODEX_APP) environment.AGENT_COMPANION_CODEX_APP = resolve(env.AGENT_COMPANION_CODEX_APP);
  if (options.configPath ?? env.AGENT_COMPANION_CONFIG_PATH) environment.AGENT_COMPANION_CONFIG_PATH = resolve(options.configPath ?? env.AGENT_COMPANION_CONFIG_PATH);
  const plist = buildAgentPlist({ label, logDir, environment, programArguments: agentProgramArguments(options) });
  await mkdir(plistDir, { recursive: true, mode: 0o700 });
  await mkdir(logDir, { recursive: true, mode: 0o700 });
  const temporary = join(plistDir, `.${label}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, plist, { mode: 0o600, flag: "wx" });
    await rename(temporary, plistPath);
    await chmod(plistPath, 0o600);
  } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  return { label, uid, plistPath };
}

// 只有使用默认标签时才处理旧标签：测试或自定义 --label 安装不能顺手卸掉用户真实的服务。
function legacyLocation(options) {
  if (options.label !== undefined && options.label !== AGENT_LABEL) return null;
  return location({ ...options, label: LEGACY_AGENT_LABEL });
}

// 旧 plist 还在才处理：没有老安装时不多调 launchctl。
async function removeLegacyAgent(options) {
  const legacy = legacyLocation(options);
  if (!legacy) return false;
  try { await access(legacy.plistPath); } catch { return false; }
  await bootoutAgent(options, legacy);
  try { await unlink(legacy.plistPath); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

/**
 * 老版本登记的服务（旧标签、旧 opt 路径）升级后会拉起新版本。新版本在做任何事之前先把服务交接给新标签：
 * 写新 plist 并注册（新进程正常抢锁运行），删掉旧 plist，最后 bootout 旧标签——这一步会结束当前进程。
 * 注册失败时撤回新 plist，返回 false，当前进程继续以旧标签运行，下次启动再试。
 */
export async function handoffLegacyAgent(options = {}) {
  const env = options.env ?? process.env;
  if ((options.hostPlatform ?? process.platform) !== "darwin" || env.XPC_SERVICE_NAME !== LEGACY_AGENT_LABEL) return false;
  const logger = options.logger ?? console;
  const current = withProgram({ ...options, label: AGENT_LABEL }, env);
  const legacy = location({ ...current, label: LEGACY_AGENT_LABEL });
  let written;
  try {
    written = await writeAgentPlist(current);
    await bootstrapAgent(current, written);
  } catch (error) {
    logger.error?.(`[agent-companion] 交接到新服务标签失败，继续以旧标签运行：${error.message}`);
    if (written) await unlink(written.plistPath).catch(() => {});
    return false;
  }
  await unlink(legacy.plistPath).catch(error => { if (error.code !== "ENOENT") throw error; });
  logger.info?.(`[agent-companion] 后台服务已交接到 ${AGENT_LABEL}，旧标签 ${LEGACY_AGENT_LABEL} 即将退出`);
  await bootoutAgent(current, legacy);
  return true;
}

export async function installAgent(options = {}) {
  options = withProgram(options, options.env ?? process.env);
  if ((options.hostPlatform ?? process.platform) === "linux") {
    const env = options.env ?? process.env;
    const environment = linuxEnvironment(options, env);
    const launcher = launcherProgramArguments(options);
    return installLinuxAgent({ home: options.home, env: options.env, execFileImpl: options.execFileImpl,
      programArguments: agentProgramArguments(options), environment,
      launcherArguments: Object.keys(environment).length
        ? ["/usr/bin/env", ...Object.entries(environment).map(([key, value]) => `${key}=${value}`), ...launcher] : launcher });
  }
  const { label, uid } = location(options);
  // 升级时先卸载旧 job（含改名前的旧标签），再替换声明；不能把 bootstrap 的任意失败当作重复安装。
  const legacyRemoved = await removeLegacyAgent(options);
  await bootoutAgent(options, { uid, label });
  const { plistPath } = await writeAgentPlist(options);
  await bootstrapAgent(options, { uid, plistPath });
  return { installed: true, label, plistPath, ...(legacyRemoved ? { legacyRemoved: LEGACY_AGENT_LABEL } : {}) };
}

export async function uninstallAgent(options = {}) {
  const linux = (options.hostPlatform ?? process.platform) === "linux";
  const deps = createAgentDependencies(options);
  // 停止服务会触发 agent 清空 attachment，因此提前保留端口，并在卸载前重新核对实例。
  const state = await deps.runtimeState.load();
  let removed;
  if (linux) removed = await uninstallLinuxAgent({ home: options.home, env: options.env, execFileImpl: options.execFileImpl });
  else {
    const { label, uid, plistPath } = location(options);
    await bootoutAgent(options, { uid, label });
    await unlink(plistPath).catch(error => { if (error.code !== "ENOENT") throw error; });
    const legacyRemoved = await removeLegacyAgent(options);
    removed = { label, ...(legacyRemoved ? { legacyRemoved: LEGACY_AGENT_LABEL } : {}) };
  }
  let unmounted = false;
  let unmountError;
  if (state?.port) {
    let injector;
    try {
      const snapshot = await (deps.nativeBridge ? deps.nativeBridge.snapshot() : deps.fallbackSnapshot());
      const app = snapshot.apps.find(app => state.codexKey ? app.key === state.codexKey : app.pid === state.codexPid);
      const parsed = parseCodexDebugArgs(app?.arguments);
      if (app && isCompanionDebugInstance(parsed) && parsed.debugPort === state.port) {
        injector = (options.injectorFactory ?? (port => new CodexInjector(port)))(state.port);
        await injector.injectOnce("unmount");
        unmounted = true;
      }
    } catch (error) { unmountError = String(error.message ?? error); }
    finally { injector?.stop(); }
  }
  // 撤掉「长任务先列计划」写进 Codex 指令文件的提示；只动带 Companion 标记的那一段，失败不影响卸载。
  let planHintRemoved = false;
  try {
    const codexHome = defaultCodexHome({ env: options.env ?? (options.home ? {} : process.env), home: options.home ?? homedir() });
    planHintRemoved = await (options.planHint ?? createPlanHint({ codexHome })).set(false);
  } catch {}
  return { uninstalled: true, ...removed, unmounted, ...(unmountError ? { unmountError } : {}), ...(planHintRemoved ? { planHintRemoved } : {}) };
}

export async function restartCodex(options = {}) {
  const deps = createAgentDependencies(options);
  if (!deps.nativeBridge) return { stopped: false, launched: false, reason: "native-helper-missing" };
  const config = await deps.configStore.loadV2({ strict: true });
  const adapter = createAgentAdapter({ ...options, ...deps, initialConfig: config });
  const now = options.now ?? Date.now;
  const setTimer = options.setTimeoutImpl ?? setTimeout;
  const clearTimer = options.clearTimeoutImpl ?? clearTimeout;
  const sleep = options.sleepImpl ?? (ms => new Promise(resolveSleep => setTimer(resolveSleep, ms)));
  let stopped = false;
  let timer;
  try {
    const snapshot = await adapter.snapshot();
    if (snapshot.apps.length > 1) return { stopped, launched: false, reason: "multiple-instances" };
    const app = snapshot.apps[0];
    if (app) {
      const quit = await adapter.quit({ pid: app.pid, key: app.key, mode: "user" });
      if (!quit.accepted) return { stopped, launched: false, reason: quit.reason ?? "quit-refused" };
      const timeoutMs = Math.min(options.quitTimeoutMs ?? 10_000, 10_000);
      const deadline = now() + timeoutMs;
      const timeout = new Promise((_, reject) => {
        timer = setTimer(() => reject(Object.assign(new Error("等待 Codex 退出超时"), { code: "quit-timeout" })), timeoutMs);
      });
      while (true) {
        if (now() >= deadline) return { stopped, launched: false, reason: "quit-timeout" };
        await Promise.race([sleep(Math.min(200, deadline - now())), timeout]);
        const next = await Promise.race([adapter.snapshot(), timeout]);
        if (now() >= deadline) return { stopped, launched: false, reason: "quit-timeout" };
        if (next.apps.some(entry => entry.key !== app.key)) return { stopped, launched: false, reason: "another-instance" };
        if (!next.apps.length) { stopped = true; break; }
      }
      clearTimer(timer);
    }
    return { stopped, ...await adapter.launch({ hidden: false }) };
  } catch (error) { return { stopped, launched: false, reason: error.code ?? "restart-failed", message: error.message }; }
  finally { clearTimer(timer); }
}

export async function runAgentCommand(subcommand, options = {}) {
  if (!subcommand) {
    // 被旧标签拉起时先交接；交接成功后旧标签被 bootout，当前进程随之结束，不再进入常驻流程。
    if (await (options.handoffImpl ?? handoffLegacyAgent)(options)) return { running: false, reason: "handed-off" };
    return runAgent(options);
  }
  const commands = { install: installAgent, uninstall: uninstallAgent, status: readAgentStatus, "restart-codex": restartCodex };
  if (!commands[subcommand]) throw new Error(`未知 agent 命令：${subcommand}`);
  const result = await commands[subcommand](options);
  (options.output ?? console.log)(JSON.stringify(result));
  return result;
}
