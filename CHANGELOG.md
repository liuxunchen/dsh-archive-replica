# 更新日志（Changelog）

本仓库的版本历史。npm 上现有 `0.1.0`、`0.1.1`、`0.1.2`（已 deprecate）、`0.1.3`、`0.1.4`、`0.1.5`、`0.1.6`；
`0.1.7` 为当前工作树版本（尚未发布）。

## 0.1.7 — 2026-11-07

跟进 dsh **0.2.2-rc.1**（2026-11-04 发布）。**代码零改动**——本版只做兼容性验证、文档更新与升级指引；`lib/index.js` 与 0.1.6 相同。

- **验证通过 dsh 0.2.2-rc.1**：隔离 `DSH_HOME` + 真实启动冒烟（临时 profile、依赖农场指向新宿主、临时 vault）——插件正常加载、正常发布 `archive-<machineId>.json`。0.2.2 的会话存储结构变化（会话目录由 `session-<uuid>` 改为裸 UUID、日志文件 `session.v3→v4.jsonl.zstd`）**不影响本插件**：插件从不读会话文件，只走 `workspaceRegistry`（`archivedSessionIds` / `archiveSession`），该注册表 API 在 0.2.2 未变（workspace 域 schema、`WorkspaceUnknownSessionError` / `WorkspaceActiveSessionError` 与 0.2.1 逐字节一致）。
- **升级必做：重链 profile 依赖农场**（DSH 升级后插件"突然报错/行为异常"的根因）：DSH 组合包的运行时依赖由 `~/.dsh/profiles/node_modules`（依赖农场）解析；用新前缀重装 dsh 后，农场里指向旧宿主安装根的软链**不会自动跟随**，插件会把旧版宿主包的类（`WorkspaceUnknownSessionError` 等）加载进来——与运行时宿主不是同一份模块实例，`instanceof` 全部失效，`unknown`/`active` 被误判成 `failed`，表现为每 2 秒对每个本机不存在的会话 id 刷一条警告。升级后把农场全部软链的目标前缀重指新宿主安装根（新宿主不再自带的包跳过），然后重启 dsh；见 README「dsh 升级后的必做动作」。
- **文档**：README / README.en 新增「dsh 升级后的必做动作（重链农场）」小节；本文件头部"0.1.6 尚未发布"订正。

## 0.1.6 — 2026-09-28

跟进 dsh 0.1.7 的归档管理（`unarchiveSession` / 归档准入活动检查 / 侧栏已归档筛选），插件**只做归档集合同步**。

- **删除「撤销归档」这整条通道**：dsh 自己已经有取消归档（核心 `workspaceRegistry.unarchiveSession`，
  侧栏「全部对话（显示已归档）」里也有入口），插件不再需要、也不应该替别的机器决定某个会话该不该归档。
  - `unarchived-<machineId>.json` 撤销清单、`unarchive-session.sh`、`reportStaleRevocations`、
    `republishOnRevocationChange` 与 `parseUnarchiveDocument` / `renderUnarchiveDocument` / `unarchiveFileName`
    全部移除；读取时只对 `archive-*.json` 取并集。
  - **共享目录里遗留的 `unarchived-*.json` 是惰性文件**，可以删掉，不影响插件。
  - **行为变化**：取消归档不再跨机传播。某台机器取消归档后，别的机器仍保留该归档并在并集里发布它，
    于是本机下次扫描会把它**再归档回来**（这正是"只做同步"的定义）。要让某台机器上也显示出来，
    就在那台机器上取消一次。
  - 插件现在**只做加法**：从不调用 `unarchiveSession`，从不从自己的发布文档里删 id。
- **适配归档准入的活动检查**（`WorkspaceActiveSessionError`）：别的机器归档了某个会话、而它在本机正在跑时，
  插件**不打断**本机的回合（不传 `stopActivity`），而是跳过该 id、日志里报一次，之后每次扫描重试；
  工作停下来后它会自己归档进来。报告按「繁忙时段」去重：状态出现时报一行，全部停止后复位。
- `reportRetiredSidecar` 更名为 `reportStaleSidecar`（返回类型 `StaleSidecarReport`）：警告文案改为
  「它的启动器每次启动都会把那些 id 写回注册表，于是本机归档集合跟着这个文件走，而不是跟着 GUI」——
  与撤销无关，仍是启动时的一行提醒。
- **测试与开发环境可在独立 clone 里跑**：除组合守卫 `tests/loader-composition.spec.ts`（按相对路径
  import dsh 源码树，只能在源码树里跑）外，`npx vitest run` 用宿主 dsh 自带的 `@deepseek-ai/*` 软链即可
  跑通 38 个测试；`lib/index.js` 可用 `npx esbuild` 在仓库根直接重建。
- 测试改动：`tests/unarchive.spec.ts` → `tests/sidecar.spec.ts`（只留侧车守卫），
  `replica.spec.ts` 新增「本机在跑的发布被跳过且只报一次」用例，`ReconcileResult.revoked` → `active`。

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
