/** An exported derived skill follows accepted preferences on every native load. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeRuntime } from './fixtures/native-runtime.js'

test('已导出规则停用后原生技能立即读取当前风格，撤销全部偏好后旧导出不可加载', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t, { recipes: {
    MD_FIXTURE_DERIVED_LOAD: { calls: [{ name: 'skill', arguments: { name: 'media-desk-voice' } }], reply: 'Current derived skill observed.' },
    MD_FIXTURE_INDEPENDENT_SKILL: { calls: [{ name: 'skill', arguments: { name: 'llm-wiki' } }], reply: 'Independent skill remains available.' },
  } })
  await runtime.start()
  await runtime.host('notes/migrate', {})
  const added = await runtime.host('ops', { ops: [
    { op: 'add_style', name: 'Derived fixture style', tone: 'The current derived fixture tone.' },
    { op: 'add_skill', name: 'Derived fixture rule', rule: 'The disabled derived fixture rule.', status: 'active' },
  ] })
  assert.equal(added.status, 200, JSON.stringify(added.value))
  const styleId = added.value.receipts[0].target
  const ruleId = added.value.receipts[1].target
  assert.equal((await runtime.host('ops', { ops: [{ op: 'set_style', id: styleId }] })).status, 200)
  assert.equal((await runtime.host('skills/export', {})).status, 200)
  const path = join(runtime.home, 'skills', 'media-desk-voice', 'SKILL.md')
  const association = (await runtime.host('sessions/open', { workId: null })).value.association
  const load = async (marker = 'MD_FIXTURE_DERIVED_LOAD') => {
    const request = await runtime.prompt(association.sessionId, marker + ': load the named skill now.')
    const turn = await runtime.turn(association.sessionId, request)
    assert.equal(turn.end.data.reason.kind, 'completed')
    const result = turn.events.find(event => event.type === 'tool/result')
    assert.ok(result)
    return result.data.message
  }
  const warm = await load()
  assert.equal(warm.isError, false)
  assert.match(JSON.stringify(warm), /The disabled derived fixture rule/)
  assert.equal((await runtime.host('ops', { ops: [{ op: 'update_skill', id: ruleId, status: 'proposed' }] })).status, 200)
  const disabled = await load()
  assert.equal(disabled.isError, false)
  assert.doesNotMatch(JSON.stringify(disabled), /The disabled derived fixture rule/)
  assert.match(JSON.stringify(disabled), /The current derived fixture tone/)
  assert.doesNotMatch(await readFile(path, 'utf8'), /The disabled derived fixture rule/)
  assert.equal((await runtime.host('ops', { ops: [{ op: 'update_style', id: styleId, tone: 'The newly accepted derived fixture tone.' }] })).status, 200)
  const changed = await load()
  assert.match(JSON.stringify(changed), /The newly accepted derived fixture tone/)
  assert.equal((await runtime.host('ops', { ops: [{ op: 'update_skill', id: ruleId, status: 'active' }] })).status, 200)
  assert.match(JSON.stringify(await load()), /The disabled derived fixture rule/)
  assert.equal((await runtime.host('ops', { ops: [{ op: 'update_skill', id: ruleId, status: 'proposed' }, { op: 'delete_style', id: styleId }] })).status, 200)
  await assert.rejects(readFile(path), { code: 'ENOENT' })
  assert.equal((await load()).isError, true)
  assert.equal((await load('MD_FIXTURE_INDEPENDENT_SKILL')).isError, false)
  assert.equal((await runtime.host('ops', { ops: [{ op: 'update_skill', id: ruleId, status: 'active' }] })).status, 200)
  await assert.rejects(readFile(path), { code: 'ENOENT' })
  assert.equal((await runtime.host('skills/export', {})).status, 200)
  assert.match(JSON.stringify(await load()), /The disabled derived fixture rule/)
})
