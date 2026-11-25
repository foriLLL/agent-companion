import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { cardsArtifact } from "../src/agent/session.mjs";
import { CdpConnection } from "../src/cdp-connection.mjs";
import { CardCatalog, defaultCardRoots } from "../src/platform/cards/catalog.mjs";
import { filterCodexTargets, listCdpTargets } from "../src/targets.mjs";

// Codex 宿主适配自检：Codex 升级后运行 `npm run check:host`，看 Companion 的每项适配落在哪一级。
// 只读：只对正在运行的 Codex 页面执行查询表达式，不改动页面，也不启动 / 退出 / 显示 Codex。
// 端口默认取自后台服务（agent status），也可以用 --port 指定。

const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

// Companion 用到的 Codex 内部命名。缺失不一定出问题（都有不依赖它们的后备），但意味着已经降级。
export const HOST_HOOKS = [
  { selector: "[data-thread-user-message-navigation-content]", use: "会话列（判档用的会话区宽度）" },
  { selector: "[data-request-input-activity-root]", use: "会话布局根（原生平移变量写在这里）" },
  { selector: '[class*="shiftWithTranscript"]', use: "原生平移样式（与 Summary 一致地推开对话流）" },
  { selector: "[data-thread-summary-panel-toggle]", use: "Summary 开关（顶栏入口的首选位置）" },
  { selector: "[data-app-action-sidebar-thread-row]", use: "侧栏会话条目（任务看板的标记与定位）" },
  { selector: "#app-shell-sidebar", use: "侧栏容器（任务看板只监听侧栏变化）" }
];

// 在页面里执行；必须自包含。
function probe(hooks) {
  const visible = (node) => { const rect = node.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; };
  const companion = globalThis.__AGENT_COMPANION__;
  let diagnostics = null;
  try { diagnostics = companion?.runtime?.getDiagnostics?.() ?? null; } catch {}
  const composer = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]')).some(visible);
  return {
    injected: Boolean(companion),
    artifactHash: diagnostics?.artifactHash ?? companion?.artifactHash ?? null,
    adapter: diagnostics?.adapter ?? null,
    errors: (diagnostics?.errors ?? []).length,
    composer,
    hooks: hooks.map(({ selector }) => {
      const nodes = Array.from(document.querySelectorAll(selector));
      return { selector, total: nodes.length, visible: nodes.filter(visible).length };
    })
  };
}

export function summarize(result, { expectedHash = null } = {}) {
  const lines = [];
  const degraded = [];
  const adapter = result.adapter;
  if (!result.injected || !adapter) {
    return { lines: ["Companion 没有注入到这个页面：先确认后台服务在运行（node src/cli.mjs agent status）。"], degraded: ["未注入"] };
  }
  const hashNote = expectedHash && result.artifactHash !== expectedHash ? "（与本地源码不一致，重启后台服务后再查）" : "";
  lines.push(`Companion   已注入 ${String(result.artifactHash ?? "").slice(0, 12)}${hashNote}`);

  const entry = { summary: "顶栏，Summary 开关旁", share: "顶栏，分享按钮旁", trailing: "顶栏，最右侧按钮旁", floating: "右上角悬浮按钮" }[adapter.entry] ?? "当前页面不显示入口";
  lines.push(`入口        ${entry}`);
  if (adapter.entry === "floating") degraded.push("顶栏里找不到可放入口的位置，入口改为悬浮按钮");

  const thread = { hooks: "按 Codex 具名钩子识别", composer: "按输入框位置识别（具名钩子缺失）" }[adapter.thread] ?? "当前页面没有会话区";
  lines.push(`会话区      ${thread}`);
  if (adapter.thread === "composer") degraded.push("会话区的具名钩子缺失，改按输入框定位");
  if (!adapter.thread && !result.composer) lines.push("            页面上也没有输入框；若这是普通会话页，抽屉只能浮在会话上方");

  const room = { native: "原生平移，与 Summary 一致", pad: "主面板右侧留白（原生平移不可用）", clamp: "限制主面板宽度（原生平移与留白都不可用）" }[adapter.room]
    ?? (adapter.visible ? "未让位（宽窗留白足够，或浮层档）" : "抽屉未打开，打开后才能判断");
  lines.push(`让位        ${room}`);
  if (adapter.room === "pad" || adapter.room === "clamp") degraded.push("原生平移不可用，改用通用让位");
  if (adapter.roomFallbacks > 0) lines.push(`            本次注入后有 ${adapter.roomFallbacks} 次让位方式实测不生效并自动降级`);

  const layout = { chunk: "原生模块（独立分包）", runtime: "原生模块（打包运行时）", builtin: "内置公式（找不到原生模块）" }[adapter.layoutSource] ?? adapter.layoutSource;
  lines.push(`判档公式    ${layout}`);
  if (adapter.layoutSource === "builtin") degraded.push("找不到原生布局模块，判档用内置公式（阈值可能与新版 Summary 不同）");
  if (result.errors > 0) { lines.push(`运行错误    ${result.errors} 条（见页面诊断 errors）`); degraded.push("运行时有错误记录"); }

  lines.push("", "Codex 内部命名（缺失的项已有后备，但说明这一版改了结构）");
  for (const hook of result.hooks) {
    const { use } = HOST_HOOKS.find((item) => item.selector === hook.selector) ?? {};
    lines.push(`  ${hook.total > 0 ? "✓" : "✗"} ${hook.selector}  ×${hook.total}  ${use ?? ""}`);
  }
  const sidebar = result.hooks.find((hook) => hook.selector === "[data-app-action-sidebar-thread-row]");
  if (sidebar && sidebar.total === 0) degraded.push("侧栏会话条目识别不到：任务看板无法标记、定位会话（侧栏收起时属正常）");
  return { lines, degraded };
}

async function resolvePort(argv) {
  const index = argv.indexOf("--port");
  if (index >= 0) return Number(argv[index + 1]);
  const { stdout } = await promisify(execFile)(process.execPath, [cli, "agent", "status"]);
  const status = JSON.parse(stdout);
  if (!status.codex?.running || !status.codex?.port) throw new Error("后台服务没有连接到正在运行的 Codex。先打开 Codex，或用 --port 指定调试端口。");
  return status.codex.port;
}

// 本地的注入产物身份：平台代码 + 当前卡片目录（内置 + 用户安装），与后台服务算法一致。
async function localArtifactHash() {
  try {
    const catalog = new CardCatalog({ roots: defaultCardRoots(), logger: { warn() {} } });
    await catalog.load();
    return cardsArtifact(catalog, "codex").hash;
  } catch {
    return null;
  }
}

async function main(argv) {
  const port = await resolvePort(argv);
  const targets = filterCodexTargets(await listCdpTargets(port));
  if (!targets.length) throw new Error(`端口 ${port} 上没有 Codex 页面。`);
  const expectedHash = await localArtifactHash();
  let degradedTotal = 0;
  for (const target of targets) {
    const connection = new CdpConnection(target.webSocketDebuggerUrl);
    await connection.connect();
    try {
      const response = await connection.send("Runtime.evaluate", {
        expression: `(${probe.toString()})(${JSON.stringify(HOST_HOOKS)})`, returnByValue: true
      });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
      const { lines, degraded } = summarize(response.result.value, { expectedHash });
      console.log(`\n[${(target.title || target.url).slice(0, 60)}]`);
      for (const line of lines) console.log(line);
      console.log(degraded.length ? `\n结论：${degraded.length} 项降级\n${degraded.map((item) => `  - ${item}`).join("\n")}` : "\n结论：全部命中，没有降级。");
      degradedTotal += degraded.length;
    } finally {
      connection.close();
    }
  }
  // 降级不算失败（功能仍可用）；退出码 2 方便脚本在 Codex 升级后发现需要跟进。
  if (degradedTotal > 0) process.exitCode = 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[check-host] ${error.message}`);
    process.exitCode = 1;
  });
}
