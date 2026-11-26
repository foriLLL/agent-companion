import { homedir } from "node:os";
import { resolve } from "node:path";
import { CompanionConfig } from "./companion-config.mjs";
import { buildCardRenderer } from "./platform/cards/build.mjs";
import { CardCatalog, builtinCardsDir, userCardsDir } from "./platform/cards/catalog.mjs";
import { installCard, linkCard, readInstallRecords, removeCard, updateCard } from "./platform/cards/manage.mjs";
import { createCard } from "./platform/cards/scaffold.mjs";
import { companionDataDir } from "./platform/paths.mjs";

export const CARDS_HELP = `
卡片插件：

  agent-companion cards list [--json]                 已安装的卡片（内置 + 自己安装的）与加载问题
  agent-companion cards install <来源> [--ref <tag|分支|commit>] [--path <子目录>] [--force]
        来源：owner/repo[@ref]、https / ssh 的 git 地址，或本地目录
  agent-companion cards update [<id>...] [--ref <ref>]  按安装来源重新获取（不写 id 时更新全部）
  agent-companion cards remove <id> [--purge]          卸载；--purge 同时删除它的数据
  agent-companion cards link [<目录>] [--force]         开发用：把卡片目录链接进来，改动几秒内生效
  agent-companion cards build [<目录>]                  把 renderer.mjs 打包成 renderer.js（需要 Bun）
  agent-companion cards create <id> [--title 名称] [--service] [--dir 目录]
        新建独立插件仓库骨架（缺省建在 ./<id>）

在 GitHub 搜索 topic:agent-companion-card 可以找到别人写的卡片。插件代码以你的用户权限运行，只安装信任的来源。
安装、卸载、更新后，运行中的后台服务几秒内自动载入，新安装的卡片缺省关闭，在 Companion 设置里启用。
`;

const FLAGS = {
  list: { "--json": "json" },
  install: { "--ref": ["ref"], "--path": ["path"], "--force": "force" },
  update: { "--ref": ["ref"] },
  remove: { "--purge": "purge" },
  link: { "--force": "force" },
  build: {},
  create: { "--title": ["title"], "--service": "service", "--dir": ["dir"] }
};

export function parseCardsArgs(argv) {
  const [subcommand = "list", ...rest] = argv;
  if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") return { subcommand: "help" };
  const flags = FLAGS[subcommand];
  if (!flags) throw new Error(`cards 子命令无效：${subcommand}（可用：${Object.keys(FLAGS).join(" / ")}）`);
  const options = { subcommand, args: [] };
  while (rest.length) {
    const arg = rest.shift();
    if (arg === "--help" || arg === "-h") return { subcommand: "help" };
    const flag = flags[arg];
    if (Array.isArray(flag)) {
      const value = rest.shift();
      if (!value || value.startsWith("--")) throw new Error(`${arg} 必须提供值`);
      options[flag[0]] = value;
    } else if (flag) options[flag] = true;
    else if (arg.startsWith("-")) throw new Error(`cards ${subcommand} 不支持参数 ${arg}`);
    else options.args.push(arg);
  }
  const arity = { list: [0, 0], install: [1, 1], update: [0, Infinity], remove: [1, 1], link: [0, 1], build: [0, 1], create: [1, 1] }[subcommand];
  if (options.args.length < arity[0] || options.args.length > arity[1]) throw new Error(`cards ${subcommand} 参数个数不对，见 agent-companion cards --help`);
  return options;
}

function describe(card) {
  const capabilities = card.manifest.capabilities.length ? card.manifest.capabilities.join(", ") : "无";
  return `${card.manifest.title}（${card.id}）能力：${capabilities}${card.service ? "；含后台服务（在后台进程里以你的用户权限运行）" : ""}`;
}

async function disableCard(configStore, id) {
  if (typeof configStore.patch !== "function") return;
  for (let attempt = 0; ; attempt++) {
    const config = await configStore.loadV2();
    const raw = config?.cards?.[id];
    if ((typeof raw === "boolean" ? raw : raw?.enabled) !== true || !Number.isSafeInteger(config.revision)) return;
    try {
      await configStore.patch({ cards: { [id]: { enabled: false } } }, { expectedRevision: config.revision });
      return;
    } catch (error) {
      if (error?.code !== "CONFIG_CONFLICT" || attempt >= 2) throw error;
    }
  }
}

/**
 * cards 命令。dependencies 供测试替换：home、env、platform、cwd、out（{ log, error }）、isTTY、
 * catalogFactory、configStore、execFileImpl、build。
 */
export async function runCardsCommand(argv, dependencies = {}) {
  const options = parseCardsArgs(argv);
  const out = dependencies.out ?? console;
  if (options.subcommand === "help") { out.log(CARDS_HELP.trim()); return null; }
  const env = dependencies.env ?? process.env;
  const platform = dependencies.platform ?? process.platform;
  const home = dependencies.home ?? homedir();
  const cwd = dependencies.cwd ?? process.cwd();
  const dataRoot = companionDataDir(home, { platform, env });
  const builtinDir = dependencies.builtinDir ?? builtinCardsDir({ env });
  const userDir = dependencies.userDir ?? userCardsDir({ dataDir: dataRoot, env });
  const catalog = (dependencies.catalogFactory ?? (roots => new CardCatalog({ roots, logger: { warn() {} } })))([
    { dir: builtinDir, source: "builtin" }, { dir: userDir, source: "user" }
  ]);
  await catalog.load();
  const builtinIds = catalog.list().filter(card => card.source === "builtin" || card.overrides === "builtin").map(card => card.id);
  const common = { userDir, builtinIds, execFileImpl: dependencies.execFileImpl, build: dependencies.build };

  switch (options.subcommand) {
    case "list": {
      const configStore = dependencies.configStore ?? new CompanionConfig({ path: env.AGENT_COMPANION_CONFIG_PATH });
      const config = await configStore.loadV2().catch(() => null);
      const installs = await readInstallRecords(userDir);
      const manifests = catalog.manifests();
      const enabledOf = (manifest) => {
        const raw = config?.cards?.[manifest.id];
        return typeof raw === "boolean" ? raw : raw?.enabled ?? manifest.defaultEnabled;
      };
      const json = options.json || !(dependencies.isTTY ?? process.stdout.isTTY);
      if (json) {
        // 设置 App 读这份 JSON：保持 manifest 数组的形状，只追加字段。
        out.log(JSON.stringify(manifests.map(manifest => {
          const card = catalog.get(manifest.id);
          return { ...manifest, source: card.source, enabled: enabledOf(manifest), dir: card.dir,
            ...(card.linked ? { linked: card.linked } : {}), ...(installs[manifest.id] ? { install: installs[manifest.id] } : {}) };
        })));
        return manifests;
      }
      for (const manifest of manifests) {
        const card = catalog.get(manifest.id);
        const from = card.linked ? `链接 → ${card.linked}` : installs[manifest.id]
          ? `${installs[manifest.id].source}${installs[manifest.id].ref ? `@${installs[manifest.id].ref}` : ""}` : card.source === "builtin" ? "内置" : "本地";
        out.log(`${enabledOf(manifest) ? "●" : "○"} ${manifest.id.padEnd(16)} ${manifest.title}  [${from}]${card.overrides ? "（覆盖内置版本）" : ""}`);
      }
      for (const problem of catalog.problems) out.log(`✕ ${String(problem.id ?? problem.dir).padEnd(16)} 未加载：${problem.message}`);
      out.log(`\n内置卡片目录：${builtinDir}\n用户卡片目录：${userDir}`);
      return manifests;
    }
    case "install": {
      const result = await installCard({ ...common, source: options.args[0], ref: options.ref ?? null, path: options.path ?? null, force: options.force === true, cwd });
      out.log(`已${result.replaced ? "重新" : ""}安装 ${describe(result.card)}${result.commit ? `，版本 ${result.commit.slice(0, 12)}` : ""}`);
      if (result.overridesBuiltin) out.log("它和一张内置卡片同 id，会覆盖内置版本；cards remove 即恢复内置版本。");
      out.log("新安装的卡片缺省关闭：在 Codex 卡片区的 Companion 设置里启用。后台服务运行中时几秒内自动载入。");
      return result;
    }
    case "update": {
      const installs = await readInstallRecords(userDir);
      const ids = options.args.length ? options.args : Object.keys(installs);
      if (ids.length === 0) { out.log("没有通过 install 安装的卡片。"); return []; }
      const results = [];
      for (const id of ids) {
        try {
          const result = await updateCard({ ...common, id, ref: options.ref });
          results.push(result);
          if (result.skipped === "linked") out.log(`${id}：是开发链接（→ ${result.linked}），跳过`);
          else out.log(`${id}：${result.previous && result.previous === result.commit ? "已是最新" : `已更新${result.commit ? ` 到 ${result.commit.slice(0, 12)}` : ""}`}`);
        } catch (error) {
          results.push({ id, error });
          out.error(`${id}：更新失败：${error.message}`);
        }
      }
      if (results.some(result => result.error)) process.exitCode = 1;
      return results;
    }
    case "remove": {
      const result = await removeCard({ ...common, id: options.args[0], dataRoot, purgeData: options.purge === true });
      // 和设置页的卸载一致：关掉开关，以后重新安装仍然缺省关闭；恢复内置版本时开关属于内置卡片，不动。
      if (!result.restoresBuiltin) {
        const configStore = dependencies.configStore ?? new CompanionConfig({ path: env.AGENT_COMPANION_CONFIG_PATH });
        await disableCard(configStore, result.id).catch(error => out.error(`卸载后关闭 ${result.id} 的开关失败：${error.message}`));
      }
      out.log(`已${result.linked ? "删除开发链接" : "卸载"} ${result.id}${options.purge ? "，并删除了它的数据" : ""}${result.restoresBuiltin ? "；恢复使用内置版本" : ""}`);
      return result;
    }
    case "link": {
      const result = await linkCard({ ...common, dir: resolve(cwd, options.args[0] ?? "."), force: options.force === true, platform });
      out.log(`已链接 ${describe(result.card)}\n${result.dir} → ${result.source}\n改完界面后运行 agent-companion cards build，几秒内生效；后台服务的改动需要重启后台服务（agent-companion agent install）。`);
      return result;
    }
    case "build": {
      const result = await (dependencies.build ?? buildCardRenderer)({ dir: resolve(cwd, options.args[0] ?? ".") });
      out.log(`已生成 ${result.outFile}（${Math.round(result.bytes / 1024)} KB）`);
      return result;
    }
    case "create": {
      const [id] = options.args;
      const result = await createCard({ id, title: options.title ?? id, service: options.service === true,
        cardsDir: resolve(cwd, options.dir ?? id), standalone: true });
      out.log(`已创建 ${result.directory}\n下一步：cd 进去，agent-companion cards build && agent-companion cards link .`);
      return result;
    }
    default:
      throw new Error(`未知子命令 ${options.subcommand}`);
  }
}
