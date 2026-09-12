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
