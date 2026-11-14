/** The assembled native edit tool retains bounded production revisions and fixed draft references. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeRuntime } from './fixtures/native-runtime.js'
import { inspectRuntime } from './fixtures/inspector.js'

const read = { name: 'media_desk_read', arguments: { kind: 'work', limit: 20000 } }
const PNG = Buffer.from('89504e470d0a1a0a000000000000ff80', 'hex')
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
const firstResults = events => {
  const callIds = new Set(events.filter(event => event.type === 'tool/call').map(event => event.data.callId))
  const seen = new Set()
  return events.filter(event => {
    if (event.type !== 'tool/result' || !callIds.has(event.data.message.toolCallId) || seen.has(event.data.message.toolCallId)) return false
    seen.add(event.data.message.toolCallId)
    return true
  })
}

test('真实原生修订保留限额和当前文字，回执不生图，显式重画每次一次且拒绝越权编辑', { timeout: 180000 }, async t => {
  const plan = { title: 'The original production', coverText: 'Original', facts: [], outline: [], cover: 'Original cover',
    images: [{ caption: 'Original caption', prompt: 'Original image' }],
    shots: [{ shot: 'Original', visual: 'Original visual', voice: 'Original voice', seconds: 5, prompt: 'Original shot' }], sources: [] }
  const recipes = {
    MD_STAGE_plan: { calls: [read, { name: 'media_desk_submit_result', arguments: { stageId: '$stageId', result: JSON.stringify(plan) } }], reply: 'Plan submitted.' },
    MD_STAGE_article: { calls: [read, { name: 'media_desk_submit_result', arguments: { stageId: '$stageId', result: JSON.stringify({ article: 'The accepted original production.\n', sources: [] }) } }], reply: 'Article submitted.' },
  }
  const runtime = await nativeRuntime(t, { recipes })
  const requests = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      requests.push(JSON.parse(body))
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }))
    })
  })
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  await runtime.start()
  await runtime.host('notes/migrate', {})
  await runtime.host('settings', { imageCount: 1, shotCount: 1 })
  assert.equal((await runtime.host('produce', { id: 'seed_2' })).status, 200)
  await waitState(runtime, state => state.items.find(row => row.id === 'seed_2').production.status === 'done')
  await runtime.host('ops', { ops: [{ op: 'save_draft', id: 'seed_2', format: 'article', text: 'The retained inactive article.\n' },
    { op: 'save_draft', id: 'seed_2', format: 'script', text: 'The selected current draft.\n' }] })
  const before = (await runtime.host('state')).value.state.items.find(row => row.id === 'seed_2')
  assert.ok(before.drafts.article.textVersion)
  const revision = { title: 'The revised current title', cover: { prompt: 'Cover '.repeat(300) },
    images: [{ no: 1, caption: 'Caption '.repeat(10), prompt: 'Image '.repeat(300) }],
    shots: [{ no: 1, shot: 'Closeup '.repeat(3), visual: 'Visual '.repeat(40), voice: 'Voice '.repeat(50), seconds: 99, prompt: 'Shot '.repeat(300) }] }
  const operation = { op: 'revise_production', id: before.id, attemptId: before.production.attemptId, revision }
  const edit = (op, resultId, expectedContent = '$versions') => ({ name: 'media_desk_edit', arguments: { operations: JSON.stringify([op]), expectedContent, resultId } })
  const acceptedEdit = edit(operation, 'bounded-native-revision')
  recipes.MD_FIXTURE_REVISION = { calls: [read, acceptedEdit, acceptedEdit, read], reply: 'The descriptions were saved without redrawing.' }
  recipes.MD_FIXTURE_REDRAW = { calls: [read, { name: 'media_desk_produce', arguments: { action: 'redraw', id: before.id, target: 'cover' } }], reply: 'One explicit redraw was admitted.' }
  recipes.MD_FIXTURE_FOREIGN_REVISION = { calls: [read, edit({ ...operation, id: 'seed_1' }, 'foreign-native-revision')], reply: 'The foreign revision was refused.' }
  recipes.MD_FIXTURE_OLD_ATTEMPT = { calls: [read, edit({ ...operation, attemptId: 'retired-attempt' }, 'old-attempt-revision')], reply: 'The old production attempt was refused.' }
  recipes.MD_FIXTURE_STALE_REVISION = { calls: [read, edit(operation, 'stale-native-revision', JSON.stringify({ [before.id]: before.content }))], reply: 'The old content version was refused.' }
  recipes.MD_FIXTURE_MISSING_VERSION = { calls: [read, edit(operation, 'missing-version-revision', '{}')], reply: 'The unversioned revision was refused.' }
  recipes.MD_FIXTURE_RESULT_CONFLICT = { calls: [read, edit({ ...operation, revision: { title: 'Conflicting duplicate title' } }, 'bounded-native-revision')], reply: 'The conflicting duplicate was refused.' }
  const currentText = 'The selected current draft.'
  const editedText = 'The selected draft edited through the production whitelist.'
  recipes.MD_FIXTURE_TEXT_REVISION = { calls: [read, edit({ ...operation, revision: { edits: [{ find: currentText, replace: editedText }] } }, 'current-text-revision')], reply: 'The current registered text was revised.' }
  await runtime.host('settings', { image: { baseUrl: 'http://127.0.0.1:' + server.address().port, model: 'fixture-image', apiKey: 'private-fixture-key' } })
  const exit = await runtime.stop()
  assert.equal(exit.timedOut, false)
  assert.notEqual(exit.signal, 'SIGKILL')
  await runtime.start()
  const association = (await runtime.host('sessions/open', { workId: before.id })).value.association
  const request = await runtime.prompt(association.sessionId, 'MD_FIXTURE_REVISION: revise the retained descriptions only')
  const turn = await runtime.turn(association.sessionId, request)
  const results = firstResults(turn.events)
  assert.equal(results.length, 4)
  assert.ok(results.every(row => !row.data.message.isError), JSON.stringify(results.filter(row => row.data.message.isError)))
  const values = results.map(row => JSON.parse(row.data.message.content[0].text))
  assert.deepEqual(values[0].drafts.article.version, before.drafts.article.textVersion)
  assert.deepEqual(values[0].drafts.article.aiVersion, before.drafts.article.aiVersion)
  assert.deepEqual(values[2].acceptance, values[1].acceptance)
  assert.deepEqual(values[1].receipts[0].redrawTargets, ['cover', 'image:0', 'shot:0'])
  const state = (await runtime.host('state')).value.state
  const current = state.items.find(row => row.id === before.id)
  assert.equal(current.title, revision.title)
  assert.equal(current.body, before.body)
  assert.equal(current.production.article, before.production.article)
  assert.equal(current.production.cover.prompt, revision.cover.prompt.slice(0, 1200))
  assert.equal(current.production.images[0].caption, revision.images[0].caption.slice(0, 40))
  assert.equal(current.production.images[0].prompt, revision.images[0].prompt.slice(0, 1200))
  for (const [field, length] of [['shot', 12], ['visual', 200], ['voice', 200], ['prompt', 1200]]) assert.equal(current.production.shots[0][field], revision.shots[0][field].slice(0, length))
  assert.equal(current.production.shots[0].seconds, 60)
  assert.deepEqual(current.production.aiVersion, before.production.aiVersion)
  assert.deepEqual(current.drafts.article.textVersion, before.drafts.article.textVersion)
  assert.equal(state.receipts.filter(row => row.resultKey.endsWith(':bounded-native-revision')).length, 1)
  assert.equal(requests.length, 0)
  for (const marker of ['FOREIGN_REVISION', 'OLD_ATTEMPT', 'STALE_REVISION', 'MISSING_VERSION', 'RESULT_CONFLICT']) {
    const input = await runtime.prompt(association.sessionId, 'MD_FIXTURE_' + marker + ': refuse the unauthorized revision')
    const refused = await runtime.turn(association.sessionId, input)
    const replies = firstResults(refused.events)
    assert.equal(JSON.parse(replies[0].data.message.content[0].text).id, before.id)
    assert.equal(replies.at(-1).data.message.isError, true, JSON.stringify(replies.at(-1)))
    if (marker === 'FOREIGN_REVISION') assert.match(replies.at(-1).data.message.content[0].text, /owns another work/)
    if (marker === 'OLD_ATTEMPT') assert.match(replies.at(-1).data.message.content[0].text, /current production attempt/)
    if (marker === 'MISSING_VERSION') assert.match(replies.at(-1).data.message.content[0].text, /current work content version/)
  }
  const refusedState = (await runtime.host('state')).value.state
  assert.deepEqual(refusedState.items.find(row => row.id === before.id), current)
  assert.equal(refusedState.receipts.filter(row => row.resultKey.endsWith(':bounded-native-revision')).length, 1)
  assert.equal(requests.length, 0)
  const textRequest = await runtime.prompt(association.sessionId, 'MD_FIXTURE_TEXT_REVISION: edit the selected current draft text')
  const textTurn = await runtime.turn(association.sessionId, textRequest)
  assert.ok(firstResults(textTurn.events).every(row => !row.data.message.isError))
  const selected = (await runtime.host('state')).value.state.items.find(row => row.id === before.id)
  assert.equal(selected.body, before.body.replace(currentText, editedText))
  assert.equal(selected.production.article, selected.body)
  assert.equal(selected.production.current, true)
  assert.deepEqual(selected.production.aiVersion, before.production.aiVersion)
  assert.deepEqual(selected.drafts.article.textVersion, before.drafts.article.textVersion)
  assert.equal(requests.length, 0)
  const redraw = await runtime.prompt(association.sessionId, 'MD_FIXTURE_REDRAW: redraw the revised cover once')
  const redrawTurn = await runtime.turn(association.sessionId, redraw)
  assert.equal(redrawTurn.end.data.reason.kind, 'completed')
  const rendered = await waitState(runtime, draft => draft.items.find(row => row.id === before.id).production.cover.status === 'done')
  const cover = rendered.items.find(row => row.id === before.id).production.cover
  assert.equal(requests.length, 1)
  assert.ok(requests[0].prompt.includes(revision.cover.prompt.slice(0, 1200)))
  assert.deepEqual(await readFile(join(cover.media.notesRoot, cover.media.relativePath)), PNG)
  assert.equal(rendered.items.find(row => row.id === before.id).body, selected.body)
  // Redraw retains the script's done state; its completion write advances finishedAt.
  const completed = await waitState(runtime, draft => {
    const production = draft.items.find(row => row.id === before.id).production
    return production.status === 'done' && production.finishedAt !== selected.production.finishedAt
  })
  const completedWork = completed.items.find(row => row.id === before.id)
  const fresh = await runtime.host('chat/clear', { workId: before.id })
  assert.equal(fresh.status, 200, JSON.stringify(fresh.value))
  assert.notEqual(fresh.value.association.sessionId, association.sessionId)
  const retained = fresh.value.state.items.find(row => row.id === before.id)
  assert.equal(retained.body, completedWork.body)
  assert.equal(retained.title, completedWork.title)
  assert.deepEqual(retained.content, completedWork.content)
  assert.deepEqual(retained.production, completedWork.production)
  assert.deepEqual(retained.drafts, completedWork.drafts)
  assert.deepEqual(retained.textHistory, completedWork.textHistory)
  const businessReceipts = state => state.receipts.filter(row => /^(native|stage|media):/.test(row.resultKey) || row.contentVersions.length || row.resources.length)
  assert.deepEqual(businessReceipts(fresh.value.state), businessReceipts(completed))
  assert.deepEqual(await readFile(join(retained.production.cover.media.notesRoot, retained.production.cover.media.relativePath)), PNG)
})

test('原生画面修订拒绝迟到旧图，两个显式重画只发起两次请求', { timeout: 120000 }, async t => {
  const plan = { title: 'Revision race', coverText: 'Revision', cover: 'The original prompt.', facts: [], outline: [], images: [], shots: [], sources: [] }
  const recipes = {
    MD_STAGE_plan: { calls: [read, { name: 'media_desk_submit_result', arguments: { stageId: '$stageId', result: JSON.stringify(plan) } }], reply: 'Plan submitted.' },
    MD_STAGE_article: { calls: [read, { name: 'media_desk_submit_result', arguments: { stageId: '$stageId', result: JSON.stringify({ article: 'The accepted article.\n', sources: [] }) } }], reply: 'Article submitted.' },
  }
  const runtime = await nativeRuntime(t, { recipes })
  const requests = []
  let entered, releaseImage
  const imageStarted = new Promise(resolve => { entered = resolve })
  const release = () => { const reply = releaseImage; releaseImage = undefined; reply?.() }
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      requests.push(JSON.parse(body))
      const reply = () => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }))
      }
      if (requests.length === 1) { releaseImage = reply; entered() }
      else reply()
    })
  })
  t.after(async () => { release(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  await runtime.start()
  await runtime.host('notes/migrate', {})
  await runtime.host('settings', { imageCount: 0, shotCount: 0 })
  assert.equal((await runtime.host('produce', { id: 'seed_2' })).status, 200)
  const state = await waitState(runtime, draft => draft.items.find(row => row.id === 'seed_2').production.status === 'done')
  const before = state.items.find(row => row.id === 'seed_2')
  const latePrompt = 'The newer prompt accepted while the old image request waits.'
  recipes.MD_FIXTURE_LATE_PROMPT = { calls: [read, { name: 'media_desk_edit', arguments: {
    operations: JSON.stringify([{ op: 'revise_production', id: before.id, attemptId: before.production.attemptId, revision: { cover: { prompt: latePrompt } } }]),
    expectedContent: '$versions', resultId: 'late-cover-prompt',
  } }], reply: 'The newer cover prompt was saved.' }
  recipes.MD_FIXTURE_REDRAW = { calls: [read, { name: 'media_desk_produce', arguments: { action: 'redraw', id: before.id, target: 'cover' } }], reply: 'One explicit redraw was admitted.' }
  await runtime.host('settings', { image: { baseUrl: 'http://127.0.0.1:' + server.address().port, model: 'fixture-image', apiKey: 'private-fixture-key' } })
  const exit = await runtime.stop()
  assert.equal(exit.timedOut, false)
  assert.notEqual(exit.signal, 'SIGKILL')
  await runtime.start()
  const association = (await runtime.host('sessions/open', { workId: before.id })).value.association
  const redraw = await runtime.prompt(association.sessionId, 'MD_FIXTURE_REDRAW: start the original cover request')
  const redrawTurn = await runtime.turn(association.sessionId, redraw)
  assert.equal(redrawTurn.end.data.reason.kind, 'completed')
  let timer
  try { await Promise.race([imageStarted, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('The held image request was not observed')), 60000) })]) }
  finally { clearTimeout(timer) }
  const rendering = (await runtime.host('state')).value.state.items.find(row => row.id === before.id).production.cover
  assert.equal(rendering.status, 'running')
  const promptRequest = await runtime.prompt(association.sessionId, 'MD_FIXTURE_LATE_PROMPT: revise the description without starting another image request')
  const promptTurn = await runtime.turn(association.sessionId, promptRequest)
  assert.equal(promptTurn.end.data.reason.kind, 'completed', JSON.stringify(promptTurn.end))
  const promptResults = firstResults(promptTurn.events)
  assert.equal(promptResults.length, 2)
  assert.ok(promptResults.every(row => !row.data.message.isError), JSON.stringify(promptResults))
  const revised = (await runtime.host('state')).value.state.items.find(row => row.id === before.id).production.cover
  assert.equal(revised.prompt, latePrompt)
  assert.notEqual(revised.renderId, rendering.renderId)
  assert.equal(requests.length, 1)
  release()
  const settled = await waitState(runtime, draft => draft.items.find(row => row.id === before.id).production.status === 'partial')
  const refusedImage = settled.items.find(row => row.id === before.id).production.cover
  assert.equal(refusedImage.status, 'idle')
  assert.equal(refusedImage.media, undefined)
  assert.equal(settled.receipts.some(row => row.resultKey.startsWith('media:')), false)
  const freshRedraw = await runtime.prompt(association.sessionId, 'MD_FIXTURE_REDRAW: explicitly redraw the new accepted description')
  const freshTurn = await runtime.turn(association.sessionId, freshRedraw)
  assert.equal(freshTurn.end.data.reason.kind, 'completed')
  const rendered = await waitState(runtime, draft => draft.items.find(row => row.id === before.id).production.cover.status === 'done')
  const cover = rendered.items.find(row => row.id === before.id).production.cover
  assert.equal(requests.length, 2)
  assert.ok(requests[0].prompt.includes(plan.cover))
  assert.ok(requests[1].prompt.includes(latePrompt))
  assert.deepEqual(await readFile(join(cover.media.notesRoot, cover.media.relativePath)), PNG)
  assert.equal(rendered.items.find(row => row.id === before.id).body, before.body)
})

test('Host 与原生工具重画在真实 Store 读取期间重叠时只受理一张图，失败受理释放目标', { timeout: 180000 }, async t => {
  const plan = { title: 'One redraw admission', coverText: 'One', cover: 'One accepted image prompt.', facts: [], outline: [], images: [], shots: [], sources: [] }
  const runtime = await nativeRuntime(t, { recipes: {
    MD_STAGE_plan: { calls: [read, { name: 'media_desk_submit_result', arguments: { stageId: '$stageId', result: JSON.stringify(plan) } }], reply: 'Plan submitted.' },
    MD_STAGE_article: { calls: [read, { name: 'media_desk_submit_result', arguments: { stageId: '$stageId', result: JSON.stringify({ article: 'The accepted article.\n', sources: [] }) } }], reply: 'Article submitted.' },
    MD_FIXTURE_REDRAW: { calls: [read, { name: 'media_desk_produce', arguments: { action: 'redraw', id: 'seed_2', target: 'cover' } }], reply: 'The existing redraw admission was retained.' },
  } })
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
  await runtime.host('settings', { imageCount: 0, shotCount: 0 })
  assert.equal((await runtime.host('produce', { id: 'seed_2' })).status, 200)
  const state = await waitState(runtime, draft => draft.items.find(row => row.id === 'seed_2').production.status === 'done')
  const work = state.items.find(row => row.id === 'seed_2')
  assert.equal((await runtime.host('produce/regen', { id: work.id, target: 'cover' })).status, 400)
  await runtime.host('settings', { image: { baseUrl: 'http://127.0.0.1:' + server.address().port, model: 'fixture-image', apiKey: 'private-fixture-key' } })
  const association = (await runtime.host('sessions/open', { workId: work.id })).value.association
  const client = await inspectRuntime(t, runtime)
  const point = await client.breakAt('/src/produce.js', 'if (!this.ready(settings)) throw')
  const input = await runtime.prompt(association.sessionId, 'MD_FIXTURE_REDRAW: admit one redraw while the Host also requests it')
  const paused = await point.next()
  const retained = await client.send('Debugger.evaluateOnCallFrame', { callFrameId: paused.callFrames[0].callFrameId, expression: 'this', returnByValue: false })
  assert.equal(retained.exceptionDetails, undefined)
  const call = async functionDeclaration => {
    const result = await client.send('Runtime.callFunctionOn', { objectId: retained.result.objectId, functionDeclaration, returnByValue: true })
    assert.equal(result.exceptionDetails, undefined)
    return result.result.value
  }
  // Execute the real Store read, then hold only its returned promise before admission continues.
  await call(`function () {
    const producer = this, store = this.store, read = store.read;
    this.redrawReadBarrier = { entered: false };
    store.read = async function (...args) {
      store.read = read;
      const state = await read.apply(store, args);
      producer.redrawReadBarrier.entered = true;
      await new Promise(resolve => { producer.redrawReadBarrier.release = resolve });
      return state;
    };
  }`)
  await point.remove()
  await client.send('Debugger.resume')
  try {
    const deadline = Date.now() + 60000
    while (!await call('function () { return this.redrawReadBarrier.entered }')) {
      assert.ok(Date.now() < deadline, 'The first redraw did not reach its real Store read')
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    const duplicate = await runtime.host('produce/regen', { id: work.id, target: 'cover' })
    assert.equal(duplicate.status, 200, JSON.stringify(duplicate.value))
    assert.equal(requests, 0)
  } finally { await call('function () { this.redrawReadBarrier.release?.(); delete this.redrawReadBarrier }') }
  const turn = await runtime.turn(association.sessionId, input)
  assert.equal(turn.end.data.reason.kind, 'completed')
  const replies = firstResults(turn.events)
  assert.equal(replies.length, 2)
  assert.ok(replies.every(row => !row.data.message.isError), JSON.stringify(replies))
  const settled = await waitState(runtime, draft => draft.items.find(row => row.id === work.id).production.cover.status === 'done')
  const current = settled.items.find(row => row.id === work.id)
  assert.equal(requests, 1)
  assert.deepEqual(await readFile(join(current.production.cover.media.notesRoot, current.production.cover.media.relativePath)), PNG)
  assert.equal(current.body, work.body)
  assert.equal(settled.receipts.filter(row => row.resultKey.startsWith('media:')).length, 1)
})
