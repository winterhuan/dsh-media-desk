/** Public media retries and cold receipt recovery settle the original native production. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeRuntime } from './fixtures/native-runtime.js'
import { inspectRuntime } from './fixtures/inspector.js'
import { buildSeed } from '../src/seed.js'

const PNG = Buffer.from('89504e470d0a1a0a000000000000ff80', 'hex')
const read = { name: 'media_desk_read', arguments: { kind: 'work' } }
const plan = { title: 'The retained image', coverText: 'Retained', facts: [], outline: [], cover: 'Paper', images: [], shots: [], sources: [] }
const article = { article: 'The accepted script accompanies the retained image.\n', sources: [] }
const recipes = {
  MD_STAGE_plan: { calls: [read, { name: 'media_desk_submit_result', arguments: { stageId: '$stageId', result: JSON.stringify(plan) } }], reply: 'Plan submitted.' },
  MD_STAGE_article: { calls: [read, { name: 'media_desk_submit_result', arguments: { stageId: '$stageId', result: JSON.stringify(article) } }], reply: 'Article submitted.' },
}
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

for (const boundary of ['explicit-retry', 'receipt-recovery', 'language-retry']) test('原生部分成稿的图片保存 ' + boundary + ' 复用原始字节和回执并结算成稿', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t, { recipes })
  if (boundary === 'language-retry') {
    const state = buildSeed(new Date('2026-11-01T12:00:00Z'))
    state.items.find(row => row.id === 'seed_2').otherLang = { en: { title: 'The existing English work', body: 'The accepted English text.\n', language: 'en', drafts: {} } }
    await mkdir(join(runtime.home, 'media-desk'))
    await writeFile(join(runtime.home, 'media-desk', 'state.json'), JSON.stringify(state))
  }
  let requests = 0
  const server = createServer((req, res) => {
    requests++
    req.resume()
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }))
  })
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  await runtime.start([], { NODE_OPTIONS: '--inspect=127.0.0.1:0' })
  await runtime.host('notes/migrate', {})
  await runtime.host('settings', { imageCount: 0, shotCount: 0,
    image: { baseUrl: 'http://127.0.0.1:' + server.address().port, model: 'fixture-image', apiKey: 'private-fixture-key' } })
  const client = await inspectRuntime(t, runtime)
  const point = await client.breakAt('/src/media-files.js', 'const target = join(record.notesRoot, record.relativePath)')
  assert.equal((await runtime.host('produce', { id: 'seed_2' })).status, 200)
  const paused = await point.next()
  const record = await client.value(paused, 'record')
  const candidate = join(runtime.home, 'media-desk', 'media-writes', record.id, 'candidate.png')
  const journal = join(runtime.home, 'media-desk', 'media-writes', record.id, 'pending.json')
  const assets = join(record.notesRoot, 'assets')
  await writeFile(assets, 'The Notes directory is temporarily blocked.\n')
  await point.remove()
  await client.send('Debugger.resume')
  const failed = await waitState(runtime, state => state.items.find(row => row.id === record.workId).production.status === 'partial')
  assert.equal(failed.items.find(row => row.id === record.workId).production.cover.pendingId, record.id)
  assert.deepEqual(await readFile(candidate), PNG)
  assert.equal(JSON.parse(await readFile(journal, 'utf8')).phase, 'candidate')
  const model = await readFile(runtime.telemetryPath, 'utf8')
  await unlink(assets)
  const productionAt = state => {
    const item = state.items.find(row => row.id === record.workId)
    return item.content.language === record.language ? item.production : item.otherLang[record.language].production
  }
  let receipt, selectedProduction
  if (boundary === 'language-retry') {
    const switched = await runtime.host('notes/language', { id: record.workId, language: record.language === 'en' ? 'zh' : 'en', expectedContent: failed.items.find(row => row.id === record.workId).content })
    assert.equal(switched.status, 200, JSON.stringify(switched.value))
    const current = switched.value.state.items.find(row => row.id === record.workId)
    assert.notEqual(current.content.language, record.language)
    selectedProduction = current.production
  }
  if (boundary === 'receipt-recovery') {
    const accepted = await client.breakAt('/src/media-files.js', "record.phase = 'accepted'")
    const pending = runtime.host('media/retry', { id: record.id }).then(value => ({ value }), error => ({ error }))
    await accepted.next()
    const disk = JSON.parse(await readFile(join(runtime.home, 'media-desk', 'state.json'), 'utf8'))
    receipt = disk.receipts.find(row => row.resultKey === 'media:' + record.id)
    assert.ok(receipt)
    assert.equal(disk.items.find(row => row.id === record.workId).production.status, 'partial')
    const exit = await runtime.stop('SIGKILL')
    assert.equal(exit.signal, 'SIGKILL')
    assert.equal(exit.timedOut, false)
    assert.ok((await pending).error)
    await runtime.start()
  } else {
    const retried = await runtime.host('media/retry', { id: record.id })
    assert.equal(retried.status, 200, JSON.stringify(retried.value))
    assert.equal(productionAt(retried.value.state).status, 'done')
    receipt = retried.value.state.receipts.find(row => row.resultKey === 'media:' + record.id)
  }
  const recovered = (await runtime.host('state')).value.state
  const work = recovered.items.find(row => row.id === record.workId)
  const production = productionAt(recovered)
  assert.equal(production.status, 'done')
  assert.equal(production.cover.status, 'done')
  assert.equal(production.attemptId, record.attemptId)
  assert.equal(production.cover.renderId, record.renderId)
  assert.equal(production.cover.pendingId, undefined)
  if (boundary === 'language-retry') assert.deepEqual(work.production, selectedProduction)
  assert.deepEqual(await readFile(join(record.notesRoot, record.relativePath)), PNG)
  const duplicate = await runtime.host('media/retry', { id: record.id })
  assert.equal(duplicate.status, 200, JSON.stringify(duplicate.value))
  assert.deepEqual(duplicate.value.acceptance, receipt)
  assert.equal(duplicate.value.state.receipts.filter(row => row.resultKey === 'media:' + record.id).length, 1)
  assert.equal(requests, 1)
  assert.equal(await readFile(runtime.telemetryPath, 'utf8'), model)
  assert.equal(recovered.nativeRequests.length, 2)
})
