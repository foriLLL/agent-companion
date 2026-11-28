# AGENTS.md

Agent Companion — 在 Codex 桌面端（macOS；Linux 预览）中注入红果短剧、Emby、代理状态与任务看板。
不修改 app.asar 或应用签名：launchd 常驻 agent 监听 Codex 启动，刚打开且未带调试参数的 Codex
在安全条件下被正常退出、以 loopback 随机端口重开，再经 CDP 注入卡片；设置页在 Codex 内（卡片区齿轮）。
Linux 不自动重开：用户级 `chatgpt.desktop` 覆盖菜单入口（`open-codex` 带调试参数启动），
systemd 用户服务常驻发现并注入；主进程 cmdline 被 Chromium setproctitle 改写成空格拼接的一行。
官方插件（MCP Apps）链路已彻底放弃并删除，不要再加回来。
Antigravity（预览，macOS）是第二个宿主：后台 agent 里的 `antigravity-host.mjs` 经原生助手监听 Antigravity 启动，
刚打开且未带调试参数（含后台启动与自动更新重启）的实例在安全条件下被正常退出、以 loopback 随机端口重开并注入，
用户也可以随时用 `agent-companion antigravity [--restart]` 带调试端口打开；注入、卡片平台、设置页与 Codex 共用，
按 `host` 区分页面适配器、会话定位与任务看板的数据源。

## 技术栈
- JavaScript ESM (`.mjs`, `"type": "module"`)，Node.js >= 22
- 打包用 Bun (`bun --compile`)；引导/备用设置 App 为 Swift/SwiftUI (AppKit)；
  原生助手 `companion-native` 为 Swift 命令行（NSWorkspace 观察与进程动作）
- 依赖本地精确锁定，无 CDN：hls.js、mp4box、undici、openhongguo；FFmpeg 由用户自行安装

## 目录结构
- `src/agent/` — 无感注入 agent：`controller.mjs` 状态机（纯逻辑）、`adapter.mjs`
  平台动作、`session.mjs` 注入会话、`main.mjs` 常驻运行时与单实例锁、
  `launch-agent.mjs` 安装/卸载/状态/重启命令、`native-bridge.mjs` 原生助手封装、
  `linux-service.mjs` systemd 用户服务与菜单入口覆盖、`open-codex.mjs` Linux 菜单入口启动器、
  `antigravity-host.mjs` 发现并接上带调试端口的 Antigravity、`open-antigravity.mjs` 带端口打开 Antigravity
- `packaging/mac-app/Native/` — 原生助手源码；`scripts/smoke-native.mjs` 只对 dummy app 冒烟
- `src/platform/` — 平台差异集中处：`paths.mjs` 数据目录/PATH 查找/路径包含判断、
  `processes.mjs` Linux `/proc` 进程发现、
  `secret-store.mjs` 凭证存储（钥匙串 / DPAPI / Secret Service）
- `src/platform/cards/` — 卡片插件：`catalog.mjs` 运行时从磁盘发现卡片（内置目录 + 用户目录）、
  `build.mjs` 把 `renderer.mjs` 打成 `renderer.js`、`manage.mjs` 安装/更新/卸载/链接、`scaffold.mjs` 骨架；
  `src/cards-command.mjs` 是 `agent-companion cards` 命令
- `cards/` — 内置卡片，与用户安装的插件同一种包（规范见 `cards/README.md`）：emby、hongguo
  （`hongguo-sdk-client.mjs` 封装 openhongguo，wasm 运行时从卡片目录 / `Resources/openhongguo` / 仓库依赖动态 import）、
  proxy、tasks、usage；`sdk/` 是卡片可引入的公共库（媒体管线等），随卡片一起打包
- `src/` — 共用核心逻辑。入口 `cli.mjs`；`injection.mjs` 组装注入产物（平台 bundle + 启用卡片的 `renderer.js`）；
  `src/platform/media/` 媒体层（`hls-proxy.mjs` 是 Emby HLS 的 127.0.0.1 本地代理）；
  `daemon.mjs` 看门狗；`cdp-connection.mjs`、`rpc-bridge.mjs` 通信层
- `test/` — `*.test.mjs`，Node 内置 test runner
- `scripts/` — 构建 (`build-app.mjs`、`build-linux.mjs`、`build-native.mjs`、`package-cards.mjs`、`prepare-installer.mjs`)、生成 (`generate-renderer.mjs`)、
  探测 (`probe-emby.mjs`)、冒烟 (`smoke-*.mjs`)
- `packaging/` — `install.sh`（macOS 与 Linux）与 macOS 启动器 (`mac-app/`)

## 常用命令
- 以源码注册 agent：`npm start`（即 `agent install`；`prestart` 先生成渲染器，再由
  `scripts/prepare-source-install.mjs` 在 macOS 编译原生助手并检查 / 用 Homebrew 补装 FFmpeg）
- 无感注入 agent：`node src/cli.mjs agent [--log-dir <dir>]`（常驻）、
  `agent install|uninstall|status|restart-codex`；原生助手 `node scripts/build-native.mjs`
- 卡片插件：`node src/cli.mjs cards list|install|update|remove|link|build|create`（测试里用临时 HOME /
  `AGENT_COMPANION_CARDS_DIR`，不要动真实数据目录里的卡片）
- 原生冒烟：`node scripts/smoke-native.mjs`（默认档不抢焦点；`--interactive` 会激活窗口）
- 旧一次性 CDP 启动与注入：`npm run start:legacy`
- 测试：`npm test`（即 `node --test`）
- 构建 .app：`npm run build:app`（默认 arm64；`-- --target darwin-x64`）
- 构建 Linux 后端：`npm run build:linux -- --target linux-x64|linux-arm64`；Release 由
  `scripts/prepare-installer.mjs` 把 Team ID、tag 与 Linux 归档 SHA256 写入 `install.sh`
- 冒烟/探测：`npm run smoke` / `npm run probe:emby`
- 发版：`npm run release -- X.Y.Z`（干净的 main；改版本号、把 CHANGELOG 的 Unreleased 改名、提交并打 tag，
  不推送）。推送 tag 后 `release.yml` 发布 Release 并把 `Formula/agent-companion.rb` 的 url/sha256 指向新源码包，
  这两行由 CI 维护，不要手改
- 宿主适配自检：`npm run check:host`（只读查询正在运行的 Codex，列出入口、会话区、让位方式各落在哪一级，
  以及哪些 Codex 内部命名已缺失；有降级时退出码为 2）。Codex 升级后先跑它

## 新增卡片
卡片是一个目录：内置卡片在 `cards/<id>/`，用户安装的插件在数据目录 `cards/<id>/`，格式相同，平台运行时从磁盘发现
（安装、发布与包格式见 `cards/README.md`）。平台负责外框、Shadow DOM 隔离、开关与排序、
生命周期、存档与 RPC，卡片只写自己的界面和逻辑。
- 生成骨架：内置卡片 `npm run card:create -- <id> --title <标题>`；独立插件仓库 `agent-companion cards create <id>`。
  需要后台服务时加 `--service`。`id` 为小写字母开头的字母、数字或连字符，不能是 `companion`。
- `manifest.json`：`id`、`title`、`version`、`defaultEnabled`（新卡保持 `false`）、`defaultOrder`、
  `layout`（`height`: `content` | `viewport`，`minHeight`，`scroll`: `inner` | `outer`）、
  `lifecycle`（`hidden`: `retain` | `suspend`，`start`: `immediate` | `first-visible`）、
  `state`（`scope`: `target` | `session` | `global`，`version`）、`capabilities`；可选 `hosts`（`codex` | `antigravity`，
  缺省为全部宿主，只对某个宿主有意义的卡片才写）、`apiVersion`（需要的平台接口版本，当前 1）、`description`、`homepage`（https）。
- `capabilities` 只声明用到的：`storage`（本地存档）、`rpc`（调用本卡的后台服务）、
  `threads`（宿主的会话列表：Codex 侧栏；Antigravity 只有当前会话与按 id 打开）、`overlay`（卡片区之外的顶层浮层）、`attention`（发提醒，可让平台暂停
  卡片里正在播放的媒体；`ctx.attention.notify({ key, tone, title, text, detail, color, pause, action })`，
  默认只在有媒体播放时显示；`ctx.attention.act()` 对本卡最新一条带操作的提醒执行「去处理」，供快捷键用）、
  `host`（宿主自身的数据：`ctx.host.id` 为 `codex` | `antigravity`；Antigravity 另有 `ctx.host.quota({ force })`，
  调用 Hub 自己的客户端读模型额度，不读也不传任何 token）。
  未声明的能力不会出现在 `ctx` 上。播放类卡片不用声明任何能力：平台自动识别卡片 ShadowRoot 里的 `<video>` / `<audio>`。
- `renderer.mjs` 导出 `mount(ctx)`：只在 `ctx.root`（本卡的 ShadowRoot）里渲染，不碰宿主 DOM。
  `ctx` 提供 `manifest`、`settings`、`signal`、`storage`、`rpc`、`effects`、`reportError`、`isVisible()`、
  `requestOpen()`。事件、定时器、观察器和 Object URL 一律经 `ctx.effects`（`listen` / `timeout` / `interval` /
  `observe` / `objectUrl` / `add`）登记，卸载时由平台统一回收。返回值可含 `updateSettings`、
  `visibilityChanged`、`dispose`、`api`。动态内容用 `textContent`，不要拼进 `innerHTML`。
  需要设置项时导出 `settings(kit)`，在 Companion 设置里加本卡的一节（范例 `cards/tasks/settings.mjs`），
  不要往平台的 `settings-panel.mjs` 里写某张卡片的设置。
- 页面里运行的是打包好的 `renderer.js`（`npm run generate:renderer` / `agent-companion cards build` 生成）；
  内置卡片的 `renderer.js` 不进仓库，插件要提交。只有启用的卡片才把界面代码送进页面。
- `service.mjs` 导出 `createService(api)`，返回 `{ methods, cleanupMethods?, disposeTarget?, dispose?, applyConfig? }`。
  `api` 是平台注入的运行时接口（`card.dir` / `card.dataDir`、`sessions`、`codex`、`media.interceptor`、`config.load()` 等，
  见 `src/platform/services/card-api.mjs`）。方法 `foo` 对外是 `<id>.foo`，页面里用 `ctx.rpc("foo", params)` 调用。
  每个方法都要校验参数、尊重 `context.signal`，按 `context.targetId` 归属资源并在 `disposeTarget` 里清理；
  `scope: "global"` 的状态只能由后台服务写。内置卡片的服务一直加载；用户插件的服务只在启用后才 import。
- 卡片只引入自己目录里的文件、`sdk/`、`node:` 内置模块和 `dependencies` 里的包，不直接引入 `src/`
  （`test/card-registry.test.mjs` 检查）。平台需要知道某张卡片的地方一律走 manifest / 卡片目录，
  `src/` 里不要出现具体卡片的 id 或 import。
- 写完运行 `npm test`（`pretest` 会重新生成内置卡片清单与 `renderer.js`），界面改动再跑 `npm run smoke`；
  后台服务运行中时几秒内自动载入新卡，在卡片区设置里启用即可。只在本机自用的卡片不必进仓库：
  `agent-companion cards create` 建独立目录后 `cards build && cards link .`。
- 要把卡片提交进仓库时，同步更新写死内置卡片清单的断言（`test/card-registry.test.mjs`、
  `test/companion-config.test.mjs`、`test/config-v2.test.mjs`、`test/injector-rpc.test.mjs`、
  `test/service-registry.test.mjs`、`test/helpers/builtin-cards.mjs`），并给卡片补测试。

## 宿主适配（`src/renderer/adapters/`）
Codex 每次升级都可能改掉类名、data 属性、DOM 层级和打包方式。凡是依赖 Codex 页面结构的能力都按下面的规则写，
否则升级一次坏一次：
- **自有界面不依赖宿主**：入口（悬浮按钮）和抽屉都挂在自己的 Shadow DOM 里，任何锚点都找不到时仍然可用。
- **信号按稳定程度分级**：自动化属性（`data-app-action-*`、`data-thread-summary-panel-toggle` 等）→ ARIA 语义
  （`role`、`aria-*`、`contenteditable`）→ 几何位置。CSS Modules 类名、Tailwind 类名、按钮文案、打包产物的文件名
  只能作为最高一级的可选信号，后面必须还有不依赖它们的一级。
- **生效与否靠实测，不靠「选择器命中」**：改动原生布局前先写入、同步读回位置、撤销（`probeRoom`），
  不符合预期就换下一级并记入诊断（`roomFallbacks`）。不能假设某个变量或类名还在被原生样式消费。
- **只加自己的标记**：对原生节点只增删 `data-companion-*` 属性并用自己的样式表覆盖，不改写原生的
  `style` / `class`，撤销后原生状态原样保留。
- **每一级都进诊断和冒烟**：`getDiagnostics().adapter` 的 `entry` / `thread` / `room` 标出当前落在哪一级；
  新增一种宿主结构或后备方式时，在 `scripts/smoke-codex-adapter.mjs` 里加对应夹具（含「钩子全无」的场景）。
- 与原生 Summary 完全一致（判档阈值、平移量、动画）只在最高一级保证；后备级只保证不压住对话、
  入口不丢、关闭后原样恢复。
- **按宿主区分**：`src/targets.mjs` 的 `HOST_TARGETS` 决定注入哪些页面，`card-runtime.mjs` 的 `HOST_FACTORIES`
  决定页面适配器与会话定位（`antigravity.mjs` / `antigravity-threads.mjs`），任务服务按 `host` 依赖选数据源
  （`CodexSessions` / `AntigravitySessions`，接口相同）和看板文件。只对某个宿主有意义的卡片在 manifest 里写 `hosts`。
  Antigravity 的锚点先认 `[data-testid="toggle-overview-panel"]`，找不到（如新建会话页）再退到右上角标题栏最右侧的原生图标按钮（`titlebar-trailing`），都找不到时退到右上角自有悬浮按钮（避开右下角发送按钮）；
  侧栏任务色标记先认 `[data-sidebar-row-id] [data-cascade-id]`（正文区的对话容器也带 `data-cascade-id`，不能单用），
  再退到 `/c/<id>` 链接所在、高度像一行的元素；
  会话跳转走 Hub 的 TanStack Router（`pushState` 带 `__TSR_index` 再发 `popstate`）。冒烟在 `scripts/smoke-antigravity-adapter.mjs`。

## 自动更新（`src/updater.mjs`）
- 版本只认打了 `vX.Y.Z` tag 的正式 Release（API 403/429 时改读 `releases/latest` 跳转 + tag 上的 CHANGELOG，未登录 API 按出口 IP 限流）；agent 启动 2 分钟后、之后每 6 小时查一次，状态存数据目录 `update-state.json`。
- 只有 macOS 的 Homebrew 安装会自动装：`brew update` + `brew upgrade`（`HOMEBREW_NO_INSTALL_CLEANUP=1` 保留旧版本文件，
  旧进程还会懒加载自己目录里的模块），装好后等卡片里没有媒体在播，agent 正常清理并以退出码 75 结束，
  由 launchd（`KeepAlive.SuccessfulExit=false`）拉起新版本；新进程确认换上新版本后才 `brew cleanup agent-companion`。
  不重启 Codex。源码安装只提醒，不能替用户 `git pull`。
- 检查结果不推给页面：卡片外框在挂载时、每 5 分钟和窗口回到前台（focus / visibilitychange）时读 `status` 更新红点。
- 配置开关是顶层 `updates.auto`（缺省 true），不要放进 `agent`：旧版本的校验拒绝 `agent` 里的未知字段。
- 页面经 `companion.update.status|check|apply|acknowledge` 访问；`apply` 立即返回，界面轮询 `status`。
- 测试里构造 `runAgent` 要传 `updater: false` 或假的 `updaterFactory`，否则假时钟推进会真的访问 GitHub。
- `scripts/upgrade.sh` 给 0.2.0 之前的老安装一键升级（README 里是 raw main 地址，改路径要同步）：按 launchd plist /
  systemd 单元登记的程序判断 Homebrew 还是源码；源码仓库不在 main 或有改动（`*.generated.mjs` 除外）时拒绝。
  测试 `test/upgrade-script.test.mjs` 把 brew / npm 换成桩，**不要让它真的执行 `npm start` 或 `agent install`**。

## 代码约定
- 无 lint/format 配置。风格：2 空格缩进、双引号、分号、ESM
- 注释与文档用中文，代码标识符用英文
- 提交信息遵循 Conventional Commits（`fix:` / `feat:` / `chore:`）
- 分支命名：`agent/*`、`codex/*`、`feature/*`、`fix/*`

## 关键陷阱
- Codex 的 Electron fuse 已关闭 inspect/RunAsNode/NODE_OPTIONS，CDP 只能在**启动参数**上开启；
  已运行且未带参数的 Codex 只能重启后注入。开启自动加载时，agent 只自动重开「刚启动（30 秒内）、启动完成、单实例、未带调试端口」
  的实例（不限前后台与启动后输入，守卫在 JS 状态机与原生助手两侧各查一次；后台实例静默用 `--background` 重开不抢焦点；
  已处理过的实例 key 落盘到 `runtime.json`，agent 重启或自动更新后绝不重复处理或打断正在运行的基线实例），
  基线旧实例/多实例/外部调试端口/未知参数只提醒不碰，绝不强杀。
- 退出 Codex 只能用 `NSRunningApplication.terminate()`；禁止 SIGKILL、forceTerminate。
  Linux 上 agent 不退出也不重启 Codex，只提示用户从应用菜单重开。
  开发与测试禁止对真实 Codex 执行 quit/launch/show，原生能力只对 dummy app 验证。
- 配置 `config-v2.json` 是唯一事实来源：设置页、Swift App 都通过
  revision + 文件锁写入；agent 由 config watcher 热更新。
- 平台 RPC 命名空间 `companion.*` 保留给设置页，卡片 id 不能为 `companion`。
- **测试必须用 `node --test`，不要用 `bun test`**：Bun 转译器会改写
  函数体，破坏基于 `toString()` 的源码断言。
  Bun 仅用于编译打包
- **改名兼容**：0.4.0 由 Codex Companion 改名为 Agent Companion。旧名字（`codex-companion` 数据目录、
  `com.codexcompanion.agent` 标签、`codex-companion-agent.service`、`CODEX_COMPANION_*` 变量、`codex-companion.emby`
  凭证、`codex-companion.card.*` 存档、`__CODEX_COMPANION__` 页面全局、`codex-companion:plan-hint` 标记、
  `com.codexcompanion.launcher` 偏好域）只用于识别和迁移，集中在 `src/platform/legacy-names.mjs` 和各模块的 `LEGACY_*` 常量里，
  新代码不要再写入它们。Formula 必须保留 `bin/codex-companion` 兼容入口：老 plist 写死了 `opt/codex-companion/bin/codex-companion`，
  formula 改名迁移后靠它拉起新版本，再由 `handoffLegacyAgent` 交接到新标签。批量替换名字时别把这些旧名字也替换掉
- **Antigravity 数据**：会话状态读 `~/.gemini/antigravity/conversation_summaries.db` 的 `raw_summary`
  （`exa.jetski_cortex_pb.CascadeTrajectorySummary`，`src/antigravity-sessions.mjs` 按字段号容错解码），
  库是 WAL，Hub 运行中实时写入；没有 `-wal/-shm` 时只读打开会 CANTOPEN(14)，退回 `immutable=1`。
  不连语言服务器的 API（要从它的进程里取 CSRF token，等同于取凭证）。开发与测试不得连接用户正在运行的 Antigravity：
  agent 只在真实进程入口（`cli.mjs`）开启 Antigravity 宿主，测试一律用假进程快照
- `src/*.generated.mjs`、`src/card-registry.mjs`、`cards/*/renderer.js` 由 `npm run generate:renderer`
  生成（`pretest` 自动执行），不要手改
- **卡片插件**：插件以用户权限运行、没有沙箱，平台不做签名或审核（vim / zsh 插件式，GitHub topic `agent-companion-card`）。
  关闭的插件不能运行任何代码：界面只在启用时注入，服务只在启用后 import。`.app` / Linux 版里内置卡片放在后端同级的
  `cards/`（`scripts/package-cards.mjs`，服务打成自包含的单文件），Linux install.sh 的归属检查按 `PACKAGED_CARD_FILES`；
  编译后的 Bun 会忽略 import 的查询串，服务代码更新要重启后台服务才生效。设置页「插件」一节经 `companion.cards.remove`
  卸载（只删用户目录里的卡片，卸载后关掉开关）；卡片目录一变页面就整体重新注入（会打断正在播放的媒体），
  `entry.mjs` 把旧运行时的 `getUiState()` 交给新运行时的 `restoreUi`，抽屉与设置保持打开
- **安全红线**：CDP 调试端口只绑 loopback + 随机端口，禁止改为
  0.0.0.0；Emby AccessToken 只存系统凭证库（`src/platform/secret-store.mjs`），
  明文不得出现在命令行参数（macOS `security` 除外）；连接信息存数据目录下 `emby.json` (0600)。
  红果播放是已知例外：签名播放地址与内容密钥只能作为 FFmpeg 参数（`-i`、`-decryption_key`）传入，
  播放期间同一用户的进程可见；不要把这种做法扩展到其它凭证
- 跨平台：平台分支函数接受 `platform` 参数，测试显式传入；macOS 专属能力（launchd、
  通过代理重启 Codex、`/bin/ps`、`defaults`）在其它平台返回「不支持」而非抛 ENOENT；
  文件权限断言用 `test/helpers/permissions.mjs` 的 `assertMode`
- 「长任务先列计划」除了 AGENTS.md 的提示块，还在 `~/.codex/config.toml` 写 `[tools.update_plan] enabled = true`
  （`src/codex-plan-hint.mjs`）。Codex 用 toml_edit 改写这个文件、新表追加在末尾，**不能用成对的开始/结束标记**
  （新表会落进标记之间被一起删掉）；只认「标记注释 + 表头 + enabled = true」，用户改过或自己配过 update_plan 就不碰。
- 常驻 agent 带主线程看门狗：主线程 30 秒无响应即以 SIGABRT 退出、由 launchd / systemd 重启。
  调试 agent 时在断点停住会被它终止，用 `AGENT_COMPANION_WATCHDOG=0` 关闭
- `npm run inject` 是一次性注入后退出，RPC 随之结束，只能看静态布局，
  不能用于浏览/播放
- 公开 `.app` 不打包 FFmpeg；本机转码只调用用户通过 PATH、常见包管理器路径或
  `AGENT_COMPANION_FFMPEG` 指定的系统 FFmpeg
- tag Release 必须 Developer ID 签名并经 Apple 公证；缺少凭据时工作流应失败关闭。
  Linux 没有平台签名，install.sh 只下载同 tag 归档并比对写入脚本的 SHA256，不跟随 latest
