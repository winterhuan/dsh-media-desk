/** Native file edits share the workbench's Notes owner; validation has no save side effects. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeWork } from '../src/native-work.js'
import { Notes } from '../src/notes.js'
import { nativeRuntime } from './fixtures/native-runtime.js'

test('校验作品、材料和偏好只读当前字节，不刷新状态、历史或索引', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'media-desk-validation-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const notes = new Notes({ wikiRoot: root, notesRoot: root, notesRoots: [root], dataRoot: root })
  const now = '2026-11-21T00:00:00Z'
  const reference = (relativePath, language) => ({ notesRoot: root, relativePath, ...(language && { language }), sha256: 'unchanged', revision: 1 })
  const item = { id: 'work', title: 'Original', body: 'Original body.', createdAt: now, language: 'en', content: reference('works/work.md', 'en') }
  const other = { ...item, id: 'other', content: reference('works/other.md', 'en') }
  const style = { id: 'style', name: 'Style', summary: 'Concrete sentences.', content: reference('preferences/styles/style.md') }
  const rule = { id: 'rule', name: 'Rule', rule: 'Check dates.', content: reference('preferences/rules/rule.md') }
  const voice = { text: 'Personal voice.', content: reference('preferences/voice.md') }
  const material = { title: 'Material', body: 'Source text.' }
  item.materialContent = reference('materials/work.md')
  const state = { items: [item, other], styles: [style], skills: [rule], voice }
  const file = join(root, 'state.json')
  const documents = [
    [item.content, notes.document(item)], [other.content, notes.document(other)],
    [style.content, notes.managedDocument('style', style.id, style)],
    [rule.content, notes.managedDocument('rule', rule.id, rule)],
    [voice.content, notes.managedDocument('voice', 'personal-voice', voice)],
    [item.materialContent, notes.managedDocument('material', item.id, material)],
  ]
  for (const [ref, bytes] of documents) {
    await mkdir(join(root, ref.relativePath, '..'), { recursive: true })
    await writeFile(join(root, ref.relativePath), bytes)
  }
  await writeFile(file, JSON.stringify(state))
  await writeFile(join(root, 'index.md'), '# Existing index\n')
  const sessions = { requireAssociation: agent => ({ workId: agent.workId }) }
  const work = new NativeWork({}, { file, notes, read() { throw new Error('Validation must not hydrate Store') } }, sessions)
  const exec = workId => ({ agent: { workId }, signal: new AbortController().signal })
  const validate = (ref, workId = null) => work.validate(exec(workId), { file_path: join(root, ref.relativePath) })
  const snapshot = async () => {
    const files = (await readdir(root, { recursive: true })).sort()
    const entries = []
    for (const relativePath of files) {
      const path = join(root, relativePath)
      const info = await stat(path)
      if (info.isFile()) entries.push([relativePath, (await readFile(path)).toString('hex'), info.mtimeMs, info.ino])
    }
    return entries
  }
  await writeFile(join(root, item.content.relativePath), notes.document({ ...item, title: 'Direct edit', body: 'Agent-written body.' }))
  const before = await snapshot()
  for (const [ref] of documents) {
    const result = await validate(ref)
    assert.equal(result.valid, true, JSON.stringify(result))
  }
  assert.equal((await validate(item.content, item.id)).valid, true)
  assert.deepEqual(await snapshot(), before)

  for (const bytes of ['---\ntitle: [\n---\n', notes.document({ ...item, id: 'wrong' }), notes.document({ ...item, language: 'zh' })]) {
    await writeFile(join(root, item.content.relativePath), bytes)
    const invalid = await snapshot()
    const result = await validate(item.content, item.id)
    assert.equal(result.valid, false)
    assert.match(result.errors[0].code, /^notes\/(metadata-invalid|identity-mismatch)$/)
    assert.deepEqual(await snapshot(), invalid)
  }
  await assert.rejects(validate(other.content, item.id), { code: 'native/file-unregistered' })
  await assert.rejects(validate(style.content, item.id), { code: 'native/file-unregistered' })
  await assert.rejects(work.validate(exec(null), { file_path: 'works/work.md' }), { code: 'native/file-path' })
  await assert.rejects(work.validate(exec(null), { file_path: join(root, 'index.md') }), { code: 'native/file-unregistered' })
})

test('原生 Agent 直接编辑文件并修复格式，工作台刷新版本、历史和索引', { timeout: 180000 }, async t => {
  const recipes = {}
  const runtime = await nativeRuntime(t, { recipes })
  await runtime.start()
  const added = await runtime.host('ops', { ops: [{ op: 'add_item', title: 'Native file editing', body: 'Original body.', language: 'en' }] })
  assert.equal(added.status, 200)
  const id = added.value.receipts[0].target
  const initial = added.value.state
  const original = initial.items.find(row => row.id === id)
  const path = join(original.content.notesRoot, original.content.relativePath)
  const originalBytes = await readFile(path, 'utf8')
  const association = (await runtime.host('sessions/open', { workId: id })).value.association
  const check = { name: 'media_desk_validate', arguments: { file_path: path } }
  recipes.MD_FIXTURE_FILES = { calls: [
    { name: 'media_desk_read', arguments: { kind: 'work' } },
    { name: 'read', arguments: { file_path: path } },
    { name: 'edit', arguments: { file_path: path, old_string: 'Original body.', new_string: 'Written directly by the Agent.' } }, check,
    { name: 'edit', arguments: { file_path: path, old_string: 'kind: work', new_string: 'kind: invalid' } }, check,
    { name: 'write', arguments: { file_path: path, content: originalBytes.replace('Original body.', 'Written directly by the Agent.').replace('title: Native file editing', 'title: A directly edited title') } }, check,
  ], reply: 'The file was edited and its format checked.' }
  recipes.MD_FIXTURE_VALIDATE = { calls: [check], reply: 'Read-only format check completed.' }
  recipes.MD_FIXTURE_FILE_FAILURE = { calls: [
    { name: 'read', arguments: { file_path: path } },
    { name: 'edit', arguments: { file_path: path, old_string: 'Written directly by the Agent.', new_string: 'The file survives a failed turn.' } }, check,
  ], failAt: 3 }
  await runtime.stop()
  await runtime.start()
  const baseline = JSON.parse(await readFile(join(runtime.home, 'media-desk', 'state.json'), 'utf8'))
  const request = await runtime.prompt(association.sessionId, 'MD_FIXTURE_FILES: directly edit this work and repair any format errors.')
  const turn = await runtime.turn(association.sessionId, request)
  assert.equal(turn.end.data.reason.kind, 'completed')
  const results = turn.events.filter(row => row.type === 'tool/result')
  assert.equal(results.length, 8)
  assert.ok(results.every(row => !row.data.message.isError), JSON.stringify(results))
  const value = index => JSON.parse(results[index].data.message.content[0].text)
  assert.equal(value(3).valid, true)
  assert.equal(value(5).valid, false)
  assert.equal(value(5).errors[0].code, 'notes/metadata-invalid')
  assert.equal(value(7).valid, true)
  const state = (await runtime.host('state')).value.state
  const current = state.items.find(row => row.id === id)
  assert.equal(current.body, 'Written directly by the Agent.')
  assert.equal(current.title, 'A directly edited title')
  assert.ok(current.content.revision > original.content.revision)
  assert.ok(current.textHistory.some(row => row.sha256 === original.content.sha256))
  const saved = JSON.parse(await readFile(join(runtime.home, 'media-desk', 'state.json'), 'utf8'))
  assert.deepEqual(saved.receipts, baseline.receipts)
  assert.deepEqual(saved.notesUndo, baseline.notesUndo)
  assert.match(await readFile(join(original.content.notesRoot, 'index.md'), 'utf8'), /A directly edited title/)
  const readonlyRequest = await runtime.prompt(association.sessionId, 'Read-only MD_FIXTURE_VALIDATE: check format without modifying anything.')
  const readonlyTurn = await runtime.turn(association.sessionId, readonlyRequest)
  const readonlyResult = readonlyTurn.events.find(row => row.type === 'tool/result')
  assert.equal(readonlyResult.data.message.isError, false)
  assert.equal(JSON.parse(readonlyResult.data.message.content[0].text).valid, true)
  const failedRequest = await runtime.prompt(association.sessionId, 'MD_FIXTURE_FILE_FAILURE: edit the file before the model fails.')
  const failedTurn = await runtime.turn(association.sessionId, failedRequest)
  assert.equal(failedTurn.end.data.reason.kind, 'error')
  assert.match(await readFile(path, 'utf8'), /The file survives a failed turn/)
  const afterFailure = (await runtime.host('state')).value.state.items.find(row => row.id === id)
  assert.equal(afterFailure.body, 'The file survives a failed turn.')
  const telemetry = (await readFile(runtime.telemetryPath, 'utf8')).trim().split('\n').map(JSON.parse)
  const context = JSON.stringify(telemetry.find(row => row.marker === 'MD_FIXTURE_FILES').context)
  assert.match(context, /use edit or write directly/)
  assert.doesNotMatch(context, /Registered creative materials use Media Desk business operations|Do not write registered creative files/)
})
