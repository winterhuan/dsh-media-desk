/** Media publication and export operate on the actual owned Store and Notes files. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WriteOwner } from '../src/write-owner.js'
import { Store } from '../src/store.js'
import { Notes } from '../src/notes.js'
import { MediaFiles } from '../src/media-files.js'
import { Producer } from '../src/produce.js'
import { saveProduction } from '../src/export.js'

const PNG = Buffer.from('89504e470d0a1a0a000000000000ff80', 'hex')
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'media-desk-binary-'))
  const wiki = join(root, 'wiki')
  await mkdir(wiki)
  const owner = new WriteOwner(join(root, 'data'), wiki)
  t.after(async () => { await owner.drain(); await owner.release(); await rm(root, { recursive: true, force: true }) })
  await owner.acquire()
  const store = new Store(owner.dataRoot, owner)
  store.notes = new Notes(owner)
  await store.notes.init()
  await store.read()
  await store.migrateNotes()
  await store.mutate('Prepare an accepted plan', state => {
    state.items.find(row => row.id === 'seed_2').production = { attemptId: 'attempt-one', title: 'A snapshot', article: '## Evidence\n\nAccepted text.', current: true, status: 'running', coverText: 'Cover', cover: { renderId: 'render-one', status: 'running' }, images: [], shots: [], sources: [{ title: 'Evidence', reference: 'raw/source.md', date: '2026-11-12', limitations: 'Observed only' }] }
  }, { undoable: false })
  return { root, wiki, store, media: new MediaFiles(store) }
}

test('图片以 Notes 单一主文件接受，重复保存返回同一回执且能读取非 UTF-8 字节', async t => {
  const { store, media } = await fixture(t)
  const saved = await media.save('seed_2', 'cover', { buffer: PNG, ext: '.png' }, { attemptId: 'attempt-one', renderId: 'render-one' })
  const work = (await store.read()).items.find(row => row.id === 'seed_2')
  assert.equal(work.production.cover.src, 'media-desk/media/' + saved.id)
  assert.deepEqual(await readFile(await media.resolve(saved.id)), PNG)
  const repeated = await media.retry(saved.id)
  assert.equal(repeated.acceptance.resultKey, 'media:' + saved.id)
  assert.equal((await store.read()).receipts.filter(row => row.resultKey === 'media:' + saved.id).length, 1)
  await assert.rejects(media.save('seed_2', 'cover', { buffer: PNG, ext: '.png' }, { attemptId: 'retired', renderId: 'render-one' }), /no longer current/)
})

for (const boundary of ['journal', 'candidate']) test('已接受图片的私有 ' + boundary + ' 清理失败保留成功状态和同一回执', async t => {
  const { store } = await fixture(t)
  const errors = []
  const media = new MediaFiles(store, { onError: error => errors.push(error) })
  let requests = 0, id, blocked, retained, originalReceipt
  const producer = new Producer({ store, settings: {}, native: {}, generate: async () => { requests++; return { buffer: PNG, ext: '.png' } } })
  producer.media = media
  t.after(() => producer.close())
  const mutate = store.mutate.bind(store)
  store.mutate = async (label, change, options) => {
    const result = await mutate(label, change, options)
    if (!id && options?.resultKey?.startsWith('media:')) {
      id = options.resultKey.slice('media:'.length)
      originalReceipt = JSON.parse(await readFile(store.file, 'utf8')).receipts.find(row => row.resultKey === options.resultKey)
      blocked = join(media.root, id, boundary === 'journal' ? 'pending.json' : 'candidate.png')
      retained = blocked + '.retained'
      await rename(blocked, retained)
      await mkdir(blocked)
    }
    return result
  }
  await producer.renderAsset('seed_2', 'cover', { image: {} }, undefined, 'attempt-one')
  const disk = JSON.parse(await readFile(store.file, 'utf8'))
  assert.equal(disk.items.find(row => row.id === 'seed_2').production.cover.status, 'done')
  assert.deepEqual(disk.receipts.find(row => row.resultKey === 'media:' + id), originalReceipt)
  assert.equal(errors.length, 1)
  assert.ok(errors[0].code)
  await rm(blocked, { recursive: true })
  await rename(retained, blocked)
  assert.deepEqual(await readFile(await media.resolve(id)), PNG)
  await store.mutate('Repair an earlier failed accepted image', draft => {
    Object.assign(draft.items.find(row => row.id === 'seed_2').production.cover, { status: 'failed', error: 'Earlier cleanup failure', pendingId: id })
  }, { undoable: false })
  const repeated = await media.retry(id)
  const repaired = (await store.read()).items.find(row => row.id === 'seed_2').production.cover
  assert.equal(repaired.status, 'done')
  assert.equal(repaired.pendingId, undefined)
  assert.equal(repaired.error, null)
  assert.equal(repeated.acceptance.id, originalReceipt.id)
  assert.deepEqual(JSON.parse(await readFile(store.file, 'utf8')).receipts.find(row => row.resultKey === 'media:' + id), originalReceipt)
  assert.deepEqual(await media.saves(), [])
  assert.equal((await store.read()).receipts.filter(row => row.resultKey === 'media:' + id).length, 1)
  assert.equal(requests, 1)
})

test('媒体回执后的 Notes 索引 EIO 保留图片成功状态并报告原始错误', async t => {
  const { store } = await fixture(t)
  const errors = []
  const media = new MediaFiles(store, { onError: error => errors.push(error) })
  let requests = 0, receipt
  const producer = new Producer({ store, settings: {}, native: {}, generate: async () => { requests++; return { buffer: PNG, ext: '.png' } } })
  producer.media = media
  t.after(() => producer.close())
  const syncIndex = store.notes.syncIndex.bind(store.notes)
  store.notes.syncIndex = async state => {
    const accepted = store.state.receipts?.find(row => row.resultKey.startsWith('media:'))
    if (accepted && !receipt) {
      receipt = JSON.parse(await readFile(store.file, 'utf8')).receipts.find(row => row.id === accepted.id)
      throw Object.assign(new Error('Injected Notes index EIO after media acceptance'), { code: 'EIO' })
    }
    return syncIndex(state)
  }
  await producer.renderAsset('seed_2', 'cover', { image: {} }, undefined, 'attempt-one')
  const state = await store.read()
  const cover = state.items.find(row => row.id === 'seed_2').production.cover
  assert.equal(cover.status, 'done')
  assert.equal(cover.error, null)
  assert.equal(cover.pendingId, undefined)
  assert.deepEqual(await readFile(await media.resolve(cover.media.id)), PNG)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].code, 'EIO')
  assert.deepEqual(JSON.parse(await readFile(store.file, 'utf8')).receipts.find(row => row.id === receipt.id), receipt)
  assert.equal(state.receipts.filter(row => row.resultKey === receipt.resultKey).length, 1)
  assert.equal((await media.retry(cover.media.id)).acceptance.id, receipt.id)
  assert.deepEqual(await media.saves(), [])
  assert.equal(requests, 1)
})

test('媒体目录符号链接不发布到 Wiki 外，修复后只重试原候选并拒绝取消后的候选', async t => {
  const { root, wiki, store, media } = await fixture(t)
  const outside = join(root, 'outside')
  await mkdir(outside)
  const assets = join(wiki, 'notes', 'assets')
  await symlink(outside, assets)
  let pendingId
  await assert.rejects(media.save('seed_2', 'cover', { buffer: PNG, ext: '.png' }, { attemptId: 'attempt-one', renderId: 'render-one' }), error => { pendingId = error.mediaPendingId; return Boolean(pendingId) })
  await unlink(assets)
  const accepted = await media.retry(pendingId)
  assert.equal(accepted.id, pendingId)
  assert.deepEqual(await readFile(await media.resolve(pendingId)), PNG)
  const backup = await store.migration.backup()
  assert.equal(await store.migration.verify(backup), true)
  assert.ok(backup.entries.some(entry => entry.kind === 'media'))
})

test('每次导出创建独立目录，文字、来源和注册媒体指纹一起保存，部分导出不混入旧图片', async t => {
  const { root, store, media } = await fixture(t)
  await media.save('seed_2', 'cover', { buffer: PNG, ext: '.png' }, { attemptId: 'attempt-one', renderId: 'render-one' })
  const work = (await store.read()).items.find(row => row.id === 'seed_2')
  const options = { filesDir: store.filesDir, exportDir: join(root, 'export'), resolveMedia: id => media.resolve(id), snapshot: { workId: work.id, content: work.content } }
  const first = await saveProduction(work.production, options)
  const second = await saveProduction({ ...work.production, savedPath: first.path, cover: { status: 'failed' } }, options)
  assert.notEqual(first.path, second.path)
  const manifest = JSON.parse(await readFile(join(first.path, 'manifest.json'), 'utf8'))
  assert.equal(manifest.media[0].sha256, work.production.cover.media.sha256)
  assert.match(await readFile(join(first.path, 'sources.md'), 'utf8'), /raw\/source.md/)
  const script = first.files.find(file => /脚本.md|script.md/.test(file))
  assert.doesNotMatch(await readFile(join(first.path, script), 'utf8'), /raw\/source.md/)
  assert.equal(second.missing.length, 1)
  assert.equal(second.files.some(file => /封面原图|cover-original/.test(file)), false)
})

test('未发布媒体候选可被发现，取消后重试拒绝接受；二进制回滚保留后续媒体证据', async t => {
  const { root, wiki, store, media } = await fixture(t)
  const outside = join(root, 'outside')
  await mkdir(outside)
  await symlink(outside, join(wiki, 'notes', 'assets'))
  let id
  await assert.rejects(media.save('seed_2', 'cover', { buffer: PNG, ext: '.png' }, { attemptId: 'attempt-one', renderId: 'render-one' }), error => { id = error.mediaPendingId; return Boolean(id) })
  assert.equal((await media.saves())[0].id, id)
  await store.mutate('Cancel the admitted attempt', state => { state.items.find(row => row.id === 'seed_2').production.status = 'cancelled' }, { undoable: false })
  await unlink(join(wiki, 'notes', 'assets'))
  await assert.rejects(media.retry(id), /cannot accept/)
  assert.ok(!(await store.read()).receipts.some(row => row.resultKey === 'media:' + id))
  await store.mutate('Prepare another attempt', state => { state.items.find(row => row.id === 'seed_2').production.status = 'running' }, { undoable: false })
  const accepted = await media.retry(id)
  const reference = (await store.read()).mediaReferences[id]
  const backup = await store.migration.backup()
  await writeFile(join(reference.notesRoot, reference.relativePath), Buffer.from('later media bytes'))
  const rolled = await store.migration.rollback(backup.id)
  assert.deepEqual(await readFile(join(reference.notesRoot, reference.relativePath)), PNG)
  assert.ok(rolled.retainedId)
  const retained = await store.migration.load(rolled.retainedId)
  assert.ok(retained.entries.some(entry => entry.kind === 'media' && entry.sha256 !== reference.sha256))
  assert.equal(accepted.id, id)
  const restored = (await store.read()).items.find(row => row.id === 'seed_2')
  await store.mutate('Keep historical accepted media available', state => { state.items.find(row => row.id === 'seed_2').production.cover = { status: 'idle' } }, { undoable: false })
  assert.deepEqual(await readFile(await media.resolve(id)), PNG)
  assert.ok(restored.production.cover.media.id)
})
