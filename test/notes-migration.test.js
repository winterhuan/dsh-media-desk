/** Populated legacy work migration retains identity, language versions and fixed originals. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { nativeRuntime } from './fixtures/native-runtime.js'
import { inspectRuntime } from './fixtures/inspector.js'

const execute = promisify(execFile)

async function diskFiles(root, prefix = '') {
  const result = {}
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name)
    if (entry.isDirectory()) Object.assign(result, await diskFiles(root, path))
    else if (entry.isFile()) result[path] = (await readFile(join(root, path))).toString('base64')
  }
  return result
}

function legacyState() {
  return { version: 1, sampleCleared: true, sampleLang: 'zh', activeStyleId: 'custom-style',
    items: [{ id: 'populated_work', kind: 'note', title: '原有作品标题', body: '未标明语言的原始选题。\n', tags: ['original'], source: 'Original source', url: 'https://example.com/original',
      createdAt: '2026-11-01T12:00:00Z', status: 'ready', scheduledAt: '2026-11-15T12:00:00Z', customMetadata: { preserved: true },
      drafts: { article: { text: 'The separate article draft.\n', aiText: 'The fixed article AI original.\n', by: 'user', at: '2026-11-02T12:00:00Z', engine: 'old-article' },
        script: { text: 'The separate script draft.\n', aiText: 'The fixed script AI original.\n', by: 'user', at: '2026-11-03T12:00:00Z', engine: 'old-script' } },
      production: { status: 'done', title: 'Accepted production', article: 'The accepted current production.\n', aiArticle: 'The fixed production AI original.\n', facts: ['A preserved fact'], outline: ['A preserved outline'] },
      otherLang: { zh: { title: '中文版本', body: '中文版本的原始选题。\n', tags: ['中文'], source: '中文来源', drafts: { article: { text: '中文文章稿。\n', aiText: '中文 AI 原稿。\n', by: 'user', at: '2026-11-02T12:00:00Z' } } },
        en: { title: 'English language work', body: 'The English source idea.\n', tags: ['English'], source: 'English source', production: { status: 'done', article: 'The English accepted production.\n', aiArticle: 'The English fixed AI original.\n' }, drafts: {} } } }],
    people: [], angles: [], skills: [{ id: 'legacy_rule', name: 'Keep this rule', rule: 'Preserved successor material', status: 'active' }], accounts: [],
    metrics: [{ id: 'metric-before', itemId: 'populated_work', platform: 'YouTube', date: '2026-11-01T12:00:00Z', views: 17 }],
    styles: [{ id: 'custom-style', name: 'Original style', tone: 'Original tone' }], chat: [{ id: 'legacy-chat', text: 'Preserved old conversation', role: 'user', itemId: 'populated_work' }] }
}

test('保留编辑器修改未选中的语言时，可核对和选择该版本而不改变当前语言', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t)
  const data = join(runtime.home, 'media-desk')
  await mkdir(data)
  await writeFile(join(data, 'state.json'), JSON.stringify(legacyState()))
  await runtime.start()
  const migrated = await runtime.host('notes/migrate', {})
  const work = migrated.value.state.items[0]
  const selected = await runtime.host('notes/language', { id: work.id, language: 'en', expectedContent: work.content })
  const english = selected.value.state.items[0]
  const path = join(english.content.notesRoot, english.content.relativePath)
  const original = await readFile(path, 'utf8')
  const editor = await open(path, 'r+')
  t.after(() => editor.close())
  const edited = await runtime.host('ops', { resultKey: 'inactive-language-edit', expectedContent: { [work.id]: english.content }, ops: [{ op: 'update_item', id: work.id, body: 'A newly accepted English body.\n' }] })
  assert.equal(edited.status, 200, JSON.stringify(edited.value))
  const current = edited.value.state.items[0]
  const switched = await runtime.host('notes/language', { id: work.id, language: 'zh', expectedContent: current.content })
  assert.equal(switched.status, 200, JSON.stringify(switched.value))
  const chinese = switched.value.state.items[0]
  const external = original.replace('The English accepted production.', 'The retained external English body.')
  await editor.truncate(0)
  await editor.write(external, 0, 'utf8')
  const saved = (await runtime.host('notes/saves')).value.writes.find(row => row.id === edited.value.acceptance.id)
  const conflict = saved.conflicts[0]
  const request = { id: saved.id, workId: work.id, relativePath: conflict.reference.relativePath, sha256: conflict.observedSha256 }
  const preview = await runtime.host('notes/version', request)
  assert.equal(preview.status, 200, JSON.stringify(preview.value))
  assert.equal(preview.value.current.body, 'A newly accepted English body.\n')
  const resolved = await runtime.host('notes/resolve', { ...request, choice: 'external' })
  assert.equal(resolved.status, 200, JSON.stringify(resolved.value))
  const active = resolved.value.state.items[0]
  assert.equal(active.content.language, 'zh')
  assert.equal(active.body, chinese.body)
  assert.equal(active.content.status, 'ready')
  const back = await runtime.host('notes/language', { id: work.id, language: 'en', expectedContent: active.content })
  assert.equal(back.status, 200, JSON.stringify(back.value))
  assert.equal(back.value.state.items[0].body, 'The retained external English body.\n')
  assert.ok(back.value.state.items[0].content.revision > active.content.revision)
  assert.equal(await readFile(join(conflict.reference.notesRoot, conflict.reference.relativePath), 'utf8'), external)
  await assert.rejects(readFile(runtime.telemetryPath), { code: 'ENOENT' })
})

test('填充迁移先验证备份并保留未知语言、所有语言稿与 AI 原稿，重复迁移复用回执', { timeout: 240000 }, async t => {
  const runtime = await nativeRuntime(t)
  const data = join(runtime.home, 'media-desk')
  await mkdir(data)
  const original = JSON.stringify(legacyState())
  await writeFile(join(data, 'state.json'), original)
  await runtime.start()
  const opened = await runtime.host('sessions/open', { workId: 'populated_work' })
  assert.equal(opened.status, 200, JSON.stringify(opened.value))
  const migration = await runtime.host('notes/migrate', {})
  assert.equal(migration.status, 200, JSON.stringify(migration.value))
  const work = migration.value.state.items.find(row => row.id === 'populated_work')
  assert.equal(work.content.language, 'und', 'UI language and CJK text do not establish original language')
  assert.equal(work.languageBasis.kind, 'unknown')
  assert.equal(work.body, 'The accepted current production.\n')
  assert.equal(work.drafts.article.text, 'The separate article draft.\n')
  assert.equal(work.drafts.article.aiText, 'The fixed article AI original.\n')
  assert.equal(work.drafts.script.text, 'The separate script draft.\n')
  assert.equal(work.drafts.script.aiText, 'The fixed script AI original.\n')
  assert.equal(work.production.aiArticle, 'The fixed production AI original.\n')
  assert.deepEqual(work.customMetadata, { preserved: true })
  assert.equal(work.sourceContent.scope, 'idea')
  assert.match(await readFile(join(work.sourceContent.notesRoot, work.sourceContent.relativePath), 'utf8'), /未标明语言的原始选题。/)
  assert.deepEqual(Object.keys(work.otherLang).sort(), ['en', 'zh'])
  const saved = JSON.parse(await readFile(join(data, 'state.json'), 'utf8'))
  assert.equal(saved.version, 2)
  assert.equal(saved.notesMigration.id, migration.value.migration.id)
  assert.equal(saved.items[0].body, undefined)
  for (const variant of Object.values(saved.items[0].otherLang)) {
    assert.equal(variant.body, undefined)
    assert.equal(variant.production?.article, undefined)
    for (const draft of Object.values(variant.drafts ?? {})) assert.equal(draft.text, undefined)
  }
  const backups = (await runtime.host('notes/migrations')).value.migrations
  const backup = backups.find(row => row.id === migration.value.migration.id)
  assert.equal(backup.verified, true)
  assert.equal(await readFile(join(backup.path, 'state.json'), 'utf8'), original)
  const beforeFiles = await readdir(join(work.content.notesRoot, 'history', work.id))
  const repeated = await runtime.host('notes/migrate', {})
  assert.deepEqual(repeated.value.acceptance, migration.value.acceptance)
  assert.deepEqual(await readdir(join(work.content.notesRoot, 'history', work.id)), beforeFiles)
  const switched = await runtime.host('notes/language', { id: work.id, language: 'en', expectedContent: work.content })
  assert.equal(switched.status, 200, JSON.stringify(switched.value))
  const english = switched.value.state.items.find(row => row.id === work.id)
  assert.equal(english.body, 'The English accepted production.\n')
  assert.equal(english.production.aiArticle, 'The English fixed AI original.\n')
  assert.ok(english.content.revision > work.content.revision)
  const stale = await runtime.host('ops', { expectedContent: { [work.id]: work.content }, ops: [{ op: 'update_item', id: work.id, body: 'Late wrong-language replacement.' }] })
  assert.equal(stale.status, 409)
  await runtime.stop()
  await runtime.start()
  const restored = (await runtime.host('state')).value.state.items.find(row => row.id === work.id)
  const back = await runtime.host('notes/language', { id: work.id, language: 'und', expectedContent: restored.content })
  assert.equal(back.status, 200, JSON.stringify(back.value))
  assert.equal(back.value.state.items.find(row => row.id === work.id).body, 'The accepted current production.\n')
  const association = (await runtime.host('sessions/open', { workId: work.id })).value.association
  assert.equal(association.sessionId, opened.value.association.sessionId)
  await assert.rejects(readFile(runtime.telemetryPath), { code: 'ENOENT' })
  const current = back.value.state.items.find(row => row.id === work.id)
  const later = await runtime.host('ops', { resultKey: 'post-migration-edit', expectedContent: { [work.id]: current.content }, ops: [{ op: 'update_item', id: work.id, body: 'Post-migration accepted text to retain.\n' }] })
  assert.equal(later.status, 200, JSON.stringify(later.value))
  const input = await runtime.prompt(association.sessionId, 'MD_FIXTURE_POST_MIGRATION_HISTORY')
  assert.equal((await runtime.turn(association.sessionId, input)).end.data.reason.kind, 'completed')
  const events = await runtime.events(association.sessionId)
  const model = await readFile(runtime.telemetryPath, 'utf8')
  await runtime.stop()
  const nativeBefore = await diskFiles(join(runtime.home, 'sessions'))
  const postState = await readFile(join(data, 'state.json'), 'utf8')
  const command = fileURLToPath(new URL('../src/notes-rollback.js', import.meta.url))
  const rollback = async () => JSON.parse((await execute(process.execPath, [command, migration.value.migration.id], {
    cwd: runtime.wiki, env: { ...process.env, DSH_HOME: runtime.home, WIKI_PATH: runtime.wiki }, timeout: 60000,
  })).stdout)
  const restoredBackup = await rollback()
  assert.equal(restoredBackup.verified, true)
  assert.equal(await readFile(join(data, 'state.json'), 'utf8'), original)
  assert.equal(await readFile(join(restoredBackup.retainedPath, 'state.json'), 'utf8'), postState)
  assert.equal(restoredBackup.nativeSessionIds.includes(association.sessionId), true)
  assert.deepEqual(await diskFiles(join(runtime.home, 'sessions')), nativeBefore)
  assert.match(await readFile(join(work.content.notesRoot, work.content.relativePath), 'utf8'), /Post-migration accepted text to retain/)
  assert.deepEqual(await rollback(), restoredBackup)
  await runtime.start()
  const originalView = (await runtime.host('state')).value.state.items.find(row => row.id === work.id)
  assert.equal(originalView.body, '未标明语言的原始选题。\n')
  const oldAssociation = (await runtime.host('sessions/open', { workId: work.id })).value.association
  assert.equal(oldAssociation.sessionId, association.sessionId)
  const reopenedEvents = await runtime.events(association.sessionId)
  assert.deepEqual(reopenedEvents.slice(0, events.length), events)
  assert.equal(reopenedEvents.filter(event => event.type === 'turn/start').length, events.filter(event => event.type === 'turn/start').length)
  assert.equal(await readFile(runtime.telemetryPath, 'utf8'), model)
})

test('读时语言迁移保留原语言与外部修改，重叠迟到写入在语言切换后被拒绝', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t)
  const data = join(runtime.home, 'media-desk')
  await mkdir(data)
  const state = legacyState()
  state.items[0].id = 'seed_2'
  state.items[0].sample = true
  delete state.items[0].otherLang.zh
  state.metrics[0].itemId = 'seed_2'
  const original = JSON.stringify(state)
  await writeFile(join(data, 'state.json'), original)
  await runtime.start([], { NODE_OPTIONS: '--inspect=127.0.0.1:0' })
  const englishRead = await runtime.host('state', undefined, { 'x-media-desk-lang': 'en' })
  assert.equal(englishRead.status, 200, JSON.stringify(englishRead.value))
  const english = englishRead.value.state.items.find(row => row.id === 'seed_2')
  assert.equal(english.content.language, 'en')
  assert.equal(english.body, 'The English accepted production.\n')
  assert.equal(english.otherLang.zh.content.language, 'zh')
  const backups = (await runtime.host('notes/migrations')).value.migrations
  assert.equal(await readFile(join(backups[0].path, 'state.json'), 'utf8'), original)
  const path = join(english.content.notesRoot, english.content.relativePath)
  await writeFile(path, (await readFile(path, 'utf8')).replace('The English accepted production.', 'An external English version to preserve.'))
  const client = await inspectRuntime(t, runtime)
  const point = await client.breakAt('/src/store.js', 'const temporary = this.file +', `state.items.find(row => row.id === 'seed_2')?.content?.language === 'zh'`)
  const pause = point.next()
  const switchRequest = runtime.host('state', undefined, { 'x-media-desk-lang': 'zh' }).then(value => ({ value }), error => ({ error: error.message }))
  await pause
  const late = runtime.host('ops', { expectedContent: { seed_2: english.content }, ops: [{ op: 'update_item', id: 'seed_2', body: 'A late edit from the English editor.' }] }).then(value => ({ value }), error => ({ error: error.message }))
  await point.remove()
  await client.send('Debugger.resume')
  const switched = await switchRequest
  assert.equal(switched.value.status, 200, JSON.stringify(switched))
  const chinese = switched.value.value.state.items.find(row => row.id === 'seed_2')
  assert.equal(chinese.body, 'The accepted current production.\n')
  assert.ok(chinese.content.revision > english.content.revision)
  const stale = await late
  assert.equal(stale.value.status, 409, JSON.stringify(stale))
  assert.equal(stale.value.value.code, 'notes/conflict')
  const back = await runtime.host('state', undefined, { 'x-media-desk-lang': 'en' })
  assert.equal(back.value.state.items.find(row => row.id === 'seed_2').body, 'An external English version to preserve.\n')
  assert.ok(back.value.state.items.find(row => row.id === 'seed_2').content.revision > chinese.content.revision)
  await assert.rejects(readFile(runtime.telemetryPath), { code: 'ENOENT' })
})

test('迁移后删除与撤销保留已创作字段和主文件，不能恢复旧运行阶段或降低版本', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t)
  const data = join(runtime.home, 'media-desk')
  await mkdir(data)
  const state = legacyState()
  delete state.items[0].otherLang
  state.items[0].production = { status: 'running', stage: 'drawing', attemptId: 'retired-runtime-attempt', startedAt: '2026-11-03T12:00:00Z',
    title: 'Retain the authored title', article: 'Retain the previous production text.\n', coverText: 'Retain cover words', cover: { src: 'media-desk/files/accepted-cover.png', status: 'done', prompt: 'Retain the accepted visual prompt' } }
  await writeFile(join(data, 'state.json'), JSON.stringify(state))
  await runtime.start()
  const migration = await runtime.host('notes/migrate', {})
  assert.equal(migration.status, 200, JSON.stringify(migration.value))
  const work = migration.value.state.items[0]
  const removed = await runtime.host('ops', { expectedContent: { [work.id]: work.content }, ops: [{ op: 'delete_item', id: work.id }] })
  assert.equal(removed.status, 200)
  const saved = JSON.parse(await readFile(join(data, 'state.json'), 'utf8'))
  assert.equal(JSON.stringify(saved.notesUndo).includes('retired-runtime-attempt'), false)
  assert.equal(JSON.stringify(saved.notesUndo).includes('"revision"'), false)
  const undone = await runtime.host('undo', { id: removed.value.undoId })
  assert.equal(undone.status, 200, JSON.stringify(undone.value))
  const restored = undone.value.state.items.find(row => row.id === work.id)
  assert.equal(restored.production.title, 'Retain the authored title')
  assert.equal(restored.production.coverText, 'Retain cover words')
  assert.equal(restored.production.cover.src, 'media-desk/files/accepted-cover.png')
  assert.equal(restored.production.status, undefined)
  assert.equal(restored.production.stage, undefined)
  assert.equal(restored.production.attemptId, undefined)
  assert.equal(restored.production.startedAt, undefined)
  assert.equal(restored.body, work.body)
  assert.ok(restored.content.revision > work.content.revision)
  await assert.rejects(readFile(runtime.telemetryPath), { code: 'ENOENT' })
})

test('迁移不覆盖未登记的同名文件，显式登记保留重复语言历史并迁移其他语言', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t)
  const data = join(runtime.home, 'media-desk')
  await mkdir(data)
  const state = legacyState()
  const original = JSON.stringify(state)
  await writeFile(join(data, 'state.json'), original)
  await mkdir(join(runtime.wiki, 'notes', 'works'), { recursive: true })
  const relativePath = 'works/populated_work-en.md'
  const path = join(runtime.wiki, 'notes', relativePath)
  const external = '---\nformat: 1\nkind: work\nid: populated_work\ntitle: Explicit external English work\ncreatedAt: 2026-11-01T12:00:00Z\nupdatedAt: 2026-11-04T12:00:00Z\nlanguage: en\ntags: [external]\nsources: []\n---\n\nThe externally selected current English body.\n'
  await writeFile(path, external)
  await runtime.start()
  const rejected = await runtime.host('notes/migrate', {})
  assert.equal(rejected.status, 409, JSON.stringify(rejected.value))
  assert.equal(rejected.value.code, 'notes/migration-path-conflict')
  assert.equal(await readFile(path, 'utf8'), external)
  assert.equal(await readFile(join(data, 'state.json'), 'utf8'), original)
  const registered = await runtime.host('notes/register', { id: 'populated_work', language: 'en', relativePath })
  assert.equal(registered.status, 200, JSON.stringify(registered.value))
  const work = registered.value.state.items.find(row => row.id === 'populated_work')
  assert.equal(work.body, 'The externally selected current English body.\n')
  assert.equal(await readFile(path, 'utf8'), external)
  assert.equal(work.otherLang.zh.content.language, 'zh')
  assert.equal(work.drafts.article.aiText, state.items[0].drafts.article.aiText)
  const archived = work.languageHistory.find(row => row.language === 'en').version
  const archivedBytes = await readFile(join(archived.notesRoot, archived.relativePath), 'utf8')
  assert.deepEqual(JSON.parse(archivedBytes.slice(archivedBytes.indexOf('---\n\n') + 5)), state.items[0].otherLang.en)
  const saved = JSON.parse(await readFile(join(data, 'state.json'), 'utf8'))
  assert.equal(saved.items[0].otherLang.zh.body, undefined)
  assert.equal(saved.items[0].languageHistory[0].version.role, 'legacy-language')
})

test('多语言迁移在首次实际发布后终止，冷恢复及重试复用同一候选与已验证备份', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t)
  const data = join(runtime.home, 'media-desk')
  await mkdir(data)
  const original = JSON.stringify(legacyState())
  await writeFile(join(data, 'state.json'), original)
  await runtime.start([], { NODE_OPTIONS: '--inspect=127.0.0.1:0' })
  const client = await inspectRuntime(t, runtime)
  const point = await client.breakAt('/src/notes-writes.js', "entry.phase = 'published'", "record.resultKey.startsWith('migrate:')", 1)
  const pause = point.next()
  const operation = runtime.host('notes/migrate', {}).then(value => ({ value }), error => ({ error: error.message }))
  const paused = await pause
  const record = await client.value(paused, 'record')
  const primary = await client.value(paused, 'entry.after')
  assert.equal(await readFile(join(primary.notesRoot, primary.relativePath), 'utf8'), await readFile(join(record.files[0].candidate.notesRoot, record.files[0].candidate.relativePath), 'utf8'))
  assert.equal(await readFile(join(data, 'state.json'), 'utf8'), original)
  await runtime.stop('SIGKILL')
  assert.ok((await operation).error)
  await runtime.start()
  const recovered = await runtime.host('state')
  assert.equal(recovered.value.state.items[0].body, '未标明语言的原始选题。\n')
  const retry = await runtime.host('notes/migrate', {})
  assert.equal(retry.status, 200, JSON.stringify(retry.value))
  assert.equal(retry.value.acceptance.id, record.id)
  assert.equal(retry.value.migration.id, record.resultKey.slice(8))
  assert.equal(retry.value.acceptance.contentVersions.length, 3)
  const backups = (await runtime.host('notes/migrations')).value.migrations
  assert.equal(backups.length, 1)
  assert.equal(backups[0].verified, true)
  assert.equal(await readFile(join(backups[0].path, 'state.json'), 'utf8'), original)
  assert.equal((await runtime.host('notes/retry', { id: record.id })).value.acceptance.id, record.id)
  await assert.rejects(readFile(runtime.telemetryPath), { code: 'ENOENT' })
})
