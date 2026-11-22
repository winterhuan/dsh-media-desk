import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, readdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { Notes } from '../src/notes.js'
import { Store } from '../src/store.js'
import { DeskReader } from '../src/desk-reader.js'
import { applyOps } from '../src/ops.js'

async function setup(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'media-rule-files-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const wiki = join(root, 'wiki'), notesRoot = join(wiki, 'notes'), data = join(root, 'data')
  await mkdir(join(notesRoot, 'preferences/rules'), { recursive: true })
  const notes = new Notes({ wikiRoot: wiki, notesRoot, notesRoots: new Set([notesRoot]), dataRoot: data, selectedNotesRoot: notesRoot })
  const store = new Store(data)
  store.notes = notes
  const rule = { id: 's_direct', name: '机制标题', rule: '用小标题表达具体机制。', scope: '技术分析文章', evidence: '作者确认了小标题修改。',
    before: '原理一', after: '订阅给了上下文，没给授权', source: 'work-1 sha256 ' + 'a'.repeat(64) }
  const path = id => join(notesRoot, notes.managedPath('rule', id))
  const save = row => writeFile(path(row.id), notes.managedDocument('rule', row.id, row))
  return { root, wiki, notesRoot, data, notes, store, rule, path, save }
}

async function inventory(root) {
  const entries = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) entries.push(...await inventory(path))
    else if (entry.isFile()) entries.push([path, (await readFile(path)).toString('base64')])
  }
  return entries.sort(([a], [b]) => a.localeCompare(b))
}

test('Agent 新建规则可离线读取与校验，插件登记保留字节并持久化待审状态', async t => {
  const { root, wiki, data, notes, store, rule, path, save } = await setup(t)
  await save(rule)
  const bytes = await readFile(path(rule.id))
  const before = await inventory(root)
  const reader = await new DeskReader({ dataRoot: data, wikiRoot: wiki }).load()
  const prefs = await reader.read({ kind: 'preferences' })
  assert.equal(prefs.rules[0].registered, false)
  assert.equal(prefs.rules[0].status, 'proposed')
  assert.equal(prefs.rules[0].value.before, rule.before)
  assert.equal((await reader.file(path(rule.id))).valid, true)
  assert.deepEqual(await inventory(root), before)
  const first = await store.read()
  const registered = first.skills.find(row => row.id === rule.id)
  assert.equal(registered.status, 'proposed')
  assert.equal(registered.rule, rule.rule)
  assert.equal(registered.content.sha256, createHash('sha256').update(bytes).digest('hex'))
  assert.equal(registered.content.revision, 1)
  assert.equal(first.contentRevisions['rule:' + rule.id], 1)
  assert.ok(registered.content.snapshot)
  const stateBytes = await readFile(store.file)
  const durable = JSON.parse(stateBytes).skills.find(row => row.id === rule.id)
  assert.equal(durable.rule, undefined)
  assert.equal(durable.status, 'proposed')
  assert.deepEqual(await readFile(path(rule.id)), bytes)
  await store.read()
  assert.deepEqual(await readFile(store.file), stateBytes)
  await save({ ...rule, rule: '用小标题表达机制和因果。' })
  const updated = (await store.read()).skills.find(row => row.id === rule.id)
  assert.equal(updated.content.revision, 2)
  assert.equal(updated.status, 'proposed')
  await store.mutate('Enable rule', draft => applyOps(draft, [{ op: 'update_skill', id: rule.id, status: 'active' }]))
  const restarted = new Store(data)
  restarted.notes = notes
  assert.equal((await restarted.read()).skills.find(row => row.id === rule.id).status, 'active')
  const registeredReader = await new DeskReader({ dataRoot: data, wikiRoot: wiki }).load()
  assert.equal((await registeredReader.read({ kind: 'preferences' })).rules[0].registered, true)
})

test('重复、错误格式、身份冲突和符号链接可诊断，文件字段不能自行启用规则', async t => {
  const { root, wiki, data, store, rule, path, save, notesRoot } = await setup(t)
  await save(rule)
  await store.read()
  await save({ ...rule, id: 's_duplicate' })
  await save({ ...rule, id: 's_invalid', evidence: '' })
  await save({ ...rule, id: 's_related', rule: '另一条规则', relatedRuleId: 'missing' })
  await save({ ...rule, id: 's_enabled', rule: '文件不决定启用状态' })
  await writeFile(path('s_enabled'), (await readFile(path('s_enabled'), 'utf8')).replace('data:', 'status: active\ndata:\n  status: active'))
  await writeFile(path('wrong-name'), await readFile(path('s_enabled')))
  await symlink(path(rule.id), path('s_symlink'))
  const state = await store.read()
  assert.equal(state.skills.filter(row => !row.sample).length, 2)
  assert.equal(state.skills.find(row => row.id === 's_enabled').status, 'proposed')
  assert.ok(state.ruleFileIssues.some(row => row.code === 'notes/rule-duplicate' && row.duplicateOf === rule.id))
  assert.ok(state.ruleFileIssues.some(row => row.code === 'notes/rule-proposal-invalid'))
  assert.ok(state.ruleFileIssues.some(row => row.code === 'notes/rule-related-missing'))
  assert.ok(state.ruleFileIssues.some(row => row.file === path('s_symlink')))
  assert.ok(state.ruleFileIssues.some(row => row.file === path('wrong-name')))
  const reader = await new DeskReader({ dataRoot: data, wikiRoot: wiki }).load()
  assert.equal((await reader.file(path('s_invalid'))).valid, false)
  await save({ ...rule, id: 's_invalid', rule: '修复后可登记' })
  assert.ok((await store.read()).skills.some(row => row.id === 's_invalid'))
  const alternate = join(root, 'alternate-notes')
  await mkdir(join(alternate, 'preferences/rules'), { recursive: true })
  await writeFile(join(alternate, 'preferences/rules/' + rule.id + '.md'), await readFile(path(rule.id)))
  store.notes.roots.add(alternate)
  assert.ok((await store.read()).ruleFileIssues.some(row => row.code === 'notes/rule-identity-conflict'))
  // A separate owned Notes root exposes no files through a symlinked rule directory.
  const linked = join(root, 'linked-notes')
  await mkdir(join(linked, 'preferences'), { recursive: true })
  await symlink(join(notesRoot, 'preferences/rules'), join(linked, 'preferences/rules'))
  store.notes.roots.add(linked)
  assert.ok((await store.read()).ruleFileIssues.some(row => row.file === join(linked, 'preferences/rules')))
})

test('停用和删除跨重启保留，删除不被残留文件复活，缺失文件不能启用', async t => {
  const { data, notes, store, rule, path, save } = await setup(t)
  await save(rule)
  await store.read()
  await store.mutate('Enable', draft => applyOps(draft, [{ op: 'update_skill', id: rule.id, status: 'active' }]))
  await store.mutate('Disable', draft => applyOps(draft, [{ op: 'update_skill', id: rule.id, status: 'proposed' }]))
  const restarted = new Store(data)
  restarted.notes = notes
  assert.equal((await restarted.read()).skills.find(row => row.id === rule.id).status, 'proposed')
  await restarted.mutate('Delete', draft => applyOps(draft, [{ op: 'delete_skill', id: rule.id }]))
  assert.ok(await readFile(path(rule.id)))
  assert.equal((await restarted.read()).skills.some(row => row.id === rule.id), false)
  const again = new Store(data)
  again.notes = notes
  assert.equal((await again.read()).skills.some(row => row.id === rule.id), false)
  await again.undoLast()
  assert.equal((await again.read()).skills.find(row => row.id === rule.id).status, 'proposed')
  await rm(path(rule.id))
  const missing = await again.read()
  assert.equal(missing.skills.find(row => row.id === rule.id).content.status, 'missing')
  const result = applyOps(missing, [{ op: 'update_skill', id: rule.id, status: 'active' }])
  assert.equal(result.errors.length, 1)
})

test('登记前外部文件变化拒绝旧指纹，下一次读取采用最新文件且保持待审', async t => {
  const { store, notes, rule, save } = await setup(t)
  await save(rule)
  const sync = notes.syncIndex.bind(notes)
  let changed = false
  notes.syncIndex = async state => {
    await sync(state)
    if (!changed) {
      changed = true
      await save({ ...rule, rule: '登记期间由外部编辑器修改的规则。' })
    }
  }
  await assert.rejects(store.read(), { code: 'notes/rule-conflict' })
  assert.equal(JSON.parse(await readFile(store.file, 'utf8')).skills.some(row => row.id === rule.id), false)
  const next = (await store.read()).skills.find(row => row.id === rule.id)
  assert.equal(next.rule, '登记期间由外部编辑器修改的规则。')
  assert.equal(next.status, 'proposed')
})
