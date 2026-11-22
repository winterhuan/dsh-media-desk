/** The npm CLI observes Agent edits without accepting them or changing any stored bytes. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Notes } from '../src/notes.js'
import { DeskReader } from '../src/desk-reader.js'

const execute = promisify(execFile)
const cli = new URL('../scripts/media-desk-read.mjs', import.meta.url).pathname

async function inventory(root) {
  const entries = []
  for (const row of await readdir(root, { withFileTypes: true })) {
    const path = join(root, row.name)
    if (row.isDirectory()) entries.push(...await inventory(path))
    else if (row.isFile()) entries.push([path, (await readFile(path)).toString('base64')])
    else entries.push([path, 'symlink'])
  }
  return entries.sort(([a], [b]) => a.localeCompare(b))
}

test('npm read/validate 读取直接改稿与偏好，拒绝错误身份和版本，校验不写入任何文件', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'media-read-cli-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const wiki = join(root, 'wiki'), data = join(root, 'media-desk'), notesRoot = join(wiki, 'notes')
  await mkdir(join(notesRoot, 'works'), { recursive: true })
  await mkdir(join(notesRoot, 'preferences/rules'), { recursive: true })
  await mkdir(data)
  const notes = new Notes({ wikiRoot: wiki, notesRoot, dataRoot: data, notesRoots: new Set([notesRoot]) })
  const item = { id: 'work-1', title: 'Direct work', body: 'First draft.', language: 'zh', createdAt: '2026-11-22T00:00:00Z' }
  const workFile = join(notesRoot, 'works/Direct work.md')
  await writeFile(workFile, notes.document(item))
  const reference = { notesRoot, relativePath: 'works/Direct work.md', language: 'zh', revision: 1,
    sha256: (await notes.readWork({ notesRoot, relativePath: 'works/Direct work.md', language: 'zh' }, item.id)).sha256 }
  const rule = { id: 'rule-1', name: '因果', rule: '展开因果', scope: '技术分析', evidence: '已确认的修改' }
  const sourceWork = { ...item, content: reference }
  await notes.keepSource(sourceWork, 'Original source material.')
  const ruleFile = join(notesRoot, 'preferences/rules/rule-1.md')
  await writeFile(ruleFile, notes.managedDocument('rule', rule.id, rule))
  await writeFile(join(data, 'state.json'), JSON.stringify({ items: [{ id: item.id, status: 'draft', content: reference, sourceContent: sourceWork.sourceContent }],
    styles: [], skills: [{ id: rule.id, status: 'active', content: { notesRoot, relativePath: 'preferences/rules/rule-1.md' } }] }))
  await writeFile(workFile, (await readFile(workFile, 'utf8')).replace('First draft.', 'The Agent edited this body.'))
  const before = await inventory(root)
  const run = args => execute(process.execPath, [cli, ...args, '--data-root', data, '--wiki', wiki])
  const work = JSON.parse((await run(['read', '--kind', 'work', '--id', item.id])).stdout)
  assert.equal(work.current.body, 'The Agent edited this body.')
  assert.equal(work.current.changed, true)
  assert.equal(work.current.registeredVersion.sha256, reference.sha256)
  assert.equal(work.source.body, 'Original source material.')
  assert.equal(work.source.valid, true)
  const prefs = JSON.parse((await run(['read', '--kind', 'preferences'])).stdout)
  assert.equal(prefs.rules[0].value.rule, rule.rule)
  assert.equal(prefs.rules[0].status, 'active')
  const defaults = JSON.parse((await execute(process.execPath, [cli, 'read', '--kind', 'preferences'], {
    env: { ...process.env, DSH_HOME: root, WIKI_PATH: wiki },
  })).stdout)
  assert.deepEqual(defaults, prefs)
  const validation = JSON.parse((await run(['validate', '--file', workFile])).stdout)
  assert.equal(validation.valid, true)
  assert.equal(validation.registered, true)
  assert.equal(validation.text, undefined)
  await assert.rejects(run(['validate', '--file', workFile, '--sha256', reference.sha256]), error => JSON.parse(error.stdout).errors[0].code === 'notes/version-changed')
  await assert.rejects(run(['commit']), /write operations are not available/)
  assert.deepEqual(await inventory(root), before)
  await writeFile(workFile, (await readFile(workFile, 'utf8')).replace('id: work-1', 'id: wrong-work'))
  const invalidBefore = await inventory(root)
  await assert.rejects(run(['validate', '--file', workFile]), error => JSON.parse(error.stdout).errors[0].code === 'notes/identity-mismatch')
  assert.deepEqual(await inventory(root), invalidBefore)
  const candidate = join(notesRoot, 'works/New work.md')
  await writeFile(candidate, notes.document({ ...item, id: 'new-work', body: 'Candidate without registration.' }))
  const result = JSON.parse((await run(['validate', '--file', candidate])).stdout)
  assert.equal(result.valid, true)
  assert.equal(result.registered, false)
  const reader = await new DeskReader({ dataRoot: data, wikiRoot: wiki }).load()
  await assert.rejects(reader.file(join(root, 'outside.md')), /Notes directory/)
  await symlink(candidate, join(notesRoot, 'works/Link.md'))
  assert.equal((await reader.file(join(notesRoot, 'works/Link.md'))).valid, false)
  const absentData = join(root, 'absent-data')
  const empty = await new DeskReader({ dataRoot: absentData, wikiRoot: wiki }).load()
  assert.deepEqual(await empty.read(), { works: [] })
  await assert.rejects(readFile(join(absentData, 'state.json')), { code: 'ENOENT' })
})
