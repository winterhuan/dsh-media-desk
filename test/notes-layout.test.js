import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WriteOwner } from '../src/write-owner.js'
import { Store } from '../src/store.js'
import { Notes } from '../src/notes.js'
import { pruneNotesHistory } from '../src/notes-history.js'
import { applyOps } from '../src/ops.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'media-desk-layout-'))
  const wiki = join(root, 'wiki')
  await mkdir(wiki)
  const owner = new WriteOwner(join(root, 'data'), wiki)
  t.after(async () => { await owner.drain(); await owner.release(); await rm(root, { recursive: true, force: true }) })
  await owner.acquire()
  const store = new Store(owner.dataRoot, owner)
  store.notes = new Notes(owner)
  await store.notes.init()
  await store.read()
  await store.run(() => pruneNotesHistory(store))
  const edit = ops => store.mutate('Edit work', draft => applyOps(draft, ops))
  const added = await edit([{ op: 'add_item', title: '我的创作稿', body: 'Version 0', language: 'zh' }])
  return { store, owner, edit, id: added.receipts[0].target }
}

test('标题文件可读，重复标题和外部文件不被覆盖', async t => {
  const { store, edit, id } = await fixture(t)
  const first = (await store.read()).items.find(row => row.id === id)
  assert.equal(first.content.relativePath, 'works/我的创作稿.md')
  const original = await readFile(join(first.content.notesRoot, first.content.relativePath))
  const added = await edit([{ op: 'add_item', title: '我的创作稿', body: 'Another work', language: 'zh' }])
  const second = (await store.read()).items.find(row => row.id === added.receipts[0].target)
  assert.match(second.content.relativePath, /^works\/我的创作稿-[a-f0-9]{6}\.md$/)
  assert.deepEqual(await readFile(join(first.content.notesRoot, first.content.relativePath)), original)
  await writeFile(join(first.content.notesRoot, 'works', 'Untouched.md'), 'External content')
  await edit([{ op: 'add_item', title: 'Untouched', body: 'Owned content', language: 'en' }])
  assert.equal(await readFile(join(first.content.notesRoot, 'works', 'Untouched.md'), 'utf8'), 'External content')
})

test('历史隐藏且重复冻结复用文件，旧版本过期后最近编辑仍可撤销并冷读取', async t => {
  const { store, owner, edit, id } = await fixture(t)
  let work = (await store.read()).items.find(row => row.id === id)
  const first = work.content.snapshot
  const originalReceipt = store.state.receipts.find(receipt => receipt.outcome?.receipts?.some(row => row.target === id))
  assert.match(first.relativePath, /^\.media-desk\/history\//)
  const bytes = await store.notes.readBytes(work.content)
  const frozen = await store.notes.saveSnapshot(work.content, id, bytes)
  const repeated = await store.notes.saveSnapshot(work.content, id, bytes)
  assert.deepEqual(repeated, frozen)
  for (let version = 1; version <= 9; version++) await edit([{ op: 'update_item', id, body: `Version ${version}` }])
  work = (await store.read()).items.find(row => row.id === id)
  assert.equal(work.body, 'Version 9')
  assert.ok(work.textHistory.length <= 5)
  await assert.rejects(readFile(join(first.notesRoot, first.relativePath)), { code: 'ENOENT' })
  assert.deepEqual((await store.retrySave(originalReceipt.id)).acceptance, originalReceipt)
  await store.undoLast()
  assert.equal((await store.read()).items.find(row => row.id === id).body, 'Version 8')
  const cold = new Store(owner.dataRoot, owner)
  cold.notes = new Notes(owner)
  await cold.notes.init()
  assert.equal((await cold.read()).items.find(row => row.id === id).body, 'Version 8')
  await assert.rejects(readdir(join(work.content.notesRoot, 'history')), { code: 'ENOENT' })
  const records = (await cold.saves()).filter(row => row.files.some(file => file.kind === 'index'))
  assert.ok(records.length <= 1)
})

test('整理后回滚还原仅由保存日志引用的历史文件，下一次备份仍可验证', async t => {
  const { store, owner, edit, id } = await fixture(t)
  const backup = await store.run(async () => {
    await edit([{ op: 'add_item', title: 'Another work', body: 'Independent text', language: 'en' }])
    return store.migration.backup({ reuse: false })
  })
  const candidates = backup.entries.filter(entry => /history\/index%3A[^/]+\/.*-candidate\.md$/.test(entry.source))
  assert.ok(candidates.length >= 2)
  for (let version = 1; version <= 9; version++) await edit([{ op: 'update_item', id, body: `Version ${version}` }])
  await owner.drain()
  const restored = await store.run(() => store.migration.rollback(backup.id))
  assert.equal(restored.verified, true)
  for (const entry of candidates) assert.deepEqual(await readFile(entry.source), await readFile(join(backup.path, entry.saved)))
  await store.read()
  assert.equal((await store.read()).items.find(row => row.id === id).body, 'Version 0')
  assert.equal(await store.migration.verify(await store.run(() => store.migration.backup({ reuse: false }))), true)
})

test('冷备份拒绝缺失的未接受候选，不能把它当作过期历史', async t => {
  const { store, owner, edit, id } = await fixture(t)
  await owner.drain()
  const persist = store.persist
  store.persist = async () => { throw Object.assign(new Error('Fixture full disk'), { code: 'ENOSPC' }) }
  try { await assert.rejects(edit([{ op: 'update_item', id, body: 'Unsaved candidate' }]), { code: 'ENOSPC' }) }
  finally { store.persist = persist }
  const pending = store.writes.records.find(row => row.status === 'failed')
  assert.ok(pending)
  const candidate = pending.files[0].candidate
  await unlink(join(candidate.notesRoot, candidate.relativePath))
  const cold = new Store(owner.dataRoot, owner)
  cold.notes = new Notes(owner)
  await cold.notes.init()
  await cold.refresh()
  await assert.rejects(cold.run(() => cold.migration.backup({ reuse: false })), { code: 'notes/missing' })
})

test('单份保存日志支持冷读取与旧 proposal 恢复，锁根目录以当前日志为准', async t => {
  const { store, owner, id } = await fixture(t)
  await owner.drain()
  const record = store.writes.records.find(row => row.files.some(file => file.workId === id))
  const current = store.writes.path(record, 'pending.json')
  const legacy = store.writes.path(record, 'proposal.json')
  await assert.rejects(readFile(legacy), { code: 'ENOENT' })
  const staleRoot = join(owner.dataRoot, 'stale-notes')
  await writeFile(legacy, (await readFile(current, 'utf8')).replaceAll(owner.notesRoot, staleRoot))
  assert.equal((await owner.savedRoots()).has(staleRoot), false)
  await store.run(() => store.writes.save(record))
  await assert.rejects(readFile(legacy), { code: 'ENOENT' })
  await rename(current, legacy)
  assert.equal((await owner.savedRoots()).has(owner.notesRoot), true)
  const cold = new Store(owner.dataRoot, owner)
  cold.notes = new Notes(owner)
  await cold.notes.init()
  assert.equal((await cold.read()).items.find(row => row.id === id).body, 'Version 0')
  const restored = cold.writes.records.find(row => row.id === record.id)
  await cold.run(() => cold.writes.save(restored))
  assert.equal(JSON.parse(await readFile(current, 'utf8')).id, record.id)
  await assert.rejects(readFile(legacy), { code: 'ENOENT' })
})

test('过期撤销文件清理，近期撤销与未完成保存仍可冷恢复', async t => {
  const { store, owner, edit, id } = await fixture(t)
  const undoRoot = join(store.filesDir, 'undo')
  await edit([{ op: 'update_item', id, pos: { x: 1, y: 0 } }])
  const expired = store.state.notesUndo.at(-1).changes.relativePath
  await writeFile(join(undoRoot, 'external.json'), 'Unrelated private file')
  for (let x = 2; x <= 8; x++) await edit([{ op: 'update_item', id, pos: { x, y: 0 } }])
  await owner.drain()
  await store.run(() => pruneNotesHistory(store))
  assert.equal(store.state.notesUndo.length, 5)
  await assert.rejects(readFile(join(store.filesDir, expired)), { code: 'ENOENT' })
  assert.equal(await readFile(join(undoRoot, 'external.json'), 'utf8'), 'Unrelated private file')
  const persist = store.persist
  store.persist = async () => { throw Object.assign(new Error('Fixture full disk'), { code: 'ENOSPC' }) }
  try { await assert.rejects(edit([{ op: 'update_item', id, body: 'Pending text' }]), { code: 'ENOSPC' }) }
  finally { store.persist = persist }
  const pending = store.writes.records.find(row => row.status === 'failed')
  assert.ok(pending.undoEntry)
  await store.run(() => pruneNotesHistory(store))
  assert.ok(await readFile(join(store.filesDir, pending.undoEntry.changes.relativePath)))
  const cold = new Store(owner.dataRoot, owner)
  cold.notes = new Notes(owner)
  await cold.notes.init()
  assert.equal((await cold.read()).items.find(row => row.id === id).pos.x, 8)
  await cold.undoLast()
  assert.equal((await cold.read()).items.find(row => row.id === id).pos.x, 7)
  assert.equal((await cold.retrySave(pending.id)).state.items.find(row => row.id === id).body, 'Pending text')
})
