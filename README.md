# dsh-archive-replica

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的**会话归档状态**在多台机器之间同步，并支持**撤销归档**。

English · [README.en.md](README.en.md)

## 它解决什么问题

dsh 的会话归档状态**不在会话日志里**：

| 数据 | 位置 | 随网盘同步？ |
|---|---|---|
| 会话内容 | `~/.dsh/sessions/` | ✅（软链到同步目录时） |
| 归档集合 `archivedSessionIds` | `$DSH_HOME/storages/workspace.json` | ❌ 只在本机 |

于是 A 机归档一个会话后，B 机（会话日志已经同步过去）里它照旧显示——归档状态没有任何可同步的载体。

而且归档在 dsh 里是**单向**的：核心只有 `archiveSession`，误归档之后没有撤销入口。

本插件补上这两件事：

- **复制**：每台机器把本机归档集合写成共享目录里的一份文档，所有机器读取时取并集；
- **撤销**：共享目录里另有一份「撤销清单」，被撤销的会话不会再被任何机器导入或发布（全局撤销）。

## 安装

**前置**：多台机器通过同一个文件同步工具（坚果云 / Dropbox / Syncthing…）共享一个目录，并且各自的 `~/.dsh/sessions` 也指向同步目录（会话日志才会跨机）。
共享目录必须落在同步工具的**已注册同步范围**内——坚果云这类工具的挂载根下新建目录默认不同步。

```bash
git clone https://github.com/<owner>/dsh-archive-replica.git ~/dsh-archive-replica

bash ~/dsh-archive-replica/install.sh --enable \
  --vault "$HOME/path/to/shared/sync/folder" \
  --machine "$(hostname -s)"

# 然后重启 dsh
```

- `--vault`：所有机器共享、且被网盘复制的目录（**必填**，且必须已存在）
- `--machine`：本机唯一标识，用于命名本机的文档；**每台机器必须不同**，默认取 `hostname -s`。
  ⚠️ **多台机器 hostname 相同是常事** —— 那种情况下必须显式指定（如 `--machine laptop`）。
  插件会在发布文档里记下本机指纹，`install.sh` 在检测到"同名文档来自另一台机器"时**直接拒绝安装**，插件启动时也会告警
- 装到哪：`~/.dsh/plugins/archive-replica` ＋ `~/.dsh/profiles/node_modules/@local/dsh-archive-replica` 软链 ＋ profile patch 里的启用行
- 自检：`bash install.sh --check`；更新：`git pull && bash install.sh`，再重启 dsh

也可以用 npm 安装（等价；bin 会装成 `dsh-archive-replica-install`）：

```bash
npm install -g dsh-archive-replica
dsh-archive-replica-install --enable --vault "$HOME/path/to/shared/sync/folder"

# 不想全局安装（试用/无 sudo）就用 npx：
npx -p dsh-archive-replica dsh-archive-replica-install --check
```

第二台机器重复同样三步（换 `--machine`）。

## 配置

启用行写在 `~/.dsh/profiles/<profile>/cordis.patch.yml`：

```yaml
- insert:
    - id: archive-replica-external
      name: '@local/dsh-archive-replica'
      config:
        directory: /共享目录/绝对路径
        machineId: desktop         # 每台机器必须不同
        # watch: true              # 是否持续扫描共享目录（默认 true）
        # pollIntervalMs: 2000     # 扫描间隔，毫秒（默认 2000）
```

## 撤销归档

归档是单向的，所以撤销走「数据」这条路：

```bash
# 1) 先在跑 dsh 的终端里 Ctrl+C 停掉 dsh
# 2) 撤销（写撤销清单 + 清本机注册表 + 清所有同步文件 + 读回校验）
bash ~/dsh-archive-replica/unarchive-session.sh <session-id>
# 3) 重启 dsh —— 该会话重新出现在列表里
```

- 撤销是**全局**的：一台撤销，所有机器都不再归档该会话。插件读到清单后**不再导入**它、并从自己的发布里**剔除**它，所以别的机器不会把这次归档"播放"回来。
- **另一台机器**：把 `unarchive-session.sh` 拷过去，**不带参数**跑一次即可应用撤销清单（它只清本机注册表并校验）。
- 为什么撤销要停 dsh：注册表 `workspace.json` 的内存态才是权威，dsh 运行期间改文件会被内存态写回；而且核心没有取消归档接口，脚本必须离线重写注册表。

## 工作原理

共享目录里每台机器写两类文件，都是**单写者**：

| 文件 | 内容 |
|---|---|
| `archive-<machineId>.json` | 本机的归档集合 |
| `unarchived-<machineId>.json` | 本机撤销过的 id（撤销清单） |

读取时对整个目录取并集，**撤销清单优先**：任何清单撤销的 id 都不会被导入，也不会出现在本机的发布里。
文件按内容识别而非文件名，所以网盘产生的冲突副本会被自然并入，写了一半或不相干的 JSON 被忽略。

插件用扫描循环（默认 2s）读目录，不依赖文件系统通知——网盘挂载点上的通知本就不可靠。
所有归档写入都走 dsh 自己的 `workspace/archiveSession` 接口，插件从不直接写注册表。

如果本机归档集合里仍留着已被撤销的 id，插件会在日志里报告一次（附 id 列表），提示你运行 `unarchive-session.sh`。

## 已知限制

- **把撤销应用到某台机器需要一次离线操作**（见上），因为注册表没有取消归档接口；
- **共享目录是被信任的输入**：其中任何能解析成本文档格式的 JSON 都会被并入，所以目录必须由你自己掌控；
- 只同步**归档集合**：工作区顺序与记账、附件都不在同步范围内；
- 未安装本插件的机器什么也不发布，它的归档只留本机；
- **两台机器配了同一个 `machineId` 就无法正常工作**：它们写同一份文档、互相覆盖归档集合。插件与安装脚本都会检测并报错（依据是文档里的机器指纹），但 `machineId` 仍要你自己保证唯一。

## 开发与测试

源码是 TypeScript，由 dsh 的 tsx 启动器直接加载；插件只依赖 Node 内建能力与宿主提供的 `@deepseek-ai/*` 包，**不依赖任何第三方运行时包**（这也是它能装在 dsh 源码目录之外的原因）。

测试需要在 dsh 源码树里跑（它们 import 的是 dsh 的包，独立 clone 解析不到）：

```bash
cd /path/to/deepseek-harness
pnpm exec vitest run packages/workspace/archive-replica     # 41 tests
```

`lib/index.js` 是发布用的构建产物（esbuild 打的单文件 ESM bundle；`@deepseek-ai/*` 保持外部引用，运行时由宿主的 dsh 提供）。
改了 `src/` 之后要重新构建并随提交更新 `lib/`：

```bash
cd /path/to/deepseek-harness        # 在 dsh 源码树里构建，才能解析 @deepseek-ai/*
pnpm exec esbuild <repo>/src/index.ts --bundle --format=esm --platform=node \
  --target=node22 --external:@deepseek-ai/\* --outfile=<repo>/lib/index.js
```

## 文档

- [`docs/cross-machine-sync.zh.md`](docs/cross-machine-sync.zh.md) —— 原理、安装、配置、撤销与排障
- [`CHANGELOG.md`](CHANGELOG.md) —— 版本历史与修复记录
- [`PUBLISH.md`](PUBLISH.md) —— 维护者发布流程（GitHub / npm）

## 许可

[MIT](LICENSE)
