/**
 * Provider smoke test: run without DSH by faking `ctx.skills`.
 *   node test/provider.test.mjs
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

let registered
apply({
  skills: {
    registerProvider(factory) {
      registered = factory({})
    },
  },
})

const list = await registered.list()
assert.equal(list.length, 2, `expected 2 skills, got ${list.length}`)

const skill = list.find((item) => item.name === 'dsh-release')
assert.ok(skill, 'dsh-release not discovered')
assert.equal(skill.provider, 'jojo-adam-release')
assert.ok(skill.description.length > 20)

const loaded = await registered.get(skill)
assert.ok(loaded.content.includes('发布流水线'))
assert.ok(existsSync(join(skill.resourceBase.path, 'scripts/release.mjs')))

console.log(`ok — ${list.length} skills: ${list.map((i) => i.name).sort().join(', ')}`)
