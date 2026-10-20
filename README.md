# dsh-release · JOJO&Adam

把自己的 DSH 插件从「改完代码」送到「用户能装」，一条命令跑完：

```
check → 升版本 → 测试 → commit → SSH push → npm publish → 等 registry 生效 →（可选）装桌面版
```

凭据只从 macOS 钥匙串读，不落盘、不打印。默认只读，写操作必须 `--yes`。

## 安装

```bash
dsh plugin --profile web add @jojonadam/dsh-release
dsh plugin --profile desktop add @jojonadam/dsh-release
```

## 用法

```bash
# 环境体检（token / SSH / dsh CLI）
node skills/dsh-release/scripts/release.mjs doctor

# 预检（只读）
node skills/dsh-release/scripts/release.mjs check --dir /path/to/dsh-xxx

# 预览发布计划
node skills/dsh-release/scripts/release.mjs release --dir /path/to/dsh-xxx --bump patch --dry-run

# 只安装已发布版本
node skills/dsh-release/scripts/release.mjs install --dir /path/to/dsh-xxx

# 真发布
node skills/dsh-release/scripts/release.mjs release --dir /path/to/dsh-xxx --bump patch --yes

# 发完装进桌面版
node skills/dsh-release/scripts/release.mjs release --dir /path/to/dsh-xxx --bump patch --yes --install

# 提交到 dsh-plugin-hub
node skills/dsh-release/scripts/release.mjs hub-issue --dir /path/to/dsh-xxx \
  --category "Tools & Capabilities" --value "一句话价值"
```

## 凭据

| 凭据 | 位置 |
|---|---|
| npm token | 钥匙串 generic `dsh-npm-token` |
| GitHub token | 钥匙串 internet password `github.com` |
| SSH key | `~/.ssh/id_ed25519_dsh` |

换账号或改 scope 时，改脚本顶部常量即可。

## 它替你记住的坑

- `cordis.patch.yml` 的 name 必须等于 package.json 的 name，否则装不上；
- scoped 包必须 `publishConfig.access=public`；
- `npm pack` 不能带 `test/`；
- 首次发布 registry 有几分钟 202 延迟，必须轮询而不是重发；
- npmmirror 对新包不同步，发布/安装都显式走 npmjs；
- pnpm 的 `minimumReleaseAge` 会挡新版本，安装前要写豁免；
- `github.com` HTTPS 不通时改用 SSH，key 与 known_hosts 都显式指定。

## License

MIT · JOJO & Adam · <https://jojo-adam.com>
