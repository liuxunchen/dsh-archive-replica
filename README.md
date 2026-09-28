# dsh-archive-replica

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的**会话归档状态**在多台机器之间同步。

English · [README.en.md](README.en.md)

## 它解决什么问题

dsh 的会话归档状态**不在会话日志里**：

| 数据 | 位置 | 随网盘同步？ |
|---|---|---|
| 会话内容 | `~/.dsh/sessions/` | ✅（软链到同步目录时） |
| 归档集合 `archivedSessionIds` | `$DSH_HOME/storages/workspace.json` | ❌ 只在本机 |

于是 A 机归档一个会话后，B 机（会话日志已经同步过去）里它照旧显示——归档状态没有任何可同步的载体。

本插件补上的就是**复制**这一件事：每台机器把本机归档集合写成共享目录里的一份文档，所有机器读取时取并集。

**取消归档不归本插件管**：dsh 自己已经有这个能力（`workspaceRegistry.unarchiveSession`，侧栏筛选「全部对话（显示已归档）」里也有取消归档入口），
所以把会话取回来是**在本机做的一次操作**，不跨机传播——哪台机器想让它重新出现，就在那台机器上取消归档。

## 安装

**前置**：多台机器通过同一个文件同步工具（坚果云 / Dropbox / Syncthing…）共享一个目录，并且各自的 `~/.dsh/sessions` 也指向同步目录（会话日志才会跨机）。
共享目录必须落在同步工具的**已注册同步范围**内——坚果云这类工具的挂载根下新建目录默认不同步。

本包是**可安装的 DSH 组合包**（`package.json` 声明 `dsh.bundle.patch`）：安装进 profile 后，插件行由包自己携带，不再需要外置安装脚本。

```bash
dsh plugin --profile web add dsh-archive-replica      # 装进 web profile（包名即参数）
```

首次使用会初始化 profile，并把本包追加进它的组合包层。**装完还要启用它**——组合包层里的插件行默认禁用（原因见下节「配置」），它需要你给出共享目录与本机 id。重启 dsh 即生效。

沿用旧版**外置副本**（`@local/dsh-archive-replica` ＋ `install-archive-replica.sh`）的机器：删掉外置副本的启用行（id `archive-replica-external`）与 `~/.dsh/plugins/archive-replica`、`~/.dsh/profiles/node_modules/@local/dsh-archive-replica` 软链，改用上面「配置」一节里的那一行即可；数据文件 `archive-<machineId>.json` 不动。要迁回外置副本（例如机器装不上 pnpm）：`git clone` 本仓库后 `bash install.sh --enable --vault <共享目录> --machine <本机 id>`，或 `npm i -g dsh-archive-replica` 后用 `dsh-archive-replica-install --check` 自检——这两条路与本包各自独立，**不要同时启用**。

## 配置

组合包自带这一行（`cordis.patch.yml`，默认 `disabled: true`），启用 = 在**自己的 profile patch** 里按 id 覆盖它。归档集合同步离开用户配置就没有合理默认值——默认启用只会得到一个"看起来配好了、其实什么都没复制"的插件，所以这行必须由你写成实际值：

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: archive-replica
  disabled: false
  config:
    directory: '/共享目录/绝对路径'   # 必填，且必须已存在（落在网盘「已注册同步范围」内）
    machineId: desktop               # 必填，每台机器必须不同；纯数字也要加引号
    # watch: true                    # 是否持续扫描共享目录（默认 true）
    # pollIntervalMs: 2000           # 扫描间隔，毫秒（默认 2000）
```

- `directory`：所有机器共享、且被网盘复制的目录（**必填**，且必须已存在）
- `machineId`：本机唯一标识，用于命名本机的文档；**每台机器必须不同**。
  ⚠️ **多台机器 hostname 相同是常事** —— 别照抄 `desktop` 这类文档占位符；插件会在发布文档里记下本机指纹，一旦发现"同名文档来自另一台机器"就会告警
- 按 id 覆盖的是 `config` **整体**，不是深合并：改了 `directory` 就得把 `machineId` 一起写上
- 重启 dsh 后看日志里那一行 info（共享目录、machineId、指纹）确认插件起来了

## 取消归档（本机操作）

在侧栏把筛选切到「全部对话（显示已归档）」或「仅显示已归档」，对着那一行点「取消归档」即可；
核心接口就是 `workspaceRegistry.unarchiveSession(id)`，会把它从注册表全局归档集合里删掉，会话回到原来的位置。

- **不跨机传播**：取消归档只动本机。别的机器各自还留着这条归档，而且它们的发布里也有它，所以你把本机这一份取消掉之后，
  下次扫描（或本机下次归档别的东西时）会被并集**再归档回来**。要让某台机器上也显示出来，就在那台机器上取消一次。
- 本插件**只做加法**：它从不调用 `unarchiveSession`，从不从自己的文档里删 id。
- 归档时若有工作在跑（dsh 新增的 `WorkspaceActiveSessionError`）：插件**不打断**本机正在跑的回合，而是跳过它、
  在日志里报一次，之后每次扫描重试——工作停下来之后它会自己归档进来。
- 历史遗留的 `unarchived-<machineId>.json` 撤销清单已不再被读取，可以删掉（见 [CHANGELOG](CHANGELOG.md) 0.1.6）。

## 工作原理

共享目录里每台机器写一份文件，**单写者**：

| 文件 | 内容 |
|---|---|
| `archive-<machineId>.json` | 本机的归档集合 |

读取时对整个目录取并集，逐个交给 dsh 自己的 `workspace/archiveSession` 归档（插件从不直接写注册表）。
文件按内容识别而非文件名，所以网盘产生的冲突副本会被自然并入，写了一半或不相干的 JSON 被忽略。

插件用扫描循环（默认 2s）读目录，不依赖文件系统通知——网盘挂载点上的通知本就不可靠。
本机新归档一个会话时，注册表的 `domain/changed` 事件会立刻触发一次发布（约 1 秒内），不用等下一次扫描。

## 已知限制

- **取消归档是每台机器各自的动作**，不跨机同步（见上）；
- **共享目录是被信任的输入**：其中任何能解析成本文档格式的 JSON 都会被并入，所以目录必须由你自己掌控；
- 只同步**归档集合**：工作区顺序与记账、附件、置顶（`pinnedSessionIds`）都不在同步范围内；
- 未安装本插件的机器什么也不发布，它的归档只留本机；
- **两台机器配了同一个 `machineId` 就无法正常工作**：它们写同一份文档、互相覆盖归档集合。插件与安装脚本都会检测并报错（依据是文档里的机器指纹），但 `machineId` 仍要你自己保证唯一。

## 开发与测试

源码是 TypeScript，由 dsh 的 tsx 启动器直接加载；插件只依赖 Node 内建能力与宿主提供的 `@deepseek-ai/*` 包，**不依赖任何第三方运行时包**（这也是它能装在 dsh 源码目录之外的原因）。

```bash
npx vitest run                                  # 38 tests：vault / replica / 失败路径 / 插件行 / 指纹
npx tsc --noEmit                                # 全部源码与测试的类型检查
```

唯一的例外是 `tests/loader-composition.spec.ts`——真实 Loader + Include + 真实 workspace 注册表的组合守卫，
它按相对路径 import dsh 源码树里的 `workspace/src` 与 `storage-domain/tests`，**只能在 dsh 源码树里跑**：

```bash
cd /path/to/deepseek-harness
pnpm exec vitest run packages/workspace/archive-replica/     # 含组合守卫
```

其余测试所需的 `@deepseek-ai/*` 就是宿主 dsh 自带的那几个包：在仓库根建 `node_modules/@deepseek-ai/`
把它们软链进来即可（`node_modules/` 已在 `.gitignore` 里）。

`lib/index.js` 是发布用的构建产物（esbuild 打的单文件 ESM bundle；`@deepseek-ai/*` 保持外部引用，运行时由宿主的 dsh 提供）。
改了 `src/` 之后要重新构建并随提交更新 `lib/`：

```bash
npx esbuild src/index.ts --bundle --format=esm --platform=node --target=node22 \
  --external:@deepseek-ai/\* --outfile=lib/index.js
```

（在 dsh 源码树里也可以用 `pnpm exec esbuild`，两者产物一致。）

## 文档

- [`docs/cross-machine-sync.zh.md`](docs/cross-machine-sync.zh.md) —— 原理、安装、配置与排障
- [`CHANGELOG.md`](CHANGELOG.md) —— 版本历史与修复记录
- [`PUBLISH.md`](PUBLISH.md) —— 维护者发布流程（GitHub / npm）

## 许可

[MIT](LICENSE)
