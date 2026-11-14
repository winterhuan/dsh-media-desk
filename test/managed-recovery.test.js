/** Task-owned managed publications retain accepted preimages until a valid save retry. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Notes } from '../src/notes.js'
import { Store } from '../src/store.js'
import { exportSkill } from '../src/learn.js'

test('任务校验前崩溃不把未接受的风格、规则、语气和材料投影为正式内容', async t => {
  for (const mode of ['unchanged publication', 'edited publication inode', 'invalid publication metadata']) await t.test(mode, async t => {
    const edited = mode !== 'unchanged publication'
    const allocated = await mkdtemp(join(tmpdir(), 'media-desk-managed-recovery-'))
    t.after(() => rm(allocated, { recursive: true, force: true }))
    const root = await realpath(allocated)
    const wikiRoot = join(root, 'wiki')
    const notesRoot = join(wikiRoot, 'notes')
    const dataRoot = join(root, 'data')
    const home = join(root, 'home')
    const exportedPath = join(home, 'skills', 'media-desk-voice', 'SKILL.md')
    await mkdir(notesRoot, { recursive: true })
    const create = () => {
      const store = new Store(dataRoot)
      store.notes = new Notes({ wikiRoot, notesRoot, notesRoots: [notesRoot], selectedNotesRoot: notesRoot, dataRoot })
      store.syncDerivedSkill = state => exportSkill(state, home, { existingOnly: true })
      return store
    }
    const rows = state => [
      [state.styles.find(row => row.id === 'managed-style'), 'content', 'tone'],
      [state.skills.find(row => row.id === 'managed-rule'), 'content', 'rule'],
      [state.voice, 'content', 'text'],
      [state.items.find(row => row.id === 'managed-material'), 'materialContent', 'body'],
    ]
    const store = create()
    await store.mutate('Accept managed originals', draft => {
      draft.styles.push({ id: 'managed-style', name: 'Managed style', tone: 'Accepted managed original.' })
      draft.activeStyleId = 'managed-style'
      draft.skills.push({ id: 'managed-rule', name: 'Managed rule', rule: 'Accepted managed original.', status: 'active' })
      draft.voice = { text: 'Accepted managed original.' }
      draft.items.push({ id: 'managed-material', imported: true, title: 'Managed material', body: 'Accepted managed original.', createdAt: '2026-11-01T12:00:00Z', drafts: {} })
    }, { undoable: false })
    const before = await store.read()
    await exportSkill(before, home)
    const versions = rows(before).map(([row, key]) => structuredClone(row[key]))
    // A crash before rollback leaves the real publication and receipt-free journal on disk.
    store.writes.restoreAccepted = async () => { throw Object.assign(new Error('Interrupted before rollback'), { code: 'EIO' }) }
    let pendingId
    await assert.rejects(store.mutate('Publish task-owned candidates', draft => {
      for (const [row, , field] of rows(draft)) row[field] = 'Unaccepted managed candidate.'
    }, { undoable: false, resultKey: 'native:managed-recovery', payloadHash: '1'.repeat(64),
      validateAcceptance: () => { throw Object.assign(new Error('Task validation unavailable'), { code: 'native/preference-conflict' }) } }), error => {
      pendingId = error.pendingId
      return error.code === 'native/preference-conflict' && Boolean(pendingId)
    })
    const journal = JSON.parse(await readFile(join(dataRoot, 'notes-writes', pendingId, 'pending.json'), 'utf8'))
    assert.equal(journal.status, 'published')
    assert.equal(journal.requiresValidation, true)
    assert.equal(journal.files.length, 4)
    if (edited) {
      const file = journal.files.find(file => file.kind === 'style')
      const primary = join(file.after.notesRoot, file.after.relativePath)
      assert.equal((await stat(primary)).ino, (await stat(join(file.publication.notesRoot, file.publication.relativePath))).ino)
      await writeFile(primary, mode === 'invalid publication metadata' ? 'An unaccepted editor file without valid metadata.'
        : (await readFile(primary, 'utf8')).replace('Unaccepted managed candidate.', 'Editor changed the unaccepted publication.'))
    }
    const cold = create()
    const recovered = await cold.read()
    for (const [index, [row, key, field]] of rows(recovered).entries()) {
      assert.equal(row[field], 'Accepted managed original.')
      assert.equal(row[key].sha256, versions[index].sha256)
      assert.equal(row[key].revision, versions[index].revision)
      assert.equal(row[key].status, edited && index === 0 ? 'conflict' : 'pending')
      assert.equal(row[key].pendingId, pendingId)
    }
    assert.equal(recovered.receipts.some(receipt => receipt.id === pendingId), false)
    const pendingExport = await readFile(exportedPath, 'utf8')
    assert.match(pendingExport, /Accepted managed original/)
    assert.doesNotMatch(pendingExport, /Unaccepted managed candidate|Editor changed/)
    const durable = JSON.parse(await readFile(join(dataRoot, 'state.json'), 'utf8'))
    for (const [index, [row, key]] of rows(durable).entries()) {
      assert.equal(row[key].sha256, versions[index].sha256)
      assert.equal(row[key].revision, versions[index].revision)
      assert.equal(row[key].status, 'ready')
    }
    await assert.rejects(cold.retrySave(pendingId), { code: 'notes/validation-required' })
    await cold.mutate('Disable the unresolved rule', draft => { draft.skills.find(row => row.id === 'managed-rule').status = 'proposed' }, { undoable: false })
    const disabledExport = await readFile(exportedPath, 'utf8')
    assert.match(disabledExport, /Accepted managed original/)
    assert.doesNotMatch(disabledExport, /Managed rule|Unaccepted managed candidate/)
    if (edited) {
      const file = journal.files.find(file => file.kind === 'style')
      await writeFile(join(file.publication.notesRoot, file.publication.relativePath), await readFile(join(file.candidate.notesRoot, file.candidate.relativePath)))
    }
    const accepted = await cold.retrySave(pendingId, { validateAcceptance: () => true })
    assert.equal(accepted.acceptance.id, pendingId)
    const duplicate = await cold.retrySave(pendingId, { validateAcceptance: () => true })
    assert.deepEqual(duplicate.acceptance, accepted.acceptance)
    assert.equal(duplicate.state.receipts.filter(receipt => receipt.id === pendingId).length, 1)
    const acceptedExport = await readFile(exportedPath, 'utf8')
    assert.match(acceptedExport, /Unaccepted managed candidate/)
    assert.doesNotMatch(acceptedExport, /Managed rule|Accepted managed original/)
    for (const [index, [row, key, field]] of rows(duplicate.state).entries()) {
      assert.equal(row[field], 'Unaccepted managed candidate.')
      assert.equal(row[key].revision, versions[index].revision + 1)
      assert.equal(row[key].status, 'ready')
    }
    for (const file of journal.files) assert.match(await readFile(join(file.beforeSnapshot.notesRoot, file.beforeSnapshot.relativePath), 'utf8'), /Accepted managed original\./)
  })
})
