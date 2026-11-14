/** Candidate acceptance is tested through the real Loader, Agent loop and durable Notes files. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { nativeRuntime } from './fixtures/native-runtime.js'

const read = { name: 'media_desk_read', arguments: { kind: 'work' } }
const waitState = async (runtime, predicate) => {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    const response = await runtime.host('state')
    assert.equal(response.status, 200, JSON.stringify(response.value))
    if (predicate(response.value.state)) return response.value.state
    if (response.value.state.nativeRequests?.some(row => row.status === 'failed')) {
      const id = response.value.state.nativeRequests.find(row => row.status === 'failed').sessionId
      const events = id ? (await runtime.events(id)).filter(event => event.type === 'tool/result') : []
      throw new Error(JSON.stringify(events) + '\n' + JSON.stringify(response.value.state.nativeRequests) + '\n' + runtime.log)
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('Expected accepted Host state was not observed\n' + runtime.log)
}

test('全局复盘把任务编号误传为作品编号后可发现作品并读取正文与指标', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t, { recipes: { MD_STAGE_rules: { calls: [read,
    { name: 'media_desk_read', arguments: { kind: 'work', id: '$stageId' } },
    read,
    { name: 'media_desk_read', arguments: { kind: 'work', id: 'seed_2' } },
    { name: 'media_desk_read', arguments: { kind: 'metrics' } },
    { name: 'media_desk_submit_result', arguments: { stageId: '$stageId', result: JSON.stringify({ rules: [] }) } },
  ], reply: 'Reviewed the available work; no supported rule to propose.' } } })
  await runtime.start()
  const initial = (await runtime.host('state')).value.state
  assert.equal((await runtime.host('ops', { ops: initial.items.filter(work => !['seed_1', 'seed_2'].includes(work.id))
    .map(work => ({ op: 'delete_item', id: work.id })) })).status, 200)
  assert.equal((await runtime.host('notes/migrate', {})).status, 200)
  const requested = await runtime.host('skills/learn', {})
  assert.equal(requested.status, 200)
  const stage = requested.value.stage
  const turn = await runtime.turn(stage.sessionId, stage.requestId)
  const results = turn.events.filter(event => event.type === 'tool/result')
  assert.equal(results.length, 6)
  assert.equal(results[1].data.message.isError, true)
  assert.match(results[1].data.message.content[0].text, /omit id.*list works/)
  assert.ok(results.filter((_, index) => index !== 1).every(event => !event.data.message.isError))
  const listing = JSON.parse(results[2].data.message.content[0].text)
  assert.equal(listing.stage.workId, null)
  assert.ok(listing.works.some(work => work.id === 'seed_2' && work.content))
  const work = JSON.parse(results[3].data.message.content[0].text)
  assert.equal(work.id, 'seed_2')
  assert.equal(typeof work.body, 'string')
  assert.ok(work.body.length > 0)
  assert.ok(Array.isArray(JSON.parse(results[4].data.message.content[0].text).metrics))
  await waitState(runtime, state => state.nativeRequests.some(row => row.id === stage.id && row.status === 'accepted'))
})

test('原生工具按实际 Agent 归属编辑，保留持久回执与唯一 Notes 正文', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t, { recipes: { MD_FIXTURE_EDIT: { calls: [read,
    { name: 'media_desk_edit', arguments: { operations: JSON.stringify([{ op: 'update_item', id: 'seed_2', body: 'Accepted by the native business tool.' }]), expectedContent: '$versions', resultId: 'native-edit' } },
  ], reply: 'The tool returned a saved receipt.' } } })
  await runtime.start()
  await runtime.host('notes/migrate', {})
  const association = (await runtime.host('sessions/open', { workId: 'seed_2' })).value.association
  const requestId = await runtime.prompt(association.sessionId, 'MD_FIXTURE_EDIT: update the owned work through Media Desk.')
  const finished = await runtime.turn(association.sessionId, requestId)
  assert.equal(finished.end.data.reason.kind, 'completed')
  const results = finished.events.filter(event => event.type === 'tool/result')
  assert.ok(results.every(event => event.data.message.isError === false), JSON.stringify(results))
  const state = await waitState(runtime, state => state.items.find(row => row.id === 'seed_2').body === 'Accepted by the native business tool.')
  const work = state.items.find(row => row.id === 'seed_2')
  assert.match(await readFile(join(work.content.notesRoot, work.content.relativePath), 'utf8'), /Accepted by the native business tool/)
  assert.ok(state.receipts.some(row => row.resultKey.includes('native-edit')))
})

test('原生成稿先接受策划，再接受脚本；无图模式不使用模板假成功', { timeout: 180000 }, async t => {
  const plan = { title: 'Dated native work', coverText: 'Native', facts: ['Observed fixture evidence'], outline: ['Evidence'], cover: 'Plain paper', characters: '', images: [], shots: [], sources: [{ title: 'Fixture', reference: 'raw/evidence.md', date: '2026-11-12', limitations: 'Fixture observation only' }] }
  const runtime = await nativeRuntime(t, { recipes: {
    MD_STAGE_plan: { calls: [read, { name: 'media_desk_submit_result', arguments: { stageId: '$stageId', result: JSON.stringify(plan) } }], reply: 'Plan candidate submitted.' },
    MD_STAGE_article: { calls: [read, { name: 'media_desk_submit_result', arguments: { stageId: '$stageId', result: JSON.stringify({ article: '## Evidence\n\nA dated native result.', sources: plan.sources }) } }], reply: 'Article candidate submitted.' },
  } })
  await runtime.start()
  assert.equal((await runtime.host('notes/migrate', {})).status, 200)
  await runtime.host('settings', { imageCount: 0, shotCount: 0 })
  const admitted = await runtime.host('produce', { id: 'seed_2' })
  assert.equal(admitted.status, 200, JSON.stringify(admitted.value))
  const state = await waitState(runtime, state => state.items.find(row => row.id === 'seed_2')?.production?.status === 'done')
  const work = state.items.find(row => row.id === 'seed_2')
  assert.equal(work.production.article, '## Evidence\n\nA dated native result.')
  const stages = state.nativeRequests.filter(row => row.workId === work.id)
  assert.deepEqual(stages.map(row => row.kind), ['plan', 'article'])
  assert.ok(stages.every(row => row.status === 'accepted' && row.acceptance?.id && row.endSeq >= row.startSeq))
  assert.match(await readFile(join(work.content.notesRoot, work.content.relativePath), 'utf8'), /A dated native result/)
  for (const stage of stages) {
    const events = await runtime.events(stage.sessionId)
    assert.ok(events.some(event => event.type === 'turn/end' && event.data.turn === stage.turn && event.data.reason.kind === 'completed'))
  }
})


test('原生编辑拒绝其他作品、只读输入和未知操作，重复保存返回同一回执', { timeout: 180000 }, async t => {
  const edit = operations => ({ name: 'media_desk_edit', arguments: { operations: JSON.stringify(operations), expectedContent: '$versions', resultId: 'duplicate-proof' } })
  const own = edit([{ op: 'update_item', id: 'seed_2', body: 'One accepted edit.' }])
  const runtime = await nativeRuntime(t, { recipes: {
    MD_FIXTURE_FOREIGN: { calls: [read, edit([{ op: 'update_item', id: 'seed_1', body: 'Unauthorized edit.' }])], reply: 'Foreign edit was refused.' },
    MD_FIXTURE_READONLY: { calls: [read, own], reply: 'Read-only edit was refused.' },
    MD_FIXTURE_UNKNOWN: { calls: [read, edit([{ op: 'constructor', id: 'seed_2' }])], reply: 'Unknown operation was refused.' },
    MD_FIXTURE_DUPLICATE: { calls: [read, own, own], reply: 'One durable edit was accepted.' },
  } })
  await runtime.start()
  await runtime.host('notes/migrate', {})
  const association = (await runtime.host('sessions/open', { workId: 'seed_2' })).value.association
  const original = (await runtime.host('state')).value.state
  for (const marker of ['FOREIGN', 'READONLY', 'UNKNOWN']) {
    const requestId = await runtime.prompt(association.sessionId, 'MD_FIXTURE_' + marker + (marker === 'READONLY' ? ': 只读，不要修改文件' : ': exercise the refused operation'))
    const turn = await runtime.turn(association.sessionId, requestId)
    const result = turn.events.filter(row => row.type === 'tool/result').at(-1)
    assert.equal(result.data.message.isError, true, JSON.stringify(turn))
  }
  const unchanged = (await runtime.host('state')).value.state
  assert.equal(unchanged.items.find(row => row.id === 'seed_2').body, original.items.find(row => row.id === 'seed_2').body)
  assert.equal(unchanged.items.find(row => row.id === 'seed_1').body, original.items.find(row => row.id === 'seed_1').body)
  const requestId = await runtime.prompt(association.sessionId, 'MD_FIXTURE_DUPLICATE: perform a durable idempotent edit')
  const turn = await runtime.turn(association.sessionId, requestId)
  const results = turn.events.filter(row => row.type === 'tool/result')
  assert.ok(results.every(row => !row.data.message.isError), JSON.stringify(results))
  const state = (await runtime.host('state')).value.state
  assert.equal(state.receipts.filter(row => row.resultKey.endsWith(':duplicate-proof')).length, 1)
  const requests = (await readFile(runtime.telemetryPath, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.ok(requests.every(row => row.sessionId === association.sessionId))
})

test('提交候选后模型失败不接受正式策划，不重放后续阶段', { timeout: 180000 }, async t => {
  const plan = { title: 'Rejected plan', coverText: 'Candidate', facts: [], outline: [], cover: 'Paper', characters: '', images: [], shots: [], sources: [] }
  const runtime = await nativeRuntime(t, { recipes: {
    MD_STAGE_plan: { calls: [read, { name: 'media_desk_submit_result', arguments: { stageId: '$stageId', result: JSON.stringify(plan) } }], failAt: 2 },
  } })
  await runtime.start()
  await runtime.host('notes/migrate', {})
  await runtime.host('settings', { imageCount: 0, shotCount: 0 })
  const original = (await runtime.host('state')).value.state.items.find(row => row.id === 'seed_2').body
  await runtime.host('produce', { id: 'seed_2' })
  let state
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    state = (await runtime.host('state')).value.state
    if (state.nativeRequests?.[0]?.status === 'failed') break
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.equal(state.nativeRequests[0].status, 'failed', JSON.stringify(state.nativeRequests))
  assert.equal(state.nativeRequests.length, 1)
  assert.equal(state.items.find(row => row.id === 'seed_2').body, original)
  assert.ok(!state.receipts.some(row => row.resultKey === 'stage:' + state.nativeRequests[0].id))
  assert.equal((await runtime.host('native/retry', { id: state.nativeRequests[0].id })).value.code, 'native/stage-stale')
  const stored = JSON.parse(await readFile(join(runtime.home, 'media-desk', 'state.json'), 'utf8'))
  assert.equal(stored.nativeRequests[0].candidate, undefined)
})


test('重复成稿只受理一次；开始新对话停止候选轮次并保留旧队列与已接受正文', { timeout: 180000 }, async t => {
  const recipes = {}
  const runtime = await nativeRuntime(t, { recipes })
  const barrier = Object.fromEntries(['enteredPath', 'releasePath', 'abortedPath', 'settledPath'].map(name => [name, join(runtime.root, name)]))
  barrier.at = 2
  recipes.MD_STAGE_plan = { calls: [read, { name: 'media_desk_submit_result', arguments: { stageId: '$stageId', result: JSON.stringify({ title: 'A late plan', coverText: 'Late', facts: [], outline: [], cover: 'Paper', characters: '', images: [], shots: [], sources: [] }) } }], barrier, reply: 'Late candidate.' }
  await runtime.start()
  await runtime.host('notes/migrate', {})
  await runtime.host('settings', { imageCount: 0, shotCount: 0 })
  const association = (await runtime.host('sessions/open', { workId: 'seed_2' })).value.association
  const original = (await runtime.host('state')).value.state.items.find(row => row.id === 'seed_2').body
  const admitted = await Promise.all([runtime.host('produce', { id: 'seed_2' }), runtime.host('produce', { id: 'seed_2' })])
  assert.ok(admitted.every(row => row.status === 200), JSON.stringify(admitted))
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    try { if ((await readFile(barrier.enteredPath, 'utf8')) === 'entered\n') break } catch (error) { if (error.code !== 'ENOENT') throw error }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.equal(await readFile(barrier.enteredPath, 'utf8'), 'entered\n')
  const pendingId = await runtime.prompt(association.sessionId, 'An unrelated future native message.')
  const before = await runtime.rpc('session/state', { request: { sessionId: association.sessionId } })
  assert.ok(before.value.queue.some(row => row.rpcId === pendingId))
  const resets = await Promise.all([runtime.host('chat/clear', { workId: 'seed_2' }), runtime.host('chat/clear', { workId: 'seed_2' })])
  const fresh = resets[0]
  assert.equal(resets[1].value.association.sessionId, fresh.value.association.sessionId)
  assert.equal(fresh.status, 200, JSON.stringify(fresh.value) + runtime.log)
  assert.notEqual(fresh.value.association.sessionId, association.sessionId)
  const parked = await runtime.rpc('session/state', { request: { sessionId: association.sessionId } })
  assert.equal(parked.value.running, false)
  assert.ok(parked.value.queue.some(row => row.rpcId === pendingId))
  const state = (await runtime.host('state')).value.state
  assert.equal(state.nativeRequests.length, 1)
  assert.equal(state.nativeRequests[0].status, 'cancelled')
  assert.equal((await runtime.host('native/retry', { id: state.nativeRequests[0].id })).value.code, 'native/stage-stale')
  assert.equal(state.items.find(row => row.id === 'seed_2').body, original)
  assert.ok(!state.receipts.some(row => row.resultKey === 'stage:' + state.nativeRequests[0].id))
})


test('真实 Host 并发脚本与 HTTP 图片，单图失败保留其他成果并独立重画到 Notes', { timeout: 180000 }, async t => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lWQAAAAASUVORK5CYII=', 'base64')
  let releaseImages, failImage = true, calls = 0
  const gate = new Promise(resolve => { releaseImages = resolve })
  const server = createServer(async (request, response) => {
    const parts = []; for await (const part of request) parts.push(part)
    const input = JSON.parse(Buffer.concat(parts).toString())
    calls++
    await gate
    response.setHeader('content-type', 'application/json')
    if (input.prompt.includes('FAIL_ONE') && failImage) { response.statusCode = 400; response.end(JSON.stringify({ error: { message: 'One fixture image failed' } })) }
    else response.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
  })
  t.after(async () => { releaseImages(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const plan = { title: 'Sibling consistency', coverText: 'Evidence', facts: ['One dated fact'], outline: ['Evidence'], cover: 'A plain cover', characters: '', images: [{ caption: 'Evidence', anchor: 'Evidence', prompt: 'FAIL_ONE' }], shots: [{ shot: 'Medium', visual: 'Paper', voice: 'One dated fact', seconds: 4, prompt: 'A paper storyboard' }], sources: [{ title: 'Fixture evidence', reference: 'raw/source.md', date: '2026-11-12', limitations: 'Fixture only' }] }
  const recipes = {
    MD_STAGE_plan: { calls: [read, { name: 'media_desk_submit_result', arguments: { stageId: '$stageId', result: JSON.stringify(plan) } }], reply: 'Plan submitted.' },
    MD_STAGE_article: { calls: [read, { name: 'media_desk_submit_result', arguments: { stageId: '$stageId', result: JSON.stringify({ article: '## Evidence\n\nOne dated fact.', sources: plan.sources }) } }], reply: 'Article submitted.' },
  }
  const runtime = await nativeRuntime(t, { recipes })
  const barrier = { at: 0, enteredPath: join(runtime.root, 'article-entered'), releasePath: join(runtime.root, 'article-release'), abortedPath: join(runtime.root, 'article-aborted'), settledPath: join(runtime.root, 'article-settled') }
  recipes.MD_STAGE_article.barrier = barrier
  await runtime.start()
  await runtime.host('notes/migrate', {})
  await runtime.host('settings', { imageCount: 1, shotCount: 1, image: { baseUrl: 'http://127.0.0.1:' + server.address().port, model: 'fixture-image', apiKey: 'private-fixture-key' } })
  await runtime.host('produce', { id: 'seed_2' })
  const planned = await waitState(runtime, state => state.nativeRequests?.some(row => row.kind === 'article' && row.status === 'running'))
  const attemptId = planned.items.find(row => row.id === 'seed_2').production.attemptId
  assert.equal((await runtime.host('produce', { id: 'seed_2' })).value.started, false)
  assert.equal((await runtime.host('state')).value.state.nativeRequests.length, 2)
  await writeFile(barrier.releasePath, 'release\n')
  const writing = await waitState(runtime, state => state.items.find(row => row.id === 'seed_2').production?.nativeStageId)
  assert.equal((await runtime.host('produce', { id: 'seed_2' })).value.started, false)
  const repeated = (await runtime.host('state')).value.state
  assert.equal(repeated.nativeRequests.length, 2)
  assert.equal(repeated.items.find(row => row.id === 'seed_2').production.attemptId, attemptId)
  assert.ok(writing.items.find(row => row.id === 'seed_2').production.cover.status !== 'done')
  releaseImages()
  const partial = await waitState(runtime, state => state.items.find(row => row.id === 'seed_2').production?.status === 'partial')
  const production = partial.items.find(row => row.id === 'seed_2').production
  assert.equal(production.images[0].status, 'failed')
  assert.equal(production.cover.status, 'done')
  assert.equal(production.shots[0].status, 'done')
  for (const asset of [production.cover, production.shots[0]]) assert.deepEqual(await readFile(join(asset.media.notesRoot, asset.media.relativePath)), png)
  assert.equal(calls, 3)
  failImage = false
  assert.equal((await runtime.host('produce/regen', { id: 'seed_2', target: 'image:0' })).status, 200)
  const done = await waitState(runtime, state => state.items.find(row => row.id === 'seed_2').production?.status === 'done')
  const work = done.items.find(row => row.id === 'seed_2')
  assert.equal(calls, 4)
  assert.deepEqual(work.production.cover.media, production.cover.media)
  assert.match(await readFile(join(work.content.notesRoot, work.content.relativePath), 'utf8'), /raw\/source.md/)
  assert.doesNotMatch(JSON.stringify(done), /private-fixture-key/)
})

test('旧选段经原生草稿发送后仍受版本约束，重新读取不能授权覆盖外部更新', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t, { recipes: { MD_FIXTURE_SELECTION: { calls: [read,
    { name: 'media_desk_edit', arguments: { operations: JSON.stringify([{ op: 'update_item', id: 'seed_2', body: 'Stale selected edit.' }]), expectedContent: '$versions' } },
  ], reply: 'The stale selection was refused.' } } })
  await runtime.start()
  await runtime.host('notes/migrate', {})
  const selected = (await runtime.host('state')).value.state.items.find(row => row.id === 'seed_2')
  const path = join(selected.content.notesRoot, selected.content.relativePath)
  await writeFile(path, (await readFile(path, 'utf8')).replace(selected.body, 'External current body.'))
  const association = (await runtime.host('sessions/open', { workId: selected.id })).value.association
  const requestId = await runtime.prompt(association.sessionId, 'MD_FIXTURE_SELECTION: rewrite the selected passage\n[Media Desk selection: ' + JSON.stringify({ [selected.id]: selected.content }) + ']')
  const turn = await runtime.turn(association.sessionId, requestId)
  assert.equal(turn.events.filter(row => row.type === 'tool/result').at(-1).data.message.isError, true)
  assert.equal((await runtime.host('state')).value.state.items.find(row => row.id === selected.id).body, 'External current body.')
})

test('原生队列编辑、删除和引导使未消费策划失效，保留无关待发输入', { timeout: 180000 }, async t => {
  const recipes = {}
  const runtime = await nativeRuntime(t, { recipes })
  for (const action of ['edit', 'remove', 'steer']) recipes['MD_FIXTURE_HOLD_' + action] = {
    calls: [], reply: 'The held native request completed.', barrier: { at: 0, enteredPath: join(runtime.root, action + '-entered'), releasePath: join(runtime.root, action + '-release'), abortedPath: join(runtime.root, action + '-aborted'), settledPath: join(runtime.root, action + '-settled') },
  }
  await runtime.start()
  await runtime.host('notes/migrate', {})
  await runtime.host('settings', { imageCount: 0, shotCount: 0 })
  const original = (await runtime.host('state')).value.state.items.find(row => row.id === 'seed_2').body
  for (const kind of ['edit', 'remove', 'steer']) {
    const association = (await runtime.host(kind === 'edit' ? 'sessions/open' : 'chat/clear', { workId: 'seed_2' })).value.association
    const held = await runtime.prompt(association.sessionId, 'MD_FIXTURE_HOLD_' + kind)
    const entered = join(runtime.root, kind + '-entered')
    const deadline = Date.now() + 30000
    for (;;) {
      try { await readFile(entered); break } catch (error) { if (error.code !== 'ENOENT' || Date.now() > deadline) throw error }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    await runtime.host('produce', { id: 'seed_2' })
    const state = (await runtime.host('state')).value.state
    const stage = state.nativeRequests.at(-1)
    const unrelated = await runtime.prompt(association.sessionId, 'An unrelated future input.')
    const pending = (await runtime.rpc('session/state', { request: { sessionId: association.sessionId } })).value.queue
    const item = pending.find(row => row.rpcId === stage.requestId)
    assert.ok(item)
    const action = kind === 'edit' ? { kind, content: [{ type: 'text', text: 'An edited ordinary request.' }] } : { kind }
    const changed = await runtime.rpc('session/updateQueue', { request: { sessionId: association.sessionId, itemId: item.id, action } })
    assert.equal(changed.ok, true, JSON.stringify(changed))
    assert.equal((await runtime.rpc('session/cancel', { request: { sessionId: association.sessionId } })).ok, true)
    await runtime.turn(association.sessionId, held)
    const parked = (await runtime.rpc('session/state', { request: { sessionId: association.sessionId } })).value
    assert.ok(parked.queue.some(row => row.rpcId === unrelated), JSON.stringify(parked))
    const final = (await runtime.host('state')).value.state
    assert.ok(['interrupted', 'cancelled'].includes(final.nativeRequests.find(row => row.id === stage.id).status), JSON.stringify(final.nativeRequests))
    assert.equal(final.items.find(row => row.id === 'seed_2').body, original)
    assert.ok(!final.receipts.some(row => row.resultKey === 'stage:' + stage.id))
  }
})

test('原生成稿读取冻结的自定义语气、风格和启用规则，外部修改不改变已受理偏好', { timeout: 180000 }, async t => {
  const recipes = {}
  const runtime = await nativeRuntime(t, { recipes })
  const barrier = { at: 1, enteredPath: join(runtime.root, 'preferences-entered'), releasePath: join(runtime.root, 'preferences-release'), abortedPath: join(runtime.root, 'preferences-aborted'), settledPath: join(runtime.root, 'preferences-settled') }
  recipes.MD_STAGE_plan = { calls: [read, { name: 'media_desk_read', arguments: { kind: 'preferences' } }, { name: 'media_desk_submit_result', arguments: { stageId: '$stageId', result: JSON.stringify({ title: 'Frozen preferences', coverText: 'Frozen', facts: [], outline: [], cover: 'Paper', images: [], shots: [], sources: [] }) } }], barrier, reply: 'Frozen preferences read.' }
  recipes.MD_STAGE_article = { calls: [read, { name: 'media_desk_submit_result', arguments: { stageId: '$stageId', result: JSON.stringify({ article: 'Accepted frozen-preference script.', sources: [] }) } }], reply: 'Script submitted.' }
  await runtime.start()
  await runtime.host('notes/migrate', {})
  await runtime.host('settings', { imageCount: 0, shotCount: 0, voice: 'Original personal voice.' })
  const added = await runtime.host('ops', { ops: [{ op: 'add_style', name: 'Frozen custom style', tone: 'Original custom tone.' }, { op: 'add_skill', name: 'Enabled rule', rule: 'Original enabled rule.', status: 'active' }, { op: 'add_skill', name: 'Disabled rule', rule: 'Never use this disabled rule.', status: 'disabled' }] })
  assert.equal(added.status, 200, JSON.stringify(added.value))
  const style = added.value.state.styles.find(row => row.name === 'Frozen custom style')
  await runtime.host('ops', { ops: [{ op: 'set_style', id: style.id }] })
  await runtime.host('produce', { id: 'seed_2' })
  const deadline = Date.now() + 30000
  for (;;) {
    try { await readFile(barrier.enteredPath); break } catch (error) { if (error.code !== 'ENOENT' || Date.now() > deadline) throw error }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  const path = join(style.content.notesRoot, style.content.relativePath)
  await writeFile(path, (await readFile(path, 'utf8')).replace('Original custom tone.', 'New external tone.'))
  await runtime.host('settings', { voice: 'New personal voice.' })
  await writeFile(barrier.releasePath, 'release\n')
  const state = await waitState(runtime, state => state.items.find(row => row.id === 'seed_2').production?.status === 'done')
  const stage = state.nativeRequests.find(row => row.kind === 'plan')
  const results = (await runtime.events(stage.sessionId)).filter(row => row.type === 'tool/result')
  const text = JSON.stringify(results)
  assert.match(text, /Original personal voice/)
  assert.match(text, /Original custom tone/)
  assert.match(text, /Original enabled rule/)
  assert.doesNotMatch(text, /Never use this disabled rule/)
  assert.equal(state.styles.find(row => row.id === style.id).tone, 'New external tone.')
})
