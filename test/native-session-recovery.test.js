/** Model configuration and interrupted associations use the installed DSH Session services. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeRuntime } from './fixtures/native-runtime.js'

const missing = { provider: 'removed-provider', model: 'removed-model' }

test('重试拒绝不匹配的 home、工作区和缺失会话，保留待完成记录', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t)
  await runtime.start()
  const association = (await runtime.host('sessions/open', { workId: 'seed_2' })).value.association
  const file = join(runtime.home, 'media-desk', 'sessions.json')
  for (const [patch, code] of [
    [{ dshHome: runtime.wiki }, 'association/wrong-home'],
    [{ workspaceId: 'missing-workspace' }, 'association/workspace-changed'],
    [{ sessionId: 'session-missing-fixture' }, 'session/not-found'],
  ]) {
    await runtime.stop()
    const pending = JSON.stringify({ version: 1, associations: [{ ...association, status: 'pending', ...patch }] })
    await writeFile(file, pending)
    await runtime.start()
    const refused = await runtime.host('sessions/retry', { workId: 'seed_2' })
    assert.ok(refused.status >= 400, JSON.stringify(refused.value))
    assert.equal(refused.value.code, code, JSON.stringify(refused.value))
    assert.equal(await readFile(file, 'utf8'), pending)
    assert.deepEqual((await runtime.rpc('session/list', { _request: {} })).value.items.map(row => row.sessionId), [association.sessionId])
    await assert.rejects(readFile(runtime.telemetryPath), { code: 'ENOENT' })
  }
  const fresh = await runtime.host('chat/clear', { workId: 'seed_2' })
  assert.equal(fresh.status, 200, JSON.stringify(fresh.value))
  const records = (await runtime.host('sessions')).value.associations
  assert.equal(records.length, 2)
  assert.equal(records[0].sessionId, 'session-missing-fixture')
  assert.equal(records[0].active, false)
  assert.equal(records[1].status, 'bound')
})

test('旧助手模型配置被移除，新会话使用原生默认且保留图片设置', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t)
  const file = join(runtime.home, 'media-desk', 'settings.json')
  await mkdir(join(runtime.home, 'media-desk'), { recursive: true })
  const image = { source: 'http', baseUrl: 'https://images.example/v1', model: 'image-fixture', apiKey: 'private-fixture-key' }
  await writeFile(file, JSON.stringify({ assistant: missing, image, imageCount: 1 }))
  await runtime.start()
  const opened = await runtime.host('sessions/open', { workId: 'seed_2' })
  assert.equal(opened.status, 200, JSON.stringify(opened.value))
  assert.deepEqual(opened.value.association.model, { provider: 'media-desk-fixture', model: 'native-fixture' })
  const saved = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(Object.hasOwn(saved, 'assistant'), false)
  assert.deepEqual(saved.image, image)
  assert.equal(saved.imageCount, 1)
  assert.equal(Object.hasOwn((await runtime.host('settings')).value, 'assistant'), false)
  assert.ok(!(await runtime.events(opened.value.association.sessionId)).some(event => event.type === 'model/selection'))
  await assert.rejects(readFile(runtime.telemetryPath), { code: 'ENOENT' })
})

test('默认模型不可用仍可绑定会话，成稿失败结束进度并允许原生切换模型', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t)
  await runtime.start([{ id: 'agent-default-model', config: missing }])
  const opened = await runtime.host('sessions/open', { workId: 'seed_1' })
  assert.equal(opened.status, 200, JSON.stringify(opened.value))
  const association = opened.value.association
  assert.deepEqual(association.model, missing)
  const before = (await runtime.host('state')).value.state.items.find(row => row.id === 'seed_1')
  const failed = await runtime.host('produce', { id: 'seed_1', withImages: false })
  assert.equal(failed.status, 503, JSON.stringify(failed.value))
  assert.equal(failed.value.code, 'session/model-unavailable')
  const state = (await runtime.host('state')).value.state
  const work = state.items.find(row => row.id === 'seed_1')
  assert.equal(work.production.status, 'failed')
  assert.equal(work.production.stage, 'done')
  assert.equal(work.production.error, failed.value.error)
  assert.equal(state.nativeRequests.at(-1).status, 'failed')
  assert.equal(work.body, before.body)
  assert.deepEqual(work.media, before.media)
  assert.deepEqual(work.content, before.content)
  await assert.rejects(readFile(runtime.telemetryPath), { code: 'ENOENT' })
  assert.equal((await runtime.rpc('session/selectModel', { request: { sessionId: association.sessionId, provider: 'media-desk-fixture', model: 'native-second' } })).ok, true)
  const requestId = await runtime.prompt(association.sessionId, 'MD_FIXTURE_MODEL_RECOVERY: continue after selecting an available model')
  assert.equal((await runtime.turn(association.sessionId, requestId)).end.data.reason.kind, 'completed')
  await runtime.stop()
  await runtime.start()
  const reopened = await runtime.host('sessions/open', { workId: 'seed_1' })
  assert.equal(reopened.status, 200, JSON.stringify(reopened.value))
  assert.equal(reopened.value.association.sessionId, association.sessionId)
  assert.equal(reopened.value.association.model.model, 'native-second')
})

test('明确重试待完成关联复用实际会话，保留原生模型、标题、历史和作品', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t)
  await runtime.start()
  const association = (await runtime.host('sessions/open', { workId: 'seed_1' })).value.association
  assert.equal((await runtime.rpc('session/selectModel', { request: { sessionId: association.sessionId, provider: 'media-desk-fixture', model: 'native-second' } })).ok, true)
  assert.equal((await runtime.rpc('session/rename', { request: { sessionId: association.sessionId, title: 'Retained native title' } })).ok, true)
  const requestId = await runtime.prompt(association.sessionId, 'MD_FIXTURE_RETAINED_HISTORY: keep this ordinary native history')
  await runtime.turn(association.sessionId, requestId)
  const telemetry = await readFile(runtime.telemetryPath, 'utf8')
  const before = (await runtime.host('state')).value.state.items.find(row => row.id === 'seed_1')
  await runtime.stop()
  const file = join(runtime.home, 'media-desk', 'sessions.json')
  const saved = JSON.parse(await readFile(file, 'utf8'))
  saved.associations[0] = { ...saved.associations[0], status: 'pending', model: missing, error: { code: 'session/model-unavailable', message: 'Select an available model before sending a message.' } }
  await writeFile(file, JSON.stringify(saved))
  await runtime.start()
  // Resuming a persisted Session appends DSH's end-seed marker without changing conversation history.
  const conversation = events => events.filter(event => event.type !== 'session/end-seed')
  const events = conversation(await runtime.events(association.sessionId))
  const refused = await runtime.host('sessions/open', { workId: 'seed_1' })
  assert.equal(refused.status, 409)
  assert.equal(refused.value.code, 'association/pending')
  assert.match(refused.value.error, /Select an available model/)
  const retried = await Promise.all([runtime.host('sessions/retry', { workId: 'seed_1' }), runtime.host('sessions/retry', { workId: 'seed_1' })])
  for (const result of retried) {
    assert.equal(result.status, 200, JSON.stringify(result.value))
    assert.equal(result.value.association.id, association.id)
    assert.equal(result.value.association.sessionId, association.sessionId)
    assert.equal(result.value.association.status, 'bound')
    assert.equal(result.value.association.model.model, 'native-second')
    assert.equal(Object.hasOwn(result.value.association, 'error'), false)
  }
  assert.equal((await runtime.host('sessions')).value.associations.length, 1)
  assert.deepEqual(conversation(await runtime.events(association.sessionId)), events)
  assert.equal(await readFile(runtime.telemetryPath, 'utf8'), telemetry)
  assert.deepEqual((await runtime.host('state')).value.state.items.find(row => row.id === 'seed_1'), before)
  const listed = await runtime.rpc('session/list', { _request: {} })
  assert.equal(listed.value.items.find(row => row.sessionId === association.sessionId).projections.values.title, 'Retained native title')
  await runtime.stop()
  await runtime.start()
  assert.equal((await runtime.host('sessions/open', { workId: 'seed_1' })).value.association.sessionId, association.sessionId)
})

test('无法确认实际会话的重试保留关联，新对话显式建立另一条关联', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t)
  await runtime.start()
  const association = (await runtime.host('sessions/open', { workId: 'seed_2' })).value.association
  await runtime.stop()
  const file = join(runtime.home, 'media-desk', 'sessions.json')
  const saved = JSON.parse(await readFile(file, 'utf8'))
  delete saved.associations[0].sessionId
  saved.associations[0].status = 'pending'
  const pending = JSON.stringify(saved)
  await writeFile(file, pending)
  await runtime.start()
  const refused = await runtime.host('sessions/retry', { workId: 'seed_2' })
  assert.equal(refused.status, 409, JSON.stringify(refused.value))
  assert.equal(refused.value.code, 'association/pending')
  assert.equal(await readFile(file, 'utf8'), pending)
  assert.equal((await runtime.rpc('session/list', { _request: {} })).value.items.length, 1)
  const fresh = await runtime.host('chat/clear', { workId: 'seed_2' })
  assert.equal(fresh.status, 200, JSON.stringify(fresh.value))
  assert.notEqual(fresh.value.association.sessionId, association.sessionId)
  const records = (await runtime.host('sessions')).value.associations
  assert.equal(records.length, 2)
  assert.equal(records[0].status, 'pending')
  assert.equal(records[0].active, false)
  await assert.rejects(readFile(runtime.telemetryPath), { code: 'ENOENT' })
})
