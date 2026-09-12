#!/usr/bin/env bash
# 撤销会话归档（全局生效）。
#
# 为什么需要它：dsh 的归档是单向的（核心只有 archiveSession，没有取消归档接口），
# 归档集合又只持久化在本机的 $DSH_HOME/storages/workspace.json 里。本脚本是官方的
# 撤销入口：它写下的「撤销清单」由 dsh-archive-replica 插件跨机传播，别的机器不会
# 再把该会话灌回归档。
#
# 做四件事（必须在 dsh 停止时做，否则内存态会写回文件）：
#   1. 把要撤销的 id 写进本机撤销清单 unarchived-<machineId>.json（插件读它 → 不再导入、
#      发布时剔除 → 传到另一台机器）
#   2. 从本机注册表 workspace.json 的归档集合里移除这些 id（列表里就重新出现）
#   3. 从共享目录里所有归档文档中移除这些 id
#   4. 读回校验
#
# 用法：
#   unarchive-session.sh <session-id> [<session-id> ...]   撤销这些会话
#   unarchive-session.sh                                   只应用已有的全局撤销清单
#                                                          （另一台机器撤销后，本机跑这一条）
#
# 共享目录与本机 id 的来源（优先级从高到低）：
#   --vault/--machine 参数  >  环境变量 VAULT_DIR/MACHINE  >  从 profile patch 自动读取
set -euo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
REG="$DSH_HOME/storages/workspace.json"
MACHINE="${MACHINE:-}"
VAULT_DIR="${VAULT_DIR:-}"
SIDS=()

usage() { sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --vault) VAULT_DIR="${2:-}"; shift 2 ;;
    --machine) MACHINE="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "未知参数：$1" >&2; usage; exit 2 ;;
    *) SIDS+=("$1"); shift ;;
  esac
done

# ---- 自动发现共享目录与本机 id（未显式给出时）-------------------------------
if [ -z "$VAULT_DIR" ] || [ -z "$MACHINE" ]; then
  patches="$(ls "$DSH_HOME"/profiles/*/cordis.patch.yml 2>/dev/null || true)"
  if [ -n "$patches" ]; then
    # shellcheck disable=SC2086
    [ -n "$VAULT_DIR" ] || VAULT_DIR="$(grep -h -m1 '^[[:space:]]*directory:' $patches 2>/dev/null \
      | head -1 | sed 's/^[[:space:]]*directory:[[:space:]]*//' | tr -d '"' | tr -d "'" | xargs || true)"
    # shellcheck disable=SC2086
    [ -n "$MACHINE" ] || MACHINE="$(grep -h -m1 '^[[:space:]]*machineId:' $patches 2>/dev/null \
      | head -1 | sed 's/^[[:space:]]*machineId:[[:space:]]*//' | tr -d '"' | tr -d "'" | xargs || true)"
  fi
fi
MACHINE="${MACHINE:-$(hostname -s)}"

[ -n "$VAULT_DIR" ] || {
  echo "✗ 找不到共享目录。请用 --vault <路径> 指定，或在 profile patch 里配置 directory。" >&2
  exit 1
}
[ -d "$VAULT_DIR" ] || { echo "✗ 共享目录不存在：$VAULT_DIR" >&2; exit 1; }

# 归档集合的落点：插件共享目录（可用 EXTRA_DIRS 追加，例如网盘的冲突副本目录）
DIRS=("$VAULT_DIR")
for extra in ${EXTRA_DIRS:-}; do DIRS+=("$extra"); done
export UNARCHIVE_DIRS="$(printf '%s\n' "${DIRS[@]}")"

TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="${BACKUP_DIR:-$DSH_HOME/dsh/archive-sync/backups}"
JOURNAL="$VAULT_DIR/unarchived-$MACHINE.json"

echo "== 撤销会话归档（机器 $MACHINE，共享目录 $VAULT_DIR）=="

# 1) 安全检查：dsh 必须已停止
if [ "${SKIP_RUNNING_CHECK:-0}" != "1" ] && ss -ltn 2>/dev/null | grep -q ':3080'; then
  echo "✗ dsh 仍在监听 3080。请先在运行 dsh 的终端 Ctrl+C 停掉，再运行本脚本。" >&2
  exit 1
fi
echo "✓ dsh 已停止（3080 无监听）"

# 2) 备份注册表
mkdir -p "$BACKUP_DIR"
[ -f "$REG" ] || { echo "✗ 找不到注册表：$REG（这台机器跑过 dsh 吗？）" >&2; exit 1; }
cp -p "$REG" "$BACKUP_DIR/workspace.json.$TS.bak"
echo "✓ 已备份注册表 → $BACKUP_DIR/workspace.json.$TS.bak"

# 3) 写撤销清单 + 清注册表 + 清共享目录里的归档文档
python3 - "$REG" "$JOURNAL" "$MACHINE" "$BACKUP_DIR" "$TS" "${SIDS[@]+"${SIDS[@]}"}" <<'PY'
import datetime, json, os, shutil, sys, tempfile

reg_path, journal, machine, backup_dir, ts = sys.argv[1:6]
requested = [i for i in sys.argv[6:] if i]
dirs = [p for p in os.environ.get('UNARCHIVE_DIRS', '').splitlines() if p]
now = datetime.datetime.now(datetime.timezone.utc)
stamp = now.strftime('%Y-%m-%dT%H:%M:%S.') + f'{now.microsecond // 1000:03d}Z'


def load_ids(path, field, holder=None):
    try:
        with open(path, encoding='utf-8') as fh:
            doc = json.load(fh)
    except (OSError, ValueError):
        return None
    if not isinstance(doc, dict):
        return None
    target = doc.get(holder) if holder else doc
    if not isinstance(target, dict):
        return None
    ids = target.get(field)
    return list(ids) if isinstance(ids, list) else None


def write_json(path, doc):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix='.unarchive-', suffix='.tmp')
    with os.fdopen(fd, 'w', encoding='utf-8') as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=2)
        fh.write('\n')
    os.replace(tmp, path)


# 3a) 目标撤销集合 = 已有的全局撤销清单 ∪ 本次指定的 id
revoked = []
for d in dirs:
    if not os.path.isdir(d):
        continue
    for name in sorted(os.listdir(d)):
        if name.startswith('unarchived-') and name.endswith('.json'):
            ids = load_ids(os.path.join(d, name), 'unarchivedSessionIds')
            if ids:
                revoked.extend(ids)
revoked.extend(requested)
seen, ordered = set(), []
for sid in revoked:
    if sid not in seen:
        seen.add(sid)
        ordered.append(sid)
revoked = ordered

if not revoked:
    print('  · 既没有现存撤销清单，也没有指定 id：无事可做。')
    sys.exit(0)
print(f'  目标撤销集合：{len(revoked)} 条' + (f'（本次新增 {len(requested)} 条）' if requested else '（全部来自已有清单）'))
seen = set(revoked)

# 3b) 写本机撤销清单（插件据此停止导入、并从发布中剔除 → 传给另一台机器）
previous = load_ids(journal, 'unarchivedSessionIds') or []
merged, seen_ids = [], set()
for sid in previous + revoked:
    if sid not in seen_ids:
        seen_ids.add(sid)
        merged.append(sid)
if merged != previous:
    if os.path.exists(journal):
        shutil.copy2(journal, os.path.join(backup_dir, f'{os.path.basename(journal)}.{ts}.bak'))
    write_json(journal, {
        'version': 1,
        'machine': machine,
        'updatedAt': stamp,
        'unarchivedSessionIds': merged,
    })
    print(f'  ✓ 已写撤销清单 {journal}：{len(previous)} → {len(merged)} 条')
else:
    print(f'  · 撤销清单已是最新（{len(merged)} 条）')

# 3c) 从注册表与共享目录的归档文档里移除这些 id
def strip(path, is_registry):
    try:
        with open(path, encoding='utf-8') as fh:
            doc = json.load(fh)
    except (OSError, ValueError):
        return
    if not isinstance(doc, dict):
        return
    target = doc.get('global') if is_registry else doc
    if not isinstance(target, dict) or not isinstance(target.get('archivedSessionIds'), list):
        return
    before = list(target['archivedSessionIds'])
    after = [i for i in before if i not in seen]
    shutil.copy2(path, os.path.join(backup_dir, f'{os.path.basename(path)}.{ts}.bak'))
    if before == after:
        print(f'  · {path}：{len(before)} 条，本就不含，跳过')
        return
    target['archivedSessionIds'] = after
    if 'updatedAt' in doc:
        doc['updatedAt'] = stamp
    if 'count' in doc:
        doc['count'] = len(after)
    write_json(path, doc)
    print(f'  ✓ {path}：{len(before)} → {len(after)}（移除 {len(before) - len(after)} 条）')


print('【注册表】')
strip(reg_path, True)

print('【共享目录】')
for d in dirs:
    if not os.path.isdir(d):
        continue
    for name in sorted(os.listdir(d)):
        if name.endswith('.json') and not name.startswith('unarchived-'):
            strip(os.path.join(d, name), False)
PY

# 4) 读回校验
python3 - "$REG" <<'PY'
import json, os, sys
reg_path = sys.argv[1]
dirs = [p for p in os.environ.get('UNARCHIVE_DIRS', '').splitlines() if p]
revoked = set()
for d in dirs:
    if not os.path.isdir(d):
        continue
    for name in sorted(os.listdir(d)):
        if name.startswith('unarchived-') and name.endswith('.json'):
            try:
                ids = json.load(open(os.path.join(d, name), encoding='utf-8')).get('unarchivedSessionIds') or []
            except (OSError, ValueError):
                continue
            revoked.update(ids)
doc = json.load(open(reg_path, encoding='utf-8'))
left_reg = sorted(revoked & set(doc['global']['archivedSessionIds']))
print(f'  注册表：{len(doc["global"]["archivedSessionIds"])} 条归档，仍含已撤销 {left_reg or "无 ✓"}')
bad = list(left_reg)
for d in dirs:
    if not os.path.isdir(d):
        continue
    for name in sorted(os.listdir(d)):
        if not name.endswith('.json') or name.startswith('unarchived-'):
            continue
        p = os.path.join(d, name)
        try:
            other = json.load(open(p, encoding='utf-8'))
        except (OSError, ValueError):
            continue
        ids = other.get('archivedSessionIds')
        if not isinstance(ids, list):
            continue
        left = sorted(revoked & set(ids))
        print(f'  {p}：{len(ids)} 条，仍含已撤销 {left or "无 ✓"}')
        bad += left
print()
if bad:
    print(f'✗ 仍有残留：{bad}')
    sys.exit(1)
print('✓ 全部落点都已不含撤销的会话')
PY

echo
echo "✓ 撤销完成。重启 dsh 后："
echo "   · 这些会话重新出现在列表里；"
echo "   · 插件读到撤销清单 → 不再导入、发布时剔除 → 另一台机器也不会再归档它们；"
echo "   · 另一台机器跑一次本脚本（不带参数）即可应用这份撤销。"
