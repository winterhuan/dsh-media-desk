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

test('只有收藏来源的导入条目在首次创作前沿用已有会话目录登记作品，成稿和首份草稿均保留独立材料', { timeout: 180000 }, async t => {
  const recipes = {}
  const runtime = await nativeRuntime(t, { recipes })
  const barrier = Object.fromEntries(['enteredPath', 'releasePath', 'abortedPath', 'settledPath'].map(name => [name, join(runtime.root, name)]))
  const plan = { title: 'New work based on imported source', coverText: 'Source', cover: 'Paper', facts: [], outline: [], images: [], shots: [], sources: [] }
  const article = 'A newly accepted article based on that material.\n'
  const read = { name: 'media_desk_read', arguments: { kind: 'work' } }
  recipes.MD_STAGE_plan = { calls: [read, { name: 'media_desk_submit_result', arguments: { stageId: '$stageId', result: JSON.stringify(plan) } }], barrier: { ...barrier, at: 0 }, reply: 'Plan candidate submitted.' }
  recipes.MD_STAGE_article = { calls: [read, { name: 'media_desk_submit_result', arguments: { stageId: '$stageId', result: JSON.stringify({ article, sources: [] }) } }], reply: 'Article candidate submitted.' }
  const source = { id: 'imported-source-only', imported: true, kind: 'note', title: 'The collected source', body: 'The independently collected source material.\n',
    source: 'Independent source', createdAt: '2026-11-01T12:00:00Z', collectedAt: '2026-11-01T12:00:00Z', status: 'ready', drafts: {} }
  const draftSource = { ...source, id: 'imported-first-draft', title: 'The draft source' }
  const resetSource = { ...source, id: 'imported-after-reset', title: 'The source with a new conversation' }
  const data = join(runtime.home, 'media-desk')
  await mkdir(data)
  await writeFile(join(data, 'state.json'), JSON.stringify({ version: 1, sampleCleared: true, items: [source, draftSource, resetSource], styles: [], skills: [], people: [], angles: [], accounts: [], metrics: [], chat: [] }))
  await runtime.start()
  const migrated = await runtime.host('notes/migrate', {})
  assert.equal(migrated.status, 200, JSON.stringify(migrated.value))
  const imported = migrated.value.state.items.find(row => row.id === source.id)
  assert.equal(imported.content, undefined)
  const materialPath = join(imported.materialContent.notesRoot, imported.materialContent.relativePath)
  const materialBytes = await readFile(materialPath, 'utf8')
  const importedDraft = migrated.value.state.items.find(row => row.id === draftSource.id)
  const draftMaterialPath = join(importedDraft.materialContent.notesRoot, importedDraft.materialContent.relativePath)
  const draftMaterialBytes = await readFile(draftMaterialPath, 'utf8')
  const importedReset = migrated.value.state.items.find(row => row.id === resetSource.id)
  const resetMaterialPath = join(importedReset.materialContent.notesRoot, importedReset.materialContent.relativePath)
  const resetMaterialBytes = await readFile(resetMaterialPath, 'utf8')
  const opened = await runtime.host('sessions/open', { workId: source.id })
  assert.equal(opened.status, 200, JSON.stringify(opened.value))
  const association = opened.value.association
  const openedReset = await runtime.host('sessions/open', { workId: resetSource.id })
  assert.equal(openedReset.status, 200, JSON.stringify(openedReset.value))
  assert.equal(openedReset.value.association.wikiRoot, association.wikiRoot)
  const secondWiki = join(runtime.root, 'second-wiki')
  await mkdir(secondWiki)
  await writeFile(join(secondWiki, 'AGENTS.md'), 'Use llm-wiki and keep source dates.\n')
  await runtime.stop()
  await runtime.start([], { WIKI_PATH: secondWiki })
  const reset = await runtime.host('chat/clear', { workId: resetSource.id })
  assert.equal(reset.status, 200, JSON.stringify(reset.value))
  const resetAssociation = reset.value.association
  assert.notEqual(resetAssociation.sessionId, openedReset.value.association.sessionId)
  assert.notEqual(resetAssociation.wikiRoot, association.wikiRoot)
  await runtime.host('settings', { imageCount: 0, shotCount: 0 })
  const admitted = await Promise.all([runtime.host('produce', { id: source.id }), runtime.host('produce', { id: resetSource.id })])
  for (const response of admitted) assert.equal(response.status, 200, JSON.stringify(response.value))
  const pending = (await runtime.host('state')).value.state
  const promoted = pending.items.find(row => row.id === source.id)
  const stage = pending.nativeRequests.find(row => row.workId === source.id && row.kind === 'plan')
  assert.equal(promoted.content?.status, 'ready')
  assert.equal(promoted.content.notesRoot, association.notesRoot)
  assert.equal(promoted.content.wikiRoot, association.wikiRoot)
  assert.equal(stage.sessionId, association.sessionId)
  assert.equal(promoted.content.language, 'und')
  assert.deepEqual(stage.expectedContent[source.id], promoted.content)
  assert.deepEqual(stage.data.materialVersion, promoted.content.snapshot)
  assert.equal(stage.data.language, promoted.content.language)
  assert.equal(promoted.sourceMaterial.body, source.body)
  const promotedReset = pending.items.find(row => row.id === resetSource.id)
  const resetStage = pending.nativeRequests.find(row => row.workId === resetSource.id && row.kind === 'plan')
  assert.equal(promotedReset.content.notesRoot, resetAssociation.notesRoot)
  assert.equal(promotedReset.content.wikiRoot, resetAssociation.wikiRoot)
  assert.equal(resetStage.sessionId, resetAssociation.sessionId)
  assert.deepEqual(resetStage.expectedContent[resetSource.id], promotedReset.content)
  assert.deepEqual(resetStage.data.materialVersion, promotedReset.content.snapshot)
  await writeFile(barrier.releasePath, 'release\n')
  // Two plan/article Session pairs share Host and filesystem capacity during the concurrent suite.
  const deadline = Date.now() + 120000
  let completed, resetCompleted
  while (Date.now() < deadline) {
    const state = (await runtime.host('state')).value.state
    completed = state.items.find(row => row.id === source.id)
    resetCompleted = state.items.find(row => row.id === resetSource.id)
    if (completed.production.status === 'done' && resetCompleted.production.status === 'done') break
    assert.ok(!state.nativeRequests.some(row => ['failed', 'save-failed'].includes(row.status)), JSON.stringify(state.nativeRequests) + runtime.log)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.equal(completed.production.status, 'done', runtime.log)
  assert.equal(resetCompleted.production.status, 'done', runtime.log)
  assert.equal(resetCompleted.body, article)
  assert.equal(resetCompleted.sourceMaterial.body, resetSource.body)
  assert.equal(await readFile(resetMaterialPath, 'utf8'), resetMaterialBytes)
  assert.equal(completed.production.article, article)
  assert.equal(completed.body, article)
  assert.equal(completed.sourceMaterial.body, source.body)
  assert.equal(completed.sourceMaterial.title, source.title)
  assert.equal(await readFile(materialPath, 'utf8'), materialBytes)
  assert.match(await readFile(join(completed.content.notesRoot, completed.content.relativePath), 'utf8'), /A newly accepted article/)
  const savedDraft = await runtime.host('ops', { ops: [{ op: 'save_draft', id: draftSource.id, format: 'script', text: 'The first independently accepted draft.\n' }] })
  assert.equal(savedDraft.status, 200, JSON.stringify(savedDraft.value))
  const drafted = savedDraft.value.state.items.find(row => row.id === draftSource.id)
  assert.equal(drafted.content.status, 'ready')
  assert.equal(drafted.body, 'The first independently accepted draft.\n')
  assert.equal(drafted.drafts.script.text, drafted.body)
  assert.equal(drafted.sourceMaterial.body, draftSource.body)
  assert.equal(await readFile(draftMaterialPath, 'utf8'), draftMaterialBytes)
  const durable = JSON.parse(await readFile(join(data, 'state.json'), 'utf8'))
  for (const work of durable.items) {
    assert.equal(work.body, undefined)
    assert.equal(work.production?.article, undefined)
    assert.equal(work.production?.aiArticle, undefined)
    assert.equal(work.sourceMaterial, undefined)
    for (const draft of Object.values(work.drafts ?? {})) { assert.equal(draft.text, undefined); assert.equal(draft.aiText, undefined) }
  }
  const requests = await readFile(runtime.telemetryPath, 'utf8')
  await runtime.stop()
  await runtime.start([], { WIKI_PATH: secondWiki })
  const cold = (await runtime.host('state')).value.state
  assert.equal(cold.items.find(row => row.id === source.id).body, article)
  assert.equal(cold.items.find(row => row.id === resetSource.id).body, article)
  assert.equal(cold.items.find(row => row.id === resetSource.id).content.notesRoot, resetAssociation.notesRoot)
  assert.equal(cold.items.find(row => row.id === draftSource.id).body, drafted.body)
  assert.equal(cold.items.find(row => row.id === source.id).sourceMaterial.body, source.body)
  assert.equal(await readFile(materialPath, 'utf8'), materialBytes)
  assert.equal(await readFile(runtime.telemetryPath, 'utf8'), requests)
})

test('收藏材料带成稿和语言稿时分别迁移原始来源与唯一作品正文', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t)
  const data = join(runtime.home, 'media-desk')
  await mkdir(data)
  const legacy = legacyState()
  Object.assign(legacy.items[0], { imported: true, collectedAt: '2026-11-01T12:00:00Z', materialType: 'source', completeness: 'complete' })
  await writeFile(join(data, 'state.json'), JSON.stringify(legacy))
  await runtime.start()
  const migrated = await runtime.host('notes/migrate', {})
  assert.equal(migrated.status, 200, JSON.stringify(migrated.value))
  const work = migrated.value.state.items[0]
  assert.equal(work.body, 'The accepted current production.\n')
  assert.equal(work.sourceMaterial.body, legacy.items[0].body)
  assert.equal(work.sourceMaterial.title, legacy.items[0].title)
  assert.equal(work.sourceMaterial.source, legacy.items[0].source)
  const materialPath = join(work.materialContent.notesRoot, work.materialContent.relativePath)
  const materialBytes = await readFile(materialPath, 'utf8')
  assert.match(materialBytes, /未标明语言的原始选题。/)
  assert.doesNotMatch(materialBytes, /The accepted current production/)
  const primary = join(work.content.notesRoot, work.content.relativePath)
  await writeFile(primary, (await readFile(primary, 'utf8')).replace('The accepted current production.', 'The externally edited current work.').replace('原有作品标题', 'Externally edited work title').replace('Original source', 'Edited work source'))
  const current = (await runtime.host('state')).value.state.items[0]
  assert.equal(current.body, 'The externally edited current work.\n')
  assert.equal(current.production.article, current.body)
  assert.equal(current.title, 'Externally edited work title')
  assert.equal(current.source, 'Edited work source')
  assert.deepEqual(current.materialContent, work.materialContent)
  assert.equal(current.sourceMaterial.body, legacy.items[0].body)
  const changed = await runtime.host('ops', { expectedContent: { [current.id]: current.content }, ops: [{ op: 'update_item', id: current.id, body: 'A newly accepted current work.\n' }] })
  assert.equal(changed.status, 200, JSON.stringify(changed.value))
  assert.equal(await readFile(materialPath, 'utf8'), materialBytes)
  await writeFile(materialPath, materialBytes.replace('未标明语言的原始选题。', 'An independently edited source collection.').replace('原有作品标题', 'Edited source title'))
  const reread = (await runtime.host('state')).value.state.items[0]
  assert.equal(reread.body, 'A newly accepted current work.\n')
  assert.equal(reread.production.article, reread.body)
  assert.equal(reread.title, 'Externally edited work title')
  assert.equal(reread.sourceMaterial.body, 'An independently edited source collection.\n')
  assert.equal(reread.sourceMaterial.title, 'Edited source title')
  assert.equal(reread.materialContent.revision, work.materialContent.revision + 1)
  const switched = await runtime.host('notes/language', { id: work.id, language: 'en', expectedContent: reread.content })
  assert.equal(switched.status, 200, JSON.stringify(switched.value))
  assert.equal(switched.value.state.items[0].body, 'The English accepted production.\n')
  assert.equal(switched.value.state.items[0].sourceMaterial.body, reread.sourceMaterial.body)
  await runtime.stop()
  await runtime.start()
  const cold = (await runtime.host('state')).value.state.items[0]
  assert.equal(cold.body, switched.value.state.items[0].body)
  assert.deepEqual(cold.sourceMaterial, reread.sourceMaterial)
  const saved = JSON.parse(await readFile(join(data, 'state.json'), 'utf8')).items[0]
  assert.equal(saved.body, undefined)
  assert.equal(saved.sourceMaterial, undefined)
  await assert.rejects(readFile(runtime.telemetryPath), { code: 'ENOENT' })
})

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
  const beforeFiles = await readdir(join(work.content.notesRoot, '.media-desk', 'history', work.id))
  const repeated = await runtime.host('notes/migrate', {})
  assert.deepEqual(repeated.value.acceptance, migration.value.acceptance)
  assert.deepEqual(await readdir(join(work.content.notesRoot, '.media-desk', 'history', work.id)), beforeFiles)
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

test('材料与写作偏好迁入 Notes，外部编辑供读取、成稿快照和当前导出共同使用', { timeout: 240000 }, async t => {
  const runtime = await nativeRuntime(t)
  const data = join(runtime.home, 'media-desk')
  await mkdir(data)
  const state = legacyState()
  state.items.push({ id: 'saved_source', kind: 'web', title: 'Collected complete source', body: 'The complete collected source text.\n', tags: ['research'], source: 'Original author',
    url: 'https://example.com/complete', createdAt: '2026-10-20T08:00:00Z', publishedAt: '2026-10-19T08:00:00Z', status: 'published', personaIds: [], drafts: {}, imported: true,
    materialType: 'source', completeness: 'complete', externalId: 'X:source-1' })
  Object.assign(state.styles[0], { summary: 'Legacy summary', samples: ['Selected author excerpt.'], source: 'Selected author', sourceUrls: ['https://example.com/author'] })
  Object.assign(state.skills[0], { source: 'Review', evidence: 'Two accepted edits', confidence: 0.8 })
  await writeFile(join(data, 'state.json'), JSON.stringify(state))
  await writeFile(join(data, 'settings.json'), JSON.stringify({ voice: 'Legacy personal voice.', imageCount: 0, shotCount: 0 }))
  await mkdir(join(runtime.wiki, 'notes'), { recursive: true })
  const unrelated = '# Independent research\n\nDo not change these bytes.\n'
  await writeFile(join(runtime.wiki, 'notes', 'unrelated.md'), unrelated)
  await runtime.start()

  const migrated = await runtime.host('notes/migrate', {})
  assert.equal(migrated.status, 200, JSON.stringify(migrated.value) + '\n' + runtime.log)
  let custom = migrated.value.state.styles.find(row => row.id === 'custom-style')
  let rule = migrated.value.state.skills.find(row => row.id === 'legacy_rule')
  let material = migrated.value.state.items.find(row => row.id === 'saved_source')
  assert.equal(custom.content.relativePath, 'preferences/styles/custom-style.md')
  assert.equal(custom.sampleContent.relativePath, 'materials/custom-style-samples.md')
  assert.equal(rule.content.relativePath, 'preferences/rules/legacy_rule.md')
  assert.equal(migrated.value.state.voice.content.relativePath, 'preferences/voice.md')
  assert.equal(material.materialContent.relativePath, 'materials/saved_source.md')
  assert.equal(material.materialType, 'source')
  assert.equal(material.completeness, 'complete')
  assert.equal(material.source, 'Original author')
  assert.equal(material.createdAt, '2026-10-20T08:00:00Z')
  assert.equal(material.body, 'The complete collected source text.\n')
  const saved = JSON.parse(await readFile(join(data, 'state.json'), 'utf8'))
  assert.equal(saved.styles.find(row => row.id === custom.id).summary, undefined)
  assert.equal(saved.styles.find(row => row.id === custom.id).samples, undefined)
  assert.equal(saved.styles.find(row => row.id === custom.id).sampleMaterial, undefined)
  assert.equal(saved.skills.find(row => row.id === rule.id).rule, undefined)
  assert.equal(saved.voice.text, undefined)
  assert.equal(saved.items.find(row => row.id === material.id).body, undefined)
  assert.equal(saved.styles.find(row => row.preset).content, undefined)
  assert.equal(JSON.parse(await readFile(join(data, 'settings.json'), 'utf8')).voice, undefined)
  assert.equal(await readFile(join(runtime.wiki, 'notes', 'unrelated.md'), 'utf8'), unrelated)
  const index = await readFile(join(runtime.wiki, 'notes', 'index.md'), 'utf8')
  assert.match(index, /preferences\/styles\/custom-style\.md/)
  assert.match(index, /preferences\/rules\/legacy_rule\.md/)
  assert.match(index, /preferences\/voice\.md/)
  assert.match(index, /materials\/saved_source\.md/)
  assert.match(index, /materials\/custom-style-samples\.md/)
  const selectedSample = await readFile(join(custom.sampleContent.notesRoot, custom.sampleContent.relativePath), 'utf8')
  assert.match(selectedSample, /materialType: author-sample/)
  assert.match(selectedSample, /completeness: excerpt/)
  assert.match(selectedSample, /selectedAuthorSample: true/)
  assert.match(selectedSample, /Selected author excerpt\./)

  const stylePath = join(custom.content.notesRoot, custom.content.relativePath)
  const rulePath = join(rule.content.notesRoot, rule.content.relativePath)
  const voicePath = join(migrated.value.state.voice.content.notesRoot, migrated.value.state.voice.content.relativePath)
  const materialPath = join(material.materialContent.notesRoot, material.materialContent.relativePath)
  await writeFile(stylePath, (await readFile(stylePath, 'utf8')).replace('Original tone', 'Externally edited tone'))
  await writeFile(rulePath, (await readFile(rulePath, 'utf8')).replace('Preserved successor material', 'Externally edited active rule'))
  await writeFile(voicePath, (await readFile(voicePath, 'utf8')).replace('Legacy personal voice.', 'Externally edited personal voice.'))
  await writeFile(materialPath, (await readFile(materialPath, 'utf8')).replace('The complete collected source text.', 'The externally edited complete source.'))
  let reread = (await runtime.host('state')).value.state
  custom = reread.styles.find(row => row.id === custom.id)
  rule = reread.skills.find(row => row.id === rule.id)
  material = reread.items.find(row => row.id === material.id)
  assert.equal(custom.tone, 'Externally edited tone')
  assert.equal(rule.rule, 'Externally edited active rule')
  assert.equal(reread.voice.text, 'Externally edited personal voice.')
  assert.equal(material.body, 'The externally edited complete source.\n')
  const preferenceEdit = await runtime.host('ops', { ops: [
    { op: 'update_style', id: custom.id, tone: 'Workbench edited tone' },
    { op: 'update_skill', id: rule.id, rule: 'Workbench edited active rule' },
  ] })
  assert.equal(preferenceEdit.status, 200, JSON.stringify(preferenceEdit.value))
  assert.equal(preferenceEdit.value.undoable, false)
  assert.match(await readFile(stylePath, 'utf8'), /Workbench edited tone/)
  assert.match(await readFile(rulePath, 'utf8'), /Workbench edited active rule/)
  const settingsEdit = await runtime.host('settings', { voice: 'Personal voice edited through the workbench.' })
  assert.equal(settingsEdit.status, 200, JSON.stringify(settingsEdit.value))
  reread = (await runtime.host('state')).value.state
  assert.equal(reread.voice.text, 'Personal voice edited through the workbench.')
  assert.match(await readFile(voicePath, 'utf8'), /Personal voice edited through the workbench\./)
  assert.equal(JSON.parse(await readFile(join(data, 'settings.json'), 'utf8')).voice, undefined)
  custom = reread.styles.find(row => row.id === custom.id)
  rule = reread.skills.find(row => row.id === rule.id)

  const work = reread.items.find(row => row.id === 'populated_work')
  const started = await runtime.host('produce', { id: work.id })
  assert.equal(started.status, 200, JSON.stringify(started.value))
  const production = started.value.state.items.find(row => row.id === work.id).production
  assert.deepEqual(production.preferenceVersions, {
    voice: reread.voice.content.snapshot,
    style: custom.content.snapshot,
    rules: [rule.content.snapshot],
  })
  const exported = await runtime.host('skills/export', {})
  assert.equal(exported.status, 200, JSON.stringify(exported.value))
  const skill = await readFile(join(runtime.home, 'skills', 'media-desk-voice', 'SKILL.md'), 'utf8')
  assert.match(skill, /Workbench edited tone/)
  assert.match(skill, /Workbench edited active rule/)
  assert.doesNotMatch(skill, /Legacy personal voice/)
  const disabled = await runtime.host('ops', { ops: [{ op: 'update_skill', id: rule.id, status: 'proposed' }] })
  assert.equal(disabled.status, 200, JSON.stringify(disabled.value))
  const refreshed = await runtime.host('skills/export', {})
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.value))
  const activeOnly = await readFile(join(runtime.home, 'skills', 'media-desk-voice', 'SKILL.md'), 'utf8')
  assert.doesNotMatch(activeOnly, /Workbench edited active rule/)
  assert.match(activeOnly, /Workbench edited tone/)
  assert.equal(await readFile(join(runtime.wiki, 'notes', 'unrelated.md'), 'utf8'), unrelated)
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
  await mkdir(join(data, 'files'), { recursive: true })
  await writeFile(join(data, 'files', 'accepted-cover.png'), Buffer.from('89504e470d0a1a0a', 'hex'))
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
  assert.equal(restored.production.cover.src, work.production.cover.src)
  assert.match(restored.production.cover.src, /^media-desk\/media\//)
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
