# Homebrew 安装（仓库本身就是 tap）：
#   brew tap foriLLL/agent-companion https://github.com/foriLLL/agent-companion
#   brew trust --formula foriLLL/agent-companion/agent-companion   # Homebrew 7 起需要
#   brew install agent-companion
#   agent-companion agent install
# 打 vX.Y.Z tag 后，CI 发布 Release 并把下面的 url / sha256 指向该版本的源码包；--HEAD 装 main 上的最新代码。
# 后台服务会自动检查 Release，发现新版本后执行 brew upgrade 并重启自己（设置里可关闭）。
class AgentCompanion < Formula
  desc "Card drawer for the Codex desktop app: task board, short dramas, Emby and more"
  homepage "https://github.com/foriLLL/agent-companion"
  url "https://github.com/foriLLL/agent-companion/releases/download/v0.5.1/agent-companion-0.5.1.tar.gz"
  sha256 "fa67ab67c16a31d2430638e3724399a272e1f444dc781c56f3a03cfcf2b0eae5"
  license "MIT"
  head "https://github.com/foriLLL/agent-companion.git", branch: "main"

  depends_on "ffmpeg"
  depends_on macos: :ventura
  depends_on "node"

  def native_target
    Hardware::CPU.arm? ? "darwin-arm64" : "darwin-x64"
  end

  def install
    node = formula_opt_bin("node")/"node"
    npm = formula_opt_bin("node")/"npm"
    ENV.prepend_path "PATH", formula_opt_bin("node")
    # 与 npm start 相同：生成卡片渲染器、编译原生助手；生成只用到开发依赖里的 Bun，装完即删。
    system npm, "ci", "--no-audit", "--no-fund"
    system node, "scripts/generate-renderer.mjs"
    system node, "scripts/build-native.mjs", "--target", native_target
    system npm, "prune", "--omit=dev", "--no-audit", "--no-fund"
    libexec.install Dir["*"]

    # 后台服务记的是这个脚本的固定路径（opt），升级 node 或本软件后都不会失效。
    # 安装渠道与 brew 路径供自动更新使用：launchd 下的 PATH 不一定能找到 brew。
    launcher = <<~SH
      #!/bin/bash
      export AGENT_COMPANION_AGENT_PROGRAM="#{opt_bin}/agent-companion"
      export AGENT_COMPANION_INSTALL_CHANNEL=homebrew
      export AGENT_COMPANION_BREW="#{HOMEBREW_PREFIX}/bin/brew"
      export AGENT_COMPANION_NATIVE_HELPER="${AGENT_COMPANION_NATIVE_HELPER:-#{opt_libexec}/dist/native/#{native_target}/companion-native}"
      exec "#{node}" "#{opt_libexec}/src/cli.mjs" "$@"
    SH
    (bin/"agent-companion").write launcher
    # 旧名 codex-companion 的兼容入口：老版本登记的 launchd 服务写死了 opt/codex-companion/bin/codex-companion，
    # formula 改名迁移后 Homebrew 把旧 opt 链到新 keg，靠这个文件把它拉起来，再由新版本把服务迁到新标签。
    (bin/"codex-companion").write launcher
  end

  def caveats
    <<~EOS
      注册登录后自动启动的后台服务，然后重新打开 Codex：
        agent-companion agent install
      后台服务会自动更新到最新正式版（Companion 设置 › 更新 里可关闭）。
      手动升级：brew upgrade agent-companion（--HEAD 安装加 --fetch-HEAD），之后再执行一次 agent-companion agent install。
      卸载：先执行 agent-companion agent uninstall，再 brew uninstall agent-companion。
    EOS
  end

  test do
    assert_predicate libexec/"dist/native/#{native_target}/companion-native", :executable?
    assert_match "agent", shell_output("#{bin}/agent-companion --help")
  end
end
