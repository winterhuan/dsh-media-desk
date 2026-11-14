/** Completion commits and job cleanup belong to the captured production attempt. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Notes } from '../src/notes.js'
import { Store } from '../src/store.js'
import { Producer } from '../src/produce.js'
import { NativeWork } from '../src/native-work.js'
import { WriteOwner } from '../src/write-owner.js'

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function ownedFixture(t, { article = false } = {}) {
  const allocated = await mkdtemp(join(tmpdir(), 'media-desk-attempt-'))
  const root = await realpath(allocated)
  const wiki = join(root, 'wiki')
  await mkdir(wiki)
  const owner = new WriteOwner(join(root, 'data'), wiki)
  let producer
  t.after(async () => { await producer?.close(); await owner.drain(); await owner.release(); await rm(root, { recursive: true, force: true }) })
  await owner.acquire()
  const store = new Store(owner.dataRoot, owner)
  store.notes = new Notes(owner)
  await store.notes.init()
  const workId = 'owned-attempt-work'
  const settings = { imageCount: 0, shotCount: 0 }
  const dispatched = []
  const association = { id: randomUUID(), sessionId: randomUUID() }
  const controller = {
    resolveAgent: async () => ({ agent: { model: { current: () => ({ provider: 'fixture', model: 'fixture' }) } } }),
    prompt: async request => { dispatched.push(request); return { accepted: true } },
  }
  const sessions = { open: async () => association, service: name => { assert.equal(name, 'sessionController'); return controller } }
  const ctx = { mediaDesk: { settings: { read: async () => settings } } }
  const native = new NativeWork(ctx, store, sessions)
  producer = new Producer({ store, settings: ctx.mediaDesk.settings, native, ready: () => false })
  ctx.mediaDesk.producer = producer
  const stage = (title = 'Accepted plan') => ({ id: randomUUID(), workId, createdAt: '2026-11-01T12:00:00Z', kind: 'plan', status: 'accepted',
    candidate: { title, coverText: 'Plan', cover: 'Paper', facts: [], outline: [], images: [], shots: [], sources: [] },
    data: { settings: { ...settings, imageReady: false } } })
  const first = stage()
  const acceptedArticle = { id: randomUUID(), workId, kind: 'article', status: 'accepted', data: { planId: first.id } }
  await store.mutate('Prepare the accepted attempt', draft => {
    draft.items.push({ id: workId, title: 'Existing work', body: 'The accepted article.', createdAt: first.createdAt, drafts: {} })
    producer.acceptPlan(draft, first)
    draft.nativeRequests = [first]
    if (article) {
      draft.nativeRequests.push(acceptedArticle)
      Object.assign(draft.items.find(row => row.id === workId).production, { status: 'done', current: true, article: 'The accepted article.', nativeStageId: acceptedArticle.id })
    }
  }, { undoable: false, resultKey: 'stage:' + first.id, payloadHash: 'a'.repeat(64) })
  if (article) await store.mutate('Keep the accepted article receipt', () => ({}), { undoable: false, resultKey: 'stage:' + acceptedArticle.id, payloadHash: 'c'.repeat(64) })
  await mkdir(join(store.root, 'native-settings'), { recursive: true })
  await writeFile(join(store.root, 'native-settings', first.id + '.json'), JSON.stringify(settings))
  const accept = next => store.mutate('Accept the successor plan', draft => {
    producer.acceptPlan(draft, next)
    draft.nativeRequests.push(next)
  }, { undoable: false, resultKey: 'stage:' + next.id, payloadHash: 'b'.repeat(64) })
  return { store, producer, native, controller, workId, first, acceptedArticle, stage, accept, dispatched }
}

test('旧尝试完成与新策划受理在真实 Store 队列重叠时保留新任务和后续派发', async t => {
  const allocated = await mkdtemp(join(tmpdir(), 'media-desk-completion-'))
  let producer, finishing, nextPlan, release
  t.after(async () => {
    release?.()
    await Promise.allSettled([finishing, nextPlan])
    await producer?.close()
    await rm(allocated, { recursive: true, force: true })
  })
  const root = await realpath(allocated)
  const wikiRoot = join(root, 'wiki')
  const notesRoot = join(wikiRoot, 'notes')
  const dataRoot = join(root, 'data')
  await mkdir(notesRoot, { recursive: true })
  const store = new Store(dataRoot)
  store.notes = new Notes({ wikiRoot, notesRoot, notesRoots: [notesRoot], selectedNotesRoot: notesRoot, dataRoot })
  const dispatched = []
  producer = new Producer({ store, settings: {}, ready: () => false, native: {
    productionSettings: async id => { dispatched.push({ settings: id }); return { imageCount: 0, shotCount: 0 } },
    request: async (kind, id) => { dispatched.push({ kind, id }); return { id: randomUUID() } },
  } })
  const oldPlanId = randomUUID()
  const articleId = randomUUID()
  const workId = 'completion-work'
  const candidate = { title: 'Accepted plan', coverText: 'Plan', cover: 'Paper', facts: [], outline: [], images: [], shots: [], sources: [] }
  const stage = { id: oldPlanId, workId, createdAt: '2026-11-01T12:00:00Z', kind: 'plan', status: 'accepted', candidate,
    data: { settings: { imageCount: 0, shotCount: 0, imageReady: false } } }
  await store.mutate('Accept the existing completed article', draft => {
    draft.items.push({ id: workId, title: 'Existing article', body: 'The accepted article.', createdAt: stage.createdAt, drafts: {} })
    producer.acceptPlan(draft, stage)
    Object.assign(draft.items.find(row => row.id === workId).production, { status: 'done', current: true, article: 'The accepted article.', nativeStageId: articleId })
    draft.nativeRequests = [stage, { id: articleId, workId, kind: 'article', status: 'accepted', data: { planId: oldPlanId } }]
  }, { undoable: false, resultKey: 'stage:' + articleId, payloadHash: 'a'.repeat(64) })
  const successor = { ...stage, id: randomUUID(), candidate: { ...candidate, title: 'The successor plan' }, data: { settings: { ...stage.data.settings, imageReady: true } } }
  const job = { attemptId: successor.id, controller: new AbortController() }
  let entered, settled = false
  const admitted = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  finishing = producer.complete(workId).then(() => { settled = true })
  nextPlan = store.mutate('Accept the successor plan', async draft => {
    producer.acceptPlan(draft, successor)
    draft.nativeRequests.push(successor)
    producer.jobs.set(workId, job)
    entered()
    await gate
  }, { undoable: false, resultKey: 'stage:' + successor.id, payloadHash: 'b'.repeat(64) })
  await admitted
  assert.equal(settled, false, 'The older completion remains pending while the successor holds the Store queue')
  assert.equal(JSON.parse(await readFile(store.file, 'utf8')).items.find(row => row.id === workId).production.attemptId, oldPlanId)
  release()
  await Promise.all([finishing, nextPlan])
  const current = (await store.read()).items.find(row => row.id === workId).production
  assert.equal(current.attemptId, successor.id)
  assert.equal(current.status, 'running')
  assert.equal(current.cover.status, 'pending')
  assert.equal(producer.jobs.get(workId), job)
  await producer.nativeAccepted(successor)
  assert.deepEqual(dispatched, [{ settings: successor.id }, { kind: 'article', id: workId }])
  assert.equal(producer.jobs.get(workId).attemptId, successor.id)
})

test('旧策划读取设置期间被替换，不派发旧脚本、不覆盖新任务且新策划仍可运行', async t => {
  const entered = deferred(), gate = deferred()
  let pending
  t.after(async () => { gate.resolve(); await Promise.allSettled([pending]) })
  const { store, producer, native, workId, first, stage, accept, dispatched } = await ownedFixture(t)
  const readSettings = native.productionSettings.bind(native)
  native.productionSettings = async id => {
    if (id === first.id) { entered.resolve(); await gate.promise }
    return readSettings(id)
  }
  pending = producer.nativeAccepted(first)
  await entered.promise
  await producer.invalidate(workId)
  const successor = stage('The successor plan')
  await accept(successor)
  await writeFile(join(store.root, 'native-settings', successor.id + '.json'), JSON.stringify({ imageCount: 0, shotCount: 0 }))
  const job = { attemptId: successor.id, controller: new AbortController() }
  producer.jobs.set(workId, job)
  gate.resolve()
  await pending
  const state = await store.read()
  assert.equal(state.items.find(row => row.id === workId).production.status, 'running')
  assert.ok(!state.nativeRequests.some(row => row.kind === 'article' && row.data.planId === first.id))
  assert.deepEqual(dispatched, [])
  assert.equal(producer.jobs.get(workId), job)
  await producer.nativeAccepted(successor)
  assert.equal(dispatched.length, 1)
  assert.match(dispatched[0].content[0].text, /\(article\)/)
  assert.equal((await store.read()).nativeRequests.find(row => row.kind === 'article').data.planId, successor.id)
  assert.equal(producer.jobs.get(workId).attemptId, successor.id)
})

test('脚本在真实写队列受理时核对当前策划，拒绝已排在新策划后的旧请求', async t => {
  const entered = deferred(), gate = deferred()
  let accepting, pending
  t.after(async () => { gate.resolve(); await Promise.allSettled([accepting, pending]) })
  const { store, producer, native, workId, first, stage, dispatched } = await ownedFixture(t)
  const successor = stage('The queued successor plan')
  accepting = store.mutate('Accept the queued successor plan', async draft => {
    draft.nativeRequests.find(row => row.id === first.id).status = 'cancelled'
    producer.acceptPlan(draft, successor)
    draft.nativeRequests.push(successor)
    entered.resolve()
    await gate.promise
  }, { undoable: false, resultKey: 'stage:' + successor.id, payloadHash: 'b'.repeat(64) })
  await entered.promise
  pending = native.request('article', workId, 'Write the owned script', { data: { planId: first.id } })
  const refused = assert.rejects(pending, error => error.code === 'native/plan-stale')
  gate.resolve()
  await Promise.all([accepting, refused])
  const state = await store.read()
  assert.equal(state.items.find(row => row.id === workId).production.attemptId, successor.id)
  assert.equal(state.items.find(row => row.id === workId).production.status, 'running')
  assert.equal(state.nativeRequests.length, 2)
  assert.deepEqual(dispatched, [])
})

test('已受理脚本等待 Session 解析后失去策划归属，不派发旧输入', async t => {
  const entered = deferred(), gate = deferred()
  let pending
  t.after(async () => { gate.resolve(); await Promise.allSettled([pending]) })
  const { store, producer, native, controller, workId, first, stage, accept, dispatched } = await ownedFixture(t)
  const resolveAgent = controller.resolveAgent
  controller.resolveAgent = async () => { entered.resolve(); await gate.promise; return resolveAgent() }
  pending = native.request('article', workId, 'Write the owned script', { data: { planId: first.id } })
  const refused = assert.rejects(pending, error => error.code === 'native/plan-stale')
  await entered.promise
  const successor = stage('The successor during Session resolution')
  await accept(successor)
  const job = { attemptId: successor.id, controller: new AbortController() }
  producer.jobs.set(workId, job)
  gate.resolve()
  await refused
  const state = await store.read()
  assert.equal(state.items.find(row => row.id === workId).production.status, 'running')
  assert.equal(state.nativeRequests.find(row => row.kind === 'article').status, 'failed')
  assert.equal(producer.jobs.get(workId), job)
  assert.deepEqual(dispatched, [])
})

test('新策划仅受理尚未接受时，已完成旧脚本和通用完成核对不提前结束新尝试', async t => {
  const { store, producer, native, workId, acceptedArticle } = await ownedFixture(t, { article: true })
  const successor = await native.request('plan', workId, 'Prepare another accepted plan', { producer: true })
  const job = { attemptId: successor.id, controller: new AbortController() }
  producer.jobs.set(workId, job)
  await producer.nativeAccepted(acceptedArticle)
  await producer.complete(workId)
  const state = await store.read()
  const production = state.items.find(row => row.id === workId).production
  assert.equal(state.nativeRequests.find(row => row.id === successor.id).status, 'pending')
  assert.equal(production.attemptId, successor.id)
  assert.equal(production.status, 'running')
  assert.equal(production.stage, 'brief')
  assert.equal(producer.jobs.get(workId), job)
})
