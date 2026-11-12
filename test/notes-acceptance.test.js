/** Real Store replacement and a final asynchronous filesystem gate retain the native execution seam. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { closeSync, constants, openSync, writeSync } from 'node:fs'
import { open, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { nativeRuntime } from './fixtures/native-runtime.js'
import { inspectRuntime } from './fixtures/inspector.js'

const execute = promisify(execFile)
const observer = fileURLToPath(new URL('./fixtures/store-acceptance.js', import.meta.url))

async function setup(t) {
  const runtime = await nativeRuntime(t)
  await runtime.start([{ insert: [{ id: 'notes-store-acceptance-fixture', name: observer }] }], { NODE_OPTIONS: '--inspect=127.0.0.1:0', UV_THREADPOOL_SIZE: '1' })
  const added = await runtime.host('ops', { undoable: false, ops: [{ op: 'add_item', title: 'A real Store acceptance', body: 'The previously accepted text.\n', language: 'en' }] })
  const work = added.value.state.items.find(row => row.id === added.value.receipts[0].target)
  const opened = await runtime.host('sessions/open', { workId: work.id })
  const sessionId = opened.value.association.sessionId
  const sourceRequestId = await runtime.prompt(sessionId, 'MD_FIXTURE_STORE_ACCEPTANCE_WARM')
  const warm = await runtime.turn(sessionId, sourceRequestId)
  assert.equal(warm.end.data.reason.kind, 'completed')
  const client = await inspectRuntime(t, runtime)
  const request = { id: work.id, sourceRequestId, resultKey: 'store-plan-' + randomUUID(), content: work.content,
    body: 'The candidate accepted with its structured plan.\n', facts: ['One accepted fact'], outline: ['One accepted outline'] }
  return { runtime, work, sessionId, warm, client, request }
}

test('实际 Store 替换同时提交正文引用、回执、真实来源关联与结构化策划，通知丢失仍返回原回执', { timeout: 180000 }, async t => {
  const { runtime, work, sessionId, warm, client, request } = await setup(t)
  const point = await client.breakAt('/src/store.js', 'this.state = state', `state.receipts?.some(receipt => receipt.resultKey === ${JSON.stringify(request.resultKey)})`)
  const pause = point.next().then(value => ({ pause: value }), error => ({ pauseError: error.message }))
  let settled = false
  const operation = runtime.host('../md-notes-fixture-save', request).then(value => { settled = true; return { value } }, error => { settled = true; return { error: error.message } })
  const reached = await Promise.race([pause, operation])
  assert.ok(reached.pause, 'The actual Store boundary must precede the HTTP outcome: ' + JSON.stringify(reached))
  const saved = JSON.parse(await readFile(join(runtime.home, 'media-desk', 'state.json'), 'utf8'))
  const receipt = saved.receipts.find(receipt => receipt.resultKey === request.resultKey)
  const accepted = saved.items.find(row => row.id === work.id)
  assert.ok(receipt)
  assert.deepEqual(accepted.content, receipt.contentVersions.find(row => row.workId === work.id) && Object.fromEntries(Object.entries(receipt.contentVersions.find(row => row.workId === work.id)).filter(([key]) => key !== 'workId')))
  assert.deepEqual(accepted.production.facts, request.facts)
  assert.deepEqual(accepted.production.outline, request.outline)
  assert.equal(accepted.production.article, undefined)
  const association = saved.planAssociations.find(row => row.id === request.resultKey)
  assert.equal(association.workId, work.id)
  assert.equal(association.sessionId, sessionId)
  assert.equal(association.sourceTurn, warm.start.data.turn)
  assert.equal(settled, false)
  assert.match(await readFile(join(accepted.content.notesRoot, accepted.content.relativePath), 'utf8'), /The candidate accepted with its structured plan/)
  await runtime.stop('SIGKILL')
  assert.ok((await operation).error)
  const model = await readFile(runtime.telemetryPath, 'utf8')
  await runtime.start([{ insert: [{ id: 'notes-store-acceptance-fixture', name: observer }] }])
  const retried = await runtime.host('notes/retry', { id: receipt.id })
  assert.equal(retried.status, 200, JSON.stringify(retried.value))
  assert.deepEqual(retried.value.acceptance, receipt)
  const duplicate = await runtime.host('../md-notes-fixture-save', request)
  assert.deepEqual(duplicate.value.acceptance, receipt)
  assert.equal((await runtime.host('sessions/open', { workId: work.id })).value.association.sessionId, sessionId)
  assert.equal(await readFile(runtime.telemetryPath, 'utf8'), model)
})

test('最后异步文件关闭等待期间真实原生输入被领取，同步校验拒绝接受且冷恢复不采用未接受主文件', {
  timeout: 180000, skip: process.platform === 'win32' && 'The real FIFO worker scheduling gate requires POSIX',
}, async t => {
  const { runtime, work, sessionId, client, request } = await setup(t)
  const statePath = join(runtime.home, 'media-desk', 'state.json')
  const acceptedBytes = await readFile(statePath, 'utf8')
  const fifo = join(runtime.root, 'notes-close.fifo')
  await execute('mkfifo', [fifo])
  let armed = false, pid
  const release = () => {
    if (!armed) return
    try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') { armed = false; return }; throw error }
    const writer = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK)
    try { writeSync(writer, Buffer.from([1])) } finally { closeSync(writer); armed = false }
  }
  t.after(release)
  const point = await client.breakAt('/src/store.js', 'await handle.close()', `state.receipts?.some(receipt => receipt.resultKey === ${JSON.stringify(request.resultKey)})`)
  const rejection = await client.breakAt('/src/store.js', 'try { await this.writes.restoreAccepted(record, error)', `record.resultKey === ${JSON.stringify(request.resultKey)}`)
  const pause = point.next().then(value => ({ pause: value }), error => ({ pauseError: error.message }))
  let settled = false
  const operation = runtime.host('../md-notes-fixture-save', request).then(value => { settled = true; return { value } }, error => { settled = true; return { error: error.message } })
  const reached = await Promise.race([pause, operation])
  assert.ok(reached.pause, 'The actual asynchronous Store preparation must precede the HTTP outcome: ' + JSON.stringify(reached))
  const paused = reached.pause
  const temporary = await client.value(paused, 'temporary')
  const proposed = JSON.parse(await readFile(temporary, 'utf8'))
  const receipt = proposed.receipts.find(receipt => receipt.resultKey === request.resultKey)
  assert.ok(receipt)
  assert.equal(await readFile(statePath, 'utf8'), acceptedBytes)
  pid = await client.value(paused, `(() => { const fs = process.getBuiltinModule('node:fs'); const fd = fs.openSync(${JSON.stringify(fifo)}, 'r+'); fs.read(fd, Buffer.alloc(1), 0, 1, null, () => { fs.close(fd, () => console.log('MD_NOTES_FIFO_CLOSED')); }); return process.pid })()`)
  armed = true
  const rejectedPause = rejection.next().then(value => ({ value }), error => ({ error: error.message }))
  await point.remove()
  await client.send('Debugger.resume')
  const nextRequestId = randomUUID()
  const claimed = client.next('Runtime.consoleAPICalled', event => event.args?.some(argument => typeof argument.value === 'string'
    && argument.value.startsWith('MD_STORE_CLAIM ') && JSON.parse(argument.value.slice(15)).rpcId === nextRequestId)).then(value => ({ value }), error => ({ error: error.message }))
  const prompted = runtime.rpc('session/prompt', { request: { sessionId, requestId: nextRequestId, mode: 'queue', content: [{ type: 'text', text: 'MD_FIXTURE_NATIVE_INPUT_AT_FINAL_NOTES_AWAIT' }] } })
    .then(value => ({ value }), error => ({ error: error.message }))
  const observation = await claimed
  assert.ok(observation.value, JSON.stringify(observation))
  const claim = JSON.parse(observation.value.args.find(argument => argument.value?.startsWith?.('MD_STORE_CLAIM ')).value.slice(15))
  assert.equal(claim.sessionId, sessionId)
  const resources = await client.send('Runtime.evaluate', { expression: 'process.getActiveResourcesInfo()', returnByValue: true })
  t.diagnostic('Live resources after the exact native claim: ' + JSON.stringify(resources.result.value))
  assert.ok(resources.result.value.includes('CloseReq'), JSON.stringify(resources.result.value))
  assert.ok(resources.result.value.includes('FSReqCallback'))
  assert.equal(settled, false)
  assert.equal(await readFile(statePath, 'utf8'), acceptedBytes)
  assert.equal(JSON.parse(await readFile(temporary, 'utf8')).receipts.at(-1).id, receipt.id)
  release()
  const rejected = await rejectedPause
  assert.ok(rejected.value, JSON.stringify(rejected))
  assert.equal(await client.value(rejected.value, 'error.code'), 'fixture/stale-native-claim')
  assert.equal(await readFile(statePath, 'utf8'), acceptedBytes, 'No stale receipt exists before any restoration can run')
  const primary = join(work.content.notesRoot, work.content.relativePath)
  const unaccepted = await readFile(primary, 'utf8')
  assert.match(unaccepted, /The candidate accepted with its structured plan/)
  const journal = JSON.parse(await readFile(join(runtime.home, 'media-desk', 'notes-writes', receipt.id, 'pending.json'), 'utf8'))
  const publication = journal.files.find(file => file.workId === work.id).publication
  const editor = await open(primary, 'r+')
  t.after(() => editor.close())
  assert.equal((await editor.stat()).ino, (await stat(join(publication.notesRoot, publication.relativePath))).ino)
  const external = unaccepted.replace('The candidate accepted with its structured plan.', 'The unaccepted candidate with an external correction.')
  await editor.truncate(0)
  await editor.write(external, 0, 'utf8')
  await runtime.stop('SIGKILL')
  assert.ok((await operation).error)
  await prompted
  const model = await readFile(runtime.telemetryPath, 'utf8')
  await runtime.start([{ insert: [{ id: 'notes-store-acceptance-fixture', name: observer }] }])
  const restored = await runtime.host('state')
  assert.equal(restored.value.state.items.find(row => row.id === work.id).body, 'The previously accepted text.\n')
  assert.equal(restored.value.state.receipts.some(row => row.id === receipt.id), false)
  assert.equal(restored.value.state.planAssociations, undefined)
  assert.equal(await readFile(primary, 'utf8'), external)
  const saved = (await runtime.host('notes/saves')).value.writes.find(row => row.id === receipt.id)
  assert.ok(saved.conflicts.some(conflict => conflict.observedSha256 !== conflict.expectedSha256))
  const retry = await runtime.host('notes/retry', { id: receipt.id })
  assert.equal(retry.status, 409)
  assert.equal(retry.value.code, 'notes/validation-required')
  assert.equal(await readFile(runtime.telemetryPath, 'utf8'), model)
})
