import assert from 'node:assert/strict'
import test from 'node:test'
import { Producer } from '../src/produce.js'
import { NativeWork } from '../src/native-work.js'

test('策划一次报告缺失封面、数量和条目错误，提示使用冻结设置重试', () => {
  const producer = new Producer({})
  assert.throws(() => producer.validatePlan({ title: 'Title', coverText: 'Cover', facts: Array(9).fill('fact'), outline: [], images: [null], shots: [] }, { imageCount: 2, shotCount: 3, imageReady: false }), error => {
    for (const expected of ['cover: required nonempty string', 'facts: at most 8', 'images: exactly 2 entries required; received 1', 'shots: exactly 3 entries required; received 0', 'each entry requires', 'same stageId', 'frozen stage.settings']) assert.ok(error.message.includes(expected), error.message)
    assert.equal(error.code, 'native/plan-invalid')
    return true
  })
  producer.validatePlan({ title: 'Title', coverText: 'Cover', cover: 'Paper', facts: [], outline: [], images: [], shots: [] }, { imageCount: 0, shotCount: 0, imageReady: false })
})

test('错用关联编号仍拒绝越权，同时提供当前作品与可执行的读取参数', async () => {
  const native = new NativeWork({}, {}, {})
  native.actor = async () => ({ association: { workId: 'owned-work' }, state: {} })
  await assert.rejects(native.read({}, { kind: 'work', id: 'association-id' }), error => {
    assert.equal(error.code, 'native/foreign-object')
    assert.match(error.message, /owned-work/)
    assert.match(error.message, /\{"kind":"work"\}/)
    assert.match(error.message, /omit id/)
    return true
  })
})

test('真实原生轮次收到策划纠错后以同一阶段重试并成功验收', { timeout: 180000 }, async t => {
  const { nativeRuntime } = await import('./fixtures/native-runtime.js')
  const plan = { title: 'Title', coverText: 'Cover', cover: 'Paper', facts: [], outline: [], images: [], shots: [], sources: [] }
  const submit = result => ({ name: 'media_desk_submit_result', arguments: { stageId: '$stageId', result: JSON.stringify(result) } })
  const runtime = await nativeRuntime(t, { recipes: {
    MD_STAGE_plan: { calls: [{ name: 'media_desk_read', arguments: { kind: 'work' } }, submit({ ...plan, cover: {}, images: [{ prompt: 'Paper' }] }), submit(plan)], reply: 'Corrected plan submitted.' },
    MD_STAGE_article: { calls: [{ name: 'media_desk_read', arguments: { kind: 'work' } }, submit({ article: 'Accepted after correcting the plan.', sources: [] })], reply: 'Article submitted.' },
  } })
  await runtime.start()
  await runtime.host('notes/migrate', {})
  await runtime.host('settings', { imageCount: 0, shotCount: 0 })
  const admitted = await runtime.host('produce', { id: 'seed_2' })
  assert.equal(admitted.status, 200)
  const deadline = Date.now() + 60000
  let state
  do {
    state = (await runtime.host('state')).value.state
    if (state.items.find(row => row.id === 'seed_2').production.status === 'done') break
    assert.ok(Date.now() < deadline, JSON.stringify(state.nativeRequests))
    await new Promise(resolve => setTimeout(resolve, 25))
  } while (true)
  const stage = state.nativeRequests.find(row => row.kind === 'plan')
  assert.equal(stage.status, 'accepted')
  assert.equal(state.receipts.filter(row => row.resultKey === 'stage:' + stage.id).length, 1)
  const events = await runtime.events(stage.sessionId)
  const errors = events.filter(row => row.type === 'tool/result' && row.data.message.isError)
  assert.equal(errors.length, 1)
  const feedback = errors[0].data.message.content[0].text
  assert.match(feedback, /cover: required nonempty string/)
  assert.match(feedback, /images: exactly 0 entries required; received 1/)
})
