# 发布流程（维护者）

发布有两个渠道，互相独立：**GitHub**（源码与文档）和 **npm**（`npm i -g` 一条命令装好）。

## 0) 准备

- 工作树就是唯一真相：改代码改 `src/`，改文档改 `README*.md` / `CHANGELOG.md` / `docs/`；
- 改了 `src/` 之后**必须重建 `lib/index.js`**（发布产物，esbuild 单文件 ESM bundle）：

  ```bash
  cd /path/to/deepseek-harness        # 在 dsh 源码树里构建，才能解析 @deepseek-ai/*
  pnpm exec esbuild <repo>/src/index.ts --bundle --format=esm --platform=node \
    --target=node22 --external:@deepseek-ai/\* --outfile=<repo>/lib/index.js
  ```

- `npm pack --dry-run` 看一眼包内容（`files` 白名单：`bin`、`lib`、`src`、`tests`、两个脚本、README、
  PUBLISH、LICENSE）。

## 1) GitHub

```bash
git add -A && git commit -m "…" && git push
git tag -a v<version> -m "v<version>" && git push --tags
```

- 需要一台能访问 `github.com` 的机器（部分网络下 DNS 给出的 IP 不通，换一个前端 IP 即可；
  `api.github.com` 与 SSH 通常一直是通的）；
- 仓库里不要放个人机器名、绝对路径等私有信息：内部记录放工作树里被 `.gitignore` 忽略的目录。

## 2) npm

**凭据**：账号需要开启 2FA；用一个 **Granular Access Token + Bypass 2FA** 写进 `~/.npmrc`：

```
//registry.npmjs.org/:_authToken=npm_xxx
```

普通 `_authToken` 发布会 403，必须 `--otp=` 或 bypass token。`npm whoami` 应输出你的账号名。

**发布**：

```bash
npm version patch -m "chore(release): %s"    # 升版本 + 打 tag（仓库已 init git）
git push && git push --tags
npm publish                                   # 无 scope 包，默认 public
```

**发布后必须复核**（npm 现在默认「暂存发布」：`npm publish` 可能只返回 `202 Accepted`，
CLI 说成功 ≠ 已经上线）：

```bash
curl -s https://registry.npmjs.org/<package> | python3 -m json.tool | head -20
npm view <package> versions
```

若进了暂存区：`npm stage list <package>` → `npm stage approve <stage-id>`。

**注意**：bypass-2FA 的 token **不能 `unpublish`**（403）——删版本只能在 npm 网页上做（或换不 bypass
的登录态 + OTP）；`npm deprecate` 与 `npm dist-tag add` 是允许的，可用来兜底。

## 3) 发布后自测（任一机器）

```bash
npm i -g --prefix /tmp/ar-test <package>@<version>
/tmp/ar-test/bin/dsh-archive-replica-install --check           # 报告当前安装状态
DSH_HOME=/tmp/ar-home /tmp/ar-test/bin/dsh-archive-replica-install --enable \
  --vault /tmp/ar-vault --machine test-machine                 # 隔离试装，不碰真实 ~/.dsh
```

⚠️ 已知坑：npm 打包会**剥掉非 `bin` 文件的执行位**（装出来的 `install.sh` 是 0644），所以
`bin/dsh-archive-replica-install` 必须显式用 `bash` 调用它，不能直接 `exec`。

## 4) 发布后自测（组合包路线，v0.1.5 起）

组合包的真实路径是「装进 profile → 层被登记 → 按 id 覆盖启用」，隔离验证三步（不碰真实 `~/.dsh`）：

```bash
export PATH="$HOME/.local/share/pnpm:$PATH"          # dsh plugin 转发给 pnpm
rm -rf /tmp/ar-home /tmp/ar-vault && mkdir -p /tmp/ar-home /tmp/ar-vault

DSH_HOME=/tmp/ar-home dsh plugin --profile web add <包路径或包名>@<version>
cat /tmp/ar-home/profiles/web/package.json           # bundles 里应出现 dsh-archive-replica，
                                                    # 且全程不得出现 "declares no dsh.bundle"
DSH_HOME=/tmp/ar-home dsh --profile web --dump-default-config   # 应出现「# == dsh-archive-replica」层标记

cat > /tmp/ar-home/profiles/web/cordis.patch.yml <<'EOF'
- id: archive-replica
  disabled: false
  config:
    directory: '/tmp/ar-vault'
    machineId: 'test-machine'
EOF
DSH_HOME=/tmp/ar-home dsh --profile web --dump-config  # 该行应为 disabled: false 且 patched by 指向 profile patch
```

## 5) 镜像同步（维护者本机）

维护者机器上有一份 `sync-mirrors.sh`（**不随本仓库发布**，三处副本同内容），方向永远是
**真相（本仓库）→ 派生物**：

| 派生物 | 用途 |
|---|---|
| `~/prj/dsh/dsh-archive-replica` | 随文件同步工具分发给各机的**完整真相副本**（无 `.git`） |
| `~/Nutstore Files/Nutstore/dsh-sync/plugin/archive-replica` | **外置副本**（`@local/…`），供 `install-archive-replica.sh` 使用；v0.1.5 起为遗留路线 |

同步内容：`src/`、**`lib/`**、`cordis.patch.yml`（组合包层）、`README*`、`CHANGELOG.md`，第 1 个派生物
是整树（排除 `.git/`、`node_modules/`、`*.tgz`）。

**不覆盖**外置副本自己的 `package.json` 与它自己的 `cordis.patch.yml[.yaml]`：那是外置清单
（包名 `@local/dsh-archive-replica`、`main: lib/index.js`），只属于外置路线，改它等于改那些机器的启用方式。

⚠️ 只改 `src/` 而不重建 `lib/`，派生物就会停在旧构建上——本脚本同步 `lib/`，不会替你构建。
发布流程走完（第 0 步重建 → 第 1 步 tag/push → 第 2 步 publish）之后再跑本脚本即可。
