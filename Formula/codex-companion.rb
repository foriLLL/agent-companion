# Homebrew 安装（仓库本身就是 tap）：
#   brew tap foriLLL/codex-companion https://github.com/foriLLL/codex_companion
#   brew trust --formula foriLLL/codex-companion/codex-companion   # Homebrew 7 起需要
#   brew install --HEAD codex-companion
#   codex-companion agent install
# 还没有打版本 tag，只能装 main 上的最新代码（--HEAD）；有了 Release 后再补 url / sha256。
class CodexCompanion < Formula
  desc "Card drawer for the Codex desktop app: task board, short dramas, Emby and more"
  homepage "https://github.com/foriLLL/codex_companion"
  license "MIT"
  head "https://github.com/foriLLL/codex_companion.git", branch: "main"

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
    (bin/"codex-companion").write <<~SH
      #!/bin/bash
      export CODEX_COMPANION_AGENT_PROGRAM="#{opt_bin}/codex-companion"
      export CODEX_COMPANION_NATIVE_HELPER="${CODEX_COMPANION_NATIVE_HELPER:-#{opt_libexec}/dist/native/#{native_target}/companion-native}"
      exec "#{node}" "#{opt_libexec}/src/cli.mjs" "$@"
    SH
  end

  def caveats
    <<~EOS
      注册登录后自动启动的后台服务，然后重新打开 Codex：
        codex-companion agent install
      升级：brew upgrade --fetch-HEAD codex-companion，之后再执行一次 codex-companion agent install。
      卸载：先执行 codex-companion agent uninstall，再 brew uninstall codex-companion。
    EOS
  end

  test do
    assert_predicate libexec/"dist/native/#{native_target}/companion-native", :executable?
    assert_match "agent", shell_output("#{bin}/codex-companion --help")
  end
end
