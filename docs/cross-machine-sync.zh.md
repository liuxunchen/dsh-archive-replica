# 跨机同步 dsh 会话归档 —— 原理、安装与排障

> 通用说明，适用于任意机器组合；文中不含特定机器名或绝对路径。

## 1. 问题：归档状态是本机的

dsh 的「归档会话」**不在会话日志里**，而是 workspace 注册表的一个全局字段：

| 数据 | 位置 | 会随会话目录一起同步吗 |
|---|---|---|
| 会话内容 | `$DSH_HOME/sessions/<工作区 slug>/<会话 id>/session.v3.jsonl.zstd` | ✅（若你把 sessions 同步起来） |
| 归档集合 | `$DSH_HOME/storages/workspace.json` 的 `global.archivedSessionIds` | ❌ 本机文件 |

于是：A 机归档了会话，B 机（日志已经同步过去）依旧把它列出来。归档还是**单向**操作——注册表只提供
`archiveSession`，没有取消归档。

## 2. 方案：每台机器各写一份文档

共享目录交给任意文件同步工具（坚果云 / Dropbox / iCloud / Syncthing …），插件只在里面读写自己的文件：

| 文件 | 内容 | 谁写 |
|---|---|---|
| `archive-<machineId>.json` | 本机归档集合；读取时对所有 `archive-*.json` 取并集 | 本机插件 |
| `unarchived-<machineId>.json` | 撤销清单（只有撤销过才出现） | 本机撤销入口 |

三条设计约束，都是踩坑之后定下来的：

1. **一台机器一个文件** ⇒ 永远单写者，结构上不可能产生“两份都合法”的同步冲突副本；
2. **并集只增不减**，撤销靠独立的撤销清单跨机传播——否则下一次并集会把撤销过的 id 又播回来；
3. 插件装在 `$DSH_HOME/plugins/archive-replica`，**不依赖 dsh 源码目录**：整份替换 dsh 源码树也不会丢，
   升级 dsh 后照旧可用。

**前置条件**：会话日志本身要能跨机（常见做法是把 `~/.dsh/sessions` 软链到同步目录）。本插件只跨机传
“归档 id”，不传日志；某条 id 在本机还没有对应日志时直接跳过，等日志同步到了自然生效。

⚠️ **不要把 `$DSH_HOME/storages/`（含 `workspace.json`）软链进同步目录**：dsh 的写路径是“同目录临时文件 +
rename”，rename 会把软链本身换成普通文件，第一次归档后同步就悄悄断了；即使整个目录软链，整文件
last-write-wins 也会让多台机器互相整份覆盖。

## 3. 安装

**npm（推荐）**

```bash
npm i -g dsh-archive-replica
dsh-archive-replica-install --enable --vault "<共享目录>" --machine "<本机唯一 id>"
# 然后重启 dsh
```

**源码（TypeScript，由 tsx 直接加载）**：把插件目录放到 `$DSH_HOME/plugins/archive-replica`，
在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 里用 `insert` 挂载：

```yaml
- insert:
    - id: archive-replica-external
      name: '@local/dsh-archive-replica'
      config:
        directory: '/path/to/shared/folder'
        machineId: 'desktop'
```

`--machine` **每台机器必须不同**（默认取短 hostname）。**hostname 相同的机器必须显式指定**，否则两台会写
同一个文档互相覆盖——插件用内核 machine-id 指纹检测这种撞车，并在安装时拒绝。

## 4. 配置

| 字段 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `directory` | ✅ | 无 | 共享目录绝对路径（故意不给默认值：默认到 cwd 只会把文件撒得到处都是） |
| `machineId` | | 短 hostname | 必须匹配 `[A-Za-z0-9._-]{1,64}`；**纯数字 id 在 YAML 里要加引号**（见第 7 节） |
| `pollIntervalMs` | | `2000` | 轮询周期。不用文件系统监听：同步目录的通知本来就不可靠，且外置插件解析不到第三方包 |

## 5. 它怎么工作

启动后按 `pollIntervalMs` 轮询共享目录 → 读所有 `archive-*.json` 取并集 → 对本机存在、尚未归档的会话调用
`ctx.workspaceRegistry.archiveSession()`（走 dsh 自己的串行落盘链，**绝不直接写文件**）→ 本机集合一旦变化
就重写自己的文档 → 各机文档自动收敛到全量并集，**任何一台的文件都能独立恢复整套归档**。本机没有的 id 跳过。
全程幂等，不会自激循环。

## 6. 撤销归档

上游 dsh 目前只有 `archiveSession`，**撤销需要先停 dsh**（它内存里的注册表才是权威），再由脚本改写注册表
并清理所有同步落点。本仓库的 `unarchive-session.sh` 是官方入口：

```bash
bash unarchive-session.sh <会话 id> [...]      # 本机撤销：写撤销清单 + 清注册表 + 清同步文件
bash unarchive-session.sh                      # 另一台：应用已有撤销清单
```

撤销是**全局**语义：一台撤销，所有机器都不再归档它，且不会被并集重新播放。

## 7. 排障

| 现象 | 原因 / 处理 |
|---|---|
| 共享目录里始终只有自己的文件 | 另一台没装/没启用插件；或该目录不在同步工具的管理范围内（很多工具只同步“已注册/已勾选”的目录，自己新建的目录默认不同步） |
| dsh 起不来，报 `$.machineId expected string but got 1234` | 生成的 YAML 里 `machineId` 没加引号，纯数字被解析成 number 而 schema 要 string；改成 `machineId: '1234'` |
| `dsh-archive-replica-install` 报 `Permission denied` | 旧版本 bug：npm 打包会剥掉非 `bin` 文件的执行位；升级到 ≥ 0.1.3 |
| 撤销后归档又回来了 | 还有第二套同步机制在跑（例如旧包装脚本把快照并回注册表）。撤销必须把所有落点一次清干净 |
| GUI 里归档状态没变化 | 确认 `--check` 三项全绿、profile patch 里已写入启用行，然后重启 dsh |

## 8. 已知边界

- 只同步**归档集合**；工作区分组与顺序不同步。
- 集合里只有 session id，不含任何对话内容（内容仍由你自己的会话同步负责）。
- 归档集合只是本机注册表的显示过滤器；插件不修改会话数据本身。
