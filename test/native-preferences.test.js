/** Global preference edits use the registered versions returned by native business reads. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeRuntime } from './fixtures/native-runtime.js'

const read = { name: 'media_desk_read', arguments: { kind: 'preferences', limit: 20000 } }
const firstResults = events => {
  const callIds = new Set(events.filter(event => event.type === 'tool/call').map(event => event.data.callId))
  const seen = new Set()
  return events.filter(event => {
    if (event.type !== 'tool/result' || !callIds.has(event.data.message.toolCallId) || seen.has(event.data.message.toolCallId)) return false
    seen.add(event.data.message.toolCallId)
    return true
  })
}

test('全局助手读取停用风格与待审规则版本后编辑和删除，作品会话、只读和旧版本仍受限', { timeout: 180000 }, async t => {
  const recipes = {}
  const runtime = await nativeRuntime(t, { recipes })
  await runtime.start()
  await runtime.host('notes/migrate', {})
  const added = await runtime.host('ops', { ops: [
    { op: 'add_style', name: 'Inactive editable style', summary: 'The inactive original summary.', samples: ['Inactive source sample stays outside the global catalog.'] },
    { op: 'add_style', name: 'Selected writing style', summary: 'The selected generation summary.', samples: ['The selected author sample remains available for writing.'] },
    { op: 'add_skill', name: 'Proposed editable rule', rule: 'The original proposed rule.', status: 'proposed' },
    { op: 'add_skill', name: 'Enabled writing rule', rule: 'The selected generation rule.', status: 'active' },
  ] })
  assert.equal(added.status, 200, JSON.stringify(added.value))
  const inactive = added.value.state.styles.find(row => row.name === 'Inactive editable style')
  const selected = added.value.state.styles.find(row => row.name === 'Selected writing style')
  const proposed = added.value.state.skills.find(row => row.name === 'Proposed editable rule')
  const enabled = added.value.state.skills.find(row => row.name === 'Enabled writing rule')
  await runtime.host('ops', { ops: [{ op: 'set_style', id: selected.id }] })
  await runtime.host('settings', { image: { apiKey: 'private-preferences-fixture-key' } })
  const operations = [{ op: 'update_style', id: inactive.id, summary: 'The edited inactive summary.' },
    { op: 'update_skill', id: proposed.id, rule: 'The edited proposed rule.' }]
  const edit = (resultId, edits = operations, expectedPreferences = '$preferences') => ({ name: 'media_desk_edit', arguments: {
    operations: JSON.stringify(edits), expectedPreferences, resultId,
  } })
  recipes.MD_FIXTURE_PREFERENCES_READONLY = { calls: [read, edit('catalog-readonly')], reply: 'The read-only edit was refused.' }
  recipes.MD_FIXTURE_PREFERENCES_STALE = { calls: [read, edit('catalog-stale', [operations[0]], JSON.stringify({ ['style:' + inactive.id]: { ...inactive.content, sha256: '0'.repeat(64) } }))], reply: 'The stale version was refused.' }
  recipes.MD_FIXTURE_PREFERENCES_WORK = { calls: [read, edit('catalog-work')], reply: 'The work Session cannot edit global preferences.' }
  recipes.MD_FIXTURE_PREFERENCES_EDIT = { calls: [read, edit('catalog-update'), read,
    edit('catalog-delete', [{ op: 'delete_style', id: inactive.id }, { op: 'delete_skill', id: proposed.id }]), read], reply: 'The registered preferences were edited and deleted.' }
  await runtime.stop()
  await runtime.start()
  const global = (await runtime.host('sessions/open', {})).value.association
  const owned = (await runtime.host('sessions/open', { workId: 'seed_2' })).value.association
  for (const marker of ['READONLY', 'STALE', 'WORK']) {
    const association = marker === 'WORK' ? owned : global
    const prompt = 'MD_FIXTURE_PREFERENCES_' + marker + (marker === 'READONLY' ? ': 只读，不要修改文件' : ': exercise the refused preference edit')
    const finished = await runtime.turn(association.sessionId, await runtime.prompt(association.sessionId, prompt))
    const results = firstResults(finished.events)
    assert.equal(results.length, 2)
    assert.equal(results[0].data.message.isError, false)
    const preferences = JSON.parse(results[0].data.message.content[0].text)
    if (marker === 'WORK') {
      assert.deepEqual(preferences.styles.map(row => row.id), [selected.id])
      assert.deepEqual(preferences.styles[0].samples, selected.samples)
      assert.deepEqual(preferences.rules.map(row => row.id), [enabled.id])
    } else {
      assert.deepEqual(preferences.styles.find(row => row.id === inactive.id)?.content, inactive.content)
      assert.deepEqual(preferences.rules.find(row => row.id === proposed.id)?.content, proposed.content)
      assert.equal(preferences.rules.find(row => row.id === proposed.id)?.status, 'proposed')
      assert.ok(preferences.styles.every(row => !row.samples && !row.sampleContent && !row.sampleMaterial))
      assert.doesNotMatch(results[0].data.message.content[0].text, /Inactive source sample|The selected author sample/)
    }
    assert.ok(preferences.rules.every(row => !row.sample))
    assert.doesNotMatch(results[0].data.message.content[0].text, /private-preferences-fixture-key|seed_s_1/)
    assert.equal(results[1].data.message.isError, true, JSON.stringify(results[1]))
    assert.match(results[1].data.message.content[0].text, marker === 'READONLY' ? /permits reading only/ : marker === 'WORK' ? /global assistant/ : /current writing preference version/)
  }
  const unchanged = (await runtime.host('state')).value.state
  assert.equal(unchanged.styles.find(row => row.id === inactive.id).summary, inactive.summary)
  assert.equal(unchanged.skills.find(row => row.id === proposed.id).rule, proposed.rule)
  assert.ok(!unchanged.receipts.some(row => /:catalog-(readonly|stale|work)$/.test(row.resultKey)))
  const finished = await runtime.turn(global.sessionId, await runtime.prompt(global.sessionId, 'MD_FIXTURE_PREFERENCES_EDIT: edit the inactive style and proposed rule, then delete them'))
  assert.equal(finished.end.data.reason.kind, 'completed', JSON.stringify(finished.end))
  const results = firstResults(finished.events)
  assert.equal(results.length, 5)
  assert.ok(results.every(row => !row.data.message.isError), JSON.stringify(results))
  const updated = JSON.parse(results[2].data.message.content[0].text)
  const style = updated.styles.find(row => row.id === inactive.id)
  const rule = updated.rules.find(row => row.id === proposed.id)
  assert.equal(style.summary, operations[0].summary)
  assert.equal(rule.rule, operations[1].rule)
  assert.equal(rule.status, 'proposed')
  assert.ok(style.content.revision > inactive.content.revision)
  assert.ok(rule.content.revision > proposed.content.revision)
  assert.match(await readFile(join(style.content.notesRoot, style.content.relativePath), 'utf8'), /The edited inactive summary/)
  assert.match(await readFile(join(rule.content.notesRoot, rule.content.relativePath), 'utf8'), /The edited proposed rule/)
  const state = (await runtime.host('state')).value.state
  assert.equal(state.styles.some(row => row.id === inactive.id), false)
  assert.equal(state.skills.some(row => row.id === proposed.id), false)
  assert.equal(state.activeStyleId, selected.id)
  for (const key of ['catalog-update', 'catalog-delete']) assert.equal(state.receipts.filter(row => row.resultKey.endsWith(':' + key)).length, 1)
})
