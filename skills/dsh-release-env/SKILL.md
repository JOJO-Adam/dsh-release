---
name: dsh-release-env
description: "发布环境与凭据排障：钥匙串里 token 叫什么、SSH key 怎么配、github.com HTTPS 不通、npmmirror 没同步、npm 202 异步、minimumReleaseAge、沙箱权限。当 release 脚本报凭据/网络/权限错误时使用。"
whenToUse: "发布失败 / 401 / 403 / 404 / EPERM / permission / SSH / token / 钥匙串 / 镜像 / minimumReleaseAge 时"
license: MIT
---

# 发布环境与凭据

## 1. 凭据放哪

| 凭据 | 钥匙串类型 | 服务名 | 读取命令 |
|---|---|---|---|
| npm token | generic | `dsh-npm-token` | `security find-generic-password -s dsh-npm-token -w` |
| GitHub token | internet | `github.com` | `security find-internet-password -s github.com -w` |
| SSH key | 文件 | `~/.ssh/id_ed25519_dsh` | `ssh -i ~/.ssh/id_ed25519_dsh -T git@github.com` |

存 npm token：

```bash
security add-generic-password -a "$USER" -s dsh-npm-token -w 'npm_xxx' -U
```

第一次读取可能弹「security 想访问钥匙串」，点始终允许。

## 2. 网络

- `api.github.com` 通常可达；`github.com` 的 HTTPS 可能被网络挡；
- 所以 git 走 SSH（22 端口），API 走 HTTPS；
- 若 SSH 也异常，用 `ssh -v` 看卡在哪一步；
- npm 官方源 `registry.npmjs.org` 可达时，显式 `--registry` 覆盖本机镜像（npmmirror 对新包有延迟）。

## 3. npm 的两个坑

**首次发布 202**：`npm publish` 打印成功，但 registry 几分钟内仍 404。不要重复发，等；脚本会轮询 dist-tags。

**minimumReleaseAge**：pnpm 会拒绝太新的版本。安装新版本前把 `name@version` 加进 profile 的 `pnpm-workspace.yaml`：

```yaml
minimumReleaseAgeExclude:
  - '@jojonadam/dsh-xxx@0.1.1'
```

## 4. 权限

发布脚本本身只读；`--install` 和写钥匙串需要文件权限。DSH 沙箱下可能报 `EPERM`：

- 让 agent 用完整访问权限执行；
- 或自己在终端跑 `<dsh> plugin --profile desktop add <pkg>`。

## 5. 身份自查

```bash
npm whoami --//registry.npmjs.org/:_authToken="$TOKEN" --registry https://registry.npmjs.org/
curl -s -H "Authorization: Bearer $GH" https://api.github.com/user
ssh -i ~/.ssh/id_ed25519_dsh -o IdentitiesOnly=yes -T git@github.com
```

三条都对上，才是环境就绪。token 不要打印到终端历史里。
