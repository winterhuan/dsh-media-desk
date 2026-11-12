/** Notes saves retain candidates and durable receipts through the public Host. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, open, readFile, rename, rmdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeRuntime } from './fixtures/native-runtime.js'
import { inspectRuntime } from './fixtures/inspector.js'

test('相同保存身份重试返回同一持久回执，不重复创建作品', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t)
  await runtime.start()
  const request = { resultKey: 'create-one-work', ops: [{ op: 'add_item', title: 'One accepted work', body: 'Save this candidate once.\n', language: 'en' }] }
  const accepted = await runtime.host('ops', request)
  assert.equal(accepted.status, 200, JSON.stringify(accepted.value))
  assert.equal(typeof accepted.value.acceptance?.id, 'string')
  const id = accepted.value.receipts[0].target
  const repeated = await runtime.host('ops', request)
  assert.equal(repeated.status, 200, JSON.stringify(repeated.value))
  assert.deepEqual(repeated.value.acceptance, accepted.value.acceptance)
  assert.equal(repeated.value.receipts[0].target, id)
  assert.equal(repeated.value.state.items.filter(row => row.title === 'One accepted work').length, 1)
  const persisted = JSON.parse(await readFile(join(runtime.home, 'media-desk', 'state.json'), 'utf8'))
  assert.equal(persisted.receipts.filter(receipt => receipt.resultKey === request.resultKey).length, 1)
  assert.equal(Object.hasOwn(persisted.items.find(row => row.id === id), 'body'), false)
  await runtime.stop()
  await runtime.start()
  const recovered = await runtime.host('ops', request)
  assert.deepEqual(recovered.value.acceptance, accepted.value.acceptance)
  const conflicting = await runtime.host('ops', { ...request, ops: [{ ...request.ops[0], body: 'A different result.\n' }] })
  assert.equal(conflicting.status, 409)
  assert.equal(conflicting.value.code, 'notes/result-conflict')
})

test('查看保留版本只读取所属证据，外部版本格式损坏仍可保留当前正文', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t)
  await runtime.start()
  const added = await runtime.host('ops', { undoable: false, ops: [{ op: 'add_item', title: 'Review retained text', body: 'Accepted body before editing.\n', language: 'en' }] })
  const id = added.value.receipts[0].target
  const before = added.value.state.items.find(row => row.id === id).content
  const primary = join(before.notesRoot, before.relativePath)
  const editor = await open(primary, 'r+')
  t.after(() => editor.close())
  const edited = await runtime.host('ops', { resultKey: 'review-retained-edit', expectedContent: { [id]: before }, ops: [{ op: 'update_item', id, body: 'Keep this accepted body.\n' }] })
  assert.equal(edited.status, 200, JSON.stringify(edited.value))
  const invalid = 'External bytes with a damaged front matter boundary.\n'
  await editor.truncate(0)
  await editor.write(invalid, 0, 'utf8')
  const saved = (await runtime.host('notes/saves')).value.writes.find(row => row.id === edited.value.acceptance.id)
  const conflict = saved.conflicts[0]
  const request = { id: saved.id, workId: id, relativePath: conflict.reference.relativePath, sha256: conflict.observedSha256 }
  const preview = await runtime.host('notes/version', request)
  assert.equal(preview.status, 200, JSON.stringify(preview.value))
  assert.equal(preview.value.current.body, 'Keep this accepted body.\n')
  assert.equal(preview.value.text, invalid)
  assert.equal(preview.value.valid, false)
  assert.equal((await runtime.host('notes/version', { ...request, relativePath: 'unregistered.md' })).status, 409)
  assert.equal((await runtime.host('notes/version', { ...request, workId: 'another-work' })).status, 409)
  const resolved = await runtime.host('notes/resolve', { ...request, choice: 'current' })
  assert.equal(resolved.status, 200, JSON.stringify(resolved.value))
  assert.equal(resolved.value.state.items.find(row => row.id === id).body, 'Keep this accepted body.\n')
  assert.equal(resolved.value.state.items.find(row => row.id === id).content.status, 'ready')
  assert.equal(await readFile(join(conflict.reference.notesRoot, conflict.reference.relativePath), 'utf8'), invalid)
})

test('回执接受后索引更新失败保留已接受正文，修复索引后重试仍返回同一回执', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t)
  await runtime.start([], { NODE_OPTIONS: '--inspect=127.0.0.1:0' })
  const added = await runtime.host('ops', { undoable: false, ops: [{ op: 'add_item', title: 'Accepted despite index failure', body: 'The earlier accepted body.\n', language: 'en' }] })
  const id = added.value.receipts[0].target
  const before = added.value.state.items.find(row => row.id === id).content
  const primary = join(before.notesRoot, before.relativePath)
  const index = join(before.notesRoot, 'index.md')
  const originalIndex = await readFile(index, 'utf8')
  const client = await inspectRuntime(t, runtime)
  const point = await client.breakAt('/src/store.js', 'await this.notes.syncIndex(draft)', 'record.resultKey === "accepted-index-failure"')
  const pause = point.next()
  const operation = runtime.host('ops', { resultKey: 'accepted-index-failure', expectedContent: { [id]: before }, ops: [{ op: 'update_item', id, body: 'The durable accepted body remains.\n' }] }).then(value => ({ value }), error => ({ error: error.message }))
  const paused = await pause
  const saveId = await client.value(paused, 'record.id')
  const acceptedState = JSON.parse(await readFile(join(runtime.home, 'media-desk', 'state.json'), 'utf8'))
  const receipt = acceptedState.receipts.find(row => row.id === saveId)
  assert.ok(receipt)
  await writeFile(index, originalIndex.replace(/<!-- \/media-desk:works:[\w]+ -->/, 'An external edit with a broken navigation marker.'))
  await point.remove()
  await client.send('Debugger.resume')
  const failed = await operation
  assert.equal(failed.value.status, 409, JSON.stringify(failed))
  assert.equal(failed.value.value.pendingId, saveId)
  assert.match(await readFile(primary, 'utf8'), /The durable accepted body remains\./)
  assert.deepEqual(JSON.parse(await readFile(join(runtime.home, 'media-desk', 'state.json'), 'utf8')).receipts.find(row => row.id === saveId), receipt)
  await writeFile(index, originalIndex)
  await runtime.stop()
  await runtime.start()
  const retried = await runtime.host('notes/retry', { id: saveId })
  assert.equal(retried.status, 200, JSON.stringify(retried.value))
  assert.deepEqual(retried.value.acceptance, receipt)
  assert.equal(retried.value.state.items.find(row => row.id === id).body, 'The durable accepted body remains.\n')
})

test('外部原子保存与实际捕获、缺失主路径重叠时保留外部文件且不接受候选', { timeout: 180000 }, async t => {
  for (const stage of ['before-capture', 'missing-primary']) await t.test(stage, { timeout: 180000 }, async t => {
    const runtime = await nativeRuntime(t)
    await runtime.start([], { NODE_OPTIONS: '--inspect=127.0.0.1:0' })
    const added = await runtime.host('ops', { ops: [{ op: 'add_item', title: 'Concurrent ordinary editor', body: 'The accepted starting body.\n', language: 'en' }] })
    const id = added.value.receipts[0].target
    const before = added.value.state.items.find(row => row.id === id).content
    const primaryPath = join(before.notesRoot, before.relativePath)
    const original = await readFile(primaryPath, 'utf8')
    const client = await inspectRuntime(t, runtime)
    const resultKey = 'editor-' + stage
    const point = await client.breakAt('/src/notes-writes.js', stage === 'before-capture'
      ? 'await rename(join(entry.before.notesRoot, entry.before.relativePath)' : "entry.phase = 'displaced'", `record.resultKey === ${JSON.stringify(resultKey)}`)
    const pause = point.next()
    let settled = false
    const operation = runtime.host('ops', { resultKey, expectedContent: { [id]: before }, ops: [{ op: 'update_item', id, body: 'The conflicting Host candidate.\n' }] }).then(value => { settled = true; return { value } }, error => { settled = true; return { error: error.message } })
    const paused = await pause
    const saveId = await client.value(paused, 'record.id')
    assert.equal(settled, false)
    if (stage === 'missing-primary') await assert.rejects(readFile(primaryPath), { code: 'ENOENT' })
    const external = original.replace('The accepted starting body.', 'An independently saved current editor version.')
    const temporary = join(runtime.root, 'ordinary-editor-save.md')
    await writeFile(temporary, external, { flag: 'wx' })
    await rename(temporary, primaryPath)
    await point.remove()
    await client.send('Debugger.resume')
    const result = await operation
    assert.equal(result.value.status, 409, JSON.stringify(result))
    assert.equal(result.value.value.code, 'notes/publication-conflict')
    assert.equal(result.value.value.pendingId, saveId)
    assert.equal(await readFile(primaryPath, 'utf8'), external)
    const record = (await runtime.host('notes/saves')).value.writes.find(row => row.id === saveId)
    assert.equal(record.status, 'conflict')
    assert.equal(record.receipt, undefined)
    const file = record.files.find(row => row.workId === id)
    assert.match(await readFile(join(file.candidate.notesRoot, file.candidate.relativePath), 'utf8'), /The conflicting Host candidate\./)
    assert.equal(await readFile(join(file.beforeSnapshot.notesRoot, file.beforeSnapshot.relativePath), 'utf8'), original)
    assert.equal(await readFile(join(file.displaced.notesRoot, file.displaced.relativePath), 'utf8'), stage === 'before-capture' ? external : original)
    const current = (await runtime.host('state')).value.state.items.find(row => row.id === id)
    assert.equal(current.body, 'An independently saved current editor version.\n')
    assert.ok(current.content.revision > before.revision)
    assert.equal(current.content.status, 'conflict')
    const retried = await runtime.host('notes/retry', { id: saveId })
    assert.equal(retried.status, 409, JSON.stringify(retried.value))
    assert.equal(await readFile(primaryPath, 'utf8'), external)
    const stored = JSON.parse(await readFile(join(runtime.home, 'media-desk', 'state.json'), 'utf8'))
    assert.equal(stored.receipts.some(receipt => receipt.resultKey === resultKey), false)
    const observed = (await runtime.host('notes/saves')).value.writes.find(row => row.id === saveId)
    assert.ok(observed.conflicts.length, 'A primary-path conflict must provide selectable observed evidence')
    const evidence = observed.conflicts[0]
    const resolved = await runtime.host('notes/resolve', { id: saveId, workId: id, relativePath: evidence.reference.relativePath, sha256: evidence.observedSha256, choice: 'current' })
    assert.equal(resolved.status, 200, JSON.stringify(resolved.value))
    assert.equal(resolved.value.state.items.find(row => row.id === id).body, 'An independently saved current editor version.\n')
    assert.equal(resolved.value.state.items.find(row => row.id === id).content.status, 'ready')
  })
})

test('选择保留的外部版本校验观察哈希并写回同一主文件，候选与旧稿仍可恢复', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t)
  await runtime.start()
  const added = await runtime.host('ops', { ops: [{ op: 'add_item', title: 'Select external text', body: 'The accepted original body.\n', language: 'en' }] })
  const id = added.value.receipts[0].target
  const before = added.value.state.items.find(row => row.id === id).content
  const primaryPath = join(before.notesRoot, before.relativePath)
  const original = await readFile(primaryPath, 'utf8')
  let handle = await open(primaryPath, 'r+')
  const close = async () => { await handle?.close(); handle = undefined }
  t.after(close)
  try {
    const edited = await runtime.host('ops', { resultKey: 'external-selection', expectedContent: { [id]: before }, ops: [{ op: 'update_item', id, body: 'The accepted candidate body.\n' }] })
    const saveId = edited.value.acceptance.id
    const external = original.replace('The accepted original body.', 'The retained external body.')
    await handle.truncate(0)
    await handle.write(external, 0, 'utf8')
    const saved = (await runtime.host('notes/saves')).value.writes.find(row => row.id === saveId)
    const conflict = saved.conflicts[0]
    const request = { id: saveId, workId: id, relativePath: conflict.reference.relativePath, sha256: conflict.observedSha256, choice: 'external' }
    assert.equal((await runtime.host('notes/resolve', { ...request, workId: 'another-work' })).status, 409)
    const latest = original.replace('The accepted original body.', 'The latest retained external body.')
    await handle.truncate(0)
    await handle.write(latest, 0, 'utf8')
    const stale = await runtime.host('notes/resolve', request)
    assert.equal(stale.status, 409)
    assert.equal(stale.value.code, 'notes/resolution-conflict')
    assert.match(await readFile(primaryPath, 'utf8'), /The accepted candidate body\./)
    const observed = (await runtime.host('notes/saves')).value.writes.find(row => row.id === saveId).conflicts[0]
    request.sha256 = observed.observedSha256
    const resolved = await runtime.host('notes/resolve', request)
    assert.equal(resolved.status, 200, JSON.stringify(resolved.value))
    const current = resolved.value.state.items.find(row => row.id === id)
    assert.equal(current.body, 'The latest retained external body.\n')
    assert.equal(current.content.relativePath, before.relativePath)
    assert.equal(current.content.status, 'ready')
    assert.ok(current.content.revision > edited.value.state.items.find(row => row.id === id).content.revision)
    const repeated = await runtime.host('notes/resolve', request)
    assert.deepEqual(repeated.value.acceptance, resolved.value.acceptance)
    assert.equal(repeated.value.state.items.find(row => row.id === id).content.revision, current.content.revision)
    const file = saved.files.find(row => row.workId === id)
    assert.equal(await readFile(join(file.beforeSnapshot.notesRoot, file.beforeSnapshot.relativePath), 'utf8'), original)
    assert.match(await readFile(join(file.candidate.notesRoot, file.candidate.relativePath), 'utf8'), /The accepted candidate body\./)
  } finally { await close() }
})

test('主文件发布后 Store 保存实际失败时返回候选身份，修复后只重试原候选', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t)
  await runtime.start([], { NODE_OPTIONS: '--inspect=127.0.0.1:0' })
  const added = await runtime.host('ops', { ops: [{ op: 'add_item', title: 'A save fault', body: 'The previously accepted body.\n', language: 'en' }] })
  const id = added.value.receipts[0].target
  const before = added.value.state.items.find(row => row.id === id).content
  const primaryPath = join(before.notesRoot, before.relativePath)
  const statePath = join(runtime.home, 'media-desk', 'state.json')
  const retainedState = join(runtime.root, 'accepted-state.json')
  const acceptedBytes = await readFile(statePath, 'utf8')
  const client = await inspectRuntime(t, runtime)
  const resultKey = 'save-fault'
  const point = await client.breakAt('/src/store.js', 'const temporary = this.file +', `state.receipts?.some(receipt => receipt.resultKey === ${JSON.stringify(resultKey)})`)
  const pause = point.next()
  const operation = runtime.host('ops', { resultKey, expectedContent: { [id]: before }, ops: [{ op: 'update_item', id, body: 'The recoverable save-fault candidate.\n' }] }, { 'x-media-desk-lang': 'en' }).then(value => ({ value }), error => ({ error: error.message }))
  const paused = await pause
  const saveId = await client.value(paused, `state.receipts.find(receipt => receipt.resultKey === ${JSON.stringify(resultKey)}).id`)
  assert.match(await readFile(primaryPath, 'utf8'), /The recoverable save-fault candidate\./)
  await rename(statePath, retainedState)
  await mkdir(statePath)
  await point.remove()
  await client.send('Debugger.resume')
  const failed = await operation
  assert.equal(failed.value.status, 500, JSON.stringify(failed))
  assert.equal(failed.value.value.pendingId, saveId)
  assert.equal(failed.value.value.code, 'EISDIR')
  assert.equal(failed.value.value.error, 'Saving failed. Check the save location and write permissions, then retry.')
  assert.equal(await readFile(retainedState, 'utf8'), acceptedBytes)
  assert.equal(JSON.parse(acceptedBytes).receipts.some(receipt => receipt.resultKey === resultKey), false)
  await rmdir(statePath)
  await rename(retainedState, statePath)
  const retained = (await runtime.host('notes/saves')).value.writes.find(row => row.id === saveId)
  assert.equal(retained.error.code, 'EISDIR')
  assert.equal(retained.error.message, '保存失败，请检查保存位置和写入权限后重试')
  const pending = (await runtime.host('state', undefined, { 'x-media-desk-lang': 'en' })).value.state.items.find(row => row.id === id)
  assert.equal(pending.body, 'The previously accepted body.\n')
  assert.equal(pending.content.pendingId, saveId)
  assert.equal(pending.content.code, 'EISDIR')
  assert.equal(pending.content.error, 'Saving failed. Check the save location and write permissions, then retry.')
  const english = (await runtime.host('notes/saves', undefined, { 'x-media-desk-lang': 'en' })).value.writes.find(row => row.id === saveId)
  assert.equal(english.error.message, 'Saving failed. Check the save location and write permissions, then retry.')
  const retried = await runtime.host('notes/retry', { id: saveId })
  assert.equal(retried.status, 200, JSON.stringify(retried.value))
  assert.equal(retried.value.acceptance.id, saveId)
  assert.equal(retried.value.state.items.find(row => row.id === id).body, 'The recoverable save-fault candidate.\n')
  assert.equal((await runtime.host('notes/retry', { id: saveId })).value.acceptance.id, saveId)
  await assert.rejects(readFile(runtime.telemetryPath), { code: 'ENOENT' })
  assert.deepEqual(await runtime.stop(), { code: 0, signal: null, timedOut: false })
})

test('发布期间旧编辑器句柄写入的版本被保留并报告冲突，显式选择后继续核对句柄', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t)
  await runtime.start([], { NODE_OPTIONS: '--inspect=127.0.0.1:0' })
  const added = await runtime.host('ops', { ops: [{ op: 'add_item', title: 'A retained editor handle', body: 'The original accepted body.\n', language: 'en' }] })
  const id = added.value.receipts[0].target
  const before = added.value.state.items.find(row => row.id === id).content
  const primaryPath = join(before.notesRoot, before.relativePath)
  const original = await readFile(primaryPath, 'utf8')
  let handle = await open(primaryPath, 'r+')
  const close = async () => { await handle?.close(); handle = undefined }
  t.after(close)
  try {
    const client = await inspectRuntime(t, runtime)
    const resultKey = 'retained-handle-edit'
    const point = await client.breakAt('/src/store.js', 'await this.notes.syncIndex(draft)', `record.resultKey === ${JSON.stringify(resultKey)}`)
    const pause = point.next()
    const operation = runtime.host('ops', { resultKey, expectedContent: { [id]: before }, ops: [{ op: 'update_item', id, body: 'The accepted Host candidate.\n' }] }).then(value => ({ value }), error => ({ error: error.message }))
    const paused = await pause
    const saveId = await client.value(paused, 'record.id')
    const record = JSON.parse(await readFile(join(runtime.home, 'media-desk', 'notes-writes', saveId, 'pending.json'), 'utf8'))
    const file = record.files.find(row => row.workId === id)
    const external = original.replace('The original accepted body.', 'The old editor writes a retained external version.')
    await handle.truncate(0)
    await handle.write(external, 0, 'utf8')
    assert.equal((await handle.stat()).ino, (await stat(join(file.displaced.notesRoot, file.displaced.relativePath))).ino)
    assert.match(await readFile(primaryPath, 'utf8'), /The accepted Host candidate\./)
    assert.equal(await readFile(join(file.displaced.notesRoot, file.displaced.relativePath), 'utf8'), external)
    await point.remove()
    await client.send('Debugger.resume')
    const result = await operation
    assert.equal(result.value.status, 200, JSON.stringify(result))
    const conflicted = (await runtime.host('state')).value.state.items.find(row => row.id === id)
    assert.equal(conflicted.body, 'The accepted Host candidate.\n')
    assert.equal(conflicted.content.status, 'conflict')
    assert.equal(conflicted.content.code, 'notes/displaced-conflict')
    const saved = (await runtime.host('notes/saves')).value.writes.find(row => row.id === saveId)
    const conflict = saved.conflicts.find(row => row.reference.relativePath === file.displaced.relativePath)
    assert.equal(conflict.workId, id)
    const resolved = await runtime.host('notes/resolve', { id: saveId, workId: id, relativePath: file.displaced.relativePath, sha256: conflict.observedSha256, choice: 'current' })
    assert.equal(resolved.status, 200, JSON.stringify(resolved.value))
    const current = resolved.value.state.items.find(row => row.id === id)
    assert.equal(current.body, 'The accepted Host candidate.\n')
    assert.equal(current.content.status, 'ready')
    assert.ok(current.content.revision > conflicted.content.revision)
    assert.equal(await readFile(join(file.candidate.notesRoot, file.candidate.relativePath), 'utf8').then(bytes => bytes.includes('The accepted Host candidate.')), true)
    const laterExternal = original.replace('The original accepted body.', 'A later write through the same retained editor handle.')
    await handle.truncate(0)
    await handle.write(laterExternal, 0, 'utf8')
    await runtime.stop()
    await runtime.start()
    const restored = (await runtime.host('state')).value.state.items.find(row => row.id === id)
    assert.equal(restored.content.status, 'conflict')
    assert.equal(restored.body, 'The accepted Host candidate.\n')
    assert.equal(await readFile(join(file.displaced.notesRoot, file.displaced.relativePath), 'utf8'), laterExternal)
    const repeat = await runtime.host('notes/retry', { id: saveId })
    assert.equal(repeat.value.acceptance.id, result.value.value.acceptance.id)
    assert.equal(repeat.value.state.items.find(row => row.id === id).content.revision, current.content.revision)
  } finally { await close() }
})

test('各实际保存边界进程终止后核对候选、主文件与回执，不重复接受或重放模型', { timeout: 360000 }, async t => {
  const boundaries = [
    { name: 'candidate', source: '/src/notes-writes.js', statement: 'if (entry.beforeSnapshot && !file.before.snapshot)', journal: false },
    { name: 'pending', source: '/src/notes-writes.js', statement: 'let displaced = entry.displaced &&', journal: true },
    { name: 'displaced', source: '/src/notes-writes.js', statement: "entry.phase = 'displaced'", journal: true },
    { name: 'published', source: '/src/notes-writes.js', statement: "entry.phase = 'published'", occurrence: 1, journal: true, published: true },
    { name: 'receipt', source: '/src/store.js', statement: 'this.state = state', journal: true, published: true, accepted: true },
    { name: 'notification', source: '/src/store.js', statement: 'await this.notes.syncIndex(draft)', journal: true, published: true, accepted: true },
  ]
  for (const boundary of boundaries) await t.test(boundary.name, { timeout: 180000 }, async t => {
    const runtime = await nativeRuntime(t)
    await runtime.start([], { NODE_OPTIONS: '--inspect=127.0.0.1:0' })
    const added = await runtime.host('ops', { ops: [{ op: 'add_item', title: 'A recoverable interrupted save', body: 'The accepted text before interruption.\n', language: 'en' }] })
    assert.equal(added.status, 200, JSON.stringify(added.value))
    const id = added.value.receipts[0].target
    const previous = added.value.state.items.find(row => row.id === id).content
    const primaryPath = join(previous.notesRoot, previous.relativePath)
    const original = await readFile(primaryPath, 'utf8')
    const opened = await runtime.host('sessions/open', { workId: id })
    assert.equal(opened.status, 200, JSON.stringify(opened.value))
    const sessionId = opened.value.association.sessionId
    const warm = await runtime.prompt(sessionId, 'MD_FIXTURE_RECOVERY_WARM')
    assert.equal((await runtime.turn(sessionId, warm)).end.data.reason.kind, 'completed')
    const modelEvidence = await readFile(runtime.telemetryPath, 'utf8')
    const eventsBefore = await runtime.events(sessionId)
    const client = await inspectRuntime(t, runtime)
    const resultKey = 'interrupted-' + boundary.name
    const condition = boundary.name === 'receipt'
      ? `state.receipts?.some(receipt => receipt.resultKey === ${JSON.stringify(resultKey)})`
      : `record.resultKey === ${JSON.stringify(resultKey)}`
    const point = await client.breakAt(boundary.source, boundary.statement, condition, boundary.occurrence ?? 0)
    const awaitingPause = point.next()
    let settled = false
    const request = { resultKey, expectedContent: { [id]: previous }, ops: [{ op: 'update_item', id, body: 'The retained interrupted candidate.\n' }] }
    const operation = runtime.host('ops', request).then(value => { settled = true; return { value } }, error => { settled = true; return { error: error.message } })
    const paused = await awaitingPause
    const saveId = await client.value(paused, boundary.name === 'receipt' ? `state.receipts.find(receipt => receipt.resultKey === ${JSON.stringify(resultKey)}).id` : 'record.id')
    const saveRoot = join(runtime.home, 'media-desk', 'notes-writes', saveId)
    const proposal = JSON.parse(await readFile(join(saveRoot, 'proposal.json'), 'utf8'))
    const file = proposal.files.find(row => row.workId === id)
    const candidatePath = join(file.candidate.notesRoot, file.candidate.relativePath)
    assert.match(await readFile(candidatePath, 'utf8'), /The retained interrupted candidate\./)
    assert.equal(settled, false, 'The actual Host caller must still await the interrupted save')
    if (boundary.journal) assert.equal(JSON.parse(await readFile(join(saveRoot, 'pending.json'), 'utf8')).id, saveId)
    else await assert.rejects(readFile(join(saveRoot, 'pending.json')), { code: 'ENOENT' })
    if (boundary.name === 'displaced') {
      await assert.rejects(readFile(primaryPath), { code: 'ENOENT' })
      assert.equal(await readFile(join(file.displaced.notesRoot, file.displaced.relativePath), 'utf8'), original)
    } else if (boundary.published) {
      assert.equal(await readFile(primaryPath, 'utf8'), await readFile(candidatePath, 'utf8'))
      assert.notEqual((await stat(primaryPath)).ino, (await stat(candidatePath)).ino)
      assert.equal(await readFile(join(file.displaced.notesRoot, file.displaced.relativePath), 'utf8'), original)
    } else assert.equal(await readFile(primaryPath, 'utf8'), original)
    const stateAtBoundary = JSON.parse(await readFile(join(runtime.home, 'media-desk', 'state.json'), 'utf8'))
    assert.equal(stateAtBoundary.receipts?.some(receipt => receipt.resultKey === resultKey) ?? false, Boolean(boundary.accepted))
    assert.equal(stateAtBoundary.items.find(row => row.id === id).content.revision, previous.revision + (boundary.accepted ? 1 : 0))
    const exit = await runtime.stop('SIGKILL')
    assert.equal(exit.timedOut, false)
    assert.equal(exit.signal, 'SIGKILL')
    assert.ok((await operation).error, 'An abrupt termination must disconnect the unsatisfied HTTP caller')
    await runtime.start()
    const restored = (await runtime.host('state')).value.state.items.find(row => row.id === id)
    assert.equal(restored.body, boundary.published ? 'The retained interrupted candidate.\n' : 'The accepted text before interruption.\n')
    const retried = await runtime.host('notes/retry', { id: saveId })
    assert.equal(retried.status, 200, JSON.stringify(retried.value))
    assert.equal(retried.value.acceptance.id, saveId)
    assert.equal(retried.value.state.items.find(row => row.id === id).body, 'The retained interrupted candidate.\n')
    assert.equal(retried.value.state.items.find(row => row.id === id).content.revision, previous.revision + 1)
    const repeated = await runtime.host('ops', request)
    assert.equal(repeated.status, 200, JSON.stringify(repeated.value))
    assert.deepEqual(repeated.value.acceptance, retried.value.acceptance)
    const after = JSON.parse(await readFile(join(runtime.home, 'media-desk', 'state.json'), 'utf8'))
    assert.equal(after.receipts.filter(receipt => receipt.resultKey === resultKey).length, 1)
    const associated = await runtime.host('sessions/open', { workId: id })
    assert.equal(associated.value.association.sessionId, sessionId)
    assert.equal(await readFile(runtime.telemetryPath, 'utf8'), modelEvidence)
    assert.equal((await runtime.events(sessionId)).filter(event => event.type === 'turn/start').length, eventsBefore.filter(event => event.type === 'turn/start').length)
  })
})

test('已接受正文保存保留独立候选、原版本和可核对的待写记录', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t)
  await runtime.start()
  const added = await runtime.host('ops', { resultKey: 'original-work', ops: [{ op: 'add_item', title: 'Recoverable save', body: 'The accepted original.\n', language: 'en' }] })
  const id = added.value.receipts[0].target
  const previous = added.value.state.items.find(row => row.id === id).content
  const edited = await runtime.host('ops', { resultKey: 'edit-work', expectedContent: { [id]: previous }, ops: [{ op: 'update_item', id, body: 'The next accepted text.\n' }] })
  assert.equal(edited.status, 200, JSON.stringify(edited.value))
  const saves = await runtime.host('notes/saves')
  assert.equal(saves.status, 200, JSON.stringify(saves.value))
  const saved = saves.value.writes.find(row => row.resultKey === 'edit-work')
  assert.equal(saved.status, 'accepted')
  assert.equal(saved.receipt.id, edited.value.acceptance.id)
  const file = saved.files.find(row => row.workId === id)
  const bytes = reference => readFile(join(reference.notesRoot, reference.relativePath), 'utf8')
  assert.match(await bytes(file.candidate), /The next accepted text\./)
  assert.match(await bytes(file.beforeSnapshot), /The accepted original\./)
  assert.match(await bytes(file.displaced), /The accepted original\./)
  const current = edited.value.state.items.find(row => row.id === id).content
  const primary = await bytes(current)
  await writeFile(join(current.notesRoot, current.relativePath), primary.replace('The next accepted text.', 'An ordinary editor changes the primary.'))
  assert.match(await bytes(file.candidate), /The next accepted text\./)
})
