/** Real Host recovery keeps accepted text, retained candidates and native turn identity separate. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { nativeRuntime } from './fixtures/native-runtime.js'
import { inspectRuntime } from './fixtures/inspector.js'

const read = { name: 'media_desk_read', arguments: { kind: 'work' } }
const plan = { title: 'Durable native recovery', coverText: 'Recovery', facts: [], outline: [], cover: 'Paper', images: [], shots: [], sources: [] }
const article = { article: 'A completed native candidate survives storage repair.\n', sources: [] }
const recipes = {
  MD_STAGE_plan: { calls: [read, { name: 'media_desk_submit_result', arguments: { stageId: '$stageId', result: JSON.stringify(plan) } }], reply: 'Plan submitted.' },
  MD_STAGE_article: { calls: [read, { name: 'media_desk_submit_result', arguments: { stageId: '$stageId', result: JSON.stringify(article) } }], reply: 'Article submitted.' },
}
const stateFile = runtime => join(runtime.home, 'media-desk', 'state.json')
const closeFixture = { insert: [{ id: 'media-desk-host-close-fixture', name: fileURLToPath(new URL('./fixtures/host-close.js', import.meta.url)) }] }
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

test('正常停止后保留已完成轮次的 Notes 保存失败，同一候选只接受一次且不重放模型', { timeout: 360000 }, async t => {
  for (const code of ['ENOSPC', 'EIO']) await t.test(code, { timeout: 180000 }, async t => {
    const runtime = await nativeRuntime(t, { recipes })
    await runtime.start([closeFixture], { NODE_OPTIONS: '--inspect=127.0.0.1:0' })
    await runtime.host('notes/migrate', {})
    await runtime.host('settings', { imageCount: 0, shotCount: 0 })
    const client = await inspectRuntime(t, runtime)
    const point = await client.breakAt('/src/notes-writes.js', 'await this.store.notes.createDirectory(entry.after.notesRoot', "entry.kind === 'work' && this.store.state.nativeRequests?.some(row => record.resultKey === 'stage:' + row.id && row.kind === 'article')", 1)
    assert.equal((await runtime.host('produce', { id: 'seed_2' })).status, 200)
    const paused = await point.next()
    await client.value(paused, `(() => { const notes = this.store.notes; const create = notes.createDirectory; notes.createDirectory = async function() { notes.createDirectory = create; throw Object.assign(new Error('Injected article Notes ${code}'), { code: '${code}' }); }; return true; })()`)
    await point.remove()
    await client.send('Debugger.resume')
    const failed = await waitState(runtime, state => state.nativeRequests.some(row => row.kind === 'article' && row.status === 'save-failed')
      && state.items.find(row => row.id === 'seed_2').production.status !== 'running')
    const stage = failed.nativeRequests.find(row => row.kind === 'article')
    const work = failed.items.find(row => row.id === 'seed_2')
    const candidatePath = join(runtime.home, 'media-desk', 'native-candidates', stage.id + '.json')
    const candidate = await readFile(candidatePath, 'utf8')
    assert.deepEqual(JSON.parse(candidate), article)
    const journalPath = join(runtime.home, 'media-desk', 'notes-writes', stage.pendingId, 'pending.json')
    const journal = JSON.parse(await readFile(journalPath, 'utf8'))
    assert.equal(journal.requiresValidation, true)
    assert.equal(journal.error.code, code)
    const native = await runtime.turn(stage.sessionId, stage.requestId)
    assert.equal(native.end.data.reason.kind, 'completed')
    assert.equal(native.start.data.turn, stage.turn)
    const turns = (await runtime.events(stage.sessionId)).filter(row => row.type === 'turn/start')
    const model = await readFile(runtime.telemetryPath, 'utf8')
    const closed = await runtime.host('../md-host-close', {})
    assert.deepEqual(closed.value, { closed: true }, JSON.stringify(closed) + '\n' + runtime.log)
    const exit = await runtime.stop()
    assert.equal(exit.timedOut, false)
    assert.notEqual(exit.signal, 'SIGKILL')
    const stopped = JSON.parse(await readFile(stateFile(runtime), 'utf8')).nativeRequests.find(row => row.id === stage.id)
    assert.equal(stopped.status, 'save-failed')
    assert.deepEqual(stopped.pendingInput, [])
    await runtime.start()
    const recovered = (await runtime.host('state')).value.state
    assert.equal(recovered.nativeRequests.find(row => row.id === stage.id).status, 'save-failed')
    assert.equal(recovered.items.find(row => row.id === work.id).body, work.body)
    assert.equal(recovered.items.find(row => row.id === work.id).content.revision, work.content.revision)
    assert.equal((await runtime.host('notes/retry', { id: stage.pendingId })).value.code, 'notes/validation-required')
    const retried = await runtime.host('native/retry', { id: stage.id })
    assert.equal(retried.status, 200, JSON.stringify(retried.value))
    const accepted = retried.value.state.nativeRequests.find(row => row.id === stage.id)
    assert.equal(accepted.turn, stage.turn)
    assert.equal(accepted.messageId, stage.messageId)
    assert.equal(accepted.candidateHash, stage.candidateHash)
    assert.equal(accepted.acceptance.id, journal.id)
    assert.equal(retried.value.state.items.find(row => row.id === work.id).body, article.article)
    assert.equal(retried.value.state.items.find(row => row.id === work.id).content.revision, work.content.revision + 1)
    const duplicate = await runtime.host('native/retry', { id: stage.id })
    assert.deepEqual(duplicate.value.acceptance, retried.value.acceptance)
    assert.equal(duplicate.value.state.receipts.filter(row => row.resultKey === 'stage:' + stage.id).length, 1)
    assert.equal(await readFile(candidatePath, 'utf8'), candidate)
    assert.equal(await readFile(runtime.telemetryPath, 'utf8'), model)
    assert.deepEqual((await runtime.events(stage.sessionId)).filter(row => row.type === 'turn/start'), turns)
  })
})

test('冷恢复接受已完成脚本或恢复丢失的通知，按已有素材结算且不派发新任务', { timeout: 540000 }, async t => {
  for (const boundary of ['candidate', 'receipt', 'idle-media']) await t.test(boundary, { timeout: 180000 }, async t => {
    const runtime = await nativeRuntime(t, { recipes })
    await runtime.start([], { NODE_OPTIONS: '--inspect=127.0.0.1:0' })
    await runtime.host('notes/migrate', {})
    let server, requests = 0, entered
    const imageStarted = new Promise(resolve => { entered = resolve })
    if (boundary === 'idle-media') {
      server = createServer((req, _res) => { requests++; req.resume(); entered() })
      t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    }
    await runtime.host('settings', { imageCount: 0, shotCount: 0,
      ...(server ? { image: { baseUrl: 'http://127.0.0.1:' + server.address().port, model: 'fixture-image', apiKey: 'private-fixture-key' } } : {}) })
    const client = await inspectRuntime(t, runtime)
    const point = await client.breakAt('/src/native-work.js', boundary === 'candidate'
      ? "const result = await this.store.mutate('接受原生成果'" : 'if (schedule) await this.ctx.mediaDesk.producer?.nativeAccepted', "stage.kind === 'article'")
    const admitted = runtime.host('produce', { id: 'seed_2' }).then(value => ({ value }), error => ({ error }))
    await point.next()
    if (server) {
      let timer
      try { await Promise.race([imageStarted, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('The image request was not observed')), 20000) })]) }
      finally { clearTimeout(timer) }
    }
    const disk = JSON.parse(await readFile(stateFile(runtime), 'utf8'))
    const stage = disk.nativeRequests.find(row => row.kind === 'article')
    assert.equal(stage.status, boundary === 'candidate' ? 'candidate' : 'accepted')
    assert.equal(disk.items.find(row => row.id === 'seed_2').production.status, 'running')
    assert.equal(disk.receipts.filter(row => row.resultKey === 'stage:' + stage.id).length, boundary === 'candidate' ? 0 : 1)
    const model = await readFile(runtime.telemetryPath, 'utf8')
    const exit = await runtime.stop('SIGKILL')
    assert.equal(exit.signal, 'SIGKILL')
    assert.equal(exit.timedOut, false)
    await admitted
    await runtime.start()
    assert.equal((await runtime.host('sessions/open', { workId: 'seed_2' })).status, 200)
    const recovered = await waitState(runtime, state => state.nativeRequests.find(row => row.id === stage.id).status === 'accepted')
    const work = recovered.items.find(row => row.id === 'seed_2')
    const accepted = recovered.nativeRequests.find(row => row.id === stage.id)
    assert.equal(work.production.status, server ? 'partial' : 'done')
    if (server) {
      assert.equal(work.production.cover.status, 'idle')
      assert.equal(requests, 1)
      assert.deepEqual(recovered.mediaReferences ?? {}, disk.mediaReferences ?? {})
    }
    assert.equal(work.production.article, article.article)
    assert.equal(work.body, article.article)
    assert.equal(work.content.revision, stage.expectedContent[work.id].revision + 1)
    assert.equal(accepted.turn, stage.turn)
    assert.equal(accepted.messageId, stage.messageId)
    assert.equal(accepted.candidateHash, stage.candidateHash)
    assert.equal(recovered.nativeRequests.length, 2)
    assert.equal(recovered.receipts.filter(row => row.resultKey === 'stage:' + stage.id).length, 1)
    assert.match(await readFile(join(work.content.notesRoot, work.content.relativePath), 'utf8'), /completed native candidate/)
    const events = await runtime.events(stage.sessionId)
    assert.ok(events.some(event => event.type === 'turn/end' && event.data.turn === stage.turn && event.data.reason.kind === 'completed'))
    assert.equal(events.filter(event => event.type === 'turn/start').length, 2)
    assert.equal(await readFile(runtime.telemetryPath, 'utf8'), model)
  })
})
