/** Unaccepted published work cannot replace verified accepted text during cold Host recovery. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { open, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeRuntime } from './fixtures/native-runtime.js'
import { inspectRuntime } from './fixtures/inspector.js'

test('未接受主文件的元数据被编辑器损坏后，冷恢复保留已接受显示与所有候选字节', { timeout: 180000 }, async t => {
  const resultId = 'pending-invalid-metadata'
  const candidateText = 'The candidate must remain unaccepted.\n'
  const runtime = await nativeRuntime(t, { recipes: { MD_FIXTURE_PENDING_METADATA: {
    calls: [{ name: 'media_desk_read', arguments: { kind: 'work' } },
      { name: 'media_desk_edit', arguments: { operations: JSON.stringify([{ op: 'update_item', id: 'seed_2', body: candidateText }]), expectedContent: '$versions', resultId } }],
    reply: 'The candidate was submitted.',
  } } })
  await runtime.start([], { NODE_OPTIONS: '--inspect=127.0.0.1:0' })
  assert.equal((await runtime.host('notes/migrate', {})).status, 200)
  const work = (await runtime.host('state')).value.state.items.find(row => row.id === 'seed_2')
  const association = (await runtime.host('sessions/open', { workId: work.id })).value.association
  const client = await inspectRuntime(t, runtime)
  const point = await client.breakAt('/src/store.js', 'validate?.()', `state.receipts?.some(row => row.resultKey?.endsWith(':${resultId}'))`)
  const admitted = await runtime.prompt(association.sessionId, 'MD_FIXTURE_PENDING_METADATA: submit the pending edit')
  assert.ok(admitted)
  const paused = await point.next()
  const receipt = await client.value(paused, `state.receipts.find(row => row.resultKey?.endsWith(':${resultId}'))`)
  const journalPath = join(runtime.home, 'media-desk', 'notes-writes', receipt.id, 'pending.json')
  const journal = JSON.parse(await readFile(journalPath, 'utf8'))
  assert.equal(journal.requiresValidation, true)
  const entry = journal.files.find(row => row.workId === work.id)
  const primary = join(entry.after.notesRoot, entry.after.relativePath)
  const candidate = join(entry.candidate.notesRoot, entry.candidate.relativePath)
  const snapshot = join(entry.beforeSnapshot.notesRoot, entry.beforeSnapshot.relativePath)
  const candidateBytes = await readFile(candidate)
  const acceptedBytes = await readFile(snapshot)
  const malformed = '---\nformat: 1\nid: wrong-identity\ntitle: [\n---\n\nThe editor changed the unaccepted publication.\n'
  const editor = await open(primary, 'r+')
  try {
    assert.equal((await editor.stat()).ino, (await stat(join(entry.publication.notesRoot, entry.publication.relativePath))).ino)
    await editor.truncate(0)
    await editor.write(malformed, 0, 'utf8')
  } finally { await editor.close() }
  const disk = JSON.parse(await readFile(join(runtime.home, 'media-desk', 'state.json'), 'utf8'))
  assert.equal(disk.receipts.some(row => row.id === receipt.id), false)
  const model = await readFile(runtime.telemetryPath, 'utf8')
  const exit = await runtime.stop('SIGKILL')
  assert.equal(exit.signal, 'SIGKILL')
  assert.equal(exit.timedOut, false)
  await runtime.start()
  const recovered = await runtime.host('state')
  assert.equal(recovered.status, 200, JSON.stringify(recovered.value))
  const current = recovered.value.state.items.find(row => row.id === work.id)
  assert.equal(current.body, work.body)
  assert.equal(current.title, work.title)
  assert.equal(current.content.revision, work.content.revision)
  assert.equal(current.content.sha256, work.content.sha256)
  assert.ok(['pending', 'conflict'].includes(current.content.status), current.content.status)
  assert.equal(current.content.pendingId, receipt.id)
  assert.equal(recovered.value.state.receipts.some(row => row.id === receipt.id), false)
  assert.deepEqual(await readFile(candidate), candidateBytes)
  assert.deepEqual(await readFile(snapshot), acceptedBytes)
  assert.equal(await readFile(primary, 'utf8'), malformed)
  assert.equal(await readFile(runtime.telemetryPath, 'utf8'), model)
  assert.equal((await runtime.host('notes/retry', { id: receipt.id })).value.code, 'notes/validation-required')
})
