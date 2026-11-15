import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeRuntime } from './fixtures/native-runtime.js'

const read = { name: 'media_desk_read', arguments: { kind: 'work' } }
const results = events => events.filter(row => row.type === 'tool/result')

test('原生输入直接授权读取，只读工具步骤不继承旧轮写权限且不增长输入台账', { timeout: 180000 }, async t => {
  const recipes = {}
  const runtime = await nativeRuntime(t, { recipes })
  await runtime.start()
  await runtime.host('notes/migrate', {})
  const work = (await runtime.host('state')).value.state.items.find(row => row.id === 'seed_2')
  const note = join(work.content.notesRoot, work.content.relativePath)
  const original = await readFile(note)
  const edit = body => ({ name: 'media_desk_edit', arguments: {
    operations: JSON.stringify([{ op: 'update_item', id: work.id, body }]),
    expectedContent: JSON.stringify({ [work.id]: work.content }), resultId: 'current-input',
  } })
  recipes.MD_FIXTURE_WARM = { calls: [read, read], reply: 'Read.' }
  recipes.MD_FIXTURE_READONLY = { calls: [read, edit('Forbidden'), read], reply: 'Read only.' }
  recipes.MD_FIXTURE_EDIT = { calls: [read, edit('Authorized by current native input'), read], reply: 'Saved.' }
  await runtime.stop()
  await runtime.start()
  const association = (await runtime.host('sessions/open', { workId: work.id })).value.association
  const statePath = join(runtime.home, 'media-desk', 'state.json')
  const before = await readFile(statePath, 'utf8')
  const warm = await runtime.turn(association.sessionId, await runtime.prompt(association.sessionId, 'MD_FIXTURE_WARM: read twice'))
  assert.ok(results(warm.events).every(row => !row.data.message.isError))
  const current = await runtime.turn(association.sessionId, await runtime.prompt(association.sessionId, 'MD_FIXTURE_READONLY: 只读，禁止写入'))
  const returned = results(current.events)
  assert.equal(returned.length, 3)
  assert.equal(returned[0].data.message.isError, false)
  assert.equal(returned[1].data.message.isError, true)
  assert.match(JSON.stringify(returned[1]), /native\/read-only|permits reading only/)
  assert.ok(!returned[2].data.message.isError)
  assert.deepEqual(await readFile(note), original)
  assert.equal(await readFile(statePath, 'utf8'), before)
  const edited = await runtime.turn(association.sessionId, await runtime.prompt(association.sessionId, 'MD_FIXTURE_EDIT: save the requested edit'))
  assert.ok(results(edited.events).every(row => !row.data.message.isError), JSON.stringify(results(edited.events)))
  const state = (await runtime.host('state')).value.state
  assert.equal(state.items.find(row => row.id === work.id).body, 'Authorized by current native input')
  assert.equal(state.nativeInputs, undefined)
  assert.equal(state.receipts.filter(row => row.resultKey.endsWith(':current-input')).length, 1)
})
