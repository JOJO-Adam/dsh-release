#!/usr/bin/env node
/**
 * release.mjs — DSH 插件发布流水线（零依赖，Node 20+）。
 *
 *   node release.mjs doctor
 *   node release.mjs check   --dir <包目录>
 *   node release.mjs release --dir <包目录> --bump patch [--yes] [--dry-run] [--install]
 *   node release.mjs hub-issue --dir <包目录> [--category "Tools & Capabilities"] [--value "..."]
 *
 * 凭据从 macOS 钥匙串读取：
 *   npm token    : dsh-npm-token（generic）
 *   GitHub token : github.com（internet password）
 *   SSH key      : ~/.ssh/id_ed25519_dsh
 *
 * 设计原则：默认只读；写操作必须 --yes；release 前自动 check；失败即停。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const HOME = homedir()
const REGISTRY = 'https://registry.npmjs.org/'
const NPM_TOKEN_SERVICE = 'dsh-npm-token'
const GITHUB_TOKEN_SERVER = 'github.com'
const SSH_KEY = join(HOME, '.ssh/id_ed25519_dsh')
const KNOWN_HOSTS = '/tmp/dsh_known_hosts'
const CACHE = '/tmp/npm-cache'
const DSH_CLI =
  process.env.DSH_CLI ||
  '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      out._.push(token)
      continue
    }
    const key = token.slice(2)
    if (key === 'yes' || key === 'dry-run' || key === 'install' || key === 'no-tag' || key === 'scan' || key === 'no-scan') {
      out[key] = true
      continue
    }
    out[key] = argv[++i]
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const command = args._[0]
const targetDir = resolve(args.dir || process.cwd())

function fail(message, code = 1) {
  console.error(`❌ ${message}`)
  process.exit(code)
}

function say(message) {
  console.log(message)
}

function ok(message) {
  console.log(`✅ ${message}`)
}

function warn(message) {
  console.log(`⚠️  ${message}`)
}

function sh(cmd, cmdArgs, options = {}) {
  const result = spawnSync(cmd, cmdArgs, {
    cwd: options.cwd || targetDir,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : 'pipe',
    timeout: options.timeout || 300000,
  })
  if (result.error) throw result.error
  if (!options.allowFail && result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').split('\n').slice(-15).join('\n')
    fail(`${cmd} ${cmdArgs.join(' ')} 失败（exit ${result.status}）\n${detail}`)
  }
  return result
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function keychain(service, internet = false) {
  const cmdArgs = internet
    ? ['find-internet-password', '-s', service, '-w']
    : ['find-generic-password', '-s', service, '-w']
  const result = spawnSync('security', cmdArgs, { encoding: 'utf8', timeout: 10000 })
  return result.status === 0 ? (result.stdout || '').trim() : ''
}

function npmToken() {
  const token = keychain(NPM_TOKEN_SERVICE)
  if (!token.startsWith('npm_')) fail(`钥匙串里没有 npm token（service: ${NPM_TOKEN_SERVICE}）`)
  return token
}

function githubToken() {
  const token = keychain(GITHUB_TOKEN_SERVER, true)
  if (!token) fail(`钥匙串里没有 GitHub token（internet password: ${GITHUB_TOKEN_SERVER}）`)
  return token
}

async function api(path, token, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'dsh-release',
      ...(options.headers || {}),
    },
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : {}
}

function packageInfo(dir) {
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) fail(`不是包目录（缺 package.json）：${dir}`)
  const pkg = readJson(pkgPath)
  const patch = pkg.dsh?.bundle?.patch
  if (!patch) fail('package.json 缺少 dsh.bundle.patch')
  const patchPath = join(dir, patch)
  if (!existsSync(patchPath)) fail(`缺少 bundle patch：${patchPath}`)
  return { pkg, pkgPath, patch, patchPath }
}

function repoSlug(pkg) {
  const url = pkg.repository?.url || ''
  const match = url.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?/)
  return match ? `${match[1]}/${match[2]}` : ''
}

function skillDirs(dir) {
  const skillsRoot = join(dir, 'skills')
  if (!existsSync(skillsRoot)) return []
  return sh('ls', [skillsRoot], { allowFail: true })
    .stdout.split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((name) => existsSync(join(skillsRoot, name, 'SKILL.md')))
}

const SECRET_PATTERNS = [
  { kind: 'npm token', severity: 'high', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: 'GitHub token', severity: 'high', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { kind: 'API key (sk-)', severity: 'high', re: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { kind: 'AWS access key', severity: 'high', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'Slack token', severity: 'high', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'private key block', severity: 'high', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\s]{20,}/g },
  { kind: 'generic assignment', severity: 'medium', re: /\b(?:api[_-]?key|secret|token|password|passwd)\s*[=:]\s*["']?([A-Za-z0-9_\-]{16,})["']?/gi },
  { kind: 'local absolute path', severity: 'low', re: /\/Users\/[A-Za-z0-9._-]+\//g },
]

function maskValue(value) {
  return value.length <= 8 ? '***' : `${value.slice(0, 4)}***${value.slice(-2)}`
}

function looksPlaceholder(value) {
  return /x{3,}|your|example|placeholder|change[-_]?me|redacted|dummy|test/i.test(value)
}

function scanText(text, file, findings) {
  for (const pattern of SECRET_PATTERNS) {
    pattern.re.lastIndex = 0
    let match
    while ((match = pattern.re.exec(text)) !== null) {
      const captured = match[1] || match[0]
      if (looksPlaceholder(captured)) continue
      const line = text.slice(0, match.index).split('\n').length
      findings.push({ file, line, kind: pattern.kind, severity: pattern.severity, masked: maskValue(captured) })
      if (pattern.re.lastIndex === match.index) pattern.re.lastIndex++
    }
  }
}

function scanPackage(dir) {
  const findings = []
  const pack = JSON.parse(sh('npm', ['pack', '--dry-run', '--json', `--cache=${CACHE}`], { cwd: dir }).stdout)[0]
  for (const file of pack.files) {
    if (/\.(png|jpe?g|webp|gif|zip|gz|glb|blend|ico)$/i.test(file.path)) continue
    let buffer
    try {
      buffer = readFileSync(join(dir, file.path))
    } catch {
      continue
    }
    if (buffer.includes(0)) continue
    scanText(buffer.toString('utf8'), file.path, findings)
  }
  return findings
}

function scanMemory() {
  const findings = []
  const root = join(HOME, '.dsh/memory')
  if (!existsSync(root)) return findings
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.md')) scanText(readFileSync(path, 'utf8'), path.replace(HOME, '~'), findings)
    }
  }
  walk(root)
  return findings
}

function printFindings(findings) {
  const order = { high: 0, medium: 1, low: 2 }
  for (const finding of findings.sort((a, b) => order[a.severity] - order[b.severity])) {
    console.log(`   ${finding.severity.toUpperCase().padEnd(6)} ${finding.file}:${finding.line}  ${finding.kind}  ${finding.masked}`)
  }
}

function bumpVersion(version, kind) {
  const [major, minor, patch] = version.split('-')[0].split('.').map(Number)
  if (kind === 'major') return `${major + 1}.0.0`
  if (kind === 'minor') return `${major}.${minor + 1}.0`
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`
  fail(`未知 bump 类型：${kind}（patch|minor|major）`)
}

function sshCommand() {
  return `ssh -i ${SSH_KEY} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${KNOWN_HOSTS}`
}

function ensureGitRemote(dir, pkg) {
  const slug = repoSlug(pkg)
  if (!slug) fail('package.json 的 repository.url 不是 GitHub 仓库')
  if (!existsSync(SSH_KEY)) fail(`缺少 SSH key：${SSH_KEY}`)
  const remotes = sh('git', ['remote', '-v'], { cwd: dir, allowFail: true }).stdout
  if (remotes.includes('origin') && !remotes.includes(`git@github.com:${slug}.git`)) {
    sh('git', ['remote', 'set-url', 'origin', `git@github.com:${slug}.git`], { cwd: dir })
  } else if (!remotes.includes('origin')) {
    sh('git', ['remote', 'add', 'origin', `git@github.com:${slug}.git`], { cwd: dir })
  }
  sh('git', ['config', 'core.sshCommand', sshCommand()], { cwd: dir })
  return slug
}

// ---------------------------------------------------------------- commands

async function doctor() {
  const checks = []
  const node = process.versions.node
  checks.push(['node', node, true])
  const npmVersion = sh('npm', ['-v'], { allowFail: true }).stdout.trim()
  checks.push(['npm', npmVersion || '缺失', Boolean(npmVersion)])
  const gitVersion = sh('git', ['--version'], { allowFail: true }).stdout.trim()
  checks.push(['git', gitVersion || '缺失', Boolean(gitVersion)])
  checks.push(['ssh key', existsSync(SSH_KEY) ? SSH_KEY : '缺失（ssh-keygen 生成）', existsSync(SSH_KEY)])
  const npm = keychain(NPM_TOKEN_SERVICE)
  checks.push(['npm token', npm.startsWith('npm_') ? `已存（${NPM_TOKEN_SERVICE}）` : '缺失', npm.startsWith('npm_')])
  const gh = keychain(GITHUB_TOKEN_SERVER, true)
  checks.push(['github token', gh ? `已存（${GITHUB_TOKEN_SERVER}）` : '缺失', Boolean(gh)])
  checks.push(['dsh CLI', existsSync(DSH_CLI) ? DSH_CLI : '缺失（设置 DSH_CLI）', existsSync(DSH_CLI)])

  let npmUser = ''
  if (npm.startsWith('npm_')) {
    const result = sh('npm', ['whoami', `--//registry.npmjs.org/:_authToken=${npm}`, '--registry', REGISTRY, `--cache=${CACHE}`], {
      allowFail: true,
    })
    npmUser = result.stdout.trim()
  }
  checks.push(['npm 身份', npmUser || '未验证', Boolean(npmUser)])

  let ghUser = ''
  if (gh) {
    try {
      ghUser = (await api('/user', gh)).login
    } catch (error) {
      ghUser = `失败：${error.message}`
    }
  }
  checks.push(['GitHub 身份', ghUser || '未验证', Boolean(ghUser) && !ghUser.startsWith('失败')])

  for (const [name, value, pass] of checks) {
    console.log(`${pass ? '✅' : '❌'} ${name.padEnd(14)} ${value}`)
  }
  process.exit(checks.every(([, , pass]) => pass) ? 0 : 1)
}

async function check({ quiet = false, scan = false } = {}) {
  const { pkg, patchPath } = packageInfo(targetDir)
  const problems = []
  const notes = []

  if (!pkg.name || !pkg.version) problems.push('package.json 缺少 name/version')
  if (!pkg.publishConfig || pkg.publishConfig.access !== 'public') {
    problems.push('缺少 publishConfig.access=public（scoped 包必需）')
  }
  const patchText = readFileSync(patchPath, 'utf8')
  if (!patchText.includes(pkg.name)) problems.push(`cordis.patch.yml 未引用包名 ${pkg.name}`)

  const skills = skillDirs(targetDir)
  if (skills.length === 0) problems.push('没有找到 skills/*/SKILL.md')
  for (const skill of skills) {
    const text = readFileSync(join(targetDir, 'skills', skill, 'SKILL.md'), 'utf8')
    if (!/^---/.test(text)) problems.push(`skills/${skill}/SKILL.md 缺少 frontmatter`)
    if (!/\nname:\s*\S/.test(text)) problems.push(`skills/${skill}/SKILL.md 缺少 name`)
    if (!/\ndescription:\s*\S/.test(text)) problems.push(`skills/${skill}/SKILL.md 缺少 description`)
  }
  notes.push(`技能 ${skills.length} 个`)

  if (existsSync(join(targetDir, 'test/provider.test.mjs'))) {
    const result = sh('node', ['test/provider.test.mjs'], { allowFail: true })
    if (result.status !== 0) problems.push(`provider 测试失败：\n${(result.stderr || result.stdout).slice(-400)}`)
    else notes.push('provider 测试通过')
  } else {
    warn('没有 test/provider.test.mjs（跳过）')
  }

  const pack = sh('npm', ['pack', '--dry-run', '--json', `--cache=${CACHE}`], { allowFail: true })
  if (pack.status !== 0) {
    problems.push(`npm pack 失败：${(pack.stderr || pack.stdout).slice(-300)}`)
  } else {
    try {
      const info = JSON.parse(pack.stdout)[0]
      const leaked = info.files.map((f) => f.path).filter((p) => p.startsWith('test/'))
      if (leaked.length) problems.push(`tarball 包含 test/：${leaked.join(', ')}`)
      notes.push(`tarball ${info.entryCount} 文件 / ${(info.unpackedSize / 1024).toFixed(1)} KB`)
    } catch {
      problems.push('无法解析 npm pack --json 输出')
    }
  }

  const gitStatus = sh('git', ['status', '--porcelain'], { cwd: targetDir, allowFail: true }).stdout.trim()
  if (!existsSync(join(targetDir, '.git'))) problems.push('不是 git 仓库')
  else if (gitStatus) notes.push('工作区有未提交改动（release 会一并提交）')

  let findings = []
  if (scan) {
    findings = [...scanPackage(targetDir), ...scanMemory()]
    const high = findings.filter((finding) => finding.severity === 'high').length
    notes.push(findings.length === 0 ? '脱敏扫描干净' : `脱敏扫描命中 ${findings.length} 项（high ${high}）`)
    if (high > 0) problems.push(`发现 ${high} 处高置信明文密钥（见下方列表）`)
  }

  const slug = repoSlug(pkg)
  if (!slug) problems.push('repository.url 不是 GitHub 仓库')

  if (!quiet) {
    say(`📦 ${pkg.name}@${pkg.version}`)
    for (const note of notes) say(`   · ${note}`)
    if (findings.length) printFindings(findings)
    for (const problem of problems) console.log(`❌ ${problem}`)
    if (problems.length === 0) ok('check 全部通过')
    else warn(`${problems.length} 个问题`)
  }
  if (problems.length && !quiet) process.exit(1)
  return { pkg, slug, problems }
}

async function release() {
  if (!args.yes && !args['dry-run']) fail('写操作需要 --yes（先用 --dry-run 预览）')
  const { pkg } = await check({ quiet: false, scan: !args['no-scan'] })
  const kind = args.bump || 'patch'
  const next = bumpVersion(pkg.version, kind)
  const tag = `v${next}`

  say(`\n计划：${pkg.name} ${pkg.version} → ${next}`)
  say(`  1. npm version ${kind}`)
  say(`  2. node test/provider.test.mjs`)
  say(`  3. git commit + push main${args['no-tag'] ? '' : ' + tag'}（SSH）`)
  say(`  4. npm publish（registry.npmjs.org）`)
  say(`  5. 轮询 registry 直到 ${next} 可见`)
  if (args.install) say('  6. 安装到 desktop profile')
  if (args['dry-run']) {
    ok('dry-run：未做任何修改')
    return
  }

  sh('npm', ['version', kind, '--no-git-tag-version'])
  sh('node', ['test/provider.test.mjs'])

  const name = pkg.name
  sh('git', ['add', '-A'])
  sh('git', ['commit', '-m', `chore: release v${next}`], {
    allowFail: true,
    env: {
      GIT_AUTHOR_NAME: 'JOJO & Adam',
      GIT_AUTHOR_EMAIL: 'dev@jojo-adam.com',
      GIT_COMMITTER_NAME: 'JOJO & Adam',
      GIT_COMMITTER_EMAIL: 'dev@jojo-adam.com',
    },
  })
  const slug = ensureGitRemote(targetDir, pkg)
  sh('git', ['push', 'origin', 'main'])
  if (!args['no-tag']) {
    sh('git', ['tag', '-f', tag], { allowFail: true })
    sh('git', ['push', 'origin', tag], { allowFail: true })
  }
  ok(`已推送 ${slug}`)

  const token = npmToken()
  const publish = sh(
    'npm',
    ['publish', '--registry', REGISTRY, `--//registry.npmjs.org/:_authToken=${token}`, `--cache=${CACHE}`],
    { allowFail: true, timeout: 600000 },
  )
  if (publish.status !== 0) fail(`npm publish 失败：\n${(publish.stderr || publish.stdout).slice(-600)}`)
  rmSync(join(CACHE, '_logs'), { recursive: true, force: true })

  const deadline = Date.now() + 10 * 60 * 1000
  let latest = ''
  while (Date.now() < deadline) {
    const response = await fetch(`${REGISTRY}-/package/${encodeURIComponent(name)}/dist-tags`)
    if (response.ok) {
      const tags = await response.json()
      latest = tags.latest
      if (latest === next) break
    }
    await new Promise((r) => setTimeout(r, 15000))
  }
  if (latest !== next) fail(`发布后 10 分钟仍未生效（latest=${latest || '?'}）`)
  ok(`npm 已生效：${name}@${next}`)

  if (args.install) installToDesktop(name, next)
  say(`\n完成：${name}@${next}`)
  say(`npm: https://www.npmjs.com/package/${name}`)
}

function installToDesktop(name, version) {
  if (!existsSync(DSH_CLI)) fail('找不到 dsh CLI，设置 DSH_CLI 后再试')
  const workspace = join(HOME, '.dsh/profiles/desktop/pnpm-workspace.yaml')
  if (existsSync(workspace)) {
    const text = readFileSync(workspace, 'utf8')
    const line = `  - '${name}@${version}'`
    if (!text.includes(line)) {
      writeFileSync(workspace, `${text.replace(/\s*$/, '')}\n${line}\n`)
      say(`   · 已加入 minimumReleaseAgeExclude：${name}@${version}`)
    }
  }
  const shimDir = mkdtempSync(join(tmpdir(), 'dsh-release-'))
  const bundledPnpm =
    '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.cjs'
  if (existsSync(bundledPnpm)) {
    writeFileSync(join(shimDir, 'pnpm'), `#!/bin/sh\nexec "${process.execPath}" "${bundledPnpm}" "$@"\n`, {
      mode: 0o755,
    })
  }
  const env = { PATH: `${shimDir}:${process.env.PATH}` }
  sh(DSH_CLI, ['plugin', '--profile', 'desktop', 'remove', name], { allowFail: true, env })
  sh(DSH_CLI, ['plugin', '--profile', 'desktop', 'add', `${name}@${version}`, '--registry', REGISTRY], {
    env,
    timeout: 300000,
  })
  const installed = join(HOME, '.dsh/profiles/desktop/node_modules', name, 'package.json')
  if (existsSync(installed)) ok(`桌面版已安装 ${readJson(installed).version}`)
  rmSync(shimDir, { recursive: true, force: true })
}

async function install() {
  const { pkg } = packageInfo(targetDir)
  const version = args.version || pkg.version
  say(`安装 ${pkg.name}@${version} 到 desktop profile`)
  installToDesktop(pkg.name, version)
}

async function hubIssue() {
  const { pkg } = packageInfo(targetDir)
  const slug = repoSlug(pkg)
  if (!slug) fail('package.json 的 repository.url 不是 GitHub 仓库')
  const token = githubToken()
  const value = args.value || pkg.description || ''
  const category = args.category || 'Tools & Capabilities'

  let existing = null
  for (let page = 1; page <= 10 && !existing; page++) {
    const items = await api(`/repos/dshplugin/dsh-plugin-hub/issues?state=all&per_page=100&page=${page}`, token)
    existing = (items || []).find((item) => item.state === 'open' && (item.title || '').includes(slug)) || null
    if (!items || items.length < 100) break
  }
  if (existing) {
    say(`已存在提交：${existing.html_url}`)
    return
  }

  const body = `### Repository
https://github.com/${slug}

### One-line value
${value}

### Category
${category}

### Install command
dsh plugin --profile web add ${pkg.name}

### Compatibility
${pkg.engines?.dsh ? `DSH ${pkg.engines.dsh}` : 'DKSH 0.2.x'}；详见仓库 README。

### License
${pkg.license || 'MIT'}

### Notes
通过 dsh-release 自动提交。

### Pre-submission checklist
- [x] Repository is public
- [x] GitHub topic \`dsh-plugin\` added
- [x] README includes the install command
- [x] Plugin exports \`apply(ctx)\`
- [x] Root \`package.json\` present
- [x] Published on npm`

  const issue = await api('/repos/dshplugin/dsh-plugin-hub/issues', token, {
    method: 'POST',
    body: JSON.stringify({ title: `[Plugin submission] ${slug} — ${value.slice(0, 60)}`, body }),
  })
  ok(`已提交：${issue.html_url}`)
}

// ---------------------------------------------------------------- main

if (!command) {
  say('用法：node release.mjs <doctor|check|install|release|hub-issue> [--dir DIR]')
  process.exit(1)
}
if (command === 'doctor') await doctor()
else if (command === 'check') await check({ scan: Boolean(args.scan) })
else if (command === 'install') await install()
else if (command === 'release') await release()
else if (command === 'hub-issue') await hubIssue()
else fail(`未知命令：${command}`)
