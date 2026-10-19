/**
 * @jojonadam/dsh-release — bundled skill provider.
 *
 * Discovers every skill bundle under `skills/<name>/SKILL.md` and serves it to
 * the DSH skill registry, with the skill directory as its resource base so
 * `scripts/` and `examples/` resolve normally.
 *
 * @module @jojonadam/dsh-release
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROVIDER_NAME = 'jojo-adam-release'
const SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url))
/** Same rank as other bundled skill roots (dsh-skill-filesystem BUNDLED_SKILL_RANK). */
const BUNDLED_SKILL_RANK = 600

/** Split `---` YAML frontmatter from the body. Handles single-line quoted values. */
function parseFrontmatter(text) {
  if (!text.startsWith('---')) return { data: {}, body: text }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return { data: {}, body: text }
  const raw = text.slice(3, end).trim()
  const body = text.slice(end + 4).replace(/^\r?\n/, '')
  const data = {}
  for (const line of raw.split(/\r?\n/)) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (match === null) continue
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    data[match[1]] = value
  }
  return { data, body }
}

function skillDirectories() {
  let entries
  try {
    entries = readdirSync(SKILLS_DIR, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(SKILLS_DIR, entry.name))
    .filter((dir) => {
      try {
        return statSync(join(dir, 'SKILL.md')).isFile()
      } catch {
        return false
      }
    })
}

function readSkill(dir) {
  const locator = join(dir, 'SKILL.md')
  const { data, body } = parseFrontmatter(readFileSync(locator, 'utf8'))
  const name = data.name ?? basename(dir)
  return {
    candidate: {
      name,
      description: data.description ?? '',
      ...(data.whenToUse === undefined ? {} : { whenToUse: data.whenToUse }),
      invocation: { modelInvocable: true, userInvocable: true },
      provider: PROVIDER_NAME,
      source: 'bundled',
      resourceBase: { kind: 'directory', path: dir },
      rank: BUNDLED_SKILL_RANK,
      locator,
    },
    content: body,
  }
}

const provider = {
  name: PROVIDER_NAME,
  async list() {
    return skillDirectories().map((dir) => readSkill(dir).candidate)
  },
  async get(candidate) {
    const loaded = readSkill(dirname(candidate.locator))
    return {
      name: loaded.candidate.name,
      description: loaded.candidate.description,
      ...(loaded.candidate.whenToUse === undefined
        ? {}
        : { whenToUse: loaded.candidate.whenToUse }),
      invocation: loaded.candidate.invocation,
      provider: PROVIDER_NAME,
      source: 'bundled',
      resourceBase: loaded.candidate.resourceBase,
      content: loaded.content,
    }
  },
}

/** Cordis plugin name. */
const name = 'dsh-release'
/** Service required by the bundled provider. */
const inject = ['skills']

/** Register the bundled skill provider on `ctx.skills`. */
function apply(ctx) {
  ctx.skills.registerProvider(() => provider)
}

export { apply, inject, name }
