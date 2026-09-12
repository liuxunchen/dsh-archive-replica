# 更新日志（Changelog）

本仓库的版本历史。npm 上现有 `0.1.0`、`0.1.1`、`0.1.2`（已 deprecate）、**`0.1.3`（latest）**。

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
