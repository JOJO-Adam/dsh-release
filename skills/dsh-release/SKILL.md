---
name: dsh-release
description: "DSH 插件发布流水线：预检、升版本、跑测试、提交、SSH 推送、npm 发布、registry 校验、可选装进桌面版、提交 hub。当要发布/升级自己的 dsh-* 插件包时使用。默认只读，写操作必须 --yes。"
whenToUse: "发布插件 / npm publish / 升版本 / release / 推 GitHub / 提交 hub / 发新版 时"
license: MIT
---

# DSH 插件发布流水线

> 一条命令把「测试 → 版本 → 提交 → 推送 → 发布 → 验证」跑完。
> 凭据只从 macOS 钥匙串读，不落盘、不打印。

## 0. 前置

| 依赖 | 要求 |
|---|---|
| npm token | 钥匙串 generic：`dsh-npm-token` |
| GitHub token | 钥匙串 internet password：`github.com`（用于建 issue / API） |
| SSH key | `~/.ssh/id_ed25519_dsh`（用于 git push） |
| dsh CLI | 默认 App 路径，可用 `DSH_CLI` 覆盖 |

先体检：

```bash
node scripts/release.mjs doctor
```

## 1. 预检（只读）

```bash
node scripts/release.mjs check --dir /path/to/dsh-xxx
```

检查项：

- `package.json` 的 name/version、`publishConfig.access=public`；
- `cordis.patch.yml` 是否引用了包名（名字对不上 = 装不上）；
- `skills/*/SKILL.md` 的 frontmatter（name / description）；
- `test/provider.test.mjs` 是否通过；
- `npm pack --dry-run` 的文件清单（`test/` 不能进包）；
- git 仓库、工作区状态、repository 是否 GitHub；
- 可选：`--scan` 脱敏扫描（发布包内文件 + `~/.dsh/memory`）；
- 可选：npm / GitHub 身份。

`--scan` 会命中 npm / GitHub / sk- / AWS / Slack / 私钥 / 通用赋值 / 本机绝对路径；**high 级命中会阻断发布**，low 级只提示。

## 2. 发布

```bash
# 先看计划，不动任何东西
node scripts/release.mjs release --dir /path/to/dsh-xxx --bump patch --dry-run

# 只安装已发布版本（不发版）
node scripts/release.mjs install --dir /path/to/dsh-xxx

# 真发（自动 commit + push + tag + publish + 等 registry 生效）
node scripts/release.mjs release --dir /path/to/dsh-xxx --bump patch --yes

# 发完顺手装进桌面版
node scripts/release.mjs release --dir /path/to/dsh-xxx --bump patch --yes --install
```

流程：`check` → `npm version` → 测试 → commit → SSH push（含 tag）→ `npm publish` → 轮询 dist-tags 直到新版本生效 → （可选）安装。

失败即停，不会带着半成品继续。

`release` 默认带 `--scan`；确认要跳过时用 `--no-scan`。

## 3. 提交 hub

```bash
node scripts/release.mjs hub-issue --dir /path/to/dsh-xxx \
  --category "Tools & Capabilities" \
  --value "一句话说清装完改变什么"
```

会先搜 dsh-plugin-hub 里有没有同仓库的提交，避免重复。

## 4. 常见失败

| 现象 | 处理 |
|---|---|
| `check` 报 patch 未引用包名 | 改 `cordis.patch.yml` 的 `name`，必须等于 `package.json` 的 name |
| `npm publish` 404/401 | token 过期或没有 scope 权限；重新存 `dsh-npm-token` |
| `git push` 卡住 | `github.com` HTTPS 不通；确认 remote 是 SSH、SSH key 已加到账号 |
| 发布后 `npm view` 404 | registry 异步处理（202），等 3–10 分钟，脚本会自动轮询 |
| 安装报 `minimumReleaseAge` | 脚本 `--install` 会自动写豁免；手动装则把 `name@version` 加进 `minimumReleaseAgeExclude` |

## 5. 边界

- 只对**你自己的** dsh-* 包使用；scope 与钥匙串服务名可按需改脚本顶部常量。
- 不处理 npm 账号注册、scope 申请、SSH key 上传（一次性人工动作）。
- `--install` 会写 `~/.dsh`，需要相应的文件权限；被沙箱挡住时在终端跑一次。
- 不自动修改 `SKILL.md` 内容，只负责把已有内容发出去。
