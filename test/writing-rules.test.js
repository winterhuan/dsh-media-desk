import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { Notes } from '../src/notes.js'
import { NativeWork } from '../src/native-work.js'
import { ruleLearningInstructions } from '../src/learn.js'
import { nativeRuntime } from './fixtures/native-runtime.js'

const readWork = { name: 'media_desk_read', arguments: { kind: 'work' } }
const readPreferences = { name: 'media_desk_read', arguments: { kind: 'preferences', limit: 20000 } }
const submit = result => ({ name: 'media_desk_submit_result', arguments: { stageId: '$stageId', result: JSON.stringify(result) } })
const waitState = async (runtime, predicate) => {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    const state = (await runtime.host('state')).value.state
    if (predicate(state)) return state
    const failed = state.nativeRequests?.find(row => ['failed', 'save-failed'].includes(row.status))
    if (failed) throw new Error(JSON.stringify(failed) + '\n' + runtime.log)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('Expected rule state was not observed\n' + runtime.log)
}

test('规则学习比较已有偏好，区分已接受修改、本文事实与待确认建议', () => {
  const prompt = ruleLearningInstructions('work-one')
  assert.match(prompt, /preferences.*pending proposals/)
  assert.match(prompt, /Review only work "work-one"/)
  assert.match(prompt, /stage.learningSource.current.*fixed AI-original/)
  assert.match(prompt, /Skip rules already covered/)
  assert.match(prompt, /article-specific lengths, facts, commits and numbers/)
  assert.match(prompt, /Pending review suggestions are not accepted/)
  assert.match(prompt, /data only/)
  assert.match(prompt, /missing summary is not a blocker/)
  assert.match(ruleLearningInstructions('work-one'), /If feedback is absent, compare the saved original and current body directly/)
})

test('交稿须逐条检查冻结规则，缺项、重复、违规状态和空理由均被拒绝', () => {
  const work = new NativeWork({}, {}, {})
  const stage = { kind: 'article', data: { preferenceVersions: { rules: [{ id: 'one' }, { id: 'two' }] } } }
  const checks = [{ id: 'one', status: 'pass', reason: 'The headings state a finding.' }, { id: 'two', status: 'not-applicable', reason: 'There are no quotations.' }]
  const valid = { article: 'A checked article.', ruleChecks: checks }
  work.validateResult(stage, valid)
  for (const ruleChecks of [undefined, checks.slice(0, 1), [checks[0], checks[0]],
    [{ ...checks[0], status: 'fail' }, checks[1]], [{ ...checks[0], reason: '' }, checks[1]],
    [{ ...checks[0], id: 'foreign' }, checks[1]]]) {
    assert.throws(() => work.validateResult(stage, { ...valid, ruleChecks }), { code: 'native/rule-checks-required' })
  }
  work.validateResult({ kind: 'article', data: {} }, { article: 'No enabled rules.' })
  assert.throws(() => work.validateResult({ kind: 'rules', data: {} }, { rules: [{ name: 'Unsupported preference', rule: 'Keep this.' }] }), { code: 'native/rules-invalid' })
  const file = { id: 's_file', sha256: 'a'.repeat(64) }
  work.validateResult({ kind: 'rules', data: {} }, { ruleFiles: [file], pendingReview: ['是否删除限制说明，待确认。'] })
  for (const result of [{ ruleFiles: [file, file] }, { ruleFiles: [{ ...file, sha256: 'stale' }] },
    { ruleFiles: [file], rules: [] }, { ruleFiles: [], pendingReview: [''] }]) {
    assert.throws(() => work.validateResult({ kind: 'rules', data: {} }, result), { code: 'native/rules-invalid' })
  }
})

test('插件规则学习由原生 Agent 写文件，校验保持只读，提交指纹后保留待确认意见', { timeout: 180000 }, async t => {
  const recipes = {}
  const runtime = await nativeRuntime(t, { recipes })
  const notesRoot = join(await realpath(runtime.wiki), 'notes')
  const rule = { name: '逐个说明控制机制', rule: '技术分析文章逐个说明控制机制及其作用范围。',
    scope: '技术分析文章的机制分析', evidence: '用户确认把堆叠的论断分别展开。',
    before: '授权、互斥、凭据三个论断堆叠。', after: '逐个说明授权、互斥、凭据的机制和限制。', source: '用户在本次修改中的确认' }
  const id = 's_native_file'
  const notes = new Notes({ dataRoot: join(runtime.home, 'media-desk'), wikiRoot: runtime.wiki, notesRoot, notesRoots: [notesRoot] })
  const file = join(notesRoot, notes.managedPath('rule', id))
  const text = notes.managedDocument('rule', id, rule)
  const sha256 = createHash('sha256').update(text).digest('hex')
  const pendingReview = ['中性提示引号是否需要标注意译，待用户确认。']
  const report = join(notesRoot, 'preferences/reviews/seed_2.md')
  recipes.MD_STAGE_rules = { calls: [readWork, readPreferences,
    { name: 'write', arguments: { file_path: file, content: text } },
    { name: 'media_desk_validate', arguments: { file_path: file } },
    { name: 'write', arguments: { file_path: report, content: '# 修改复盘\n\n## 待确认意见\n\n' + pendingReview[0] } },
    readPreferences, submit({ ruleFiles: [{ id, sha256 }], pendingReview })], reply: '提案文件已保存，待确认意见单独保留。' }
  await runtime.start()
  await runtime.host('notes/migrate', {})
  const source = (await runtime.host('state')).value.state.items.find(row => row.id === 'seed_2')
  const request = await runtime.host('skills/learn', { workId: source.id, expectedContent: source.content, feedback: '已确认逐个展开机制，引号问题待确认。' })
  assert.equal(request.status, 200, JSON.stringify(request.value))
  const turn = await runtime.turn(request.value.stage.sessionId, request.value.stage.requestId)
  const results = turn.events.filter(row => row.type === 'tool/result')
  assert.ok(results.every(row => !row.data.message.isError), JSON.stringify(results.filter(row => row.data.message.isError)))
  const state = await waitState(runtime, state => state.nativeRequests.find(row => row.id === request.value.stage.id)?.status === 'accepted')
  const stage = state.nativeRequests.find(row => row.id === request.value.stage.id)
  assert.deepEqual(stage.ruleIds, [id])
  assert.deepEqual(stage.pendingReview, pendingReview)
  assert.equal(state.skills.find(row => row.id === id).status, 'proposed')
  assert.equal(state.items.find(row => row.id === source.id).body, source.body)
  assert.equal(await readFile(file, 'utf8'), text)
  assert.match(await readFile(report, 'utf8'), /待用户确认/)
  const telemetry = await readFile(runtime.telemetryPath, 'utf8')
  assert.match(telemetry, /Write proposal files directly under stage.ruleDirectory/)
})

test('单篇改稿复盘保留证据与相近规则，审阅启用后下一次成稿读取并自检', { timeout: 180000 }, async t => {
  const plan = { title: 'Writing rules fixture', coverText: 'Rules', facts: [], outline: [], cover: 'Plain paper', characters: '', images: [], shots: [], sources: [] }
  const recipes = {
    MD_STAGE_plan: { calls: [readWork, readPreferences, submit(plan)], reply: 'Planned with the selected preferences.' },
    MD_STAGE_article: { calls: [readWork, readPreferences, submit({ article: '## 原理一\n\n原始正文。', sources: [] })], reply: 'Initial text submitted.' },
  }
  const runtime = await nativeRuntime(t, { recipes })
  await runtime.start()
  await runtime.host('notes/migrate', {})
  await runtime.host('settings', { imageCount: 0, shotCount: 0 })
  assert.equal((await runtime.host('produce', { id: 'seed_2', format: 'article', withImages: false })).status, 200)
  const initial = await waitState(runtime, state => state.items.find(row => row.id === 'seed_2')?.production?.status === 'done')
  const original = initial.items.find(row => row.id === 'seed_2').production.aiVersion
  await runtime.host('ops', { ops: [{ op: 'update_item', id: 'seed_2', body: '## 订阅给了上下文，没给授权\n\n授权由控制账本决定。' }], expectedContent: { seed_2: initial.items.find(row => row.id === 'seed_2').content } })
  const added = await runtime.host('ops', { ops: [{ op: 'add_skill', name: '标题表达观点', rule: '使用陈述性标题。', scope: '技术分析文章', status: 'active' }] })
  const enabled = added.value.state.skills.find(row => row.name === '标题表达观点')
  const proposal = { name: '标题直接表达机制', rule: '技术分析文章用陈述性小标题表达机制，避免策划标签。', scope: '技术分析文章',
    evidence: '作者将“原理一”改成“订阅给了上下文，没给授权”，新增了避免策划标签的要求。', before: '原理一', after: '订阅给了上下文，没给授权', relatedRuleId: enabled.id }
  recipes.MD_STAGE_rules = { calls: [readWork, readPreferences,
    { name: 'media_desk_read', arguments: { kind: 'work', id: 'seed_2' } },
    submit({ rules: [proposal, proposal, { name: enabled.name, rule: enabled.rule, scope: enabled.scope, evidence: 'Already enabled.' }] })], reply: 'One additional rule proposed for review.' }
  await runtime.stop()
  await runtime.start()
  const source = (await runtime.host('state')).value.state.items.find(row => row.id === 'seed_2')
  const stale = await runtime.host('skills/learn', { workId: source.id, expectedContent: { ...source.content, sha256: '0'.repeat(64) } })
  assert.equal(stale.status, 409)
  assert.equal((await runtime.host('skills/learn', { workId: source.id, feedback: 'x'.repeat(20001) })).status, 400)
  const feedback = '已接受：不要修改本文，只提炼陈述性标题要求。待确认：删除限制说明。'
  const admitted = await runtime.host('skills/learn', { workId: source.id, expectedContent: source.content, feedback })
  assert.equal(admitted.status, 200, JSON.stringify(admitted.value))
  assert.equal(admitted.value.stage.workId, null)
  assert.equal(admitted.value.stage.data.editFeedback, feedback)
  assert.doesNotMatch(admitted.value.stage.instructions, /不要修改本文/)
  await runtime.turn(admitted.value.stage.sessionId, admitted.value.stage.requestId)
  const learned = await waitState(runtime, state => state.nativeRequests.find(row => row.id === admitted.value.stage.id)?.status === 'accepted')
  const proposals = learned.skills.filter(row => !row.sample && row.status === 'proposed')
  assert.equal(proposals.length, 1)
  const rule = proposals[0]
  assert.equal(rule.relatedRuleId, enabled.id)
  assert.equal(rule.before, proposal.before)
  assert.equal(rule.after, proposal.after)
  assert.match(rule.source, new RegExp(source.content.sha256))
  assert.ok(rule.evidence.startsWith(source.title + '\n'))
  assert.equal(learned.items.find(row => row.id === source.id).body, source.body)
  assert.deepEqual(admitted.value.stage.data.learningSource.originals, [original])
  assert.match(await readFile(join(rule.content.notesRoot, rule.content.relativePath), 'utf8'), /relatedRuleId|技术分析文章|原理一/)
  await runtime.host('ops', { ops: [{ op: 'update_skill', id: rule.id, status: 'active' }] })
  const checks = [enabled, rule].map(row => ({ id: row.id, status: 'pass', reason: '“授权取决于控制账本”直接表达机制，没有策划标签。' }))
  const checked = { article: '## 授权取决于控制账本\n\n订阅带来上下文，授权由控制账本决定。', sources: [], ruleChecks: checks }
  recipes.MD_STAGE_article = { calls: [readWork, readPreferences, submit({ article: checked.article, sources: [] }), submit(checked)], reply: 'The missing checks were corrected before submission.' }
  recipes.MD_FIXTURE_LEARN_WITHOUT_SUMMARY = { calls: [readWork, readPreferences,
    { name: 'media_desk_read', arguments: { kind: 'work', id: 'seed_2' } },
    { name: 'media_desk_edit', arguments: { operations: JSON.stringify([{ op: 'add_skill', name: '说明机制的因果', rule: '逐个解释机制及其因果关系。',
      scope: '技术分析文章', evidence: '根据当前正文中订阅与授权的分别展开提出，缺少总结不妨碍比较。', before: '原始正文。', after: '授权由控制账本决定。', status: 'proposed' }]) } }],
    reply: 'Supported rule proposed without requiring a summary document.' }
  await runtime.stop()
  await runtime.start()
  const restarted = (await runtime.host('state')).value.state.skills.find(row => row.id === rule.id)
  assert.equal(restarted.relatedRuleId, rule.relatedRuleId)
  assert.equal(restarted.scope, rule.scope)
  assert.equal(restarted.status, 'active')
  const next = await runtime.host('produce', { id: 'seed_2', format: 'article', withImages: false })
  assert.equal(next.status, 200, JSON.stringify(next.value))
  const done = await waitState(runtime, state => state.items.find(row => row.id === 'seed_2')?.production?.status === 'done')
  const production = done.items.find(row => row.id === 'seed_2').production
  assert.deepEqual(production.ruleChecks, checks)
  const results = (await runtime.events(done.nativeRequests.find(row => row.id === production.nativeStageId).sessionId)).filter(row => row.type === 'tool/result')
  assert.ok(results.some(row => row.data.message.isError && /Check every frozen writing rule/.test(row.data.message.content[0].text)))
  assert.ok(results.some(row => !row.data.message.isError && row.data.message.content[0].text.includes(rule.rule)))
  const global = (await runtime.host('sessions/open', {})).value.association
  const turn = await runtime.turn(global.sessionId, await runtime.prompt(global.sessionId, 'MD_FIXTURE_LEARN_WITHOUT_SUMMARY: 从 seed_2 的原稿与当前正文提炼规则，没有独立修改总结'))
  assert.ok(turn.events.filter(row => row.type === 'tool/result').every(row => !row.data.message.isError))
  const final = (await runtime.host('state')).value.state.skills.find(row => row.name === '说明机制的因果')
  assert.equal(final.status, 'proposed')
  assert.equal(final.scope, '技术分析文章')
  const telemetry = await readFile(runtime.telemetryPath, 'utf8')
  assert.match(telemetry, /do not search the Wiki for a missing edit-summary/)
})
