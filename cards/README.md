# 卡片插件

Agent Companion 只提供卡片平台和插件规范，不运营插件市场，也不审核或签名插件。做法和 vim、zsh 的插件一样：
任何人都可以把卡片放在自己的 Git 仓库里，别人用一条命令装上；在 GitHub 按约定的 topic 搜索就能找到大家写的卡片。

内置卡片（任务看板、红果短剧、Emby、代理状态、额度）也是按同一规范写成的插件，只是随应用一起分发。
它们就在本目录下，可以当作写插件的范例。

## 找插件

- GitHub 搜索 topic：[`agent-companion-card`](https://github.com/topics/agent-companion-card)
- 仓库名约定为 `agent-companion-card-<id>`，也可以直接搜这个前缀

## 安装与管理

```sh
agent-companion cards install someone/agent-companion-card-pomodoro         # GitHub owner/repo，跟随默认分支
agent-companion cards install someone/agent-companion-card-pomodoro@v1.2.0  # 固定到 tag、分支或 commit
agent-companion cards install https://git.example.com/me/card.git --ref main
agent-companion cards install ./my-card                                     # 本地目录（复制一份）
agent-companion cards install someone/monorepo --path cards/pomodoro        # 仓库里的子目录

agent-companion cards list                # 已安装的卡片（● 启用 / ○ 关闭）与没能加载的卡片及原因
agent-companion cards update [<id>...]    # 按安装来源重新获取；固定在 tag / commit 的保持不动，--ref 改换版本
agent-companion cards remove <id>         # 卸载；--purge 同时删除它的数据（card-data/<id>）
```

- 新安装的卡片**缺省关闭**，在 Codex 卡片区的 Companion 设置（齿轮）里启用。
- 也可以在 Companion 设置的「插件」一节卸载：这里列出你自己安装的卡片和来源，卸载前可选同时删除它的数据。
  卸载后它的开关一并关掉，以后重新安装仍然缺省关闭。
- 后台服务在运行时，安装、卸载、更新几秒内自动生效，不用重启 Codex。
- 只有 `https://` 与 SSH 的 git 地址；安装时浅克隆、删掉 `.git`，只保留卡片文件，安装记录写在 `cards/.installs.json`。
- 和内置卡片同 id 的插件会覆盖内置版本（适合 fork 一张内置卡片自己改），卸载后恢复内置版本。内置卡片本身不能卸载，只能关闭。

卡片放在数据目录下的 `cards/<id>/`：macOS 是 `~/Library/Application Support/agent-companion/cards/`，
Linux 是 `~/.config/agent-companion/cards/`（可用 `AGENT_COMPANION_CARDS_DIR` 改到别处）。

## 安全

**插件是以你的用户权限运行的代码，没有沙箱。** 界面代码运行在 Codex 页面里，后台服务运行在 Companion 的后台进程里，
能读写你能读写的文件、访问网络。manifest 里的 `capabilities` 只决定平台给卡片哪些接口，不能阻止恶意代码。

- 只安装你信任的来源；装之前看一眼代码，尤其是 `service.mjs`。
- 需要稳定时固定到 tag 或 commit（`@v1.2.0`），`update` 不会把固定的版本换掉。
- 关闭的插件不运行任何代码：界面代码只在启用时注入页面，后台服务只在启用后才加载。

## 写一个插件

```sh
agent-companion cards create pomodoro --title 番茄钟 --service   # 新建独立仓库骨架 ./pomodoro
cd pomodoro
agent-companion cards build      # renderer.mjs → renderer.js
agent-companion cards link .     # 链接进卡片目录，在设置里启用后就能看到
```

链接之后，每次改完界面运行 `cards build`，几秒内页面就换上新版本。发布：

1. 把 `renderer.js` 一起提交（安装时不打包，用户机器上不一定有 Bun）。
2. 推到 GitHub，给仓库加上 topic `agent-companion-card`，仓库名建议用 `agent-companion-card-<id>`。
3. 打 tag（如 `v1.0.0`），让别人可以固定版本安装。

`cards build` 用 Bun 打包：`.app` 与 Linux 版自带 Bun 运行时可以直接用，源码安装用仓库开发依赖里的 Bun，
其它情况需要自己装 [Bun](https://bun.sh)。

## 包格式

一张卡片是一个目录，目录名就是卡片 id：

| 文件 | 必需 | 作用 |
|---|---|---|
| `manifest.json` | 是 | 卡片清单，字段见下 |
| `renderer.js` | 是 | 页面里运行的卡片界面：`renderer.mjs` 打包成的单个脚本，结尾调用 `__companionDefine(模块)` |
| `renderer.mjs` | 否 | 界面源码，`cards build` 的输入；导出 `mount(ctx)`，可选导出 `settings(kit)` |
| `service.mjs` | 否 | 后台服务，导出 `createService(api)` |

manifest：

| 字段 | 说明 |
|---|---|
| `id` | 小写字母开头的字母、数字或连字符，与目录名相同；不能是 `companion` |
| `title` / `version` | 标题；卡片实现版本（正整数） |
| `apiVersion` | 卡片需要的平台接口版本，当前为 `1`。比平台新的卡片不加载，`cards list` 会提示先更新 Agent Companion |
| `description` / `homepage` | 可选：一句话说明（≤200 字）；主页（只接受 `https://`） |
| `defaultEnabled` / `defaultOrder` | 缺省开关（用户安装的卡片一律按关闭处理）与排序 |
| `layout` | `height`: `content` \| `viewport`，`minHeight`（非负数），`scroll`: `outer` \| `inner` |
| `lifecycle` | `hidden`: `retain`（收起时保留）\| `suspend`（收起时暂停经 `ctx.effects` 登记的计时器）；`start`: `immediate` \| `first-visible` |
| `state` | 存档范围 `scope`: `target`（每个窗口）\| `session` \| `global`（页面只读，只能由后台服务写）；`version`（正整数） |
| `capabilities` | 用到的平台能力：`storage`、`rpc`、`threads`、`overlay`、`attention`、`host` |
| `hosts` | 可选：只在某些宿主出现（`codex`、`antigravity`），缺省为全部 |

未知字段会被拒绝。界面 `ctx`、存档、设置项与 RPC 的完整约定见仓库 [AGENTS.md](../AGENTS.md) 的「新增卡片」一节。

### 界面

`renderer.mjs` 导出 `mount(ctx)`，在 `ctx.root`（本卡的 ShadowRoot）里渲染，只用 `ctx` 给的接口，不碰宿主页面：
`ctx` 有 `manifest`、`settings`、`signal`、`effects`（事件、定时器、观察器统一登记，卸载时平台回收）、`reportError`、
`isVisible()`、`requestOpen()`，以及按 `capabilities` 提供的 `storage`、`rpc`、`threads`、`overlay`、`attention`、`host`。
`mount` 可以返回 `{ updateSettings, visibilityChanged, dispose }`。动态内容用 `textContent`，不要拼进 `innerHTML`。
`cards build` 把它和它 import 的文件、
npm 依赖一起打成一个 IIFE；平台注入时用自己的函数接住 `__companionDefine`，卡片代码看不到也不需要任何页面全局。

卡片可以往 Companion 设置里加自己的一节：`renderer.mjs` 导出 `settings(kit)`，返回 `{ render() }`，
用 `kit.checkbox` / `kit.choice` / `kit.button` / `kit.confirmation` 生成与设置页其它部分一致的控件，
设置项写进 `cards.<id>.settings`。范例见 `cards/tasks/settings.mjs`。

### 后台服务

`service.mjs` 导出 `createService(api)`，返回 `{ methods, cleanupMethods?, disposeTarget?, dispose?, applyConfig? }`；
页面里 `ctx.rpc("foo", params)` 调用的是 `methods.foo`。`api` 是平台给这张卡片的运行时接口：

| 字段 | 说明 |
|---|---|
| `apiVersion` | 平台接口版本 |
| `card` | `id`、`version`、卡片目录 `dir`、本卡专用的数据目录 `dataDir`（`card-data/<id>`，`cards remove --purge` 时删除） |
| `host` / `logger` | 当前宿主 id（`codex` / `antigravity`）；日志 |
| `config.load()` | 读取完整配置（只读） |
| `sessions` | 宿主的会话数据源（任务看板用） |
| `codex` | 本机 Codex 的集成：代理检测、带代理的子进程环境、全局指令里的计划提示 |
| `media.interceptor` | CDP 媒体拦截的端口登记表（播放类卡片用） |

服务由后台进程从卡片目录直接 import，只能引入自己目录里的文件和 `node:` 内置模块；需要 npm 依赖时自己先打包成
单个文件（例如 `bun build service.mjs --target=node --format=esm`）。内置卡片还用到仓库 `sdk/` 里的公共库
（媒体管线等），随构建打进各自的产物；独立插件仓库里暂时没有 `sdk/`。

后台服务的改动：源码安装几秒内重新加载；`.app` 与 Linux 版的运行时会缓存已加载的模块，需要重启后台服务
（`agent-companion agent install`）。

## 排查

`agent-companion cards list` 列出没能加载的卡片和原因：

| 原因 | 处理 |
|---|---|
| 缺少 renderer.js | 插件没提交打包产物：`cards build` 后提交；本机开发直接 `cards build` |
| 目录名与 manifest id 不一致 | 目录名必须等于 `id` |
| manifest.json 无效 / 不是合法 JSON | 按提示修正字段 |
| 需要平台接口 vN | 卡片比平台新，先更新 Agent Companion |
| renderer.js 超过 16 MiB | 多半把不该打包的东西打进去了 |

启用后界面报错会显示在卡片里；后台服务加载失败时调用返回 `CARD_SERVICE_UNAVAILABLE`，原因写在后台日志里。
