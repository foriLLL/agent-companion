#!/bin/bash
# Codex Companion 一键升级到最新正式版。自动更新从 0.2.0 起才有，之前装的版本要用它（或手动命令）升级一次：
#   curl -fsSL https://raw.githubusercontent.com/foriLLL/codex_companion/main/scripts/upgrade.sh | bash
#
# 按已注册的后台服务（macOS launchd / Linux systemd 用户服务）判断安装方式：
#   Homebrew：brew update 后升级；--HEAD 安装换成正式版（之后由后台服务自动更新），再重新注册后台服务。
#   源码安装：仓库在 main 且没有未提交的改动时 git pull --ff-only、npm ci、npm start；否则停下说明原因，不动仓库。
# 参数：源码仓库路径（后台服务没指向该仓库时用）；--dry-run 只打印将执行的命令。
# CODEX_COMPANION_BREW 指定 brew 时只用它（测试用）。
set -euo pipefail

FORMULA=codex-companion
TAP=foriLLL/codex-companion
REPOSITORY=foriLLL/codex_companion
AGENT_LABEL=com.codexcompanion.agent
SYSTEMD_UNIT=codex-companion-agent.service

dry_run=0
source_dir=""
upgraded=""

say() { printf '==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die() { printf '升级中止：%s\n' "$*" >&2; exit 1; }
# 通过 curl | bash 运行时脚本本身在 stdin 上，子进程一律不读 stdin，免得吞掉后面的脚本。
run() {
  printf '+ %s\n' "$*"
  [ "$dry_run" = 1 ] || "$@" </dev/null
}

# 后台服务登记的启动参数，每行一个；没注册时为空。
agent_arguments() {
  case "$(uname -s)" in
    Darwin)
      local plist="$HOME/Library/LaunchAgents/$AGENT_LABEL.plist" index=0 value
      [ -f "$plist" ] || return 0
      while value=$(plutil -extract "ProgramArguments.$index" raw -o - "$plist" 2>/dev/null); do
        printf '%s\n' "$value"
        index=$((index + 1))
      done
      ;;
    Linux)
      local unit="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$SYSTEMD_UNIT"
      [ -f "$unit" ] || return 0
      # ExecStart 的每个参数都是 "..."，其中 \ 与 " 前加了反斜杠，% 与 $ 写成两个。
      sed -n 's/^ExecStart=//p' "$unit" | head -n 1 | grep -oE '"([^"\\]|\\.)*"' \
        | sed -e 's/^"//' -e 's/"$//' -e 's/\\\(.\)/\1/g' -e 's/%%/%/g' -e 's/\$\$/$/g' || true
      ;;
  esac
}

brew_bin() {
  if [ -n "${CODEX_COMPANION_BREW+set}" ]; then
    [ -x "$CODEX_COMPANION_BREW" ] && printf '%s\n' "$CODEX_COMPANION_BREW"
    return
  fi
  local candidate
  for candidate in "$(command -v brew 2>/dev/null || true)" /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

# 仓库里指向 foriLLL/codex_companion 的远程名（https 或 ssh 地址都认）。
companion_remote() {
  git -C "$1" config --get-regexp '^remote\..*\.url$' 2>/dev/null \
    | sed -nE "s#^remote\\.(.+)\\.url .*github\\.com[:/]${REPOSITORY}(\\.git)?/?\$#\\1#p" | head -n 1 || true
}

upgrade_source() {
  local dir=$1 remote branch dirty other
  git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "$dir 不是 git 仓库"
  dir=$(git -C "$dir" rev-parse --show-toplevel)
  remote=$(companion_remote "$dir")
  [ -n "$remote" ] || die "$dir 没有指向 $REPOSITORY 的远程仓库"
  branch=$(git -C "$dir" symbolic-ref --short -q HEAD || true)
  [ "$branch" = main ] || die "$dir 当前在 ${branch:-分离的 HEAD} 上，切回 main 后再运行"
  # 卡片渲染器等 *.generated.mjs 由 npm start 重新生成，有改动时先还原；其余改动一律不碰。
  dirty=$(git -C "$dir" diff --name-only HEAD)
  other=$(printf '%s\n' "$dirty" | grep -vE '(^|/)[^/]*\.generated\.mjs$' | grep -v '^$' || true)
  [ -z "$other" ] || die "$dir 有未提交的改动，提交或 git stash 后再运行：$(printf '%s\n' "$other" | head -n 5 | tr '\n' ' ')"

  say "源码安装：$dir"
  cd "$dir"
  if [ -n "$dirty" ]; then
    # shellcheck disable=SC2086 # 生成文件的路径里没有空格
    run git checkout -- $dirty
  fi
  run git pull --ff-only "$remote" main || die "无法快进到 $remote/main（本地 main 有自己的提交？）"
  run npm ci
  run npm start
  upgraded=$(node -p 'require("./package.json").version' 2>/dev/null || true)
}

upgrade_brew() {
  local brew=$1 agent=$2 versions program
  versions=$("$brew" list --versions "$FORMULA" 2>/dev/null || true)
  [ -n "$versions" ] || die "Homebrew 里没有安装 $FORMULA"
  say "Homebrew 安装：${versions#"$FORMULA" }"
  export HOMEBREW_NO_ENV_HINTS=1 HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK=1
  run "$brew" update
  export HOMEBREW_NO_AUTO_UPDATE=1
  # Homebrew 7 起第三方 tap 的 Formula 要信任后才能加载；按名字信任，重复执行无副作用。
  if "$brew" trust --help >/dev/null 2>&1 </dev/null; then
    run "$brew" trust --formula "$TAP/$FORMULA"
  fi

  if [[ " $versions " == *" HEAD"* ]]; then
    if "$brew" info --json=v2 "$FORMULA" </dev/null 2>/dev/null | grep -qE '"stable": *"[0-9]'; then
      say "当前是 --HEAD 安装，换成正式版，以后由后台服务自动更新"
      run "$brew" uninstall --ignore-dependencies "$FORMULA"
      if ! run "$brew" install "$FORMULA"; then
        say "正式版安装失败，恢复原来的 --HEAD 安装"
        run "$brew" install --HEAD "$FORMULA" || true
        die "Homebrew 安装正式版失败，见上面的输出"
      fi
    else
      run "$brew" upgrade --fetch-HEAD "$FORMULA"
    fi
  else
    run "$brew" upgrade "$FORMULA"
  fi

  program="$("$brew" --prefix </dev/null)/opt/$FORMULA/bin/$FORMULA"
  case "$agent" in
    registered) run "$program" agent install ;;
    none) note "后台服务还没注册，需要时执行：$FORMULA agent install" ;;
  esac
  versions=$("$brew" list --versions "$FORMULA" 2>/dev/null || true)
  upgraded=${versions#"$FORMULA" }
}

main() {
  local arg arguments first cli brew
  for arg in "$@"; do
    case "$arg" in
      --dry-run) dry_run=1 ;;
      -*) die "未知参数 $arg（可用：--dry-run、源码仓库路径）" ;;
      *) source_dir=$arg ;;
    esac
  done
  [ "$(id -u)" != 0 ] || die "不要用 root / sudo 运行"

  if [ -n "$source_dir" ]; then
    upgrade_source "$source_dir"
  else
    arguments=$(agent_arguments)
    first=$(printf '%s\n' "$arguments" | head -n 1)
    cli=$(printf '%s\n' "$arguments" | grep -E '/src/cli\.mjs$' | head -n 1 || true)
    if [ -n "$cli" ]; then
      upgrade_source "$(dirname "$(dirname "$cli")")"
    elif [[ "$first" == */opt/$FORMULA/bin/$FORMULA || "$first" == */Cellar/$FORMULA/* ]]; then
      brew=$(brew_bin) || die "后台服务指向 Homebrew 安装（$first），但找不到 brew"
      upgrade_brew "$brew" registered
    elif [ -n "$first" ]; then
      die "后台服务运行的是 $first，不是 Homebrew 或源码安装，无法判断怎么升级"
    elif brew=$(brew_bin) && [ -n "$("$brew" list --versions "$FORMULA" 2>/dev/null </dev/null || true)" ]; then
      upgrade_brew "$brew" none
    elif [ -n "$(companion_remote "$PWD")" ]; then
      upgrade_source "$PWD"
    else
      die "没找到已安装的 Codex Companion（后台服务未注册，Homebrew 里也没有）。源码安装请带上仓库路径：curl -fsSL https://raw.githubusercontent.com/$REPOSITORY/main/scripts/upgrade.sh | bash -s -- /path/to/codex_companion"
    fi
  fi

  if [ "$dry_run" = 1 ]; then
    say "（--dry-run：以上命令都没有执行）"
  else
    say "完成${upgraded:+：Codex Companion $upgraded}。之后有新版本时，Homebrew 安装会自动更新，源码安装会在设置里提醒。"
  fi
}

main "$@"
