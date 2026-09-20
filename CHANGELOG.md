# 更新日志（Changelog）

本仓库的版本历史。npm 上现有 `0.1.0`、`0.1.1`、`0.1.2`（已 deprecate）、`0.1.3`、`0.1.4`、
**`0.1.5`（latest）**。

## 0.1.5 — 2026-09-20

- **升级为正式 DSH 组合包**：`package.json` 新增 `dsh.bundle.patch` 声明，仓库根新增
  [`cordis.patch.yml`](cordis.patch.yml)。此后 `dsh plugin --profile <name> add dsh-archive-replica`
  会自动把它登记进 profile 的组合包层，不再出现"只作为普通依赖安装、不激活任何层"的警告。
- 组合包层**默认 `disabled: true`**：共享目录与本机 id 没有合理默认值，默认启用只会得到一个
  "看起来配好了、其实什么都没复制"的插件（dsh 也会因 `directory` 缺失而拒绝启动）。启用方式是自己
  的 profile patch 里按 id 覆盖该行并给出 `directory` 与 `machineId`（见 README「安装」）；按 id
  覆盖的是 `config` 整体而非深合并，两个字段必须同时给出。
- 这条组合包路线**取代外置副本**（`@local/dsh-archive-replica` + `install-archive-replica.sh`
  + profile patch 的 `archive-replica-external` 行）。迁移：`dsh plugin remove dsh-archive-replica`
  或删掉外置副本的启用行，改用本包自己的行；插件行 id 与包内插件名都是 `archive-replica`。
  外置副本的 YAML 示例里那个 `machineId: desktop` 本就是文档占位符，注意别把占位符当成本机 id。
- 补上 0.1.4 之后未发布的源码改动（`resolveReplicaSpec` 的可选字段处理与相应注释）。

## 0.1.4 — 2026-09-12

- **仓库与包内容脱敏**：README、PUBLISH、CHANGELOG、示例与测试夹具里不再出现具体机器名、主机名或绝对路径，
  一律改用 `desktop` / `laptop` / `1234` 这类占位符；
- **文档整理**：公开文档只保留 [`docs/cross-machine-sync.zh.md`](docs/cross-machine-sync.zh.md)
  （原理、安装、配置、撤销、排障）；维护者自己的机器记录移出发布树（不进 git、也不进 npm 包）；
- `lib/index.js` 重新构建：bundle 注释里不再带作者本机的目录结构。

## 0.1.3 — 2026-09-12

- **修复 npm 安装后 bin 不可用**：npm 打包会剥掉非 `bin` 文件的执行位（装出来 `install.sh` 是 0644），
  而 `bin/dsh-archive-replica-install` 原来直接 `exec …/install.sh`，导致 `npm i -g` 之后运行必报
  `Permission denied`。改为 `exec bash "$(dirname "$self")/../install.sh" "$@"`。
  （从 git clone 使用不受影响，所以此前只在源码树里测试时没有暴露。）

## 0.1.2 — 2026-09-12（已弃用）

- 仅为绕开 npm 暂存区（staged publish）的 409 冲突而发布的版本号占位，内容与 0.1.1 相同。
- 已 `npm deprecate`（提示改用 0.1.1）；`latest` 一度退回 0.1.1，随后由 0.1.3 接任。

## 0.1.1 — 2026-09-12

- 机器指纹 + 同名 machineId 撞车检测（两台机器的 hostname 恰好相同）：文档中写入
  `fingerprint`，`install.sh --enable` 发现同名文档来自另一台机器时**拒绝安装**。
- 插件启动打一行 info（共享目录、machineId、指纹），便于确认插件是否真的起来了。
- README（中英）补 `npx` 免安装用法与 hostname 重复的警告。
- `install.sh`：空 `~/.dsh` 给提示；已启用时不再误报“未启用”；安装时写精简 `package.json`。
- **安装器生成的 YAML 一律给 `directory` / `machineId` 加引号**：纯数字 machineId（如 `1234`）会被
  YAML 解析成 number，而插件 schema 要求 string，会让 dsh **整棵插件树加载失败、根本起不来**。

## 0.1.0 — 2026-09-12

- 首个发布：每台机器各写一份 `archive-<machineId>.json`（读取时取并集，避免共享单写者文件与同步冲突副本）；
  撤销清单 `unarchived-<machineId>.json`（撤销随清单跨机传播，不会被并集重新播放）；
  `install.sh` 把插件装到 `$DSH_HOME/plugins/archive-replica`（替换 dsh 源码目录不影响）；
  `unarchive-session.sh` 作为官方撤销入口。
