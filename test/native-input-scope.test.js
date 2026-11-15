import assert from 'node:assert/strict'
import test from 'node:test'
import { NativeWork } from '../src/native-work.js'

const message = (text = 'Read the stage') => ({ id: 'input', source: { kind: 'user' }, content: [{ type: 'text', text }] })
function fixture(input = message()) {
  const state = { receipts: [] }
  const expected = []
  const native = new NativeWork({}, { read: async () => state, notes: { assertExpected: (_, versions) => expected.push(versions) } }, {
    requireAssociation: () => ({ id: 'association' }),
  })
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'user/message', data: input },
    { seq: 2, type: 'tool/call', data: { turn: 1, callId: 'read' } },
  ]
  native.events = async () => events
  return { native, events, expected, exec: { agent: { id: 'owned-agent' }, callId: 'read', signal: new AbortController().signal } }
}

test('当前原生输入无需插件登记台账即可授权，嵌套工具使用根调用身份', async () => {
  const { native, exec } = fixture()
  assert.equal((await native.actor({ ...exec, callId: 'nested', rootCallId: 'read' })).current.messageId, 'input')
})

test('新一轮没有用户输入时不能继承上一轮权限', async () => {
  const { native, events, exec } = fixture()
  events.push({ seq: 3, type: 'turn/start', data: { turn: 2 } }, { seq: 4, type: 'tool/call', data: { turn: 2, callId: 'current' } })
  await assert.rejects(native.actor({ ...exec, callId: 'current' }), { code: 'native/input-missing' })
  await assert.rejects(native.actor({ ...exec, callId: 'missing' }), { code: 'native/input-missing' })
})

test('当前只读指令限制写入，选区版本从当前输入核验', async () => {
  const { native, exec } = fixture(message('只读，不要修改'))
  await native.actor(exec)
  await assert.rejects(native.actor(exec, true), { code: 'native/read-only' })
  const selected = fixture(message('Edit [Media Desk selection: {"work":{"revision":3}}]'))
  await selected.native.actor(selected.exec, true)
  assert.deepEqual(selected.expected, [{ work: { revision: 3 } }])
})

test('旧阶段回执副本不参与重试，使用正式 Store 回执', async () => {
  const receipt = { id: 'receipt', resultKey: 'stage:accepted' }
  const native = new NativeWork({}, { read: async () => ({
    nativeRequests: [{ id: 'accepted', status: 'accepted', acceptance: { id: 'stale-copy' } }], receipts: [receipt],
  }) }, {})
  assert.deepEqual(await native.retry('accepted'), { acceptance: receipt })
})

test('等待进度仅查询活动阶段的现有关联，不唤醒已结束会话', async () => {
  const calls = []
  const native = new NativeWork({}, { owner: { signal: new AbortController().signal } }, {
    associations: [{ id: 'association', sessionId: 'session', status: 'bound' }],
    service: () => ({ state: async request => { calls.push(request); return { running: true, pendingInput: ['question'] } } }),
  })
  const state = { nativeRequests: [{ id: 'stage', workId: 'work', associationId: 'association', sessionId: 'session', turn: 1, status: 'running' }] }
  assert.deepEqual(await native.pendingInput(state, 'work'), ['question'])
  state.nativeRequests[0].status = 'accepted'
  assert.deepEqual(await native.pendingInput(state, 'work'), [])
  state.nativeRequests[0].status = 'cancelled'
  assert.deepEqual(await native.pendingInput(state, 'work'), [])
  state.nativeRequests[0].status = 'running'
  native.sessions.associations[0].active = false
  assert.deepEqual(await native.pendingInput(state, 'work'), [])
  assert.deepEqual(calls, [{ sessionId: 'session' }])
})
