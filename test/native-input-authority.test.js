/** Native business authority requires the current admitted input to survive Store persistence. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeRuntime } from './fixtures/native-runtime.js'
import { inspectRuntime } from './fixtures/inspector.js'

const read = { name: 'media_desk_read', arguments: { kind: 'work' } }
const firstResults = events => {
  const callIds = new Set(events.filter(event => event.type === 'tool/call').map(event => event.data.callId))
  const seen = new Set()
  return events.filter(event => {
    if (event.type !== 'tool/result' || !callIds.has(event.data.message.toolCallId) || seen.has(event.data.message.toolCallId)) return false
    seen.add(event.data.message.toolCallId)
    return true
  })
}
const waitForFile = async path => {
  const deadline = Date.now() + 60000
  for (;;) {
    try { return await readFile(path, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
    assert.ok(Date.now() < deadline, 'The owned model barrier was not reached')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

test('只读输入落盘失败后，空工具步骤不继承上轮写权限；新的已记录输入恢复编辑', { timeout: 180000 }, async t => {
  const recipes = {}
  const runtime = await nativeRuntime(t, { recipes })
  await runtime.start()
  assert.equal((await runtime.host('notes/migrate', {})).status, 200)
  const work = (await runtime.host('state')).value.state.items.find(row => row.id === 'seed_2')
  const note = join(work.content.notesRoot, work.content.relativePath)
  const original = await readFile(note)
  const edit = (body, resultId) => ({ name: 'media_desk_edit', arguments: {
    operations: JSON.stringify([{ op: 'update_item', id: work.id, body }]),
    expectedContent: JSON.stringify({ [work.id]: work.content }), resultId,
  } })
  const barrier = Object.fromEntries(['enteredPath', 'releasePath', 'abortedPath', 'settledPath'].map(name => [name, join(runtime.root, name)]))
  recipes.MD_FIXTURE_AUTHORITY_WARM = { calls: [read, read], reply: 'The unrestricted input was recorded.' }
  recipes.MD_FIXTURE_AUTHORITY_UNSAVED = { calls: [read, edit('An older input must not authorize this edit.', 'unsaved-current-input'), read], barrier: { ...barrier, at: 0 }, reply: 'The claimed input continued through the native loop.' }
  recipes.MD_FIXTURE_AUTHORITY_RECOVERED = { calls: [read, edit('A newly recorded input authorizes this edit.', 'recorded-current-input'), read], reply: 'The new input was saved.' }
  await runtime.stop()
  await runtime.start([], { NODE_OPTIONS: '--inspect=127.0.0.1:0' })
  const association = (await runtime.host('sessions/open', { workId: work.id })).value.association
  const warm = await runtime.turn(association.sessionId, await runtime.prompt(association.sessionId, 'MD_FIXTURE_AUTHORITY_WARM: read the work twice'))
  assert.equal(firstResults(warm.events).length, 2)
  assert.ok(firstResults(warm.events).every(row => !row.data.message.isError))
  const before = JSON.parse(await readFile(join(runtime.home, 'media-desk', 'state.json'), 'utf8'))
  assert.equal(before.nativeInputs.at(-1).turn, warm.start.data.turn)
  assert.equal(before.nativeInputs.at(-1).readOnly, false)
  const client = await inspectRuntime(t, runtime)
  const turn = warm.start.data.turn + 1
  const point = await client.breakAt('/src/store.js', 'await handle.close()', `state.nativeInputs?.some(row => row.sessionId === ${JSON.stringify(association.sessionId)} && row.turn === ${turn})`)
  const requestId = await runtime.prompt(association.sessionId, 'MD_FIXTURE_AUTHORITY_UNSAVED: 只读，禁止写入')
  await point.next()
  const statePath = join(runtime.home, 'media-desk', 'state.json')
  const retained = statePath + '.retained'
  await rename(statePath, retained)
  await mkdir(statePath)
  await point.remove()
  await client.send('Debugger.resume')
  await waitForFile(barrier.enteredPath)
  await rm(statePath, { recursive: true })
  await rename(retained, statePath)
  const failed = JSON.parse(await readFile(statePath, 'utf8'))
  assert.equal(failed.nativeInputs.some(row => row.turn === turn), false)
  await writeFile(barrier.releasePath, 'release\n')
  const finished = await runtime.turn(association.sessionId, requestId)
  assert.equal(finished.end.data.reason.kind, 'completed')
  assert.ok(finished.events.some(row => row.type === 'user/message' && row.data.source?.rpcId === requestId))
  const results = firstResults(finished.events)
  assert.equal(results.length, 3)
  assert.ok(results.every(row => row.data.message.isError), JSON.stringify(results))
  assert.ok(results.every(row => row.data.error?.code === 'native/input-unsaved' || /Native input could not be recorded/.test(row.data.message.content[0].text)))
  assert.deepEqual(await readFile(note), original)
  const unchanged = JSON.parse(await readFile(statePath, 'utf8'))
  const businessReceipts = state => state.receipts.filter(row => /^(native|stage|media):/.test(row.resultKey) || row.contentVersions.length || row.resources.length)
  assert.deepEqual(businessReceipts(unchanged), businessReceipts(before))
  assert.equal(unchanged.receipts.some(row => row.resultKey.endsWith(':unsaved-current-input')), false)
  assert.deepEqual(unchanged.items.find(row => row.id === work.id).content, before.items.find(row => row.id === work.id).content)
  // Journal recovery may retain this input, but its read-only authority cannot become the prior turn's write authority.
  const retainedInput = unchanged.nativeInputs.find(row => row.sessionId === association.sessionId && row.turn === turn)
  if (retainedInput) {
    assert.equal(retainedInput.readOnly, true)
    assert.equal(retainedInput.requestId, requestId)
  }
  const recovered = await runtime.turn(association.sessionId, await runtime.prompt(association.sessionId, 'MD_FIXTURE_AUTHORITY_RECOVERED: save the requested edit'))
  assert.equal(firstResults(recovered.events).length, 3)
  assert.ok(firstResults(recovered.events).every(row => !row.data.message.isError))
  const state = (await runtime.host('state')).value.state
  assert.equal(state.items.find(row => row.id === work.id).body, 'A newly recorded input authorizes this edit.')
  assert.equal(state.nativeInputs.at(-1).turn, recovered.start.data.turn)
  assert.equal(state.receipts.filter(row => row.resultKey.endsWith(':recorded-current-input')).length, 1)
})

test('原生问答结束的 Store 保存失败后，下一步骤先持久结算等待再接受候选', { timeout: 180000 }, async t => {
  const plan = { title: 'Recovered wait save', coverText: 'Wait', facts: [], outline: [], cover: 'Paper', images: [], shots: [], sources: [] }
  const runtime = await nativeRuntime(t, { recipes: {
    MD_STAGE_plan: { calls: [read, { name: 'ask_user_question', arguments: { questions: [{ id: 'direction', question: 'Which source should be used?', options: [{ label: 'Dated', description: 'Dated source.' }, { label: 'Brief', description: 'Brief source.' }] }] } }, read,
      { name: 'media_desk_submit_result', arguments: { stageId: '$stageId', result: JSON.stringify(plan) } }], reply: 'The plan was submitted after the answer.' },
    MD_STAGE_article: { calls: [read, { name: 'media_desk_submit_result', arguments: { stageId: '$stageId', result: JSON.stringify({ article: 'The accepted text follows the settled answer.\n', sources: [] }) } }], reply: 'The article was submitted.' },
  } })
  await runtime.start([], { NODE_OPTIONS: '--inspect=127.0.0.1:0' })
  await runtime.host('notes/migrate', {})
  await runtime.host('settings', { imageCount: 0, shotCount: 0 })
  const interactions = await runtime.interactions()
  const association = (await runtime.host('sessions/open', { workId: 'seed_2' })).value.association
  await runtime.host('produce', { id: 'seed_2' })
  const asked = await interactions.next('user-questions/request', association.sessionId)
  const waiting = (await runtime.host('state')).value.state.nativeRequests.find(row => row.kind === 'plan')
  assert.deepEqual(waiting.pendingInput, ['question'])
  const client = await inspectRuntime(t, runtime)
  const point = await client.breakAt('/src/store.js', 'await handle.close()', `state.nativeRequests?.some(row => row.id === ${JSON.stringify(waiting.id)} && row.status === 'running' && row.pendingInput?.length === 0)`)
  const failure = await client.breakAt('/src/store.js', "if (process.platform !== 'win32'", "error.code === 'EISDIR'")
  const answered = interactions.answer(asked, { answers: [{ id: 'direction', selected: ['Dated'] }] }).then(value => ({ value }), error => ({ error }))
  await point.next()
  const statePath = join(runtime.home, 'media-desk', 'state.json')
  const retained = statePath + '.retained'
  await rename(statePath, retained)
  await mkdir(statePath)
  await point.remove()
  await client.send('Debugger.resume')
  await failure.next()
  await rm(statePath, { recursive: true })
  await rename(retained, statePath)
  assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')).nativeRequests.find(row => row.id === waiting.id).pendingInput, ['question'])
  await failure.remove()
  await client.send('Debugger.resume')
  assert.equal((await answered).error, undefined)
  const finished = await runtime.turn(association.sessionId, waiting.requestId)
  assert.ok(firstResults(finished.events).every(row => !row.data.message.isError))
  const deadline = Date.now() + 60000
  let state
  for (;;) {
    state = (await runtime.host('state')).value.state
    if (state.items.find(row => row.id === 'seed_2').production.status === 'done') break
    assert.ok(Date.now() < deadline, 'The production did not finish after settling its wait')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.deepEqual(state.nativeRequests.find(row => row.id === waiting.id).pendingInput, [])
  assert.deepEqual(state.items.find(row => row.id === 'seed_2').production.pendingInput, [])
  assert.equal(state.receipts.filter(row => row.resultKey === 'stage:' + waiting.id).length, 1)
})
