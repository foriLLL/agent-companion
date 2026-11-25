import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CARD_API_VERSION, validateManifest } from "../registry/manifest.mjs";

// 新卡片的骨架：manifest.json、renderer.mjs，可选 service.mjs。模板只用平台给的 ctx / api，
// 不 import 仓库里的任何模块，放进仓库 cards/ 或单独的插件仓库都能用。
const DEFAULT_CARDS_DIR = fileURLToPath(new URL("../../../cards/", import.meta.url));

function rendererSource(title, service) {
  return `// 业务只操作自己的内部 ShadowRoot；卡片外框与相邻间距由平台维护。
export function mount(ctx) {
  if (ctx.signal.aborted) return { dispose() {} };
  const document = ctx.root.ownerDocument;
  const body = document.createElement("section");
  const style = document.createElement("style");
  style.textContent = ":host{display:block}.body{padding:20px;font:13px/1.5 system-ui;color:inherit}.body h2{margin:0 0 12px;font-size:16px}.body button{font:inherit;padding:6px 10px;margin:0 8px 8px 0}.body [role=status]{min-height:1.5em}";
  body.className = "body";
  const heading = document.createElement("h2");
  const increment = document.createElement("button");
  increment.type = "button";
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  body.append(heading, increment, status);
  ctx.root.append(style, body);
  const dispose = () => { style.remove(); body.remove(); };
  ctx.effects.add(dispose);

  // read 返回显式状态；update 重读当前 revision 后写入，不在卸载时覆盖旧快照。
  const store = ctx.storage.namespace("counter", {
    version: 1,
    validate: value => value !== null && typeof value === "object" && Number.isSafeInteger(value.count) && value.count >= 0
  });
  const loaded = store.read({ count: 0 });
  let count = loaded.value.count;
  function renderCount() { increment.textContent = "本窗口计数：" + count; }
  function updateSettings(settings = {}) {
    heading.textContent = typeof settings.label === "string" ? settings.label : (ctx.manifest?.title ?? ${JSON.stringify(title)});
  }
  updateSettings(ctx.settings);
  renderCount();
  if (!loaded.ok) status.textContent = "存档读取失败，原数据已保留。";
  ctx.effects.listen(increment, "click", () => {
    try {
      const saved = store.update(value => ({ count: (value?.count ?? 0) + 1 }));
      count = saved.value.count;
      renderCount();
      status.textContent = "已保存";
    } catch (error) {
      status.textContent = "保存失败，请重试。";
      ctx.reportError(error);
    }
  });
${service ? `
  // scoped RPC 自动添加本卡命名空间、generation 和卸载取消信号。
  const ping = document.createElement("button");
  ping.type = "button";
  ping.textContent = "检查后台";
  body.append(ping);
  ctx.effects.listen(ping, "click", async () => {
    ping.disabled = true;
    try {
      const reply = await ctx.rpc("ping");
      if (!ctx.signal.aborted) status.textContent = reply.message;
    } catch (error) {
      if (!ctx.signal.aborted) { status.textContent = "后台请求失败，请重试。"; ctx.reportError(error); }
    } finally { if (!ctx.signal.aborted) ping.disabled = false; }
  });
` : `
  // 本模板没有 RPC 能力或服务依赖。需要后端时用 --service 创建模板，
  // 或新增 service.mjs 并声明 rpc capability，然后调用 ctx.rpc("operation")。
`}
  return {
    updateSettings,
    // 收起只改变可见性，不清空状态或停止媒体。需要暂停轮询时在这里自行处理。
    visibilityChanged({ visible }) { body.dataset.visible = String(visible); },
    dispose
  };
}
`;
}

const SERVICE_SOURCE = `// 方法键是卡片内的局部操作名，平台公开为 cardId.ping。
export function createService() {
  return {
    methods: {
      async ping(_params, context) {
        if (context.signal.aborted) throw context.signal.reason;
        return { message: "pong" };
      }
    },
    // 有资源后按平台传入的 targetKey 归属清理，不能清理其他卡或实例。
    disposeTarget(_targetKey) {},
    dispose() {}
  };
}
`;

// 独立插件仓库的说明：怎么打包、怎么安装、怎么让别人搜到。
function readmeSource(id, title) {
  return `# ${title}

[Agent Companion](https://github.com/foriLLL/agent-companion) 卡片插件。

## 安装

\`\`\`sh
agent-companion cards install <你的 GitHub 用户名>/<仓库名>
\`\`\`

装好后在 Codex 卡片区的 Companion 设置里启用「${title}」。

## 开发

- \`renderer.mjs\`：卡片界面，导出 \`mount(ctx)\`；\`service.mjs\`（可选）：后台服务，导出 \`createService(api)\`。
- 打包界面：\`agent-companion cards build\`（生成 \`renderer.js\`，**需要提交进仓库**，安装时不再打包）。
- 本机调试：\`agent-companion cards link .\`，之后每次 \`cards build\` 几秒内生效。
- 在 GitHub 仓库的 Topics 里加上 \`agent-companion-card\`，别人就能搜到它；仓库名建议用 \`agent-companion-card-${id}\`。

规范见 https://github.com/foriLLL/agent-companion/blob/main/cards/README.md 。
`;
}

export async function createCard({ id, title = id, cardsDir = DEFAULT_CARDS_DIR, service = false, standalone = false } = {}) {
  if (typeof id !== "string" || id.length > 64 || !/^[a-z][a-z0-9-]*$/.test(id)
    || ["constructor", "prototype"].includes(id)) throw new Error("id 必须为 1–64 位小写字母开头的字母、数字或连字符，且不能是保留属性名");
  if (typeof title !== "string" || !title.trim() || title.length > 200) throw new Error("title 必须为 1–200 字符的非空标题");
  if (typeof cardsDir !== "string" || !cardsDir) throw new Error("cards 根目录不能为空");
  if (typeof service !== "boolean") throw new Error("service 必须为布尔值");
  const manifest = validateManifest({
    id, title, version: 1, apiVersion: CARD_API_VERSION, defaultEnabled: false, defaultOrder: 100,
    layout: { height: "content", minHeight: 180, scroll: "outer" },
    lifecycle: { hidden: "retain", start: "first-visible" },
    state: { scope: "target", version: 1 },
    capabilities: service ? ["storage", "rpc"] : ["storage"]
  });
  // standalone：cardsDir 本身就是插件仓库目录（manifest.json 在根目录），不再套一层 id。
  const directory = standalone ? resolve(cardsDir) : join(resolve(cardsDir), id);
  await mkdir(standalone ? dirname(directory) : resolve(cardsDir), { recursive: true });
  // mkdir 是不覆盖的原子占位；既有目录、文件、符号链接均直接失败。
  await mkdir(directory);
  try {
    await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    await writeFile(join(directory, "renderer.mjs"), rendererSource(title, service), { flag: "wx" });
    if (service) await writeFile(join(directory, "service.mjs"), SERVICE_SOURCE, { flag: "wx" });
    if (standalone) await writeFile(join(directory, "README.md"), readmeSource(id, title), { flag: "wx" });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return { id, directory, service };
}

