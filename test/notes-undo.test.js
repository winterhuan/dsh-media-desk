/** Undo applies only the accepted edit through the actual Notes primary. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeRuntime } from './fixtures/native-runtime.js'
import { inspectRuntime } from './fixtures/inspector.js'

test('对话回执撤销所属编辑，冷恢复后保留后来编辑且普通回答没有撤销身份', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t, { recipes: {
    MD_FIXTURE_CHAT_TITLE: { calls: [{ name: 'media_desk_read', arguments: { kind: 'work' } }, { name: 'media_desk_edit', arguments: { operations: JSON.stringify([{ op: 'update_item', id: 'chat_owned_undo', title: 'The chat title' }]), expectedContent: '$versions', resultId: 'title-edit' } }], reply: 'Title edited.' },
    MD_FIXTURE_CHAT_ANSWER: { calls: [], reply: JSON.stringify({ reply: 'An ordinary answer.', ops: [] }) },
  } })
  const data = join(runtime.home, 'media-desk')
  await mkdir(data)
  await writeFile(join(data, 'state.json'), JSON.stringify({ version: 1, sampleCleared: true,
    items: [{ id: 'chat_owned_undo', kind: 'note', title: 'The original title', language: 'en', body: 'The original body.\n', createdAt: '2026-11-01T12:00:00Z' }],
    people: [], angles: [], styles: [], skills: [], metrics: [], accounts: [], chat: [] }))
  await runtime.start()
  await runtime.host('notes/migrate', {})
  await runtime.host('ops', { label: 'An earlier body edit', ops: [{ op: 'update_item', id: 'chat_owned_undo', body: 'An earlier accepted body.\n' }] })
  const changed = await runtime.host('chat', { message: 'MD_FIXTURE_CHAT_TITLE', focusId: 'chat_owned_undo' })
  assert.equal(changed.status, 200, JSON.stringify(changed.value))
  await runtime.turn(changed.value.association.sessionId, changed.value.requestId)
  const beforeLater = (await runtime.host('state')).value.state
  const undoId = beforeLater.notesUndo.at(-1).id
  await runtime.host('ops', { label: 'A later body edit', ops: [{ op: 'update_item', id: 'chat_owned_undo', body: 'A later accepted body.\n' }] })
  await runtime.stop()
  await runtime.start()
  const restored = (await runtime.host('state')).value.state
  const undone = await runtime.host('undo', { id: undoId })
  assert.equal(undone.status, 200, JSON.stringify(undone.value))
  assert.equal(undone.value.state.items[0].title, 'The original title')
  assert.equal(undone.value.state.items[0].body, 'A later accepted body.\n')
  assert.equal(typeof undoId, 'string')
  assert.equal(restored.notesUndo.some(entry => entry.id === undoId), true)
  await runtime.host('chat/clear', {})
  const ordinary = await runtime.host('chat', { message: 'MD_FIXTURE_CHAT_ANSWER', focusId: 'chat_owned_undo' })
  assert.equal(ordinary.status, 200, JSON.stringify(ordinary.value))
  await runtime.turn(ordinary.value.association.sessionId, ordinary.value.requestId)
  assert.equal((await runtime.host('state')).value.state.notesUndo.length, 2)
})

test('撤销已切换语言的编辑只还原原语言片段，保留当前语言与后来的外部修改', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t)
  const data = join(runtime.home, 'media-desk')
  await mkdir(data)
  await writeFile(join(data, 'state.json'), JSON.stringify({ version: 1, sampleCleared: true,
    items: [{ id: 'multilingual_undo', kind: 'note', title: 'Undo its saved language', language: 'en',
      createdAt: '2026-11-01T12:00:00Z', body: 'Opening remains.\nOwned sentence before.\nClosing remains.\n',
      otherLang: { zh: { title: '保留当前中文稿', language: 'zh', body: '当前中文正文保持不变。\n' } } }],
    people: [], angles: [], styles: [], skills: [], metrics: [], accounts: [] }))
  await runtime.start()
  const migrated = await runtime.host('notes/migrate', {})
  assert.equal(migrated.status, 200, JSON.stringify(migrated.value))
  const original = migrated.value.state.items[0]
  const edited = await runtime.host('ops', { label: 'English sentence', expectedContent: { [original.id]: original.content },
    ops: [{ op: 'update_item', id: original.id, body: 'Opening remains.\nOwned sentence after.\nClosing remains.\n' }] })
  assert.equal(edited.status, 200, JSON.stringify(edited.value))
  const english = edited.value.state.items[0]
  const switched = await runtime.host('notes/language', { id: original.id, language: 'zh', expectedContent: english.content })
  assert.equal(switched.status, 200, JSON.stringify(switched.value))
  const chinese = switched.value.state.items[0]
  const chinesePath = join(chinese.content.notesRoot, chinese.content.relativePath)
  const chineseBytes = await readFile(chinesePath, 'utf8')
  const englishPath = join(english.content.notesRoot, english.content.relativePath)
  await writeFile(englishPath, (await readFile(englishPath, 'utf8')).replace('Closing remains.', 'Closing with a later external addition.')
    .replace('title: Undo its saved language', 'title: A later external English title'))
  const undone = await runtime.host('undo', { id: edited.value.undoId })
  assert.equal(undone.status, 200, JSON.stringify(undone.value))
  const active = undone.value.state.items[0]
  assert.equal(active.content.language, 'zh')
  assert.equal(active.body, chinese.body)
  assert.equal(await readFile(chinesePath, 'utf8'), chineseBytes)
  const back = await runtime.host('notes/language', { id: original.id, language: 'en', expectedContent: active.content })
  assert.equal(back.status, 200, JSON.stringify(back.value))
  assert.equal(back.value.state.items[0].body, 'Opening remains.\nOwned sentence before.\nClosing with a later external addition.\n')
  assert.equal(back.value.state.items[0].title, 'A later external English title')
  assert.ok(back.value.state.items[0].content.revision > chinese.content.revision)
  assert.equal(undone.value.canUndo, false)
  await assert.rejects(readFile(runtime.telemetryPath), { code: 'ENOENT' })
})

test('尚未迁移的旧作品撤销只保存固定引用，冷恢复保留正文和草稿原文', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t)
  const data = join(runtime.home, 'media-desk')
  await mkdir(data)
  await writeFile(join(data, 'state.json'), JSON.stringify({ version: 1, sampleLang: 'en', sampleCleared: true,
    items: [{ id: 'legacy_unmigrated', kind: 'note', sample: true, title: 'Retain a legacy work', body: 'Legacy body retained by its fixed inverse.\nSeparate closing paragraph.\n',
      createdAt: '2026-11-01T12:00:00Z', drafts: { article: { text: 'Legacy authored draft.\n', aiText: 'Legacy fixed AI original.\n', by: 'user' } } }],
    people: [], angles: [], styles: [], skills: [], metrics: [], accounts: [] }))
  await runtime.start()
  const edited = await runtime.host('ops', { ops: [{ op: 'update_item', id: 'legacy_unmigrated', body: 'Legacy body changed by one edit.\nSeparate closing paragraph.\n' }] })
  assert.equal(edited.status, 200, JSON.stringify(edited.value))
  assert.equal(typeof edited.value.undoId, 'string')
  await runtime.host('ops', { undoable: false, ops: [{ op: 'update_item', id: 'legacy_unmigrated', body: 'Legacy body changed by one edit.\nLater closing paragraph retained.\n' }] })
  const removed = await runtime.host('ops', { ops: [{ op: 'delete_item', id: 'legacy_unmigrated' }] })
  assert.equal(removed.status, 200, JSON.stringify(removed.value))
  const saved = JSON.parse(await readFile(join(data, 'state.json'), 'utf8'))
  assert.equal(JSON.stringify(saved.notesUndo).includes('Legacy body'), false)
  assert.equal(JSON.stringify(saved.notesUndo).includes('Legacy authored draft'), false)
  assert.equal(JSON.stringify(saved.notesUndo).includes('Legacy fixed AI original'), false)
  await runtime.stop()
  await runtime.start()
  const restored = await runtime.host('undo', { id: removed.value.undoId })
  assert.equal(restored.status, 200, JSON.stringify(restored.value))
  const work = restored.value.state.items.find(row => row.id === 'legacy_unmigrated')
  assert.equal(work.body, 'Legacy body changed by one edit.\nLater closing paragraph retained.\n')
  assert.equal(work.drafts.article.text, 'Legacy authored draft.\n')
  assert.equal(work.drafts.article.aiText, 'Legacy fixed AI original.\n')
  const inverse = await runtime.host('undo', { id: edited.value.undoId })
  assert.equal(inverse.status, 200, JSON.stringify(inverse.value))
  assert.equal(inverse.value.state.items.find(row => row.id === 'legacy_unmigrated').body, 'Legacy body retained by its fixed inverse.\nLater closing paragraph retained.\n')
  assert.equal(inverse.value.canUndo, false)
  await assert.rejects(readFile(runtime.telemetryPath), { code: 'ENOENT' })
})

test('迁移前受理的正文编辑在迁移后仍可撤销，保留后来的独立修改', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t)
  const data = join(runtime.home, 'media-desk')
  await mkdir(data)
  await writeFile(join(data, 'state.json'), JSON.stringify({ version: 1, sampleCleared: true,
    items: [{ id: 'legacy_edit_then_migrate', kind: 'note', title: 'Migrate an accepted inverse', language: 'en',
      createdAt: '2026-11-01T12:00:00Z', body: 'Owned sentence before.\nA separate closing paragraph.\n',
      otherLang: { zh: { title: '迁移后保留中文', language: 'zh', body: '当前中文稿保留。\n' } } }],
    people: [], angles: [], styles: [], skills: [], metrics: [], accounts: [] }))
  await runtime.start()
  const edited = await runtime.host('ops', { label: 'Before migration', ops: [{ op: 'update_item', id: 'legacy_edit_then_migrate', body: 'Owned sentence after.\nA separate closing paragraph.\n' }] })
  assert.equal(edited.status, 200, JSON.stringify(edited.value))
  await runtime.host('ops', { undoable: false, ops: [{ op: 'update_item', id: 'legacy_edit_then_migrate', body: 'Owned sentence after.\nA later closing paragraph.\n' }] })
  const migration = await runtime.host('notes/migrate', {})
  assert.equal(migration.status, 200, JSON.stringify(migration.value))
  const selected = await runtime.host('notes/language', { id: 'legacy_edit_then_migrate', language: 'zh', expectedContent: migration.value.state.items[0].content })
  assert.equal(selected.status, 200, JSON.stringify(selected.value))
  await runtime.stop()
  await runtime.start()
  const undone = await runtime.host('undo', { id: edited.value.undoId })
  assert.equal(undone.status, 200, JSON.stringify(undone.value))
  const active = undone.value.state.items.find(item => item.id === 'legacy_edit_then_migrate')
  assert.equal(active.content.language, 'zh')
  assert.equal(active.body, '当前中文稿保留。\n')
  const back = await runtime.host('notes/language', { id: active.id, language: 'en', expectedContent: active.content })
  assert.equal(back.status, 200, JSON.stringify(back.value))
  const work = back.value.state.items.find(item => item.id === 'legacy_edit_then_migrate')
  assert.equal(work.body, 'Owned sentence before.\nA later closing paragraph.\n')
  assert.equal(work.content.relativePath, migration.value.state.items[0].content.relativePath)
  assert.ok(work.content.revision > migration.value.state.items[0].content.revision)
  assert.equal(undone.value.canUndo, false)
  await assert.rejects(readFile(runtime.telemetryPath), { code: 'ENOENT' })
})

test('撤销文字编辑只还原所属片段，保留后来的外部正文与标题', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t)
  await runtime.start()
  const originalBody = 'Opening remains.\nOwned sentence before.\nClosing remains.\n'
  const added = await runtime.host('ops', { undoable: false, ops: [{ op: 'add_item', title: 'Undo one sentence', body: originalBody, language: 'en' }] })
  const id = added.value.receipts[0].target
  const before = added.value.state.items.find(row => row.id === id).content
  const edited = await runtime.host('ops', { label: 'Owned sentence', expectedContent: { [id]: before }, ops: [{ op: 'update_item', id, body: 'Opening remains.\nOwned sentence after.\nClosing remains.\n' }] })
  assert.equal(edited.status, 200, JSON.stringify(edited.value))
  const current = edited.value.state.items.find(row => row.id === id).content
  const path = join(current.notesRoot, current.relativePath)
  await writeFile(path, (await readFile(path, 'utf8')).replace('Closing remains.', 'Closing with an external addition.').replace('title: Undo one sentence', 'title: An external title'))
  const external = (await runtime.host('state')).value.state.items.find(row => row.id === id)
  const undone = await runtime.host('undo', {})
  assert.equal(undone.status, 200, JSON.stringify(undone.value))
  const work = undone.value.state.items.find(row => row.id === id)
  assert.equal(work.body, 'Opening remains.\nOwned sentence before.\nClosing with an external addition.\n')
  assert.equal(work.title, 'An external title')
  assert.equal(work.content.revision, external.content.revision + 1)
  assert.equal(undone.value.label, 'Owned sentence')
  assert.equal(undone.value.canUndo, false)
})

test('新接受编辑的撤销身份冷恢复后仍可用，重复同一撤销不应用下一条编辑', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t)
  await runtime.start()
  const added = await runtime.host('ops', { undoable: false, ops: [{ op: 'add_item', title: 'Persistent inverse edit', body: 'The fixed before text.\n', language: 'en' }] })
  const id = added.value.receipts[0].target
  const previous = added.value.state.items.find(row => row.id === id).content
  await runtime.host('ops', { label: 'The first edit', expectedContent: { [id]: previous }, ops: [{ op: 'update_item', id, body: 'The first accepted edit.\n' }] })
  const first = (await runtime.host('state')).value.state.items.find(row => row.id === id).content
  await runtime.host('ops', { label: 'The second edit', expectedContent: { [id]: first }, ops: [{ op: 'update_item', id, body: 'The second accepted edit.\n' }] })
  await runtime.stop()
  await runtime.start()
  const restored = await runtime.host('state')
  assert.equal(restored.value.canUndo, true)
  assert.equal(typeof restored.value.undoId, 'string')
  const undoId = restored.value.undoId
  const saved = JSON.parse(await readFile(join(runtime.home, 'media-desk', 'state.json'), 'utf8'))
  assert.equal(saved.notesUndo.length, 2)
  assert.equal(JSON.stringify(saved.notesUndo).includes('accepted edit'), false, 'The inverse stores fixed text references rather than editable text')
  const undone = await runtime.host('undo', { id: undoId })
  assert.equal(undone.status, 200, JSON.stringify(undone.value))
  assert.equal(undone.value.state.items.find(row => row.id === id).body, 'The first accepted edit.\n')
  const version = undone.value.state.items.find(row => row.id === id).content.revision
  const repeated = await runtime.host('undo', { id: undoId })
  assert.equal(repeated.status, 200, JSON.stringify(repeated.value))
  assert.equal(repeated.value.state.items.find(row => row.id === id).body, 'The first accepted edit.\n')
  assert.equal(repeated.value.state.items.find(row => row.id === id).content.revision, version)
  assert.equal(repeated.value.canUndo, true)
})

test('冲突撤销保留外部正文及撤销记录，重启不恢复旧正文', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t)
  await runtime.start()
  const added = await runtime.host('ops', { undoable: false, ops: [{ op: 'add_item', title: 'Conflicting inverse', body: 'Use the original wording.\n', language: 'en' }] })
  const id = added.value.receipts[0].target
  const before = added.value.state.items.find(row => row.id === id).content
  const edited = await runtime.host('ops', { label: 'Wording', expectedContent: { [id]: before }, ops: [{ op: 'update_item', id, body: 'Use the accepted wording.\n' }] })
  const content = edited.value.state.items.find(row => row.id === id).content
  const path = join(content.notesRoot, content.relativePath)
  await writeFile(path, (await readFile(path, 'utf8')).replace('Use the accepted wording.', 'Use the external replacement.'))
  const observed = await runtime.host('state')
  const undoId = observed.value.undoId
  const result = await runtime.host('undo', { id: undoId })
  assert.equal(result.status, 409)
  assert.equal(result.value.code, 'notes/undo-conflict')
  await runtime.stop()
  await runtime.start()
  const restored = await runtime.host('state')
  assert.equal(restored.value.undoId, undoId)
  assert.equal(restored.value.canUndo, true)
  assert.equal(restored.value.state.items.find(row => row.id === id).body, 'Use the external replacement.\n')
})

test('删除与撤销恢复使用单调作品版本，删除前的迟到写入不能取得旧版本', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t)
  await runtime.start()
  const added = await runtime.host('ops', { undoable: false, ops: [{ op: 'add_item', title: 'Monotonic restore', body: 'A retained accepted body.\n', language: 'en' }] })
  const id = added.value.receipts[0].target
  const before = added.value.state.items.find(row => row.id === id).content
  const deleted = await runtime.host('ops', { expectedContent: { [id]: before }, ops: [{ op: 'delete_item', id }] })
  assert.equal(deleted.status, 200)
  const undone = await runtime.host('undo', { id: deleted.value.undoId })
  assert.equal(undone.status, 200, JSON.stringify(undone.value))
  const restored = undone.value.state.items.find(row => row.id === id).content
  assert.ok(restored.revision > before.revision)
  const stale = await runtime.host('ops', { expectedContent: { [id]: before }, ops: [{ op: 'update_item', id, body: 'An obsolete input.' }] })
  assert.equal(stale.status, 409)
  assert.equal(stale.value.code, 'notes/conflict')
  assert.equal((await runtime.host('state')).value.state.items.find(row => row.id === id).body, 'A retained accepted body.\n')
})

test('撤销与外部原子保存真实重叠时保留双方与撤销身份，选择当前后可重新计算逆编辑', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t)
  await runtime.start([], { NODE_OPTIONS: '--inspect=127.0.0.1:0' })
  const added = await runtime.host('ops', { undoable: false, ops: [{ op: 'add_item', title: 'An overlapping undo', body: 'Owned sentence before.\nA separate paragraph.\n', language: 'en' }] })
  const id = added.value.receipts[0].target
  const original = added.value.state.items.find(row => row.id === id).content
  const edited = await runtime.host('ops', { expectedContent: { [id]: original }, ops: [{ op: 'update_item', id, body: 'Owned sentence after.\nA separate paragraph.\n' }] })
  const content = edited.value.state.items.find(row => row.id === id).content
  const undoId = edited.value.undoId
  const primary = join(content.notesRoot, content.relativePath)
  const bytes = await readFile(primary, 'utf8')
  const client = await inspectRuntime(t, runtime)
  const point = await client.breakAt('/src/notes-writes.js', 'await rename(join(entry.before.notesRoot, entry.before.relativePath)', `record.undoOf === ${JSON.stringify(undoId)}`)
  const pause = point.next()
  const operation = runtime.host('undo', { id: undoId }).then(value => ({ value }), error => ({ error: error.message }))
  const paused = await pause
  const pendingId = await client.value(paused, 'record.id')
  const external = bytes.replace('A separate paragraph.', 'A separately saved external paragraph.')
  const externalPath = join(runtime.root, 'ordinary-undo-editor.md')
  await writeFile(externalPath, external, { flag: 'wx' })
  await rename(externalPath, primary)
  await point.remove()
  await client.send('Debugger.resume')
  const failed = await operation
  assert.equal(failed.value.status, 409, JSON.stringify(failed))
  assert.equal(failed.value.value.pendingId, pendingId)
  assert.equal(await readFile(primary, 'utf8'), external)
  const retained = await runtime.host('state')
  assert.equal(retained.value.undoId, undoId)
  const saved = (await runtime.host('notes/saves')).value.writes.find(row => row.id === pendingId)
  const conflict = saved.conflicts[0]
  const resolved = await runtime.host('notes/resolve', { id: pendingId, workId: id, relativePath: conflict.reference.relativePath, sha256: conflict.observedSha256, choice: 'current' })
  assert.equal(resolved.status, 200, JSON.stringify(resolved.value))
  const retried = await runtime.host('undo', { id: undoId })
  assert.equal(retried.status, 200, JSON.stringify(retried.value))
  assert.equal(retried.value.state.items.find(row => row.id === id).body, 'Owned sentence before.\nA separately saved external paragraph.\n')
  assert.equal(retried.value.canUndo, false)
  assert.equal((await runtime.host('undo', { id: undoId })).value.state.items.find(row => row.id === id).body, retried.value.state.items.find(row => row.id === id).body)
})
