/** Registered work text is read through the actual Host and native Session. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, readFile, readdir, realpath, rename, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeRuntime } from './fixtures/native-runtime.js'

async function waitForFile(path, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try { return await readFile(path, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`File readiness timed out: ${path}`)
}

async function finishedProduction(runtime, id) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const result = await runtime.host('production?id=' + id)
    if (result.value.production?.status !== 'running') return result.value.production
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('Production did not settle: ' + id)
}

test('新作品的唯一可编辑正文位于 Notes 标题文件，Store 只保存引用', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t)
  await runtime.start()
  const added = await runtime.host('ops', { ops: [{ op: 'add_item', title: 'An editable work', body: 'A single current Markdown body.\n', language: 'en', tags: ['notes'], source: 'A dated source', url: 'https://example.com/source' }] })
  assert.equal(added.status, 200, JSON.stringify(added.value))
  const id = added.value.receipts[0].target
  const work = added.value.state.items.find(row => row.id === id)
  assert.equal(work.content.relativePath, 'works/An editable work.md')
  assert.equal(work.content.status, 'ready')
  assert.equal(work.body, 'A single current Markdown body.\n')
  const bytes = await readFile(join(runtime.wiki, 'notes', work.content.relativePath), 'utf8')
  assert.match(bytes, /An editable work/)
  assert.match(bytes, /A single current Markdown body\./)
  const stored = JSON.parse(await readFile(join(runtime.home, 'media-desk', 'state.json'), 'utf8')).items.find(row => row.id === id)
  assert.equal(Object.hasOwn(stored, 'body'), false)
  assert.equal(stored.content.relativePath, work.content.relativePath)
})

test('冷恢复仍拥有已保存 Wiki A 的 Notes，环境改为 B 不能绕过 A 的竞争锁', { timeout: 240000 }, async t => {
  let original, contender
  t.after(async () => { await Promise.all([original?.stop(), contender?.stop()]) })
  const recipes = {}
  original = await nativeRuntime(t, { recipes })
  await original.start()
  const added = await original.host('ops', { ops: [{ op: 'add_item', title: 'Saved Wiki A', body: 'The original Wiki A body.\n', language: 'en' }] })
  const id = added.value.receipts[0].target
  const work = added.value.state.items.find(row => row.id === id)
  const opened = await original.host('sessions/open', { workId: id })
  assert.equal(opened.status, 200, JSON.stringify(opened.value))
  const association = opened.value.association
  const settings = await original.host('settings', { imageCount: 0, language: 'en' })
  assert.equal(settings.status, 200)
  recipes.MD_FIXTURE_NOTES_SAVED_ROOT = { calls: [{ name: 'read', arguments: { file_path: `notes/${work.content.relativePath}` } }], reply: 'The registered current work was read.' }
  await original.stop()
  const savedState = await readFile(join(original.home, 'media-desk', 'state.json'), 'utf8')
  const savedSettings = await readFile(join(original.home, 'media-desk', 'settings.json'), 'utf8')
  const otherWiki = join(original.root, 'wiki-b')
  await mkdir(otherWiki)
  await writeFile(join(otherWiki, 'index.md'), 'Unrelated Wiki B content.\n')
  contender = await nativeRuntime(t)
  await contender.start([], { WIKI_PATH: original.wiki })
  assert.equal((await contender.host('state')).status, 200)
  await original.start([], { WIKI_PATH: otherWiki })
  assert.equal((await original.host('state')).status, 404)
  assert.equal(await readFile(join(original.home, 'media-desk', 'state.json'), 'utf8'), savedState)
  assert.equal(await readFile(join(original.home, 'media-desk', 'settings.json'), 'utf8'), savedSettings)
  assert.equal(await readFile(join(otherWiki, 'index.md'), 'utf8'), 'Unrelated Wiki B content.\n')
  await contender.stop()
  await original.stop()
  await original.start([], { WIKI_PATH: otherWiki })
  const restored = await original.host('sessions/open', { workId: id })
  assert.equal(restored.status, 200, JSON.stringify(restored.value))
  assert.equal(restored.value.association.sessionId, association.sessionId)
  assert.equal(restored.value.association.notesRoot, association.notesRoot)
  const edited = await original.host('ops', { ops: [{ op: 'update_item', id, body: 'Edited in saved Wiki A.\n' }] })
  assert.equal(edited.status, 200, JSON.stringify(edited.value))
  assert.match(await readFile(join(work.content.notesRoot, work.content.relativePath), 'utf8'), /Edited in saved Wiki A\./)
  await assert.rejects(readFile(join(otherWiki, 'notes', work.content.relativePath)), { code: 'ENOENT' })
  const requestId = await original.prompt(association.sessionId, 'Read-only MD_FIXTURE_NOTES_SAVED_ROOT: read the current registered work.')
  const turn = await original.turn(association.sessionId, requestId)
  assert.equal(turn.end.data.reason.kind, 'completed')
  const results = turn.events.filter(event => event.type === 'tool/result')
  assert.equal(results.length, 1)
  assert.equal(results[0].data.message.isError, false)
  assert.match(JSON.stringify(results), /Edited in saved Wiki A\./)
  assert.equal(await readFile(join(otherWiki, 'index.md'), 'utf8'), 'Unrelated Wiki B content.\n')
})

test('已经登记在 Wiki A 的作品首次建 Session 也沿用 A，新作品与全局使用新 Wiki B', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t)
  await runtime.start()
  const added = await runtime.host('ops', { ops: [{ op: 'add_item', title: 'A work before any Session', body: 'Its current text belongs to Wiki A.\n', language: 'en' }] })
  const id = added.value.receipts[0].target
  const reference = added.value.state.items.find(row => row.id === id).content
  assert.deepEqual((await runtime.host('sessions')).value.associations, [])
  await runtime.stop()
  const otherWiki = join(runtime.root, 'new-wiki-b')
  await mkdir(otherWiki)
  await runtime.start([], { WIKI_PATH: otherWiki })
  const opened = await runtime.host('sessions/open', { workId: id })
  assert.equal(opened.status, 200, JSON.stringify(opened.value))
  assert.equal(opened.value.association.notesRoot, reference.notesRoot)
  assert.equal(opened.value.association.wikiRoot, await realpath(runtime.wiki))
  const global = await runtime.host('sessions/open', {})
  assert.equal(global.status, 200, JSON.stringify(global.value))
  assert.equal(global.value.association.wikiRoot, await realpath(otherWiki))
  const newWork = await runtime.host('ops', { ops: [{ op: 'add_item', title: 'New Wiki B work', body: 'The new configured Wiki is B.\n', language: 'en' }] })
  const newId = newWork.value.receipts[0].target
  const newReference = newWork.value.state.items.find(row => row.id === newId).content
  assert.equal(newReference.notesRoot, global.value.association.notesRoot)
  const newOpened = await runtime.host('sessions/open', { workId: newId })
  assert.equal(newOpened.status, 200, JSON.stringify(newOpened.value))
  assert.equal(newOpened.value.association.notesRoot, newReference.notesRoot)
})

test('作品文件改名与无效身份返回修复状态，显式重新关联只接受所属文件', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t)
  await runtime.start()
  const added = await runtime.host('ops', { ops: [{ op: 'add_item', title: 'A repairable work', body: 'Preserve the external bytes.\n', language: 'en' }] })
  const id = added.value.receipts[0].target
  const reference = added.value.state.items.find(row => row.id === id).content
  const original = join(reference.notesRoot, reference.relativePath)
  const renamed = `works/${id}-renamed.md`
  const bytes = await readFile(original, 'utf8')
  await rename(original, join(reference.notesRoot, renamed))
  const missing = await runtime.host('state')
  assert.equal(missing.status, 200, JSON.stringify(missing.value))
  const missingWork = missing.value.state.items.find(row => row.id === id)
  assert.equal(missingWork.content.status, 'missing')
  assert.equal(Object.hasOwn(missingWork, 'body'), false)
  await assert.rejects(readFile(original), { code: 'ENOENT' })
  const repaired = await runtime.host('notes/relink', { id, relativePath: renamed })
  assert.equal(repaired.status, 200, JSON.stringify(repaired.value))
  const work = repaired.value.state.items.find(row => row.id === id)
  assert.equal(work.body, 'Preserve the external bytes.\n')
  assert.equal(work.content.relativePath, renamed)
  await writeFile(join(reference.notesRoot, renamed), bytes.replace(`id: ${id}`, 'id: another-work'))
  const invalid = await runtime.host('state')
  assert.equal(invalid.status, 200, JSON.stringify(invalid.value))
  const invalidWork = invalid.value.state.items.find(row => row.id === id)
  assert.equal(invalidWork.content.status, 'invalid')
  assert.equal(invalidWork.content.code, 'notes/identity-mismatch')
  assert.equal(Object.hasOwn(invalidWork, 'body'), false)
  const refused = await runtime.host('notes/relink', { id, relativePath: renamed })
  assert.equal(refused.status, 409)
  assert.equal(refused.value.code, 'notes/identity-mismatch')
  assert.equal(await readFile(join(reference.notesRoot, renamed), 'utf8'), bytes.replace(`id: ${id}`, 'id: another-work'))
})

test('Notes 符号链接的规范目录不替换作品实际绑定的 Wiki 工作区', { timeout: 180000, skip: process.platform === 'win32' && 'Directory symlink permissions are platform-owned' }, async t => {
  const runtime = await nativeRuntime(t)
  const otherWiki = join(runtime.root, 'another-wiki')
  await mkdir(join(otherWiki, 'notes'), { recursive: true })
  await symlink(join(otherWiki, 'notes'), join(runtime.wiki, 'notes'), 'dir')
  await runtime.start()
  const added = await runtime.host('ops', { ops: [{ op: 'add_item', title: 'The original Wiki workspace', body: 'Keep the actual Wiki binding.\n', language: 'en' }] })
  assert.equal(added.status, 200, JSON.stringify(added.value))
  const id = added.value.receipts[0].target
  const reference = added.value.state.items.find(row => row.id === id).content
  assert.equal(reference.notesRoot, await realpath(join(otherWiki, 'notes')))
  const opened = await runtime.host('sessions/open', { workId: id })
  assert.equal(opened.status, 200, JSON.stringify(opened.value))
  assert.equal(opened.value.association.wikiRoot, await realpath(runtime.wiki))
  assert.equal(opened.value.association.notesRoot, reference.notesRoot)
  const listed = await runtime.rpc('session/list', { _request: {} })
  assert.equal(listed.ok, true)
  assert.equal(listed.value.items.find(row => row.sessionId === opened.value.association.sessionId).cwd, await realpath(runtime.wiki))
})

test('保存的 Wiki 消失时不重建其父目录，其他 Wiki 默认值不能替代作品位置', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t)
  const savedWiki = join(runtime.root, 'saved-wiki')
  await mkdir(savedWiki)
  await runtime.start([], { WIKI_PATH: savedWiki })
  const added = await runtime.host('ops', { ops: [{ op: 'add_item', title: 'A missing saved Wiki', body: 'Preserve the saved work.\n', language: 'en' }] })
  const reference = added.value.state.items.find(row => row.id === added.value.receipts[0].target).content
  await runtime.stop()
  const state = await readFile(join(runtime.home, 'media-desk', 'state.json'), 'utf8')
  const relocated = join(runtime.root, 'relocated-wiki')
  await rename(savedWiki, relocated)
  await runtime.start()
  assert.equal((await runtime.host('state')).status, 404)
  await assert.rejects(stat(savedWiki), { code: 'ENOENT' })
  assert.equal(await readFile(join(runtime.home, 'media-desk', 'state.json'), 'utf8'), state)
  assert.match(await readFile(join(relocated, 'notes', reference.relativePath), 'utf8'), /Preserve the saved work\./)
})

test('运行期间 Wiki 消失也不能在新作品写入时递归重建目录', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t)
  const originalIndex = 'Preserve the independently maintained Wiki index.\n'
  await writeFile(join(runtime.wiki, 'index.md'), originalIndex)
  await runtime.start()
  await runtime.host('ops', { ops: [{ op: 'clear_samples' }], undoable: false })
  const relocated = join(runtime.root, 'relocated-active-wiki')
  await rename(runtime.wiki, relocated)
  const refused = await runtime.host('ops', { ops: [{ op: 'add_item', title: 'An unavailable Wiki', body: 'Do not rebuild the Wiki.\n', language: 'en' }] })
  assert.equal(refused.status, 409)
  assert.equal(refused.value.code, 'notes/directory-unavailable')
  await assert.rejects(stat(runtime.wiki), { code: 'ENOENT' })
  assert.equal(await readFile(join(relocated, 'index.md'), 'utf8'), originalIndex)
  const durable = JSON.parse(await readFile(join(runtime.home, 'media-desk', 'state.json'), 'utf8'))
  assert.deepEqual(durable.items, [])
  await rename(relocated, runtime.wiki)
})

test('Notes 统一索引只导航登记作品，保留原有索引和无关笔记', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t)
  const notes = join(runtime.wiki, 'notes')
  await mkdir(join(notes, 'works'), { recursive: true })
  const index = '# Research notes\n\nMy existing navigation.\n\n- [Unrelated](works/unrelated.md)\n'
  const unrelated = 'An ordinary note without a Media Desk association.\n'
  await writeFile(join(notes, 'index.md'), index)
  await writeFile(join(notes, 'works', 'unrelated.md'), unrelated)
  await writeFile(join(runtime.wiki, 'index.md'), '# My Wiki\n\nIndependent root navigation.\n')
  await runtime.start()
  const added = await runtime.host('ops', { ops: [{ op: 'add_item', title: 'An indexed work', body: 'Current indexed text.\n', language: 'en' }] })
  assert.equal(added.status, 200, JSON.stringify(added.value))
  const id = added.value.receipts[0].target
  const reference = added.value.state.items.find(row => row.id === id).content
  let navigation = await readFile(join(notes, 'index.md'), 'utf8')
  assert.equal(navigation.slice(0, index.length), index)
  assert.ok(navigation.includes(reference.relativePath.split('/').map(encodeURIComponent).join('/')))
  assert.match(navigation, /An indexed work/)
  await runtime.host('ops', { ops: [{ op: 'update_item', id, title: 'The indexed current title', status: 'published' }] })
  navigation = await readFile(join(notes, 'index.md'), 'utf8')
  assert.match(navigation, /The indexed current title/)
  assert.doesNotMatch(navigation, /published|已发布|scheduledAt/)
  const path = join(reference.notesRoot, reference.relativePath)
  await writeFile(path, (await readFile(path, 'utf8')).replace('The indexed current title', 'The external title'))
  await runtime.host('state')
  assert.match(await readFile(join(notes, 'index.md'), 'utf8'), /The external title/)
  assert.equal(await readFile(join(notes, 'works', 'unrelated.md'), 'utf8'), unrelated)
  assert.equal(await readFile(join(runtime.wiki, 'index.md'), 'utf8'), '# My Wiki\n\nIndependent root navigation.\n')
  await assert.rejects(stat(join(notes, 'media-desk')), { code: 'ENOENT' })
})

test('相同 mtime 的外部正文变化在公开读取时成为新的内容版本', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t)
  await runtime.start()
  const added = await runtime.host('ops', { ops: [{ op: 'add_item', title: 'External edits', body: 'Before the external edit.\n', language: 'en' }] })
  const id = added.value.receipts[0].target
  const previous = added.value.state.items.find(row => row.id === id).content
  const path = join(previous.notesRoot, previous.relativePath)
  const info = await stat(path)
  await writeFile(path, (await readFile(path, 'utf8')).replace('Before the external edit.', 'After the external edit.'))
  // The assertion concerns byte changes; OS mtime round-trip precision is irrelevant.
  await utimes(path, info.atime, info.mtime).catch(error => t.diagnostic(`Timestamp restoration unavailable: ${error.code}`))
  const read = await runtime.host('state')
  assert.equal(read.status, 200, JSON.stringify(read.value))
  const work = read.value.state.items.find(row => row.id === id)
  assert.equal(work.body, 'After the external edit.\n')
  assert.equal(work.content.revision, previous.revision + 1)
  assert.notEqual(work.content.sha256, previous.sha256)
  const persisted = JSON.parse(await readFile(join(runtime.home, 'media-desk', 'state.json'), 'utf8')).items.find(row => row.id === id)
  assert.deepEqual(persisted.content, work.content)
  assert.equal(Object.hasOwn(persisted, 'body'), false)
})

test('无效 YAML、身份和来源字段要求修复，公开编辑不能覆盖无效文件', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t)
  await runtime.start()
  const added = await runtime.host('ops', { ops: [{ op: 'add_item', title: 'A validated work', body: 'Preserve invalid external bytes.\n', language: 'en' }] })
  const id = added.value.receipts[0].target
  const reference = added.value.state.items.find(row => row.id === id).content
  const path = join(reference.notesRoot, reference.relativePath)
  const original = await readFile(path, 'utf8')
  const cases = [
    ['duplicate keys', original.replace(`id: ${id}`, `id: ${id}\nid: ${id}`), 'notes/metadata-invalid'],
    ['unsafe tag', original.replace('title: A validated work', 'title: !!js/function value'), 'notes/metadata-invalid'],
    ['unknown tag', original.replace('title: A validated work', 'title: !unknown value'), 'notes/metadata-invalid'],
    ['alias', original.replace('title: A validated work', 'title: &title A validated work').replace('sources: []', 'sources:\n  - label: *title'), 'notes/metadata-invalid'],
    ['malformed YAML', original.replace('title: A validated work', 'title: [unfinished'), 'notes/metadata-invalid'],
    ['wrong identity', original.replace(`id: ${id}`, 'id: a-different-work'), 'notes/identity-mismatch'],
    ['wrong language', original.replace('language: en', 'language: zh'), 'notes/identity-mismatch'],
    ['invalid date', original.replace(/updatedAt: [^\n]+/, 'updatedAt: unknown'), 'notes/metadata-invalid'],
    ['invalid source label', original.replace('sources: []', 'sources:\n  - label: 17'), 'notes/metadata-invalid'],
    ['invalid source URL', original.replace('sources: []', 'sources:\n  - url: [not, text]'), 'notes/metadata-invalid'],
  ]
  for (const [name, bytes, code] of cases) await t.test(name, async () => {
    await writeFile(path, bytes)
    const read = await runtime.host('state')
    assert.equal(read.status, 200, JSON.stringify(read.value))
    const work = read.value.state.items.find(row => row.id === id)
    assert.equal(work.content.status, 'invalid')
    assert.equal(work.content.code, code)
    assert.equal(Object.hasOwn(work, 'body'), false)
    const refused = await runtime.host('ops', { ops: [{ op: 'update_item', id, body: 'This must never replace invalid bytes.' }] })
    assert.equal(refused.status, 409, JSON.stringify(refused.value))
    assert.equal(refused.value.code, code)
    assert.equal(await readFile(path, 'utf8'), bytes)
  })
  await writeFile(path, original)
  const repaired = (await runtime.host('state')).value.state.items.find(row => row.id === id)
  assert.equal(repaired.content.status, 'ready')
  assert.equal(repaired.body, 'Preserve invalid external bytes.\n')
  const escape = await runtime.host('notes/relink', { id, relativePath: '../outside.md' })
  assert.equal(escape.status, 409)
  assert.equal(escape.value.code, 'notes/path-invalid')
  assert.equal(await readFile(path, 'utf8'), original)
})

test('公开编辑写回登记 Markdown，过期内容版本不能覆盖外部修改', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t)
  await runtime.start()
  const added = await runtime.host('ops', { ops: [{ op: 'add_item', title: 'Current title', body: 'The current body.\n', language: 'en' }] })
  const id = added.value.receipts[0].target
  const reference = added.value.state.items.find(row => row.id === id).content
  const edited = await runtime.host('ops', { expectedContent: { [id]: { revision: reference.revision, sha256: reference.sha256 } }, ops: [{ op: 'update_item', id, title: 'A freely changed title', body: 'The edited body.\n' }] })
  assert.equal(edited.status, 200, JSON.stringify(edited.value))
  const work = (await runtime.host('state')).value.state.items.find(row => row.id === id)
  assert.equal(work.body, 'The edited body.\n')
  assert.equal(work.title, 'A freely changed title')
  assert.equal(work.content.relativePath, reference.relativePath)
  assert.equal(work.content.revision, reference.revision + 1)
  const path = join(work.content.notesRoot, work.content.relativePath)
  await writeFile(path, (await readFile(path, 'utf8')).replace('The edited body.', 'The latest external body.'))
  const stale = await runtime.host('ops', { expectedContent: { [id]: { revision: work.content.revision, sha256: work.content.sha256 } }, ops: [{ op: 'update_item', id, body: 'A stale candidate.\n' }] })
  assert.equal(stale.status, 409, JSON.stringify(stale.value))
  assert.equal(stale.value.code, 'notes/conflict')
  assert.match(await readFile(path, 'utf8'), /The latest external body\./)
  const latest = (await runtime.host('state')).value.state.items.find(row => row.id === id)
  assert.equal(latest.body, 'The latest external body.\n')
  assert.equal(latest.content.revision, work.content.revision + 1)
})

test('作品文件与父目录符号链接不能取得普通 Notes 文件的写入权', { timeout: 180000, skip: process.platform === 'win32' && 'Symlink permissions are platform-owned' }, async t => {
  const runtime = await nativeRuntime(t)
  await runtime.start()
  const added = await runtime.host('ops', { ops: [{ op: 'add_item', title: 'A regular primary', body: 'Preserve the file outside Notes.\n', language: 'en' }] })
  const id = added.value.receipts[0].target
  const reference = added.value.state.items.find(row => row.id === id).content
  const path = join(reference.notesRoot, reference.relativePath)
  const bytes = await readFile(path, 'utf8')
  const external = join(runtime.root, 'outside.md')
  await rename(path, external)
  await symlink(external, path, 'file')
  const invalid = (await runtime.host('state')).value.state.items.find(row => row.id === id)
  assert.equal(invalid.content.status, 'invalid')
  assert.equal(invalid.content.code, 'notes/path-invalid')
  const refused = await runtime.host('ops', { ops: [{ op: 'update_item', id, body: 'Do not write through the link.\n' }] })
  assert.equal(refused.status, 409, JSON.stringify(refused.value))
  assert.equal(await readFile(external, 'utf8'), bytes)
  assert.equal((await runtime.host('notes/relink', { id, relativePath: reference.relativePath })).value.code, 'notes/path-invalid')
  await unlink(path)
  await rename(external, path)
  const outsideWorks = join(runtime.root, 'outside-works')
  await rename(join(reference.notesRoot, 'works'), outsideWorks)
  await symlink(outsideWorks, join(reference.notesRoot, 'works'), 'dir')
  const escaped = (await runtime.host('state')).value.state.items.find(row => row.id === id)
  assert.equal(escaped.content.status, 'invalid')
  assert.equal(escaped.content.code, 'notes/path-invalid')
  const escapedEdit = await runtime.host('ops', { ops: [{ op: 'update_item', id, body: 'Do not write through the parent.\n' }] })
  assert.equal(escapedEdit.status, 409, JSON.stringify(escapedEdit.value))
  assert.equal(await readFile(join(outsideWorks, reference.relativePath.slice('works/'.length)), 'utf8'), bytes)
})

test('只有显式登记的已有文件成为当前正文，原素材、草稿与 AI 原稿保留其角色', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t)
  const data = join(runtime.home, 'media-desk')
  await mkdir(data)
  await writeFile(join(data, 'state.json'), JSON.stringify({ version: 1, sampleCleared: true, sampleLang: 'zh',
    items: [{ id: 'legacy_work', title: 'Original idea', body: 'Saved source idea.\n', language: 'en', tags: ['legacy'], source: 'Original source', createdAt: '2026-11-01T12:00:00Z', kind: 'note', status: 'draft',
      drafts: { article: { text: 'Fixed article draft.\n', aiText: 'Fixed AI article original.\n', by: 'user', at: '2026-11-02T12:00:00Z', engine: 'old-model' }, script: { text: 'Fixed script draft.\n', by: 'user', at: '2026-11-03T12:00:00Z' } } }],
    people: [], angles: [], skills: [], accounts: [], metrics: [], styles: [], chat: [] }))
  await mkdir(join(runtime.wiki, 'notes', 'works'), { recursive: true })
  const file = join(runtime.wiki, 'notes', 'works', 'legacy_work-en.md')
  const bytes = '---\nformat: 1\nkind: work\nid: legacy_work\ntitle: Current external draft\ncreatedAt: 2026-11-01T12:00:00Z\nupdatedAt: 2026-11-04T12:00:00Z\nlanguage: en\ntags: [external]\nsources: []\n---\n\nThe external current work.\n'
  await writeFile(file, bytes)
  await runtime.start()
  assert.equal((await runtime.host('state')).value.state.items[0].body, 'Saved source idea.\n')
  assert.equal(await readFile(file, 'utf8'), bytes)
  const adopted = await runtime.host('notes/register', { id: 'legacy_work', language: 'en', relativePath: 'works/legacy_work-en.md' })
  assert.equal(adopted.status, 200, JSON.stringify(adopted.value))
  const work = adopted.value.state.items.find(row => row.id === 'legacy_work')
  assert.equal(work.body, 'The external current work.\n')
  assert.equal(work.title, 'Current external draft')
  assert.match(await readFile(join(work.sourceContent.notesRoot, work.sourceContent.relativePath), 'utf8'), /Saved source idea\./)
  assert.equal(work.drafts.article.text, 'Fixed article draft.\n')
  assert.equal(work.drafts.article.aiText, 'Fixed AI article original.\n')
  assert.equal(work.drafts.script.text, 'Fixed script draft.\n')
  const durable = JSON.parse(await readFile(join(data, 'state.json'), 'utf8')).items.find(row => row.id === 'legacy_work')
  assert.equal(Object.hasOwn(durable, 'body'), false)
  assert.equal(Object.hasOwn(durable.drafts.article, 'text'), false)
  assert.equal(Object.hasOwn(durable.drafts.article, 'aiText'), false)
  assert.equal(Object.hasOwn(durable.drafts.script, 'text'), false)
  assert.equal(await readFile(file, 'utf8'), bytes)
})

test('已经显式登记的示例作品也以文件为准，界面语言不能重新套用示例正文', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t)
  await runtime.start()
  await mkdir(join(runtime.wiki, 'notes', 'works'), { recursive: true })
  const path = join(runtime.wiki, 'notes', 'works', 'seed_2-en.md')
  const bytes = '---\nformat: 1\nkind: work\nid: seed_2\ntitle: The explicitly selected work\ncreatedAt: 2026-11-01T12:00:00Z\nupdatedAt: 2026-11-04T12:00:00Z\nlanguage: en\ntags: []\nsources: []\n---\n\nThe explicit current Notes body.\n'
  await writeFile(path, bytes)
  const registered = await runtime.host('notes/register', { id: 'seed_2', language: 'en', relativePath: 'works/seed_2-en.md' })
  assert.equal(registered.status, 200)
  for (const language of ['en', 'zh', 'en']) {
    const read = await runtime.host('state', undefined, { 'x-media-desk-lang': language })
    assert.equal(read.status, 200)
    const work = read.value.state.items.find(item => item.id === 'seed_2')
    assert.equal(work.body, 'The explicit current Notes body.\n')
    assert.equal(work.title, 'The explicitly selected work')
    assert.equal(Object.hasOwn(work, 'otherLang'), false)
    assert.equal(await readFile(path, 'utf8'), bytes)
  }
})

test('已登记作品保存不同草稿格式时选择同一主文件，并保留固定 AI 原稿', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t)
  await runtime.start()
  const added = await runtime.host('ops', { ops: [{ op: 'add_item', title: 'Draft formats', body: 'An independently saved idea.\n', language: 'en' }] })
  const id = added.value.receipts[0].target
  const article = await runtime.host('ops', { ops: [{ op: 'save_draft', id, format: 'article', text: 'The fixed AI article draft.\n', by: 'ai', engine: 'fixture-model' }] })
  assert.equal(article.status, 200, JSON.stringify(article.value))
  const first = (await runtime.host('state')).value.state.items.find(row => row.id === id)
  assert.equal(first.body, 'The fixed AI article draft.\n')
  assert.equal(first.drafts.article.text, first.body)
  assert.equal(first.drafts.article.aiText, 'The fixed AI article draft.\n')
  const aiVersion = first.drafts.article.aiVersion
  assert.match(await readFile(join(first.sourceContent.notesRoot, first.sourceContent.relativePath), 'utf8'), /An independently saved idea\./)
  await runtime.host('ops', { ops: [{ op: 'save_draft', id, format: 'script', text: 'The selected script draft.\n', by: 'user' }] })
  const script = (await runtime.host('state')).value.state.items.find(row => row.id === id)
  assert.equal(script.body, 'The selected script draft.\n')
  assert.equal(script.content.relativePath, first.content.relativePath)
  assert.equal(script.drafts.article.text, 'The fixed AI article draft.\n')
  await runtime.host('ops', { ops: [{ op: 'save_draft', id, format: 'article', text: 'The human article revision.\n', by: 'user' }] })
  const human = (await runtime.host('state')).value.state.items.find(row => row.id === id)
  assert.equal(human.body, 'The human article revision.\n')
  assert.equal(human.drafts.article.aiText, 'The fixed AI article draft.\n')
  assert.deepEqual(human.drafts.article.aiVersion, aiVersion)
  assert.equal(human.drafts.script.text, 'The selected script draft.\n')
  const stored = JSON.parse(await readFile(join(runtime.home, 'media-desk', 'state.json'), 'utf8')).items.find(row => row.id === id)
  assert.equal(Object.hasOwn(stored, 'body'), false)
  for (const draft of Object.values(stored.drafts)) {
    assert.equal(Object.hasOwn(draft, 'text'), false)
    assert.equal(Object.hasOwn(draft, 'aiText'), false)
  }
})

test('撤销正文改动经由当前 Notes 文件取得新版本，保留已经登记的历史引用', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t)
  await runtime.start()
  const added = await runtime.host('ops', { undoable: false, ops: [{ op: 'add_item', title: 'Undo current Notes text', body: 'The starting current body.\n', language: 'en' }] })
  const id = added.value.receipts[0].target
  await runtime.host('ops', { ops: [{ op: 'update_item', id, body: 'The first authored edit.\n' }] })
  await runtime.host('ops', { ops: [{ op: 'update_item', id, body: 'The second authored edit.\n' }] })
  const beforeUndo = (await runtime.host('state')).value.state.items.find(row => row.id === id)
  const history = beforeUndo.textHistory
  assert.equal(history.length, 2)
  const undone = await runtime.host('undo', {})
  assert.equal(undone.status, 200, JSON.stringify(undone.value))
  const current = undone.value.state.items.find(row => row.id === id)
  assert.equal(current.body, 'The first authored edit.\n')
  assert.equal(current.content.revision, beforeUndo.content.revision + 1)
  for (const reference of history) assert.ok(current.textHistory.some(saved => saved.relativePath === reference.relativePath))
  assert.match(await readFile(join(current.content.notesRoot, current.content.relativePath), 'utf8'), /The first authored edit\./)
  const file = join(current.content.notesRoot, current.content.relativePath)
  await runtime.host('ops', { ops: [{ op: 'update_item', id, title: 'The authored title' }] })
  await writeFile(file, (await readFile(file, 'utf8')).replace('The first authored edit.', 'The later external body.'))
  const external = (await runtime.host('state')).value.state.items.find(row => row.id === id)
  const titleUndo = await runtime.host('undo', {})
  assert.equal(titleUndo.status, 200, JSON.stringify(titleUndo.value))
  const final = titleUndo.value.state.items.find(row => row.id === id)
  assert.equal(final.title, 'Undo current Notes text')
  assert.equal(final.body, 'The later external body.\n')
  assert.equal(final.content.revision, external.content.revision + 1)
})

test('撤销删除重新读取保留的登记文件，缺失时保留撤销入口且不重建正文', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t)
  await runtime.start()
  const added = await runtime.host('ops', { undoable: false, ops: [{ op: 'add_item', title: 'Restore the registered file', body: 'The retained primary.\n', language: 'en' }] })
  const id = added.value.receipts[0].target
  const reference = added.value.state.items.find(row => row.id === id).content
  const path = join(reference.notesRoot, reference.relativePath)
  const bytes = await readFile(path, 'utf8')
  await runtime.host('ops', { ops: [{ op: 'delete_item', id }] })
  const moved = join(runtime.root, 'temporarily-moved.md')
  await rename(path, moved)
  const missing = await runtime.host('undo', {})
  assert.equal(missing.status, 409)
  assert.equal(missing.value.code, 'notes/missing')
  const pending = await runtime.host('state')
  assert.equal(pending.value.canUndo, true)
  assert.equal(pending.value.state.items.some(row => row.id === id), false)
  await assert.rejects(readFile(path), { code: 'ENOENT' })
  await rename(moved, path)
  const external = bytes.replace('The retained primary.', 'The later external primary.')
  await writeFile(path, external)
  const restored = await runtime.host('undo', {})
  assert.equal(restored.status, 200, JSON.stringify(restored.value))
  const work = restored.value.state.items.find(row => row.id === id)
  assert.equal(work.body, 'The later external primary.\n')
  assert.ok(work.content.revision > pending.value.state.notesRevisions[id])
  assert.equal(await readFile(path, 'utf8'), external)
  assert.equal(restored.value.canUndo, false)
  const stale = await runtime.host('ops', { expectedContent: { [id]: reference }, ops: [{ op: 'update_item', id, body: 'An obsolete deletion input.' }] })
  assert.equal(stale.status, 409)
  assert.equal(stale.value.code, 'notes/conflict')
  assert.equal(await readFile(path, 'utf8'), external)
})

test('无效主文件拒绝成稿受理，不留下运行中的虚假任务', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t)
  await runtime.start()
  const added = await runtime.host('ops', { ops: [{ op: 'add_item', title: 'Reject a missing input', body: 'An accepted production input.\n', language: 'en' }] })
  const id = added.value.receipts[0].target
  const reference = added.value.state.items.find(row => row.id === id).content
  const path = join(reference.notesRoot, reference.relativePath)
  const moved = join(runtime.root, 'missing-production-input.md')
  await rename(path, moved)
  const refused = await runtime.host('produce', { id })
  assert.equal(refused.status, 409)
  assert.equal(refused.value.code, 'notes/missing')
  const read = await runtime.host('production?id=' + id)
  assert.equal(read.status, 200, JSON.stringify(read.value))
  assert.equal(read.value.live.running, false)
  assert.equal(read.value.production, null)
  await assert.rejects(readFile(path), { code: 'ENOENT' })
  assert.match(await readFile(moved, 'utf8'), /An accepted production input\./)
  await assert.rejects(readFile(runtime.telemetryPath), { code: 'ENOENT' })
})

test('不同 DSH home 的第二个 Host 不能初始化共用 Notes，其他原生 Session 仍可使用', { timeout: 180000 }, async t => {
  const holder = await nativeRuntime(t)
  await holder.start()
  assert.equal((await holder.host('state')).status, 200)
  assert.equal((await holder.host('ops', { ops: [{ op: 'add_item', title: 'Owned current work', body: 'Keep this work.', language: 'en' }] })).status, 200)
  const before = await readdir(join(holder.wiki, 'notes'))
  const contender = await nativeRuntime(t, { env: { DSH_HOME: join(holder.root, 'aaa-contender-home') } })
  await contender.start([], { WIKI_PATH: holder.wiki })
  const rejected = await contender.host('state')
  assert.equal(rejected.status, 404)
  await assert.rejects(readFile(join(contender.home, 'media-desk', 'state.json')), { code: 'ENOENT' })
  await assert.rejects(readFile(join(contender.home, 'media-desk', 'settings.json')), { code: 'ENOENT' })
  assert.ok(await realpath(join(contender.home, 'media-desk')) < await realpath(join(holder.wiki, 'notes')))
  await assert.rejects(readFile(join(contender.home, 'media-desk', '.media-desk-owner.lock')), { code: 'ENOENT' })
  assert.deepEqual(await readdir(join(holder.wiki, 'notes')), before)
  const unrelated = await contender.rpc('session/create', { request: { agentPreset: 'standard' } })
  assert.equal(unrelated.ok, true, JSON.stringify(unrelated))
  const requestId = await contender.prompt(unrelated.value.sessionId, 'Continue the unrelated standard conversation')
  assert.equal((await contender.turn(unrelated.value.sessionId, requestId)).end.data.reason.kind, 'completed')
})

test('已登记作品的成稿与人工修改直接写回主文件，AI 原稿独立保留', { timeout: 180000 }, async t => {
  const recipes = {}
  const runtime = await nativeRuntime(t, { recipes })
  const barrier = Object.fromEntries(['enteredPath', 'releasePath', 'abortedPath', 'settledPath'].map(name => [name, join(runtime.root, name)]))
  recipes.MD_STAGE_plan = { calls: [{ name: 'media_desk_read', arguments: { kind: 'work' } }, { name: 'media_desk_submit_result', arguments: { stageId: '$stageId', result: JSON.stringify({ title: 'Accepted plan', coverText: 'One clear idea', facts: [], outline: [], cover: 'A paper boat', characters: '', images: [], shots: [], sources: [] }) } }], barrier, reply: 'Plan submitted.' }
  recipes.MD_STAGE_article = { calls: [{ name: 'media_desk_read', arguments: { kind: 'work' } }, { name: 'media_desk_submit_result', arguments: { stageId: '$stageId', result: JSON.stringify({ article: 'The accepted produced script.', sources: [] }) } }], reply: 'Article submitted.' }
  await runtime.start()
  await runtime.host('settings', { imageCount: 0, shotCount: 0 })
  const added = await runtime.host('ops', { ops: [{ op: 'add_item', title: 'Registered production', body: 'MD_FIXTURE_REGISTERED_PRODUCTION original source.\n', language: 'en' }] })
  const id = added.value.receipts[0].target
  const reference = added.value.state.items.find(row => row.id === id).content
  const path = join(reference.notesRoot, reference.relativePath)
  const original = await readFile(path, 'utf8')
  assert.equal((await runtime.host('produce', { id })).status, 200)
  await waitForFile(barrier.enteredPath)
  assert.equal(await readFile(path, 'utf8'), original)
  await writeFile(barrier.releasePath, 'release\n')
  const finished = await finishedProduction(runtime, id)
  assert.equal(finished.status, 'done', JSON.stringify(finished))
  const produced = (await runtime.host('state')).value.state.items.find(row => row.id === id)
  assert.equal(produced.body, 'The accepted produced script.')
  assert.equal(produced.production.article, produced.body)
  assert.equal(produced.production.aiArticle, 'The accepted produced script.')
  const aiVersion = produced.production.aiVersion
  assert.match(await readFile(join(produced.sourceContent.notesRoot, produced.sourceContent.relativePath), 'utf8'), /original source/)
  assert.match(await readFile(path, 'utf8'), /The accepted produced script\./)
  const edited = await runtime.host('ops', { expectedContent: { [id]: produced.content }, ops: [{ op: 'update_production', id, article: 'The human production revision.\n' }] })
  assert.equal(edited.status, 200, JSON.stringify(edited.value))
  const human = (await runtime.host('state')).value.state.items.find(row => row.id === id)
  assert.equal(human.body, 'The human production revision.\n')
  assert.equal(human.production.article, human.body)
  assert.deepEqual(human.production.aiVersion, aiVersion)
  assert.equal(human.production.aiArticle, 'The accepted produced script.')
  const stored = JSON.parse(await readFile(join(runtime.home, 'media-desk', 'state.json'), 'utf8')).items.find(row => row.id === id)
  assert.equal(Object.hasOwn(stored, 'body'), false)
  assert.equal(Object.hasOwn(stored.production, 'article'), false)
  assert.equal(Object.hasOwn(stored.production, 'aiArticle'), false)
  await runtime.stop()
  await runtime.start()
  const restored = (await runtime.host('state')).value.state.items.find(row => row.id === id)
  assert.equal(restored.production.article, 'The human production revision.\n')
  assert.equal(restored.production.aiArticle, 'The accepted produced script.')
})

test('延迟模型结果提交前拒绝已改变的 Notes 版本，保留外部最新正文', { timeout: 180000 }, async t => {
  const recipes = {}
  const runtime = await nativeRuntime(t, { recipes })
  const barrier = Object.fromEntries(['enteredPath', 'releasePath', 'abortedPath', 'settledPath'].map(name => [name, join(runtime.root, name)]))
  recipes.MD_STAGE_plan = { calls: [{ name: 'media_desk_read', arguments: { kind: 'work' } }, { name: 'media_desk_submit_result', arguments: { stageId: '$stageId', result: JSON.stringify({ title: 'An old-input plan', coverText: 'Old input', facts: [], outline: [], cover: 'A paper boat', characters: '', images: [], shots: [], sources: [] }) } }], barrier, reply: 'Candidate submitted.' }
  await runtime.start()
  await runtime.host('settings', { imageCount: 0, shotCount: 0 })
  const added = await runtime.host('ops', { ops: [{ op: 'add_item', title: 'A delayed result', body: 'MD_FIXTURE_PRODUCTION_STALE source text.\n', language: 'en' }] })
  const id = added.value.receipts[0].target
  const reference = added.value.state.items.find(row => row.id === id).content
  const path = join(reference.notesRoot, reference.relativePath)
  await runtime.host('produce', { id })
  await waitForFile(barrier.enteredPath)
  const external = (await readFile(path, 'utf8')).replace('MD_FIXTURE_PRODUCTION_STALE source text.', 'The latest external editor text.')
  await writeFile(path, external)
  await writeFile(barrier.releasePath, 'release\n')
  const finished = await finishedProduction(runtime, id)
  assert.equal(finished.status, 'failed', JSON.stringify(finished))
  assert.match(finished.error, /内容已变化/)
  const work = (await runtime.host('state')).value.state.items.find(row => row.id === id)
  assert.equal(work.body, 'The latest external editor text.\n')
  assert.equal(work.content.revision, reference.revision + 1)
  assert.equal(await readFile(path, 'utf8'), external)
})

test('公开停用 Host 取消模型调用，等待外部结算和所属写入后才释放 Notes', { timeout: 240000 }, async t => {
  let holder, contender
  t.after(async () => { await Promise.all([holder?.stop('SIGKILL'), contender?.stop('SIGKILL')]) })
  const recipes = {}
  holder = await nativeRuntime(t, { recipes, stopTimeoutMs: 60000 })
  contender = await nativeRuntime(t)
  const barrier = Object.fromEntries(['enteredPath', 'releasePath', 'abortedPath', 'cleanupReleasePath', 'settledPath'].map(name => [name, join(holder.root, name)]))
  recipes.MD_STAGE_plan = { calls: [], reply: 'A delayed model result.', barrier }
  await holder.start()
  const added = await holder.host('ops', { ops: [{ op: 'add_item', title: 'A work with a held model', body: 'MD_FIXTURE_PRODUCER_BARRIER accepted source text.\n', language: 'en' }] })
  const id = added.value.receipts[0].target
  const reference = added.value.state.items.find(row => row.id === id).content
  assert.equal((await holder.host('produce', { id })).status, 200)
  assert.equal(await waitForFile(barrier.enteredPath), 'entered\n')
  const inventory = await holder.rpc('pluginManager/listPlugins', {})
  assert.equal(inventory.ok, true, JSON.stringify(inventory.error))
  const entry = inventory.value.find(row => row.patchId === 'media-desk')
  assert.ok(entry)
  const disabled = holder.rpc('pluginManager/setPluginEnabled', { id: entry.entryId, enabled: false })
  try {
    assert.equal(await waitForFile(barrier.abortedPath), 'aborted\n')
    await contender.start([], { WIKI_PATH: holder.wiki })
    assert.equal((await contender.host('state')).status, 404)
    const pending = JSON.parse(await readFile(join(holder.home, 'media-desk', 'state.json'), 'utf8')).items.find(row => row.id === id)
    assert.equal(pending.production.status, 'running')
    await assert.rejects(readFile(barrier.settledPath), { code: 'ENOENT' })
    const unrelated = await holder.rpc('session/create', { request: { agentPreset: 'standard' } })
    assert.equal(unrelated.ok, true, JSON.stringify(unrelated.error))
    await writeFile(barrier.cleanupReleasePath, 'release\n')
    const result = await disabled
    assert.equal(result.ok, true, JSON.stringify(result.error))
    assert.equal(result.value.application, 'applied', JSON.stringify(result.value))
    assert.equal(await readFile(barrier.settledPath, 'utf8'), 'aborted\n')
    const settled = JSON.parse(await readFile(join(holder.home, 'media-desk', 'state.json'), 'utf8')).items.find(row => row.id === id)
    assert.equal(settled.production.status, 'cancelled')
    await assert.rejects(readFile(join(reference.notesRoot, '.media-desk-owner.lock')), { code: 'ENOENT' })
    assert.match(await readFile(join(reference.notesRoot, reference.relativePath), 'utf8'), /accepted source text/)
    await contender.stop()
    await contender.start([], { WIKI_PATH: holder.wiki })
    assert.equal((await contender.host('state')).status, 200)
    await contender.stop()
  } finally {
    await writeFile(barrier.cleanupReleasePath, 'release\n')
    await disabled.catch(error => undefined)
    await holder.stop('SIGKILL')
  }
})
