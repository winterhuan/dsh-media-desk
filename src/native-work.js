/** Host-owned native input accounting and candidate acceptance for registered creative objects. */
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { applyOps } from './ops.js'
import { normalizeStyle } from './style.js'
import { tr } from './i18n.js'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const failure = (code, message, status = 409) => Object.assign(new Error(message), { code, status })
const active = row => ['pending', 'running', 'waiting', 'candidate', 'save-failed'].includes(row.status)
const stageText = row => `Media Desk stage ${row.id} (${row.kind}).\n${row.instructions}\nRead media_desk_read for the stage and current Notes version. Submit the structured candidate using media_desk_submit_result, then finish this turn. Do not poll acceptance within this turn: the Host accepts a candidate only after the native turn succeeds. Do not write registered creative files through filesystem or Shell tools.`
const readonly = messages => messages.some(message => message.source?.kind === 'user'
  && /\bread[ -]only\b|只读|禁止写入|不要(?:保存|写入|修改)/i.test(message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')))

/** One Host service for native inputs, ordinary edits and structured stages. */
export class NativeWork {
  constructor(ctx, store, sessions) {
    this.ctx = ctx
    this.store = store
    this.sessions = sessions
    this.agents = new Map()
    this.barriers = new Map()
    this.failedInputs = new Set()
    this.recoveryPending = new Set()
  }

  /** Startup records uncertain work without repeating model, image or Wiki effects. */
  async init() {
    const state = await this.store.read()
    for (const row of state.nativeRequests ?? []) if (active(row) && row.turn !== undefined) this.recoveryPending.add(row.sessionId)
    if (!state.nativeRequests?.some(row => row.status === 'pending' && row.turn === undefined)) return
    await this.store.mutate('记录中断的原生受理', draft => {
      for (const row of draft.nativeRequests ?? []) if (row.status === 'pending' && row.turn === undefined) {
        row.status = 'interrupted'; row.error = 'Native admission was interrupted; inspect the retained Session before retrying'
      }
    }, { undoable: false })
  }

  service(name) { return this.sessions.service(name) }

  /** Read canonical native history using the public, paged Session query. */
  async events(sessionId, fromSeq = 0) {
    const records = []
    let beforeSeq, throughSeq
    for (;;) {
      const page = await this.service('sessionController').events({ address: { kind: 'session', sessionId }, maxMessages: 1000,
        ...(beforeSeq === undefined ? {} : { beforeSeq }), ...(throughSeq === undefined ? {} : { throughSeq }) }, this.store.owner.signal)
      throughSeq ??= page.cursor
      const events = page.records.filter(record => record.type === 'event').map(record => record.event)
      records.unshift(...events.filter(event => event.seq >= fromSeq))
      const first = events[0]?.seq
      if (!page.hasMore || first === undefined || first <= fromSeq) return records
      if (beforeSeq !== undefined && first >= beforeSeq) throw failure('native/history-invalid', 'Native history did not advance')
      beforeSeq = first
    }
  }

  /** Register native listeners before a creative Agent can consume input after cold recovery. */
  attach(ctx) {
    ctx.on('agent/pre-step', async (payload, next) => {
      try { await this.prepare(payload) } catch (error) {
        this.failedInputs.add(payload.agent.id)
        this.ctx.logger.error(error)
      }
      // A failed business record blocks acceptance, while the claimed native input still runs.
      return next()
    })
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end' && event.type !== 'agent/inbox/spliced') return
      const previous = this.barriers.get(session.id) ?? Promise.resolve()
      const operation = previous.then(() => this.store.owner.track(() => this.observe(session, event)))
      this.barriers.set(session.id, operation.catch(error => { this.ctx.logger.error(error) }))
    })
    ctx.on('agent/created', async ({ agent }) => {
      this.agents.set(agent.id, agent)
      await this.recover(agent)
    })
    ctx.on('agent/disposed', ({ agent }) => { this.agents.delete(agent.id) })
  }

  async prepare({ agent, messages, turn, step, modelSelection }) {
    await this.barriers.get(agent.id)
    const association = this.sessions.requireAssociation(agent)
    this.agents.set(agent.id, agent)
    const history = await this.events(agent.id)
    const startSeq = history.findLast(event => event.type === 'turn/start' && event.data.turn === turn)?.seq
    if (startSeq === undefined) throw failure('native/turn-missing', 'Native turn start is unavailable')
    const incoming = messages.filter(message => message.source?.kind === 'user')
    const interrupted = []
    await this.store.mutate('原生输入', draft => {
      draft.nativeInputs ??= []
      for (const message of incoming) {
        const request = draft.nativeRequests?.find(row => row.associationId === association.id && row.requestId === message.source.rpcId && active(row))
        const insertion = history.find(event => event.type === 'agent/inbox/spliced' && event.data.inserted.some(row => row.id === message.id))
        const input = { sessionId: agent.id, messageId: message.id, requestId: message.source.rpcId ?? null, turn, startSeq,
          target: insertion?.data.target, fingerprint: hash(message), source: message.source,
          steps: [{ step, model: { ...modelSelection } }], readOnly: readonly([message]), selectionVersions: {} }
        for (const block of message.content) if (block.type === 'text') {
          for (const match of block.text.matchAll(/\[Media Desk selection: (\{[^\n]+\})\]/g)) Object.assign(input.selectionVersions, JSON.parse(match[1]))
        }
        const old = draft.nativeInputs.find(row => row.sessionId === agent.id && row.messageId === message.id)
        if (!old) draft.nativeInputs.push(input)
        else if (!old.steps.some(row => row.step === step)) old.steps.push(...input.steps)
        for (const row of draft.nativeRequests ?? []) if (row.associationId === association.id && active(row)) {
          if (row !== request || row.inputFingerprint && row.inputFingerprint !== input.fingerprint
            || row.inputTarget && row.inputTarget !== input.target
            || row === request && (request.inputTextHash !== hash(message.content) || insertion && hash(insertion.data.inserted.find(row => row.id === message.id)) !== input.fingerprint)) {
            row.status = 'interrupted'
            row.error = 'New or changed native input superseded this stage'
            interrupted.push(structuredClone(row))
          }
        }
        if (request && active(request)) {
          request.status = 'running'
          request.turn = turn
          request.startSeq = startSeq
          request.messageId = message.id
          request.inputFingerprint = input.fingerprint
          request.inputTarget = input.target
        }
      }
      for (const request of draft.nativeRequests ?? []) if (request.sessionId === agent.id && request.turn === turn && active(request)) {
        request.actualModels ??= []
        if (!request.actualModels.some(row => row.step === step)) request.actualModels.push({ step, ...modelSelection })
      }
    }, { undoable: false })
    this.failedInputs.delete(agent.id)
    for (const row of interrupted) await this.ctx.mediaDesk.producer?.nativeEnded(row)
  }

  async observe(session, event) {
    if (event.type === 'agent/inbox/spliced' && event.data.outcome === 'canceled') {
      const inbox = { 'next-turn': [], 'next-step': [] }
      for (const row of await this.events(session.id)) {
        if (row.seq >= event.seq) break
        if (row.type === 'agent/inbox/spliced') inbox[row.data.target].splice(row.data.start, row.data.removedCount, ...row.data.inserted)
      }
      const removed = new Set(inbox[event.data.target].slice(event.data.start, event.data.start + event.data.removedCount).map(message => message.source?.rpcId))
      const interrupted = []
      await this.store.mutate('原生队列变化', draft => {
        for (const row of draft.nativeRequests ?? []) if (row.sessionId === session.id && row.status === 'pending' && removed.has(row.requestId)) {
          row.status = 'interrupted'
          row.error = 'Pending native input was removed or replaced'
          interrupted.push(structuredClone(row))
        }
      }, { undoable: false })
      for (const row of interrupted) await this.ctx.mediaDesk.producer?.nativeEnded(row)
    }
    if (event.type === 'turn/end') await this.finish(session.id, event.data.turn)
  }

  async recover(agent) {
    const state = await this.store.read()
    for (const request of state.nativeRequests ?? []) if (request.sessionId === agent.id && active(request) && request.turn !== undefined) {
      await this.finish(agent.id, request.turn, { schedule: !this.recoveryPending.has(agent.id) })
      if (this.recoveryPending.has(agent.id)) await this.store.mutate('核对中断的原生轮次', draft => {
        const row = draft.nativeRequests.find(row => row.id === request.id)
        if (active(row) && row.status !== 'save-failed') { row.status = 'interrupted'; row.error = 'The original native turn has no durable successful result' }
      }, { undoable: false })
    }
    this.recoveryPending.delete(agent.id)
  }

  async actor(exec, write = false) {
    exec.signal.throwIfAborted()
    const association = this.sessions.requireAssociation(exec.agent)
    if (this.failedInputs.has(exec.agent.id)) throw failure('native/input-unsaved', 'Native input could not be recorded; retry after repairing storage')
    const state = await this.store.read()
    const current = state.nativeInputs?.findLast(row => row.sessionId === exec.agent.id)
    if (!current) throw failure('native/input-missing', 'No recorded native user input authorizes this operation')
    if (write && current.readOnly) throw failure('native/read-only', 'This input permits reading only', 403)
    if (write) this.store.notes.assertExpected(state, current.selectionVersions ?? {})
    return { association, state, current }
  }

  /** Return bounded current content, references and the owned stage; omit settings and credentials. */
  async read(exec, { kind = 'work', id, offset = 0, limit = 12000 }) {
    const { association, state } = await this.actor(exec)
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20000) throw failure('native/read-range', 'Invalid read range', 400)
    const page = value => {
      const text = JSON.stringify(value)
      return text.length <= limit && offset === 0 ? value : { text: text.slice(offset, offset + limit), truncated: text.length > offset + limit, nextOffset: text.length > offset + limit ? offset + limit : null }
    }
    if (kind === 'work') {
      const workId = id ?? association.workId
      if (association.workId !== null && workId !== association.workId) throw failure('native/foreign-object', 'This Session owns another work', 403)
      const work = state.items.find(row => row.id === workId)
      if (!work) {
        if (workId !== null) throw failure('native/work-missing', 'Work not found', 404)
        return { works: state.items.slice(0, 80).map(row => ({ id: row.id, title: row.title, status: row.status, content: row.content })),
          stage: this.currentStage(state, association) }
      }
      const stage = this.currentStage(state, association)
      const production = work.production && { ...work.production, article: undefined, aiArticle: undefined }
      const drafts = Object.fromEntries(Object.entries(work.drafts ?? {}).map(([key, row]) => [key, { aiVersion: row.aiVersion, version: row.version }]))
      return { id: work.id, title: work.title, kind: work.kind, status: work.status, content: work.content, production, drafts, url: work.url, source: work.source, tags: work.tags,
        sourceContent: work.sourceContent, materialContent: work.materialContent, sources: work.noteMetadata?.sources,
        people: state.people.filter(row => work.personaIds?.includes(row.id)), angles: state.angles.filter(row => work.angleIds?.includes(row.id)),
        body: work.body?.slice(offset, offset + limit), truncated: (work.body?.length ?? 0) > offset + limit,
        nextOffset: (work.body?.length ?? 0) > offset + limit ? offset + limit : null, stage }
    }
    if (kind === 'preferences') {
      const stage = state.nativeRequests?.findLast(row => row.associationId === association.id && active(row))
      if (stage?.data.preferenceVersions) {
        const refs = stage.data.preferenceVersions
        const load = async reference => {
          if (!reference) return null
          if (reference.presetId) return state.styles.find(row => row.id === reference.presetId)
          const bytes = await this.store.notes.readBytes(reference)
          if (createHash('sha256').update(bytes).digest('hex') !== reference.sha256) throw failure('native/preference-conflict', 'Frozen writing preference changed')
          return this.store.notes.parseManaged(bytes, reference, reference.id, reference.kind).value
        }
        return page({ voice: await load(refs.voice), style: await load(refs.style), rules: await Promise.all(refs.rules.map(load)), stage: this.currentStage(state, association) })
      }
      return page({ voice: state.voice, activeStyleId: state.activeStyleId,
      styles: state.styles.filter(row => row.id === state.activeStyleId), rules: state.skills.filter(row => !row.sample && ['active', 'exported'].includes(row.status)).slice(0, 24),
      stage: this.currentStage(state, association) })
    }
    if (kind === 'materials') return page({ materials: state.items.filter(row => row.materialContent).slice(0, 80).map(row => ({ id: row.id, title: row.title, source: row.source, materialContent: row.materialContent })), stage: this.currentStage(state, association) })
    if (kind === 'metrics' && association.workId === null) return page({ metrics: state.metrics.slice(-100), accounts: state.accounts })
    throw failure('native/read-kind', 'Unsupported reading scope', 400)
  }

  currentStage(state, association) {
    const stage = state.nativeRequests?.findLast(row => row.associationId === association.id && active(row))
    if (!stage) return null
    return { id: stage.id, kind: stage.kind, workId: stage.workId, status: stage.status,
      expectedContent: stage.expectedContent, instructions: stage.instructions,
      settings: stage.data.settings, preferenceVersions: stage.data.preferenceVersions,
      selectedMaterial: stage.data.sampleMaterial, planId: stage.data.planId, language: stage.data.language, materialVersion: stage.data.materialVersion }
  }

  /** Apply whitelisted ordinary operations immediately, using only the actual Agent's owned objects. */
  async edit(exec, { operations, expectedContent = {}, expectedPreferences = {}, resultId }) {
    return this.store.run(async () => {
      const { association, state, current } = await this.actor(exec, true)
      if (!Array.isArray(operations) || !operations.length || operations.length > 24 || JSON.stringify(operations).length > 200000) throw failure('native/operations-invalid', 'Provide 1–24 bounded operations', 400)
      const workOps = new Set(['update_item', 'delete_item', 'schedule_item', 'set_status', 'save_draft', 'update_production'])
      const globalOps = new Set(['add_item', 'add_skill', 'update_skill', 'delete_skill', 'add_style', 'update_style', 'delete_style', 'set_style', 'add_metric', 'add_person', 'update_person', 'delete_person', 'add_angle', 'update_angle', 'delete_angle'])
      const structured = state.nativeRequests?.find(row => row.associationId === association.id && active(row) && row.turn === current.turn)
      for (const operation of operations) {
        if (workOps.has(operation.op)) {
          if (association.workId !== null && operation.id !== association.workId) throw failure('native/foreign-object', 'This Session owns another work', 403)
          const item = state.items.find(row => row.id === operation.id)
          if (!item) throw failure('native/work-missing', 'Work not found', 404)
          if (item.content && !expectedContent[item.id]) throw failure('native/version-required', 'Read and provide the current work content version', 400)
          if (structured && structured.workId === item.id) throw failure('native/stage-edit-conflict', 'Submit this structured stage through media_desk_submit_result')
        } else if (!globalOps.has(operation.op) || association.workId !== null) throw failure('native/operation-denied', 'Operation requires the global assistant', 403)
        if (['add_skill', 'update_skill'].includes(operation.op) && (operation.status !== undefined && operation.status !== 'proposed'
          || operation.op === 'update_skill' && state.skills.find(row => row.id === operation.id)?.status !== 'proposed')) throw failure('native/rule-review-required', 'Writing rules require user review and activation', 403)
        const kind = /^(update|delete)_(style|skill)$/.exec(operation.op)?.[2]
        const preference = kind && (kind === 'style' ? state.styles : state.skills).find(row => row.id === operation.id)
        if (preference?.content) {
          const version = expectedPreferences[(kind === 'style' ? 'style:' : 'rule:') + operation.id]
          if (preference.content.status !== 'ready' || preference.content.sha256 !== version?.sha256 || preference.content.revision !== version?.revision) throw failure('native/preference-conflict', 'Read and provide the current writing preference version')
        }
      }
      const identity = resultId ?? exec.callId
      if (typeof identity !== 'string' || !identity || identity.length > 100) throw failure('native/result-id', 'Invalid result identity', 400)
      return this.store.mutate('原生编辑', draft => {
        const result = applyOps(draft, operations)
        if (result.errors.length) throw failure('native/operation-invalid', result.errors.join('; '), 400)
        return result
      }, { expectedContent, resultKey: `native:${association.id}:${identity}`, payloadHash: hash({ operations, expectedContent, expectedPreferences }),
        validateAcceptance: () => { exec.signal.throwIfAborted(); this.sessions.requireAssociation(exec.agent); if (this.failedInputs.has(exec.agent.id)) throw failure('native/input-unsaved', 'Native input could not be recorded') } })
    })
  }

  /** Durably claim a stage before Session resolution or model preparation; duplicate production reuses its attempt. */
  async request(kind, workId, instructions, { producer, data = {} } = {}) {
    const claimed = await this.store.run(async () => {
      const state = await this.store.read()
      const existing = producer && state.nativeRequests?.find(row => row.workId === workId && row.producer && active(row))
      if (existing) return { request: existing, reused: true }
      const work = workId === null ? null : state.items.find(row => row.id === workId)
      if (workId !== null && !work) throw failure('native/work-missing', 'Work not found', 404)
      if (work?.content?.status && work.content.status !== 'ready') throw failure(work.content.code, work.content.error)
      const request = { id: randomUUID(), requestId: randomUUID(), kind, workId, producer: Boolean(producer), status: 'pending',
        expectedContent: work?.content ? { [workId]: structuredClone(work.content) } : {},
        createdAt: new Date().toISOString(), instructions, data }
      request.inputTextHash = hash([{ type: 'text', text: stageText(request) }])
      if (producer) {
        const settings = await this.ctx.mediaDesk.settings.read()
        await writeFileAtomic(join(this.store.root, 'native-settings', request.id + '.json'), JSON.stringify(settings), { mode: 0o600, dirMode: 0o700 })
        request.data.language = work?.content?.language ?? work?.lang ?? 'zh'
        request.data.materialVersion = work?.content?.snapshot ?? null
        request.data.settings = { imageCount: settings.imageCount, shotCount: settings.shotCount, imageReady: this.ctx.mediaDesk.producer.ready(settings) }
        const selectedStyle = state.styles?.find(row => row.id === state.activeStyleId)
        request.data.preferenceVersions = { voice: state.voice?.content?.snapshot ?? state.voice?.content,
          style: selectedStyle?.content?.snapshot ?? selectedStyle?.content ?? (selectedStyle?.preset ? { presetId: selectedStyle.id } : null),
          rules: state.skills.filter(row => !row.sample && ['active', 'exported'].includes(row.status)).map(row => row.content?.snapshot ?? row.content) }
      }
      await this.store.mutate('受理原生任务', draft => {
        (draft.nativeRequests ??= []).push(request)
        if (producer) {
          const target = draft.items.find(row => row.id === workId)
          target.production = { ...(target.production ?? {}), status: 'running', stage: 'brief', attemptId: request.id, preferenceVersions: request.data.preferenceVersions }
        }
      }, { undoable: false })
      return { request, reused: false }
    })
    if (claimed.reused) return { ...claimed.request, reused: true }
    try {
      const association = await this.sessions.open(workId)
      const resolved = await this.service('sessionController').resolveAgent(association.sessionId)
      if (resolved.error) throw resolved.error
      await this.store.mutate('关联原生任务', draft => {
        const row = draft.nativeRequests.find(row => row.id === claimed.request.id)
        if (!active(row)) throw failure('native/stage-stale', 'The admitted stage was canceled before dispatch')
        Object.assign(row, { associationId: association.id, sessionId: association.sessionId, requestedModel: { ...resolved.agent.model.current() } })
      }, { undoable: false })
      await this.service('sessionController').prompt({ sessionId: association.sessionId, requestId: claimed.request.requestId, mode: 'queue',
        content: [{ type: 'text', text: stageText(claimed.request) }] }, this.store.owner.signal)
      return { ...claimed.request, associationId: association.id, sessionId: association.sessionId }
    } catch (error) {
      await this.store.mutate('原生任务受理失败', draft => {
        const row = draft.nativeRequests.find(row => row.id === claimed.request.id)
        if (active(row)) { row.status = 'failed'; row.error = error.message }
      }, { undoable: false })
      throw error
    }
  }

  /** Persist a candidate for this actual input/turn; identical duplicates retain their candidate identity. */
  async submit(exec, { stageId, result }) {
    return this.store.run(async () => {
    const { association, state, current } = await this.actor(exec, true)
    const stage = state.nativeRequests?.find(row => row.id === stageId)
    if (!stage || stage.associationId !== association.id || stage.turn !== current.turn) throw failure('native/foreign-stage', 'Stage is not owned by this native turn', 403)
    const resultHash = hash(result)
    if (stage.candidateHash) {
      if (stage.candidateHash !== resultHash) throw failure('native/result-conflict', 'Stage already has a different candidate')
      if (stage.acceptance) return { status: 'accepted', acceptance: stage.acceptance }
      if (stage.status === 'candidate') return { status: 'candidate', stageId }
    }
    if (!active(stage)) throw failure('native/stage-stale', 'Stage was interrupted or canceled')
    if (!result || typeof result !== 'object' || Array.isArray(result) || JSON.stringify(result).length > 200000) throw failure('native/result-invalid', 'Candidate must be a bounded JSON object', 400)
    this.validateResult(stage, result)
    await writeFileAtomic(join(this.store.root, 'native-candidates', stageId + '.json'), JSON.stringify(result), { mode: 0o600, dirMode: 0o700 })
    await this.store.mutate('暂存原生候选', draft => {
      const row = draft.nativeRequests.find(row => row.id === stageId)
      if (!active(row) || row.turn !== current.turn || this.sessions.requireAssociation(exec.agent).id !== association.id || row.candidateHash && row.candidateHash !== resultHash) throw failure('native/stage-stale', 'Stage changed before candidate storage')
      row.candidateSaved = true; row.candidateHash = resultHash; row.status = 'candidate'
    }, { undoable: false, expectedContent: stage.expectedContent })
    return { status: 'candidate', stageId, next: 'Finish this native turn. The Host accepts the candidate after turn completion; do not poll within this turn.' }
    })
  }

  validateResult(stage, result) {
    if (stage.kind === 'article' && (typeof result.article !== 'string' || !result.article.trim() || result.article.length > 200000)) throw failure('native/article-invalid', 'Provide a nonempty Markdown article', 400)
    if (stage.kind === 'style' && (typeof result.name !== 'string' || !result.name.trim() || typeof result.summary !== 'string' || !result.summary.trim())) throw failure('native/style-invalid', 'Provide an observed style name and summary', 400)
    if (stage.kind === 'rules' && (!Array.isArray(result.rules) || result.rules.length > 24 || result.rules.some(row => typeof row.name !== 'string' || typeof row.rule !== 'string' || !row.rule.trim()))) throw failure('native/rules-invalid', 'Provide up to 24 writing rule proposals', 400)
    if (stage.kind === 'plan') this.ctx.mediaDesk.producer.validatePlan(result, stage.data.settings)
    const allowed = { article: ['article', 'sources'], style: ['name', 'summary', 'tone', 'sentences', 'opening', 'structure', 'words', 'avoid', 'samples'],
      rules: ['rules'], plan: ['title', 'coverText', 'facts', 'outline', 'cover', 'characters', 'images', 'shots', 'sources'] }[stage.kind]
    if (!allowed || Object.keys(result).some(key => !allowed.includes(key))) throw failure('native/result-fields', 'Candidate contains unsupported fields', 400)
    if (result.sources !== undefined && (!Array.isArray(result.sources) || result.sources.length > 24 || result.sources.some(source => !source || typeof source.title !== 'string' || typeof source.reference !== 'string' || source.reference.length > 2000 || typeof source.date !== 'string' || typeof source.limitations !== 'string'))) throw failure('native/sources-invalid', 'Sources require title, reference, date and limitations', 400)
  }

  async finish(sessionId, turn, { schedule = true } = {}) {
    const state = await this.store.read()
    const stages = state.nativeRequests?.filter(row => row.sessionId === sessionId && row.turn === turn && active(row)) ?? []
    if (!stages.length) return
    const resolved = this.agents.has(sessionId) ? { agent: this.agents.get(sessionId) } : await this.service('sessionController').resolveAgent(sessionId)
    if (resolved.error) throw resolved.error
    if (!await this.service('sessions').flush(resolved.agent.session)) throw failure('native/not-durable', 'Native Session could not be flushed')
    const events = await this.events(sessionId, Math.min(...stages.map(row => row.startSeq)))
    const end = events.find(event => event.type === 'turn/end' && event.data.turn === turn)
    if (!end) return
    for (const stage of stages) {
      const input = events.find(event => event.type === 'user/message' && event.data.id === stage.messageId && hash(event.data) === stage.inputFingerprint)
      if (end.data.reason.kind !== 'completed' || !input || !stage.candidateSaved && !stage.candidate) {
        let saveError
        try { this.store.notes.assertExpected(state, stage.expectedContent) } catch (error) { saveError = error.message }
        await this.store.mutate('原生任务结束', draft => {
          const row = draft.nativeRequests.find(row => row.id === stage.id)
          if (!active(row)) return
          row.status = ['aborted', 'interrupted', 'blocked'].includes(end.data.reason.kind) ? 'interrupted' : 'failed'
          row.error = saveError ?? (stage.candidateSaved || stage.candidate ? `Native turn ended: ${end.data.reason.kind}` : 'Native turn did not submit a candidate')
          row.endSeq = end.seq
        }, { undoable: false })
        await this.ctx.mediaDesk.producer?.nativeEnded(stage)
        continue
      }
      const validate = () => {
        const current = this.store.activeDraft?.nativeRequests?.find(row => row.id === stage.id) ?? this.store.state.nativeRequests?.find(row => row.id === stage.id)
        if (!current || !active(current) || current.candidateHash !== stage.candidateHash || this.failedInputs.has(sessionId)) throw failure('native/stage-stale', 'Native stage is no longer current')
        const association = this.sessions.requireAssociation(resolved.agent)
        if (association.id !== stage.associationId) throw failure('native/stage-stale', 'The work uses another conversation')
      }
      try {
        const candidate = stage.candidate ?? JSON.parse(await readFile(join(this.store.root, 'native-candidates', stage.id + '.json'), 'utf8'))
        if (hash(candidate) !== stage.candidateHash) throw failure('native/candidate-invalid', 'Retained native candidate changed')
        const result = await this.store.mutate('接受原生成果', draft => {
          validate()
          const row = draft.nativeRequests.find(row => row.id === stage.id)
          this.accept(draft, { ...row, candidate })
          row.status = 'accepted'; row.endSeq = end.seq; delete row.candidate; delete row.pendingId; delete row.error
          return { stageId: stage.id, workId: stage.workId }
        }, { undoable: stage.kind !== 'style', expectedContent: stage.expectedContent, resultKey: `stage:${stage.id}`, payloadHash: stage.candidateHash,
          validateAcceptance: () => {
            const current = this.store.state.nativeRequests.find(row => row.id === stage.id)
            if (!current || !active(current) || current.candidateHash !== stage.candidateHash) throw failure('native/stage-stale', 'Native stage changed before publication')
            if (this.sessions.requireAssociation(resolved.agent).id !== stage.associationId) throw failure('native/stage-stale', 'The work uses another conversation')
          } })
        await this.store.mutate('保存原生回执', draft => { draft.nativeRequests.find(row => row.id === stage.id).acceptance = result.acceptance }, { undoable: false })
        if (schedule) await this.ctx.mediaDesk.producer?.nativeAccepted(stage, result.acceptance)
      } catch (error) {
        await this.store.mutate('原生成果保存失败', draft => {
          const row = draft.nativeRequests.find(row => row.id === stage.id)
          if (row.status !== 'accepted') { row.status = 'save-failed'; row.error = error.message; row.pendingId = error.pendingId }
        }, { undoable: false })
        await this.ctx.mediaDesk.producer?.nativeEnded(stage)
      }
    }
  }

  accept(draft, stage) {
    const result = stage.candidate
    if (stage.kind === 'article') {
      const work = draft.items.find(row => row.id === stage.workId)
      if (!work) throw failure('native/work-missing', 'Work no longer exists')
      if (work.production?.attemptId !== stage.data.planId) throw failure('native/plan-stale', 'The script belongs to another production plan')
      work.noteMetadata = { ...(work.noteMetadata ?? {}), sources: [{ ...(work.url ? { url: work.url } : {}), label: work.source ?? '' }, ...result.sources ?? []] }
      work.production ??= { cover: null, images: [], shots: [] }
      Object.assign(work.production, { article: result.article, aiArticle: result.article, current: true, sources: result.sources ?? [],
        engine: stage.actualModels?.at(-1)?.model, nativeStageId: stage.id })
      for (const row of Object.values(work.drafts ?? {})) row.current = false
      if (['idea', 'outline'].includes(work.status)) work.status = 'draft'
    } else if (stage.kind === 'style') {
      const style = normalizeStyle(result, stage.data.name)
      const applied = applyOps(draft, [{ op: 'add_style', ...style }])
      if (applied.errors.length) throw failure('native/style-invalid', applied.errors[0], 400)
      const row = draft.styles.find(row => row.id === applied.receipts[0].target)
      Object.assign(row, { source: stage.data.source, sourceUrls: stage.data.sourceUrls, sampleMaterial: stage.data.sampleMaterial })
      draft.activeStyleId = row.id
    } else if (stage.kind === 'rules') {
      const applied = applyOps(draft, result.rules.map(rule => ({ op: 'add_skill', name: rule.name, rule: rule.rule, evidence: rule.evidence, source: '原生复盘', status: 'proposed' })))
      if (applied.errors.length) throw failure('native/rules-invalid', applied.errors[0], 400)
    } else if (stage.kind === 'plan') this.ctx.mediaDesk.producer.acceptPlan(draft, stage)
  }

  /** Stop only owned running work; preserve every pending native input when canceling or starting anew. */
  async cancel(workId, { wait = true, all = false } = {}) {
    const state = await this.store.read()
    const stages = state.nativeRequests?.filter(row => row.workId === workId && (active(row) || row.status === 'cancelled')) ?? []
    await this.store.mutate('取消原生任务', draft => {
      for (const row of draft.nativeRequests ?? []) if (row.workId === workId && active(row)) row.status = 'cancelled'
    }, { undoable: false })
    const sessionIds = stages.map(row => row.sessionId).filter(Boolean)
    if (all) sessionIds.push(...this.sessions.associations.filter(row => row.workId === workId && row.active !== false).map(row => row.sessionId))
    for (const sessionId of new Set(sessionIds)) {
      const resolved = await this.service('sessionController').resolveAgent(sessionId)
      if (resolved.error) throw resolved.error
      const owned = stages.some(row => row.sessionId === sessionId && row.turn !== undefined)
      if ((owned || all) && resolved.agent.status === 'running') { resolved.agent.cancel('user', { keepInbox: true }); if (wait) await resolved.agent.whenIdle() }
    }
  }

  /** Cancel materialized creative Agents and await their current native execution without waking inboxes. */
  async close() {
    this.closing = true
    const agents = [...this.agents.values()]
    for (const agent of agents) if (agent.status === 'running') agent.cancel('user', { keepInbox: true })
    await Promise.all(agents.map(agent => agent.whenIdle()))
  }

  /** Retry saving one completed native candidate, preserving the original turn and external effects. */
  async retry(stageId) {
    const state = await this.store.read()
    const row = state.nativeRequests?.find(row => row.id === stageId)
    if (!row) throw failure('native/stage-missing', 'Native stage not found', 404)
    if (row.status === 'accepted') return { acceptance: state.receipts?.find(receipt => receipt.resultKey === 'stage:' + row.id) }
    if (row.status !== 'save-failed') throw failure('native/stage-stale', 'Only a retained save failure can be retried')
    const resolved = await this.service('sessionController').resolveAgent(row.sessionId)
    if (resolved.error) throw resolved.error
    this.agents.set(row.sessionId, resolved.agent)
    await this.finish(row.sessionId, row.turn)
    const updated = (await this.store.read()).nativeRequests.find(stage => stage.id === stageId)
    if (updated.status !== 'accepted') throw failure('native/save-failed', updated.error ?? 'Native save could not be accepted')
    return { acceptance: updated.acceptance }
  }

  /** Read an attempt's private service configuration for its owned image workers. */
  async productionSettings(stageId) {
    if (!/^[a-f0-9-]{36}$/.test(stageId)) throw failure('native/stage-invalid', 'Invalid production identity', 400)
    return JSON.parse(await readFile(join(this.store.root, 'native-settings', stageId + '.json'), 'utf8'))
  }
}
