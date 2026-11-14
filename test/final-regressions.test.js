/** Installed Host publication and native Session recovery retain external edits and durable results. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeRuntime } from './fixtures/native-runtime.js'
import { inspectRuntime } from './fixtures/inspector.js'
import { hostRuntime } from './fixtures/host-runtime.js'

const read = { name: 'media_desk_read', arguments: { kind: 'work' } }
const plan = { title: 'Native wait evidence', coverText: 'Evidence', facts: [], outline: [], cover: 'Paper', images: [], shots: [], sources: [] }
const submit = { name: 'media_desk_submit_result', arguments: { stageId: '$stageId', result: JSON.stringify(plan) } }
const question = { name: 'ask_user_question', arguments: { questions: [{ id: 'direction', question: 'Which evidence should the script use?', options: [{ label: 'Dated', description: 'Use the dated source.' }, { label: 'Brief', description: 'Use the brief source.' }] }] } }
const approval = { name: 'bash', arguments: { description: 'Write an approved fixture observation', command: "printf 'approved\n' > wait-approved.txt", timeoutMs: 10000, run_in_background: false, sandbox_permissions: 'danger-full-access', justification: 'Save this fixture observation after native approval.' } }
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

test('Notes 索引捕获发布时的外部编辑和保留句柄写入，拒绝无效标记', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t)
  await runtime.start([], { NODE_OPTIONS: '--inspect=127.0.0.1:0' })
  await runtime.host('notes/migrate', {})
  const client = await inspectRuntime(t, runtime)
  const path = join(runtime.wiki, 'notes', 'index.md')
  const work = (await runtime.host('state')).value.state.items.find(row => row.id === 'seed_2')
  const workPath = join(work.content.notesRoot, work.content.relativePath)
  const points = [
    ['/src/notes.js', "await this.createDirectory(root, '')", undefined],
    ['/src/notes-writes.js', 'await rename(join(entry.before.notesRoot', "entry.kind === 'index'"],
    ['/src/notes-writes.js', 'this.validateSync(record)', "record.files.every(entry => entry.kind === 'index')"],
  ]
  for (const [index, [suffix, snippet, condition]] of points.entries()) {
    const point = await client.breakAt(suffix, snippet, condition)
    const text = await readFile(workPath, 'utf8')
    await writeFile(workPath, text.replace(/title: .*/, 'title: Index change ' + index))
    const editor = await open(path, 'a')
    try {
      const response = runtime.host('state')
      await point.next()
      const paragraph = '\nEditor paragraph ' + index + '.\n'
      await editor.write(paragraph)
      await point.remove()
      await client.send('Debugger.resume')
      const rejected = await response
      assert.equal(rejected.status, 409, JSON.stringify(rejected.value))
      assert.equal(rejected.value.code, 'notes/publication-conflict')
      assert.match(await readFile(path, 'utf8'), new RegExp('Editor paragraph ' + index))
      assert.equal((await runtime.host('state')).status, 200)
      assert.match(await readFile(path, 'utf8'), new RegExp('Editor paragraph ' + index))
    } finally { await editor.close() }
  }
  const history = join(runtime.wiki, 'notes', '.media-desk', 'history')
  const retained = (await readdir(history)).filter(name => name.startsWith('index%3A'))
  assert.ok(retained.length > 0)
  const bytes = await readFile(path, 'utf8')
  const invalid = bytes.replace(/<!-- \/media-desk:works:[^>]+ -->/, '')
  await writeFile(path, invalid)
  const rejected = await runtime.host('state')
  assert.equal(rejected.status, 409)
  assert.equal(rejected.value.code, 'notes/index-invalid')
  assert.equal(await readFile(path, 'utf8'), invalid)
  await writeFile(path, bytes)
  const crashPoint = await client.breakAt('/src/notes-writes.js', "entry.phase = 'displaced'", "entry.kind === 'index'")
  await writeFile(workPath, (await readFile(workPath, 'utf8')).replace(/title: .*/, 'title: Recovered index navigation'))
  const interrupted = runtime.host('state').catch(error => ({ error }))
  await crashPoint.next()
  await assert.rejects(readFile(path), { code: 'ENOENT' })
  const exit = await runtime.stop('SIGKILL')
  assert.equal(exit.signal, 'SIGKILL')
  assert.equal(exit.timedOut, false)
  await interrupted
  await client.close()
  // A stale terminal conflict precedes the interrupted publication in directory order.
  const journals = join(runtime.home, 'media-desk', 'notes-writes')
  let reordered = false
  for (const id of await readdir(journals)) {
    const pendingPath = join(journals, id, 'pending.json')
    let record
    try { record = JSON.parse(await readFile(pendingPath, 'utf8')) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    const entry = record.files[0]
    if (record.status !== 'conflict' || entry?.kind !== 'index' || !entry.displaced) continue
    if ((await readFile(join(entry.displaced.notesRoot, entry.displaced.relativePath), 'utf8')).includes('Editor paragraph 1')) continue
    const firstId = '00000000-0000-0000-0000-000000000000'
    for (const name of ['proposal.json', 'pending.json']) {
      const file = join(journals, id, name)
      const metadata = JSON.parse(await readFile(file, 'utf8'))
      metadata.id = firstId; metadata.receipt.id = firstId
      await writeFile(file, JSON.stringify(metadata))
    }
    await rename(join(journals, id), join(journals, firstId))
    reordered = true
    break
  }
  assert.equal(reordered, true)
  await runtime.start()
  assert.equal((await runtime.host('state')).status, 200)
  for (let index = 0; index < points.length; index++) assert.match(await readFile(path, 'utf8'), new RegExp('Editor paragraph ' + index))
})

test('原生偏好编辑在实际 hydration 和接受时核验，重复已接受结果复用回执', { timeout: 180000 }, async t => {
  const recipes = {}
  const runtime = await nativeRuntime(t, { recipes })
  await runtime.start()
  const added = await runtime.host('ops', { ops: ['HYDRATION', 'ACCEPTANCE', 'DUPLICATE'].map(name => ({ op: 'add_style', name: 'Pinned ' + name, summary: 'Original preference paragraph.' })) })
  const styles = Object.fromEntries(['HYDRATION', 'ACCEPTANCE', 'DUPLICATE'].map(name => [name, added.value.state.styles.find(row => row.name === 'Pinned ' + name)]))
  const edit = (style, resultId, operation = 'update_style') => ({ name: 'media_desk_edit', arguments: { operations: JSON.stringify([{ op: operation, id: style.id, ...(operation === 'update_style' ? { summary: 'Native replacement paragraph.' } : {}) }]), expectedPreferences: JSON.stringify({ ['style:' + style.id]: style.content }), resultId } })
  recipes.MD_FIXTURE_PREF_HYDRATION = { calls: [edit(styles.HYDRATION, 'preference-hydration')], reply: 'The changed preference was refused.' }
  recipes.MD_FIXTURE_PREF_ACCEPTANCE = { calls: [edit(styles.ACCEPTANCE, 'preference-acceptance', 'delete_style')], reply: 'The changed deletion was refused.' }
  recipes.MD_FIXTURE_PREF_DUPLICATE = { calls: [edit(styles.DUPLICATE, 'preference-duplicate'), edit(styles.DUPLICATE, 'preference-duplicate')], reply: 'One preference edit accepted.' }
  await runtime.stop()
  await runtime.start([], { NODE_OPTIONS: '--inspect=127.0.0.1:0' })
  const client = await inspectRuntime(t, runtime)
  const sessionId = (await runtime.host('sessions/open', {})).value.association.sessionId
  for (const [marker, suffix, snippet, condition] of [
    ['HYDRATION', '/src/native-work.js', "await this.store.mutate('原生编辑'", undefined],
    ['ACCEPTANCE', '/src/store.js', 'await handle.close()', "state.receipts?.some(row => row.resultKey.endsWith(':preference-acceptance'))"],
  ]) {
    const style = styles[marker]
    const path = join(style.content.notesRoot, style.content.relativePath)
    const point = await client.breakAt(suffix, snippet, condition)
    const request = runtime.prompt(sessionId, 'MD_FIXTURE_PREF_' + marker)
    await point.next()
    const changed = (await readFile(path, 'utf8')).replace('Original preference paragraph.', 'External preference paragraph.')
    await writeFile(path, changed)
    await point.remove()
    await client.send('Debugger.resume')
    const finished = await runtime.turn(sessionId, await request)
    assert.equal(finished.events.findLast(row => row.type === 'tool/result').data.message.isError, true)
    assert.equal(await readFile(path, 'utf8'), changed)
    const state = (await runtime.host('state')).value.state
    assert.ok(state.styles.some(row => row.id === style.id))
    assert.ok(!state.receipts.some(row => row.resultKey.endsWith(':preference-' + marker.toLowerCase())))
  }
  const style = styles.DUPLICATE
  await client.close()
  await runtime.stop()
  await runtime.start()
  const requestId = await runtime.prompt(sessionId, 'MD_FIXTURE_PREF_DUPLICATE')
  const finished = await runtime.turn(sessionId, requestId)
  const results = finished.events.filter(row => row.type === 'tool/result')
  assert.equal(results.length, 2)
  assert.ok(results.every(row => !row.data.message.isError), JSON.stringify(results))
  const state = (await runtime.host('state')).value.state
  assert.equal(state.styles.find(row => row.id === style.id).summary, 'Native replacement paragraph.')
  assert.equal(state.receipts.filter(row => row.resultKey.endsWith(':preference-duplicate')).length, 1)
})

test('原生问题与审批使业务阶段等待，回答继续，Stop 和重置清除等待', { timeout: 180000 }, async t => {
  const recipes = { MD_STAGE_plan: { calls: [read, question, approval, submit], reply: 'Plan accepted after native answers.' }, MD_STAGE_article: { calls: [read, { name: 'media_desk_submit_result', arguments: { stageId: '$stageId', result: JSON.stringify({ article: 'Native answers retained.', sources: [] }) } }], reply: 'Article submitted.' } }
  const runtime = await nativeRuntime(t, { recipes, env: { DSH_PERMISSION_MODE: 'workspace-write' } })
  await runtime.start()
  await runtime.host('notes/migrate', {})
  await runtime.host('settings', { imageCount: 0, shotCount: 0 })
  const interactions = await runtime.interactions()
  const association = (await runtime.host('sessions/open', { workId: 'seed_2' })).value.association
  const sessionId = association.sessionId
  const admitted = await runtime.host('produce', { id: 'seed_2' })
  assert.equal(admitted.status, 200, JSON.stringify(admitted.value))
  const next = async (event, phase) => {
    try { return await interactions.next(event, sessionId) } catch (error) {
      const state = (await runtime.host('state')).value.state
      const events = (await runtime.events(sessionId)).filter(row => ['tool/result', 'turn/end'].includes(row.type))
      throw new Error(phase + ': ' + error.message + '\n' + JSON.stringify({ requests: state.nativeRequests.map(row => ({ id: row.id, kind: row.kind, status: row.status, pendingInput: row.pendingInput })), events: events.map(row => ({ type: row.type, turn: row.data.turn, reason: row.data.reason, error: row.data.error })) }))
    }
  }
  const asked = await next('user-questions/request', 'initial question')
  const waiting = await waitState(runtime, state => state.nativeRequests.at(-1).status === 'waiting')
  assert.deepEqual(waiting.nativeRequests.at(-1).pendingInput, ['question'])
  assert.deepEqual(waiting.items.find(row => row.id === 'seed_2').production.pendingInput, ['question'])
  assert.ok((await runtime.rpc('session/state', { request: { sessionId } })).value.pendingInput.includes('question'))
  const durable = JSON.parse(await readFile(join(runtime.home, 'media-desk', 'state.json'), 'utf8'))
  assert.equal(durable.nativeRequests.at(-1).status, 'waiting')
  await interactions.answer(asked, { answers: [{ id: 'direction', selected: ['Dated'] }] })
  const approved = await next('approval/request', 'approval')
  const approving = await waitState(runtime, state => state.nativeRequests.at(-1).pendingInput?.includes('approval'))
  assert.equal(approving.nativeRequests.at(-1).status, 'waiting')
  assert.ok((await runtime.rpc('session/state', { request: { sessionId } })).value.pendingInput.includes('approval'))
  await interactions.answer(approved, 'allowed-once')
  const done = await waitState(runtime, state => state.items.find(row => row.id === 'seed_2').production.status === 'done')
  assert.ok(done.nativeRequests.every(row => row.status === 'accepted'))
  assert.deepEqual(done.nativeRequests.find(row => row.kind === 'plan').pendingInput, [])
  assert.deepEqual(done.items.find(row => row.id === 'seed_2').production.pendingInput, [])
  assert.equal(await readFile(join(runtime.wiki, 'wait-approved.txt'), 'utf8'), 'approved\n')
  for (const action of ['cancel', 'chat/clear']) {
    await runtime.host('produce', { id: 'seed_2' })
    const pending = await next('user-questions/request', action)
    assert.ok(pending)
    if (action === 'chat/clear') {
      await interactions.answer(pending, { answers: [{ id: 'direction', selected: ['Dated'] }] })
      await next('approval/request', 'reset approval')
    }
    await waitState(runtime, state => state.nativeRequests.at(-1).status === 'waiting')
    const response = action === 'cancel' ? await runtime.rpc('session/cancel', { request: { sessionId } }) : await runtime.host(action, { workId: 'seed_2' })
    assert.equal(action === 'cancel' ? response.ok : response.status === 200, true)
    const stopped = await waitState(runtime, state => ['interrupted', 'cancelled'].includes(state.nativeRequests.at(-1).status) && state.items.find(row => row.id === 'seed_2').production.status !== 'running')
    assert.deepEqual(stopped.nativeRequests.at(-1).pendingInput, [])
    assert.deepEqual(stopped.items.find(row => row.id === 'seed_2').production.pendingInput, [])
    assert.equal((await runtime.rpc('session/state', { request: { sessionId } })).value.running, false)
  }
  await interactions.close()
})

for (const kind of ['native', 'ENOSPC']) test('Host 关闭遇到 ' + kind + ' 失败仍等待受理操作结束并释放目录所有权', async t => {
  const home = await mkdtemp(join(tmpdir(), 'media-desk-close-error-'))
  const previous = process.env.DSH_HOME
  let runtime, release, releaseProducer
  t.after(async () => {
    release?.(); releaseProducer?.()
    await runtime?.close().catch(() => {})
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  })
  process.env.DSH_HOME = home
  runtime = await hostRuntime()
  const desk = runtime.ctx.get('mediaDesk')
  let entered
  const ready = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const producerGate = new Promise(resolve => { releaseProducer = resolve })
  const edit = desk.store.mutate('Admitted shutdown edit', async draft => { entered(); await gate; draft.closeEvidence = 'settled' })
  await ready
  const failure = Object.assign(new Error('Injected ' + kind + ' shutdown failure'), { code: kind })
  if (kind === 'native') desk.nativeWork.close = async () => { throw failure }
  else {
    const persist = desk.store.persist.bind(desk.store)
    desk.store.persist = async (state, validate) => { if (state.receipts?.at(-1)?.outcome?.value === 'shutdown') throw failure; return persist(state, validate) }
    const closeNative = desk.nativeWork.close.bind(desk.nativeWork)
    desk.nativeWork.close = async () => { await closeNative(); await desk.store.mutate('Fail final storage', () => 'shutdown', { undoable: false }) }
  }
  desk.producer.close = async () => { await producerGate }
  const closing = desk.close()
  const rejected = assert.rejects(closing, error => error instanceof AggregateError && error.errors.some(row => row.code === kind))
  assert.equal(desk.ownership.released, false)
  await readFile(join(desk.ownership.notesRoot, '.media-desk-owner.lock'))
  release()
  await edit
  assert.equal(desk.ownership.released, false)
  await readFile(join(desk.ownership.notesRoot, '.media-desk-owner.lock'))
  releaseProducer()
  await rejected
  assert.equal(desk.ownership.released, true)
  assert.equal(JSON.parse(await readFile(desk.store.file, 'utf8')).closeEvidence, 'settled')
  await assert.rejects(readFile(join(desk.ownership.notesRoot, '.media-desk-owner.lock')), { code: 'ENOENT' })
  await assert.rejects(readFile(join(desk.ownership.dataRoot, '.media-desk-owner.lock')), { code: 'ENOENT' })
})
