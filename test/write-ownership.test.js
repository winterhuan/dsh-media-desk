/** Cross-process ownership plus the approved public Store seam for a held asynchronous edit. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyOps } from '../src/ops.js'
import { hostRuntime } from './fixtures/host-runtime.js'
import { nativeRuntime } from './fixtures/native-runtime.js'

test('公开 Store 异步编辑提交前检测外部字节变化，保留外部正文', { timeout: 180000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'media-desk-notes-barrier-'))
  const previous = process.env.DSH_HOME
  let runtime, release, edit
  t.after(async () => {
    release?.()
    await edit?.catch(() => {})
    await runtime?.close()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  })
  process.env.DSH_HOME = home
  runtime = await hostRuntime()
  const store = runtime.ctx.get('mediaDesk').store
  const added = await store.mutate('Create a work with drafts', state => {
    const created = applyOps(state, [{ op: 'add_item', title: 'One mutation', body: 'The distinct original idea.\n', language: 'en' }])
    const id = created.receipts[0].target
    applyOps(state, [{ op: 'save_draft', id, format: 'article', by: 'ai', text: 'The fixed AI article.\n' }, { op: 'save_draft', id, format: 'script', text: 'The current script.\n' }])
    return id
  })
  const work = (await store.read()).items.find(row => row.id === added)
  assert.equal(work.body, 'The current script.\n')
  assert.equal(work.drafts.article.text, 'The fixed AI article.\n')
  assert.equal(work.drafts.article.aiText, 'The fixed AI article.\n')
  assert.match(await readFile(join(work.sourceContent.notesRoot, work.sourceContent.relativePath), 'utf8'), /The distinct original idea\./)
  const path = join(work.content.notesRoot, work.content.relativePath)
  let entered
  const readiness = new Promise(resolve => { entered = resolve })
  const barrier = new Promise(resolve => { release = resolve })
  edit = store.mutate('An awaited editor operation', async state => {
    entered()
    await barrier
    state.items.find(row => row.id === work.id).body = 'The stale held editor text.\n'
  }, { expectedContent: { [work.id]: work.content } })
  const rejected = assert.rejects(edit, { code: 'notes/conflict' })
  await readiness
  const external = (await readFile(path, 'utf8')).replace('The current script.', 'The latest external script.')
  await writeFile(path, external)
  release()
  await rejected
  assert.equal(await readFile(path, 'utf8'), external)
  const current = (await store.read()).items.find(row => row.id === work.id)
  assert.equal(current.body, 'The latest external script.\n')
  assert.equal(current.content.revision, work.content.revision + 1)
})

test('公开 Store 编辑与设置共用写队列，关闭排空后才让独立 Host 取得 Notes', { timeout: 180000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'media-desk-owned-store-'))
  const previous = process.env.DSH_HOME
  let holder, contender, release
  t.after(async () => {
    release?.()
    await contender?.stop('SIGKILL')
    await holder?.close()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  })
  process.env.DSH_HOME = home
  holder = await hostRuntime()
  const desk = holder.ctx.get('mediaDesk')
  const added = await desk.store.mutate('Create a registered work', state => applyOps(state, [{ op: 'add_item', title: 'A held edit', body: 'Accepted before the held edit.\n', language: 'en' }]))
  const id = added.receipts[0].target
  contender = await nativeRuntime(t)
  let entered
  const readiness = new Promise(resolve => { entered = resolve })
  const barrier = new Promise(resolve => { release = resolve })
  const edit = desk.store.mutate('Held public edit', async state => {
    entered()
    await barrier
    state.items.find(row => row.id === id).body = 'The admitted edit completed before ownership release.\n'
    await desk.settings.update({ voice: 'Inside the admitted edit' })
  })
  await readiness
  const settings = desk.settings.update({ voice: 'The later settings edit' })
  const closed = holder.ctx.fiber.dispose()
  await contender.start([], { WIKI_PATH: holder.wiki })
  assert.equal((await contender.host('state')).status, 404)
  await assert.rejects(readFile(join(contender.home, 'media-desk', 'state.json')), { code: 'ENOENT' })
  release()
  await Promise.all([edit, settings, closed])
  const persisted = JSON.parse(await readFile(join(home, 'media-desk', 'state.json'), 'utf8')).items.find(row => row.id === id)
  assert.equal(Object.hasOwn(persisted, 'body'), false)
  assert.equal(persisted.content.revision, 2)
  assert.match(await readFile(join(persisted.content.notesRoot, persisted.content.relativePath), 'utf8'), /The admitted edit completed before ownership release\./)
  assert.equal(JSON.parse(await readFile(join(home, 'media-desk', 'settings.json'), 'utf8')).voice, 'The later settings edit')
  await assert.rejects(desk.store.mutate('Late edit', () => {}), { code: 'ownership/closing' })
  await assert.rejects(readFile(join(home, 'media-desk', '.media-desk-owner.lock')), { code: 'ENOENT' })
  await contender.stop()
})

test('同一 DSH home 的竞争者不改设置或材料，正常停止后可重新取得所有权', { timeout: 180000 }, async t => {
  let holder, contender
  t.after(async () => { await Promise.all([holder?.stop('SIGKILL'), contender?.stop('SIGKILL')]) })
  holder = await nativeRuntime(t)
  contender = await nativeRuntime(t)
  await holder.start()
  const added = await holder.host('ops', { ops: [{ op: 'add_item', title: 'An owned work', body: 'Keep the primary bytes.\n', language: 'en' }] })
  const id = added.value.receipts[0].target
  const reference = added.value.state.items.find(row => row.id === id).content
  await holder.host('settings', { voice: 'Keep these settings', imageCount: 0 })
  const state = await readFile(join(holder.home, 'media-desk', 'state.json'), 'utf8')
  const settings = await readFile(join(holder.home, 'media-desk', 'settings.json'), 'utf8')
  const primary = await readFile(join(reference.notesRoot, reference.relativePath), 'utf8')
  await contender.start([], { DSH_HOME: holder.home })
  assert.equal((await contender.host('state')).status, 404)
  assert.equal(await readFile(join(holder.home, 'media-desk', 'state.json'), 'utf8'), state)
  assert.equal(await readFile(join(holder.home, 'media-desk', 'settings.json'), 'utf8'), settings)
  assert.equal(await readFile(join(reference.notesRoot, reference.relativePath), 'utf8'), primary)
  await holder.stop()
  await contender.stop()
  await contender.start([], { DSH_HOME: holder.home })
  const recovered = await contender.host('state')
  assert.equal(recovered.status, 200, JSON.stringify(recovered.value))
  assert.equal(recovered.value.state.items.find(row => row.id === id).body, 'Keep the primary bytes.\n')
  await contender.stop()
})

test('被终止持有者的完整 PID 锁可恢复，存活的隔离输出不被删除或重放', { timeout: 180000 }, async t => {
  let holder, external, externalExit
  t.after(async () => {
    if (external && external.exitCode === null) { external.kill('SIGKILL'); await externalExit }
    await holder?.stop('SIGKILL')
  })
  holder = await nativeRuntime(t)
  await holder.start()
  const added = await holder.host('ops', { ops: [{ op: 'add_item', title: 'Recover the owner', body: 'Preserve the accepted primary.\n', language: 'en' }] })
  const id = added.value.receipts[0].target
  const reference = added.value.state.items.find(row => row.id === id).content
  const outputDir = join(holder.home, 'media-desk', 'files', 'isolated-provider-attempt')
  await mkdir(outputDir)
  const output = join(outputDir, 'output.txt')
  await writeFile(output, 'Prepared external output.\n')
  external = spawn(process.execPath, ['--input-type=module', '-e',
    "import { writeFile } from 'node:fs/promises'; process.on('message', async () => { await writeFile(process.argv[1], 'Surviving external output.\\n'); process.send({ written: true }, () => process.disconnect()); }); process.send({ ready: true });", output],
  { env: {}, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  externalExit = new Promise(resolve => { external.once('error', error => resolve({ error })); external.once('exit', (code, signal) => resolve({ code, signal })) })
  const ready = await new Promise((resolve, reject) => { external.once('message', resolve); external.once('error', reject); external.once('exit', (code, signal) => reject(new Error(`External writer exited before readiness: ${code}/${signal}`))) })
  assert.deepEqual(ready, { ready: true })
  const terminated = await holder.stop('SIGKILL')
  assert.equal(terminated.timedOut, false)
  assert.equal(terminated.signal, 'SIGKILL')
  const lock = await readFile(join(reference.notesRoot, '.media-desk-owner.lock'), 'utf8')
  assert.match(lock, /^\d+\n$/)
  assert.equal(external.exitCode, null)
  await holder.start()
  const state = await holder.host('state')
  assert.equal(state.status, 200, JSON.stringify(state.value))
  assert.equal(state.value.state.items.find(row => row.id === id).body, 'Preserve the accepted primary.\n')
  assert.equal(await readFile(output, 'utf8'), 'Prepared external output.\n')
  const written = new Promise((resolve, reject) => { external.once('message', resolve); external.once('error', reject); external.once('exit', (code, signal) => reject(new Error(`External writer exited before output: ${code}/${signal}`))) })
  external.send('release')
  assert.deepEqual(await written, { written: true })
  const exit = await externalExit
  assert.equal(exit.signal, null)
  assert.equal(exit.code, 0)
  assert.equal(await readFile(output, 'utf8'), 'Surviving external output.\n')
  await assert.rejects(readFile(holder.telemetryPath), { code: 'ENOENT' })
  await holder.stop()
})
