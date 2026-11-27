/** Independent CLI and installed Web share registered content and accepted production without synthetic Sessions. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { nativeRuntime } from './fixtures/native-runtime.js'
import { SkillDesk } from '../src/skill-desk.js'

const execute = promisify(execFile)
const cli = fileURLToPath(new URL('../scripts/media-desk.mjs', import.meta.url))
const plan = { title: '共用技能作品', coverText: '控制边界', cover: 'Plain paper and a ledger', facts: [], outline: [], characters: '', images: [], shots: [], sources: [] }

function caller(runtime, mode = 'standalone') {
  return async (action, input = {}) => {
    const file = join(runtime.root, randomUUID() + '.json')
    const output = join(runtime.root, randomUUID() + '.json')
    await writeFile(file, JSON.stringify(input), { mode: 0o600 })
    const args = [cli, action, '--input', file, '--out', output, '--mode', mode, '--home', runtime.home, '--wiki', runtime.wiki]
    if (mode === 'plugin') args.push('--url', runtime.url)
    await execute(process.execPath, args, { env: { ...process.env, MEDIA_DESK_LOGIN_URL: mode === 'plugin' ? runtime.loginUrl : '' }, timeout: 60000 })
    return JSON.parse(await readFile(output, 'utf8'))
  }
}

test('未登记的偏好不能在独立生产中静默丢失', async () => {
  const desk = new SkillDesk({ store: {} })
  assert.equal(await desk.freeze(null, 'rule'), null)
  await assert.rejects(desk.freeze({ id: 'legacy-rule', rule: 'Keep evidence' }, 'rule'), /Register or repair/)
  assert.deepEqual(await desk.freeze({ id: 'preset', preset: true }, 'style'), { presetId: 'preset', value: { id: 'preset', preset: true } })
})

test('独立生成、改稿、规则和素材可由插件继续使用；插件写入可离线读回', { timeout: 180000 }, async t => {
  const runtime = await nativeRuntime(t)
  const standalone = caller(runtime)
  await standalone('settings', { patch: { imageCount: 0, shotCount: 0, generateImages: false } })
  const added = await standalone('ops', { operations: [{ op: 'add_item', title: '初始灵感', body: '控制边界素材', kind: 'note', language: 'zh' }] })
  const id = added.receipts[0].target
  const ruleAdded = await standalone('ops', { operations: [{ op: 'add_skill', name: '陈述性标题', rule: '标题直接表达机制。', scope: '技术分析文章', status: 'active' }] })
  const ruleId = ruleAdded.receipts[0].target
  await assert.rejects(standalone('ops', { operations: [{ op: 'update_skill', id: ruleId, status: 'active' }] }), /current writing preference version/)
  const rule = (await standalone('read', { kind: 'preferences' })).rules.find(row => row.id === ruleId)
  await standalone('ops', { operations: [{ op: 'update_skill', id: ruleId, status: 'active' }], expectedPreferences: { ['rule:' + ruleId]: rule.content } })
  const requestId = randomUUID()
  const prepared = await standalone('begin', { id, requestId, format: 'article', withImages: false })
  assert.equal(prepared.preferences.rules[0].id, ruleId)
  const result = { article: '## 授权由控制账本决定\n\n原始正文。', sources: [], ruleChecks: [{ id: ruleId, status: 'pass', reason: '标题直接表达授权机制。' }] }
  const commit = { requestId, plan, result }
  await assert.rejects(standalone('commit', { ...commit, result: { article: result.article } }), /Check every frozen/)
  const accepted = await standalone('commit', commit)
  assert.equal(accepted.accepted, true)
  const repeat = await standalone('commit', commit)
  assert.equal(repeat.acceptance.id, accepted.acceptance.id)
  assert.equal((await standalone('begin', { id, requestId, format: 'article', withImages: false })).request.status, 'accepted')
  await assert.rejects(standalone('commit', { ...commit, result: { ...result, article: 'Other text' } }), /different content/)
  const original = await standalone('read', { kind: 'work', id })
  assert.equal(original.originals[0].text, result.article)
  assert.equal(original.work.production.attemptId, undefined)
  await assert.rejects(readFile(join(runtime.home, 'media-desk/sessions.json')), { code: 'ENOENT' })
  await standalone('ops', { operations: [{ op: 'update_item', id, body: '## 订阅给了上下文\n\n授权仍由控制账本决定。' }], expectedContent: original.expectedContent })
  await assert.rejects(standalone('ops', { operations: [{ op: 'update_item', id, body: 'Stale' }], expectedContent: original.expectedContent }), /已变化|conflict|版本/)
  const edited = await standalone('read', { kind: 'work', id })
  const source = { id, title: edited.work.title, current: edited.work.content.snapshot, originals: edited.originals.map(row => row.reference) }
  const proposal = { name: '拆开机制因果', rule: '分别展开上下文和授权机制的因果。', scope: '技术分析文章', evidence: '当前稿分别解释订阅和授权。', before: '原始正文。', after: '授权仍由控制账本决定。' }
  await assert.rejects(standalone('rules', { result: { rules: [proposal] }, learningSource: { ...source, current: { sha256: '0'.repeat(64) } } }), /Learning source changed/)
  await standalone('rules', { result: { rules: [proposal, proposal] }, learningSource: source })
  const styles = await standalone('read', { kind: 'preferences' })
  const activeStyleId = styles.style?.id ?? null
  const styleDetails = { logic: '先给证据再归纳', story: '从具体场景切入', flow: '用问题连接段落' }
  await standalone('style', { result: { name: '样文风格', summary: '逐段展开机制', ...styleDetails, samples: ['作者原句。'] } })
  assert.equal((await standalone('read', { kind: 'preferences' })).style?.id ?? null, activeStyleId)
  const png = join(runtime.root, 'cover.png')
  await writeFile(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3foAAAAASUVORK5CYII=', 'base64'))
  const asset = await standalone('asset', { id, target: 'cover', file: png, expectedContent: edited.expectedContent })
  assert.equal(asset.accepted, true)
  await runtime.start()
  const plugin = caller(runtime, 'plugin')
  const state = (await runtime.host('state')).value.state
  const extractedStyle = state.styles.find(row => row.name === '样文风格')
  for (const [key, value] of Object.entries(styleDetails)) assert.equal(extractedStyle[key], value)
  const work = state.items.find(row => row.id === id)
  assert.equal(work.body, edited.work.body)
  assert.equal(work.production.status, 'done')
  assert.equal(work.production.skillResultId, requestId)
  assert.equal(work.production.cover.media.id, asset.id)
  assert.equal(state.skills.filter(row => row.name === proposal.name).length, 1)
  assert.equal(state.skills.find(row => row.name === proposal.name).status, 'proposed')
  const login = await fetch(runtime.loginUrl, { redirect: 'manual' })
  const binary = await fetch(runtime.url + '/media-desk/media/' + asset.id, { headers: { cookie: login.headers.get('set-cookie').split(';')[0] } })
  assert.equal(binary.status, 200)
  assert.deepEqual(Buffer.from(await binary.arrayBuffer()), await readFile(png))
  const current = await plugin('read', { kind: 'work', id })
  assert.equal(current.originals[0].text, result.article)
  const exported = await plugin('export', { id, directory: join(runtime.root, 'export'), expectedContent: current.expectedContent })
  assert.ok(exported.path)
  const saved = await runtime.host('produce/save', { id, expectedContent: current.expectedContent })
  assert.equal(saved.status, 200, JSON.stringify(saved.value))
  await plugin('ops', { operations: [{ op: 'schedule_item', id, platform: '公众号', scheduledAt: '2026-12-01T08:00:00Z' }], expectedContent: current.expectedContent })
  await runtime.stop()
  const final = await standalone('read', { kind: 'work', id })
  assert.equal(final.work.platform, '公众号')
  assert.equal(final.work.scheduledAt, '2026-12-01T08:00:00.000Z')
  assert.equal(final.originals[0].text, result.article)
  const oldRender = final.work.production.cover.renderId
  await standalone('revise', { id, expectedContent: final.expectedContent, revision: { cover: { prompt: 'A revised ledger scene' } } })
  const revised = await standalone('read', { kind: 'work', id })
  assert.notEqual(revised.work.production.cover.renderId, oldRender)
  assert.equal(revised.work.production.cover.prompt, 'A revised ledger scene')
  assert.equal(revised.work.production.cover.media.id, asset.id)
  let calls = 0
  const server = createServer(async (req, res) => {
    for await (const chunk of req) { /* Drain the isolated image request. */ }
    calls += 1
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ data: [{ b64_json: (await readFile(png)).toString('base64') }] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  await standalone('settings', { patch: { image: { baseUrl: 'http://127.0.0.1:' + server.address().port, model: 'fixture', apiKey: 'private-fixture-key' } } })
  await standalone('redraw', { id, target: 'cover' })
  const redrawn = await standalone('read', { kind: 'work', id })
  assert.equal(calls, 1)
  assert.equal(redrawn.work.production.cover.status, 'done')
  assert.notEqual(redrawn.work.production.cover.media.id, asset.id)
  assert.equal(redrawn.work.production.status, 'done')
  const next = await standalone('begin', { id, requestId: randomUUID(), format: 'article', withImages: false })
  await standalone('ops', { operations: [{ op: 'update_item', id, body: 'Changed during preparation' }], expectedContent: final.expectedContent })
  await assert.rejects(standalone('commit', { ...commit, requestId: next.request.id }), /已变化|conflict|版本/)
  await standalone('cancel', { requestId: next.request.id })
})

test('插件原生生产加载包内同一技能并继续接受真实轮次', { timeout: 180000 }, async t => {
  const submit = result => ({ name: 'media_desk_submit_result', arguments: { stageId: '$stageId', result: JSON.stringify(result) } })
  const recipes = {
    MD_STAGE_plan: { calls: [{ name: 'skill', arguments: { name: 'media-desk' } }, { name: 'skill', arguments: { name: 'image-generation' } }, { name: 'media_desk_read', arguments: { kind: 'work' } }, submit(plan)], reply: 'Planned.' },
    MD_STAGE_article: { calls: [{ name: 'media_desk_read', arguments: { kind: 'work' } }, submit({ article: '## 控制边界\n\n共用技能成稿。', sources: [] })], reply: 'Submitted.' },
  }
  const runtime = await nativeRuntime(t, { recipes })
  await runtime.start()
  await runtime.host('notes/migrate', {})
  await runtime.host('settings', { imageCount: 0, shotCount: 0 })
  const admitted = await runtime.host('produce', { id: 'seed_2', format: 'article', withImages: false })
  assert.equal(admitted.status, 200, JSON.stringify(admitted.value))
  const deadline = Date.now() + 60000
  let state
  while (Date.now() < deadline) {
    state = (await runtime.host('state')).value.state
    const work = state.items.find(row => row.id === 'seed_2')
    if (work.production?.status === 'done') break
    const failure = state.nativeRequests.find(row => ['failed', 'save-failed'].includes(row.status))
    if (failure) assert.fail(JSON.stringify(failure) + '\n' + runtime.log)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  const work = state.items.find(row => row.id === 'seed_2')
  assert.equal(work.production.status, 'done')
  assert.ok(work.production.attemptId)
  assert.equal(work.production.skillResultId, undefined)
  const stage = state.nativeRequests.find(row => row.kind === 'plan')
  const results = (await runtime.events(stage.sessionId)).filter(row => row.type === 'tool/result')
  assert.ok(results.some(row => !row.data.message.isError && row.data.message.content.some(block => block.text?.includes('共用执行入口') || block.text?.includes('# Media Desk'))))
  assert.ok(results.some(row => !row.data.message.isError && row.data.message.content.some(block => block.text?.includes('# 全局生图'))))
  assert.ok(results.every(row => !row.data.message.isError), JSON.stringify(results))
  const requests = await readFile(runtime.telemetryPath, 'utf8')
  assert.match(requests, /Media Desk is driven by the bundled skill/)
  assert.match(requests, /Use the media-desk skill for the plan stage/)
})
