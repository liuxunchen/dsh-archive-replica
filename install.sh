#!/bin/bash
# 把 dsh-archive-replica 装进 dsh 的 harness home（默认 ~/.dsh）。
#
# 安装位置（都随 $DSH_HOME 走，与 dsh 源码目录无关，整份替换 dsh 也不会丢）：
#   $DSH_HOME/plugins/archive-replica                          插件本体
#   $DSH_HOME/profiles/node_modules/@local/dsh-archive-replica 解析用软链
#   $DSH_HOME/profiles/<profile>/cordis.patch.yml              启用行（--enable 时写入）
#
# 用法：install.sh --help

set -euo pipefail

# 解析软链：npm 的 bin 是 node_modules/.bin/ 下的软链，直接取 dirname 会指错目录
SELF="${BASH_SOURCE[0]}"
if command -v readlink >/dev/null 2>&1 && readlink -f "$SELF" >/dev/null 2>&1; then
  SELF="$(readlink -f "$SELF")"
else
  while [ -L "$SELF" ]; do
    target="$(readlink "$SELF")"
    case "$target" in
      /*) SELF="$target" ;;
      *) SELF="$(dirname "$SELF")/$target" ;;
    esac
  done
fi
SCRIPT_DIR="$(cd "$(dirname "$SELF")" && pwd)"
SRC_DIR="${PLUGIN_SRC:-$SCRIPT_DIR}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${DSH_PROFILE:-web}"
PACKAGE_NAME="@local/dsh-archive-replica"
ENTRY_ID="archive-replica-external"

TARGET_DIR="$DSH_HOME/plugins/archive-replica"
LINK_DIR="$DSH_HOME/profiles/node_modules/@local"
LINK_PATH="$LINK_DIR/dsh-archive-replica"
PATCH_PATH="$DSH_HOME/profiles/$PROFILE/cordis.patch.yml"

VAULT=""
MACHINE="$(hostname -s 2>/dev/null || echo unknown)"
ENABLE=0
CHECK=0

usage() {
  cat <<'USAGE'
把 dsh-archive-replica 装进 dsh 的 harness home。

插件以 TypeScript 源码形式安装，由 dsh 的 tsx 启动器直接加载，因此它引用的 harness 包
与 dsh 主程序解析到同一份实例。包名故意用 @local/ 前缀：dsh 启动器只维护自己安装闭包里的
名字，@local/ 永远不在其中，所以替换 dsh 安装目录后这条软链不会被改指、也无需重装。
插件不依赖任何第三方运行时包，checkout 之外也能加载。

用法：
  install.sh                                            安装/更新本体与解析软链
  install.sh --check                                    只报告当前状态（不写文件）
  install.sh --enable --vault <共享目录> [--machine <id>]
                                                        安装并写入启用行

选项：
  --vault <路径>      所有机器共享、且被你的文件同步工具复制的目录。
                      --enable 时必填，且必须已存在（建议放在网盘「已注册同步范围」内）
  --machine <id>      本机唯一标识，命名本机的 vault 文档；每台机器必须不同。
                      默认取 hostname -s —— 但多台机器 hostname 相同是常事，
                      那种情况下必须显式指定（本脚本会在撞车时拒绝安装）
  -h, --help          显示本帮助

环境变量：DSH_HOME（默认 ~/.dsh）、DSH_PROFILE（默认 web）、PLUGIN_SRC（默认本仓库）

装完重启 dsh 生效；自检用 install.sh --check。
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1; shift ;;
    --enable) ENABLE=1; shift ;;
    --vault) VAULT="${2:-}"; shift 2 ;;
    --machine) MACHINE="${2:-}"; shift 2 ;;
    --dsh-home) DSH_HOME="${2:-}"; shift 2
      TARGET_DIR="$DSH_HOME/plugins/archive-replica"
      LINK_DIR="$DSH_HOME/profiles/node_modules/@local"
      LINK_PATH="$LINK_DIR/dsh-archive-replica"
      PATCH_PATH="$DSH_HOME/profiles/$PROFILE/cordis.patch.yml" ;;
    --profile) PROFILE="${2:-}"; shift 2
      PATCH_PATH="$DSH_HOME/profiles/$PROFILE/cordis.patch.yml" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$1" >&2; usage; exit 2 ;;
  esac
done

report() { printf '[archive-replica] %s\n' "$*"; }
fail() { printf '[archive-replica] 错误：%s\n' "$*" >&2; exit 1; }

# 本机指纹，与插件写的那个一致：短主机名 + 内核 machine-id 前 12 位。
# 两台机器 hostname 相同是常事，内核 id 才是区分点。
machine_fingerprint() {
  local host kid
  host="$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo unknown)"
  kid="$(head -c 12 /etc/machine-id 2>/dev/null | tr -d '\n' || true)"
  if [ -n "$kid" ]; then printf '%s:%s' "$host" "$kid"; else printf '%s' "$host"; fi
}

# ---- 状态检查 ---------------------------------------------------------------
target_ok=0; link_ok=0; entry_ok=0
[ -f "$TARGET_DIR/src/index.ts" ] && target_ok=1
[ -L "$LINK_PATH" ] && [ "$(readlink "$LINK_PATH")" = "$TARGET_DIR" ] && link_ok=1
if [ -f "$PATCH_PATH" ] && grep -q "$ENTRY_ID" "$PATCH_PATH"; then entry_ok=1; fi

if [ "$CHECK" = 1 ]; then
  report "DSH_HOME       $DSH_HOME"
  report "插件本体       $TARGET_DIR $([ "$target_ok" = 1 ] && echo '(已安装)' || echo '(缺失)')"
  report "解析软链       $LINK_PATH $([ "$link_ok" = 1 ] && echo '(就绪)' || echo '(缺失或指向别处)')"
  report "启用行         $PATCH_PATH $([ "$entry_ok" = 1 ] && echo '(已写入)' || echo '(未写入)')"
  [ -d "$DSH_HOME" ] || report "提示：$DSH_HOME 还不存在——这台机器还没跑过 dsh，先启动一次 dsh（生成 harness home）再安装。"
  [ "$target_ok" = 1 ] && [ "$link_ok" = 1 ] || exit 1
  exit 0
fi

# ---- 安装插件本体 -----------------------------------------------------------
[ -f "$SRC_DIR/src/index.ts" ] || fail "找不到插件源码：$SRC_DIR/src/index.ts"
rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR"
[ -f "$SRC_DIR/lib/index.js" ] || fail "找不到编译产物：$SRC_DIR/lib/index.js（npm 包自带 lib/；git clone 请确认 lib 已提交）"
cp -R "$SRC_DIR/src" "$TARGET_DIR/src"
cp -R "$SRC_DIR/lib" "$TARGET_DIR/lib"
# 安装用的 package.json：名字与解析软链一致（@local/），且**不声明任何依赖**。
# dsh 启动器会遍历 profile 里的依赖；声明了 peerDependencies 会让它去解析甚至下载，
# 而那些包本来就由宿主 dsh 提供。
version="$(grep -m1 '"version"' "$SRC_DIR/package.json" | sed 's/.*:[[:space:]]*"//; s/".*//')"
cat > "$TARGET_DIR/package.json" <<EOF
{
  "name": "$PACKAGE_NAME",
  "version": "${version:-0.0.0}",
  "private": true,
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./package.json": "./package.json"
  }
}
EOF
[ -f "$SRC_DIR/README.md" ] && cp "$SRC_DIR/README.md" "$TARGET_DIR/README.md"
report "插件已安装：$TARGET_DIR"

# ---- 解析软链（安装回退目录只增不删，替换 dsh 目录不影响它） ---------------
mkdir -p "$LINK_DIR"
ln -sfn "$TARGET_DIR" "$LINK_PATH"
report "解析软链：$LINK_PATH -> $TARGET_DIR"

# ---- 自检：包名能否从 profile 解析，且指向刚装好的本体 ----------------------
# 只做解析与存在性检查：插件是 TypeScript 源码，直接 import 需要 dsh 的 tsx 启动器，
# 普通 node 会以「未知扩展名」失败。
if command -v node >/dev/null 2>&1; then
  resolved=""
  # 首次安装时 profiles/<profile> 还不存在（启用行在下一步才写），退回 profiles 解析
  resolve_dir="$DSH_HOME/profiles/$PROFILE"
  [ -d "$resolve_dir" ] || resolve_dir="$DSH_HOME/profiles"
  resolved="$(cd "$resolve_dir" 2>/dev/null \
    && node --input-type=module -e "process.stdout.write(import.meta.resolve('$PACKAGE_NAME'))" 2>/dev/null || true)"
  case "$resolved" in
    file://*) entry_file="${resolved#file://}"; entry_file="${entry_file%%#*}" ;;
    *) entry_file="" ;;
  esac
  if [ -n "$entry_file" ] && [ -f "$entry_file" ]; then
    report "自检通过：$PACKAGE_NAME -> $entry_file"
  else
    report "警告：$PACKAGE_NAME 未从 profile 解析到已安装的本体（解析结果：${resolved:-无}）"
    report "      若 $DSH_HOME 从未启动过 dsh，请先启动一次再重跑本脚本。"
  fi
fi

# ---- 启用行 ------------------------------------------------------------------
if [ "$ENABLE" = 1 ]; then
  [ -n "$VAULT" ] || fail "--enable 需要 --vault <共享目录>"
  [ -n "$MACHINE" ] || fail "--enable 需要 --machine <本机 id>"
  [ -d "$VAULT" ] || fail "共享目录不存在：$VAULT"

  # machineId 撞车预检：共享目录里已有同名文档、且指纹不是本机 → 两台机器会互相覆盖
  local_fp="$(machine_fingerprint)"
  doc="$VAULT/archive-$MACHINE.json"
  if [ -f "$doc" ]; then
    existing="$(grep -o '"fingerprint"[[:space:]]*:[[:space:]]*"[^"]*"' "$doc" 2>/dev/null | head -1 | sed 's/.*:[[:space:]]*"//; s/"$//')"
    if [ -n "$existing" ] && [ "$existing" != "$local_fp" ]; then
      fail "machineId '$MACHINE' 已被另一台机器使用（文档里的指纹 $existing，本机 $local_fp）。
       两台机器会写同一份 $doc 并互相覆盖，请换一个 --machine（例如机器型号）。"
    fi
  fi

      # 2026-09-12 修复：machine id 可能是纯数字（如 1234），YAML 会解析成 number，
    # 而插件 schema 要求 string —— 会让 dsh 整树加载失败、根本起不来。故一律加引号。
    VAULT_YAML="$(printf '%s' "$VAULT" | sed "s/'/''/g")"
    MACHINE_YAML="$(printf '%s' "$MACHINE" | sed "s/'/''/g")"
    mkdir -p "$(dirname "$PATCH_PATH")"
  if [ "$entry_ok" = 1 ]; then
    report "启用行已存在，未改动：$PATCH_PATH"
  else
    trimmed="$(grep -v '^[[:space:]]*#' "$PATCH_PATH" 2>/dev/null | tr -d '[:space:]' || true)"
    if [ -n "$trimmed" ] && [ "$trimmed" != "[]" ]; then
      fail "profile patch 里已有其他配置，请手工并入本片段（见文件末尾提示）：$PATCH_PATH"
    fi
    cat > "$PATCH_PATH" <<EOF
# dsh-archive-replica：跨机同步会话归档集合（外置安装，见仓库 README）
- insert:
    - id: $ENTRY_ID
      name: '$PACKAGE_NAME'
      config:
        directory: '$VAULT_YAML'
        machineId: '$MACHINE_YAML'
EOF
    report "已写入启用行：$PATCH_PATH（vault=$VAULT, machine=$MACHINE）"
  fi
  report "重启 dsh 生效（pnpm dsh web 或你的启动命令）"
elif [ "$entry_ok" = 1 ]; then
  report "启用行已存在（$PATCH_PATH），插件本体已更新；重启 dsh 生效。"
else
  cat <<EOF
[archive-replica] 未启用。要启用请重跑并给出共享目录（本机 id 默认 hostname -s）：

  $0 --enable --vault "/path/to/shared/sync/folder"

或手工把下面片段并入 $PATCH_PATH：

- insert:
    - id: $ENTRY_ID
      name: '$PACKAGE_NAME'
      config:
        directory: /共享目录/绝对路径
        machineId: 本机唯一id
EOF
fi
