/** Real Host journals and native events verify failed publication and cold recovery. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeRuntime } from './fixtures/native-runtime.js'
import { inspectRuntime } from './fixtures/inspector.js'

const read = { name: 'media_desk_read', arguments: { kind: 'work' } }
const waitState = async (runtime, predicate) => {
  const deadline = Date.now() + 60000
  for (;;) {
    const response = await runtime.host('state')
    assert.equal(response.status, 200, JSON.stringify(response.value))
    if (predicate(response.value.state)) return response.value.state
    assert.ok(Date.now() < deadline, 'Expected Host state was not observed')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

test('索引移走主文件后 EIO 恢复编辑器段落，失败记录冷恢复也保留段落', { timeout: 360000 }, async t => {
  for (const crash of [false, true]) await t.test(crash ? 'failed journal crash' : 'live rollback', { timeout: 180000 }, async t => {
    const runtime = await nativeRuntime(t)
    await runtime.start([], { NODE_OPTIONS: '--inspect=127.0.0.1:0' })
    await runtime.host('notes/migrate', {})
    const work = (await runtime.host('state')).value.state.items.find(row => row.id === 'seed_2')
    const primary = join(work.content.notesRoot, work.content.relativePath)
    const index = join(work.content.notesRoot, 'index.md')
    const original = await readFile(index, 'utf8') + '\nAn unrelated editor paragraph survives displacement.\n'
    await writeFile(index, original)
    await writeFile(primary, (await readFile(primary, 'utf8')).replace(/title: .*/, 'title: Navigation after failed displacement'))
    const client = await inspectRuntime(t, runtime)
    const point = await client.breakAt('/src/notes-writes.js', 'await this.store.notes.createDirectory(entry.after.notesRoot', "entry.kind === 'index'", 1)
    const failed = crash && await client.breakAt('/src/notes-writes.js', 'const primary = await this.bytes(entry.after)', "record.files.every(entry => entry.kind === 'index')", 0)
    const operation = runtime.host('state').then(value => ({ value }), error => ({ error }))
    const paused = await point.next()
    const id = await client.value(paused, 'record.id')
    await assert.rejects(readFile(index), { code: 'ENOENT' })
    await client.value(paused, `(() => { const notes = this.store.notes; const create = notes.createDirectory; notes.createDirectory = async function(root, path) { if (path === '.') { notes.createDirectory = create; throw Object.assign(new Error('Injected index directory EIO'), { code: 'EIO' }); } return create.call(this, root, path); }; return true; })()`)
    await point.remove()
    await client.send('Debugger.resume')
    if (crash) {
      await failed.next()
      const journal = JSON.parse(await readFile(join(runtime.home, 'media-desk', 'notes-writes', id, 'pending.json'), 'utf8'))
      assert.equal(journal.status, 'failed')
      assert.equal(await readFile(join(journal.files[0].displaced.notesRoot, journal.files[0].displaced.relativePath), 'utf8'), original)
      const exit = await runtime.stop('SIGKILL')
      assert.equal(exit.signal, 'SIGKILL')
      assert.equal(exit.timedOut, false)
      assert.ok((await operation).error)
      await runtime.start()
    } else {
      const response = (await operation).value
      assert.equal(response.status, 500, JSON.stringify(response.value))
      assert.equal(response.value.code, 'EIO')
      assert.equal(await readFile(index, 'utf8'), original)
    }
    assert.equal((await runtime.host('state')).status, 200)
    const restored = await readFile(index, 'utf8')
    assert.match(restored, /An unrelated editor paragraph survives displacement\./)
    assert.match(restored, /Navigation after failed displacement/)
  })
})

test('索引发布后回滚保留原始存在或缺失状态，冷恢复保留捕获的编辑器版本', { timeout: 360000 }, async t => {
  for (const absent of [false, true]) await t.test(absent ? 'original absent' : 'original present', { timeout: 180000 }, async t => {
    const runtime = await nativeRuntime(t)
    await runtime.start([], { NODE_OPTIONS: '--inspect=127.0.0.1:0' })
    await runtime.host('notes/migrate', {})
    const work = (await runtime.host('state')).value.state.items.find(row => row.id === 'seed_2')
    const index = join(work.content.notesRoot, 'index.md')
    const original = await readFile(index, 'utf8') + '\nOriginal editor index paragraph.\n'
    if (absent) await unlink(index)
    else await writeFile(index, original)
    await writeFile(join(work.content.notesRoot, work.content.relativePath), (await readFile(join(work.content.notesRoot, work.content.relativePath), 'utf8')).replace(/title: .*/, 'title: Unaccepted index navigation'))
    const client = await inspectRuntime(t, runtime)
    const validation = await client.breakAt('/src/notes-writes.js', 'this.validateSync(record)', "record.files.every(entry => entry.kind === 'index')")
    const capture = await client.breakAt('/src/notes-writes.js', 'await this.restore(entry)', "entry.kind === 'index'", 1)
    const operation = runtime.host('state').then(value => ({ value }), error => ({ error }))
    const paused = await validation.next()
    const id = await client.value(paused, 'record.id')
    await client.value(paused, `(() => { const validate = this.validateSync; this.validateSync = function(record) { this.validateSync = validate; throw Object.assign(new Error('Injected index acceptance EIO'), { code: 'EIO' }); }; return true; })()`)
    await validation.remove()
    await client.send('Debugger.resume')
    const rolled = await capture.next()
    await assert.rejects(readFile(index), { code: 'ENOENT' })
    const reference = await client.value(rolled, 'entry.rejectedPrimary')
    const external = (await readFile(join(reference.notesRoot, reference.relativePath), 'utf8')) + '\nEditor write captured during rollback.\n'
    await writeFile(join(reference.notesRoot, reference.relativePath), external)
    const exit = await runtime.stop('SIGKILL')
    assert.equal(exit.signal, 'SIGKILL')
    assert.equal(exit.timedOut, false)
    assert.ok((await operation).error)
    await runtime.start()
    assert.equal((await runtime.host('state')).status, 200)
    assert.match(await readFile(index, 'utf8'), /Editor write captured during rollback\./)
    if (!absent) assert.match(await readFile(index, 'utf8'), /Original editor index paragraph\./)
    const journal = JSON.parse(await readFile(join(runtime.home, 'media-desk', 'notes-writes', id, 'pending.json'), 'utf8'))
    assert.equal(await readFile(join(journal.files[0].rejectedPrimary.notesRoot, journal.files[0].rejectedPrimary.relativePath), 'utf8'), external)
  })
})

test('带选段输入的相同已接受原生编辑复用回执，新的旧选段编辑仍被拒绝', { timeout: 180000 }, async t => {
  const edit = { name: 'media_desk_edit', arguments: { operations: JSON.stringify([{ op: 'update_item', id: 'seed_2', body: 'Selection retry accepted once.' }]), expectedContent: '$versions', resultId: 'selection-receipt-retry' } }
  const fresh = { name: 'media_desk_edit', arguments: { ...edit.arguments, operations: JSON.stringify([{ op: 'update_item', id: 'seed_2', body: 'Stale new selection edit.' }]), resultId: 'selection-new-edit' } }
  const runtime = await nativeRuntime(t, { recipes: { MD_FIXTURE_SELECTION_RETRY: { calls: [read, edit, edit, read, fresh], reply: 'Identical receipt retried; new stale selection refused.' } } })
  await runtime.start()
  await runtime.host('notes/migrate', {})
  const selected = (await runtime.host('state')).value.state.items.find(row => row.id === 'seed_2')
  const association = (await runtime.host('sessions/open', { workId: selected.id })).value.association
  const request = await runtime.prompt(association.sessionId, 'MD_FIXTURE_SELECTION_RETRY: rewrite the selected passage\n[Media Desk selection: ' + JSON.stringify({ [selected.id]: selected.content }) + ']')
  const turn = await runtime.turn(association.sessionId, request)
  const results = turn.events.filter(row => row.type === 'tool/result')
  assert.equal(results.length, 5)
  assert.ok(results.slice(0, 4).every(row => !row.data.message.isError), JSON.stringify(results))
  const receipt = JSON.parse(results[1].data.message.content[0].text).acceptance
  const duplicate = JSON.parse(results[2].data.message.content[0].text)
  assert.deepEqual(duplicate.acceptance, receipt)
  assert.equal(duplicate.state, undefined)
  assert.equal(results[4].data.message.isError, true)
  const state = (await runtime.host('state')).value.state
  assert.equal(state.receipts.filter(row => row.resultKey.endsWith(':selection-receipt-retry')).length, 1)
  assert.equal(state.receipts.some(row => row.resultKey.endsWith(':selection-new-edit')), false)
  assert.equal(state.items.find(row => row.id === selected.id).body, 'Selection retry accepted once.')
  assert.equal(state.items.find(row => row.id === selected.id).content.revision, selected.content.revision + 1)
})

test('原生问题等待时崩溃后清除业务等待，保留历史且新成稿创建新尝试', { timeout: 180000 }, async t => {
  const question = { name: 'ask_user_question', arguments: { questions: [{ id: 'direction', question: 'Which source should be used?', options: [{ label: 'Dated', description: 'Dated source.' }, { label: 'Brief', description: 'Brief source.' }] }] } }
  const runtime = await nativeRuntime(t, { recipes: { MD_STAGE_plan: { calls: [question], reply: 'No candidate.' } } })
  await runtime.start()
  await runtime.host('notes/migrate', {})
  await runtime.host('settings', { imageCount: 0, shotCount: 0 })
  const interactions = await runtime.interactions()
  const association = (await runtime.host('sessions/open', { workId: 'seed_2' })).value.association
  await runtime.host('produce', { id: 'seed_2' })
  await interactions.next('user-questions/request', association.sessionId)
  const waiting = await waitState(runtime, state => state.nativeRequests.at(-1).status === 'waiting')
  const oldStage = waiting.nativeRequests.at(-1)
  const original = waiting.items.find(row => row.id === 'seed_2').body
  assert.deepEqual(oldStage.pendingInput, ['question'])
  const modelRequests = await readFile(runtime.telemetryPath, 'utf8')
  const exit = await runtime.stop('SIGKILL')
  assert.equal(exit.signal, 'SIGKILL')
  assert.equal(exit.timedOut, false)
  await runtime.start()
  const native = await runtime.rpc('session/state', { request: { sessionId: association.sessionId } })
  assert.equal(native.value.running, false)
  assert.deepEqual(native.value.pendingInput, [])
  const state = (await runtime.host('state')).value.state
  const recovered = state.nativeRequests.find(row => row.id === oldStage.id)
  assert.equal(recovered.status, 'interrupted')
  assert.deepEqual(recovered.pendingInput, [])
  assert.deepEqual(state.items.find(row => row.id === 'seed_2').production.pendingInput, [])
  assert.equal(state.items.find(row => row.id === 'seed_2').body, original)
  assert.equal(await readFile(runtime.telemetryPath, 'utf8'), modelRequests)
  assert.ok(!state.receipts.some(row => row.resultKey === 'stage:' + oldStage.id))
  const events = await runtime.events(association.sessionId)
  assert.ok(events.some(row => row.type === 'user/message' && row.data.id === oldStage.messageId))
  const retry = await runtime.host('produce', { id: 'seed_2' })
  assert.equal(retry.value.started, true, JSON.stringify(retry.value))
  const next = await waitState(runtime, state => state.nativeRequests.at(-1).id !== oldStage.id)
  assert.notEqual(next.items.find(row => row.id === 'seed_2').production.attemptId, oldStage.id)
  await runtime.rpc('session/cancel', { request: { sessionId: association.sessionId } })
})
