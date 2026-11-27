import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { applyOps } from '../src/ops.js'
import { computeInsights } from '../src/learn.js'
import { hostRuntime } from './fixtures/host-runtime.js'

async function openDesk(t) {
  const home = await mkdtemp(join(tmpdir(), 'media-desk-read-'))
  const prior = process.env.DSH_HOME
  process.env.DSH_HOME = home
  let runtime
  t.after(async () => {
    try { await runtime?.close() } finally {
      if (prior === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prior
      await rm(home, { recursive: true, force: true })
    }
  })
  runtime = await hostRuntime()
  async function get(path) {
    let result
    await runtime.handler({ method: 'GET', url: '/media-desk/' + path, headers: {} }, {
      setHeader() {},
      end(body) { assert.equal(this.statusCode, 200, body); result = JSON.parse(body) },
    })
    return result
  }
  return { desk: runtime.ctx.get('mediaDesk'), get }
}

test('状态响应在同一次读取中附带复盘汇总，并跟随指标和账号更新', async t => {
  const { desk, get } = await openDesk(t)
  await get('state') // Complete initial sample localization before measuring reads.
  const observer = t.mock.method(desk.store, 'read')
  const before = (await get('state')).state
  assert.equal(observer.mock.callCount(), 1)
  observer.mock.restore()
  assert.deepEqual(before.insights, computeInsights(before))
  await desk.store.mutate('Record metrics', draft => {
    draft.metrics = [{ itemId: 'seed_2', platform: 'fixture', date: '2026-11-25T23:30:00Z', views: 120, likes: 12 }]
    draft.accounts = [{ followers: 45 }]
  })
  const after = (await get('state')).state
  assert.deepEqual(after.insights, await get('insights'))
  assert.equal(after.insights.views, 120)
  assert.equal(after.insights.followers, 45)
  assert.equal(after.insights.engagementRate, 0.1)
  assert.equal((await desk.store.read()).insights, undefined)
})

test('复盘等待并发编辑结算，嵌套读取仍使用当前草稿', async t => {
  const { desk, get } = await openDesk(t)
  const { store } = desk
  const added = await store.mutate('Create', draft => applyOps(draft, [{ op: 'add_item', title: 'Held edit' }]))
  const id = added.receipts[0].target
  const before = (await get('insights')).published
  for (const commit of [false, true]) {
    const entered = Promise.withResolvers()
    const release = Promise.withResolvers()
    const edit = store.mutate('Publish', async draft => {
      draft.items.find(item => item.id === id).status = 'published'
      assert.equal((await store.read()).items.find(item => item.id === id).status, 'published')
      entered.resolve()
      await release.promise
      if (!commit) throw new Error('Discard edit')
    })
    const outcome = commit ? edit : assert.rejects(edit, /Discard edit/)
    await Promise.race([entered.promise, outcome])
    const reading = Promise.withResolvers()
    const read = store.read.bind(store)
    const observer = t.mock.method(store, 'read', () => { reading.resolve(); return read() })
    const insights = get('insights')
    try { await Promise.race([reading.promise, insights]) } finally { release.resolve(); observer.mock.restore() }
    await outcome
    assert.equal((await insights).published, before + Number(commit))
  }
})

test('单篇进度只读取目标正文，外部编辑的版本与全局读取一致', async t => {
  const { desk, get } = await openDesk(t)
  const { store } = desk
  const ops = Array.from({ length: 100 }, (_, i) => ({ op: 'add_item', title: 'Read ' + i, body: 'original' }))
  const added = await store.mutate('Create works', draft => applyOps(draft, ops))
  const id = added.receipts[0].target
  const item = (await store.read()).items.find(row => row.id === id)
  await store.owner.drain()
  const observer = t.mock.method(store.notes, 'readBytes')
  const target = await get('production?id=' + id)
  assert.deepEqual(target.item, item)
  const primaryReads = observer.mock.calls.map(call => call.arguments[0].relativePath).filter(path => path.startsWith('works/'))
  assert.deepEqual(primaryReads, [item.content.relativePath])
  observer.mock.restore()
  const path = join(item.content.notesRoot, item.content.relativePath)
  await writeFile(path, (await readFile(path, 'utf8')).replace(/original$/, 'edited'))
  const changed = (await get('production?id=' + id)).item
  assert.equal(changed.body, 'edited')
  assert.equal(changed.content.revision, item.content.revision + 1)
  assert.deepEqual((await store.read()).items.find(row => row.id === id).content, changed.content)
})

test('版本接口不读取作品，新增文风字段经 Notes 保存和重新读取保留', async t => {
  const { desk, get } = await openDesk(t)
  const info = { current: '2.7.0-winter.15', latest: '2.7.2-winter.1', updateAvailable: true }
  t.mock.method(desk.version, 'read', async () => info)
  const reader = t.mock.method(desk.store, 'read')
  assert.deepEqual(await get('version'), info)
  assert.equal(reader.mock.callCount(), 0)
  reader.mock.restore()
  const fields = { logic: 'Start from evidence', story: 'Lead with one scene', flow: 'Connect cause and effect' }
  await desk.store.mutate('Save upstream style fields', draft => applyOps(draft, [{ op: 'add_style', name: 'Expanded style', ...fields }]))
  const style = (await desk.store.read()).styles.find(row => row.name === 'Expanded style')
  for (const [key, value] of Object.entries(fields)) assert.equal(style[key], value)
  const saved = await readFile(join(style.content.notesRoot, style.content.relativePath), 'utf8')
  for (const value of Object.values(fields)) assert.ok(saved.includes(value))
})
