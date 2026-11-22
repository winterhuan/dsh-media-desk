/** Assistant-driven creation shares the Host's Notes, receipts and production schema without creating native turns. */
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { applyOps, newId } from './ops.js'
import { NativeWork } from './native-work.js'
import { applyRevision, normalizePlan } from './produce.js'
import { normalizeStyle } from './style.js'
import { computeInsights, exportSkill } from './learn.js'
import { saveProduction, resolveExportDir, defaultExportDir } from './export.js'
import { publicSettings } from './settings.js'
import { imageBuffer } from './images.js'
import { harvest, harvestText } from './harvest.js'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fail = (message, status = 409) => Object.assign(new Error(message), { code: 'skill/invalid', status })
const version = work => ({ revision: work.content.revision, sha256: work.content.sha256 })
const assetAt = (production, target) => target === 'cover' ? production?.cover
  : /^(image|shot):\d+$/.test(target) ? production?.[target.startsWith('image:') ? 'images' : 'shots']?.[Number(target.split(':')[1])] : null

/** Shared execution entry for a filesystem skill and authenticated Host requests. */
export class SkillDesk {
  /** @param {object} desk - Initialized Store, Settings, Producer and MediaFiles; native sessions are optional. */
  constructor(desk) {
    this.desk = desk
    this.store = desk.store
    this.validator = new NativeWork({ mediaDesk: desk }, desk.store, null)
  }

  async preferences(state) {
    return { voice: state.voice ?? null, style: state.styles.find(row => row.id === state.activeStyleId) ?? null,
      rules: state.skills.filter(row => !row.sample && ['active', 'exported'].includes(row.status)) }
  }

  async freeze(row, kind) {
    if (!row) return null
    if (row.preset) return { presetId: row.id, value: structuredClone(row) }
    if (!row.content || row.content.status !== 'ready') throw fail('Register or repair the selected writing preference before production: ' + (row.id ?? kind))
    return this.store.notes.saveManagedSnapshot(row.content, kind === 'voice' ? 'personal-voice' : row.id, kind,
      await this.store.notes.readBytes(row.content))
  }

  async frozen(request) {
    const load = async ref => {
      if (!ref) return null
      if (ref.presetId) return ref.value
      const bytes = await this.store.notes.readBytes(ref)
      if (createHash('sha256').update(bytes).digest('hex') !== ref.sha256) throw fail('Frozen writing preference changed')
      return { id: ref.id, ...this.store.notes.parseManaged(bytes, ref, ref.id, ref.kind).value }
    }
    const refs = request.preferenceVersions
    return { voice: await load(refs.voice), style: await load(refs.style), rules: await Promise.all(refs.rules.map(load)) }
  }

  assertIdle(state, id) {
    const production = state.items.find(row => row.id === id)?.production
    if (this.desk.producer.isRunning(id) || this.desk.producer.anyAssetActive(id)
      || [production?.cover, ...production?.images ?? [], ...production?.shots ?? []].some(row => row && ['pending', 'running'].includes(row.status))
      || state.nativeRequests?.some(row => row.workId === id && ['pending', 'running', 'waiting', 'candidate', 'save-failed'].includes(row.status))) throw fail('Production or image generation is active; finish or cancel it before editing through the skill')
  }

  assertAccepted(state, work) {
    if (!work?.production?.article) throw fail('No accepted production')
    this.assertIdle(state, work.id)
    const production = work.production
    if (production.attemptId && !state.nativeRequests?.some(row => row.id === production.nativeStageId
      && row.status === 'accepted' && row.data.planId === production.attemptId)) throw fail('The current native article has not been accepted')
    if (production.skillResultId && !state.receipts?.some(row => row.resultKey === 'skill:' + production.skillResultId)) throw fail('The current skill article has no acceptance receipt')
  }

  async read({ kind = 'works', id } = {}) {
    const state = await this.store.read()
    if (kind === 'works') return { works: state.items.map(row => ({ id: row.id, title: row.title, kind: row.kind, status: row.status, content: row.content, scheduledAt: row.scheduledAt, platform: row.platform })) }
    if (kind === 'preferences') return { ...await this.preferences(state), styles: state.styles.filter(row => !row.sample), rules: state.skills.filter(row => !row.sample) }
    if (kind === 'metrics') return { metrics: state.metrics, accounts: state.accounts, insights: computeInsights(state) }
    if (kind === 'people') return { people: state.people, angles: state.angles }
    if (kind === 'requests') return { requests: (state.skillRequests ?? []).filter(row => !id || row.workId === id) }
    if (kind !== 'work') throw fail('Unknown read kind', 400)
    const work = state.items.find(row => row.id === id)
    if (!work) throw fail('Work not found', 404)
    const originals = []
    for (const ref of [work.production?.aiVersion, ...Object.values(work.drafts ?? {}).map(row => row.aiVersion),
      ...(work.textHistory ?? []).filter(row => row.role === 'ai-original')].filter(Boolean)) {
      if (!originals.some(row => row.reference.sha256 === ref.sha256)) originals.push({ reference: ref, text: await this.store.notes.readFixed(ref, id) })
    }
    return { work, originals, expectedContent: work.content ? { [id]: version(work) } : {} }
  }

  async begin(args) {
    const requestId = args.requestId ?? randomUUID()
    if (typeof requestId !== 'string' || !requestId || requestId.length > 100) throw fail('Provide a stable requestId of at most 100 characters', 400)
    if (!['article', 'script'].includes(args.format ?? 'article')) throw fail('format must be article or script', 400)
    if (args.withImages !== undefined && typeof args.withImages !== 'boolean') throw fail('withImages must be a boolean', 400)
    const settings = await this.desk.settings.read()
    const result = await this.store.mutate('Prepare skill production', async draft => {
      const work = draft.items.find(row => row.id === args.id)
      if (!work?.content) throw fail('A registered work is required')
      this.assertIdle(draft, args.id)
      if ((draft.skillRequests ?? []).some(row => row.workId === args.id && row.status === 'prepared')) throw fail('A skill request is already prepared; read requests and continue or cancel it')
      const prefs = await this.preferences(draft)
      const request = { id: requestId, workId: args.id, status: 'prepared', createdAt: new Date().toISOString(),
        format: args.format ?? 'article', withImages: args.withImages ?? settings.generateImages,
        settings: { imageCount: settings.imageCount, shotCount: settings.shotCount }, expectedContent: { [work.id]: version(work) },
        preferenceVersions: { voice: await this.freeze(prefs.voice, 'voice'), style: await this.freeze(prefs.style, 'style'),
          rules: await Promise.all(prefs.rules.map(row => this.freeze(row, 'rule'))) } }
      ;(draft.skillRequests ??= []).push(request)
      return { request }
    }, { undoable: false, resultKey: 'skill-prepare:' + requestId, payloadHash: hash({ ...args, requestId }) })
    const request = (await this.store.read()).skillRequests.find(row => row.id === requestId)
    return { ...result, request, ...(request.status === 'prepared' ? { preferences: await this.frozen(request) } : {}) }
  }

  async commit(args) {
    for (const key of ['plan', 'result']) if (!args[key] || typeof args[key] !== 'object' || Array.isArray(args[key])) throw fail('Provide a ' + key + ' object', 400)
    const state = await this.store.read()
    const request = state.skillRequests?.find(row => row.id === args.requestId)
    if (!request) throw fail('Skill request not found; begin first', 404)
    const payloadHash = hash(args)
    const receipt = state.receipts?.find(row => row.resultKey === 'skill:' + request.id)
    if (receipt) {
      if (receipt.payloadHash !== payloadHash) throw fail('This request already accepted different content')
      return { accepted: true, workId: request.workId, acceptance: receipt }
    }
    if (request.status !== 'prepared') throw fail('Skill request is no longer active')
    const prefs = await this.frozen(request)
    const refs = prefs.rules.map(row => ({ id: row.id }))
    this.validator.validateResult({ kind: 'article', data: { preferenceVersions: { rules: refs } } }, args.result)
    this.validator.validateResult({ kind: 'plan', data: { settings: request.settings } }, args.plan)
    return this.store.mutate('Accept skill production', draft => {
      const work = draft.items.find(row => row.id === request.workId)
      const current = draft.skillRequests.find(row => row.id === request.id)
      if (!work || current.status !== 'prepared') throw fail('Skill request changed')
      this.assertIdle(draft, work.id)
      const plan = normalizePlan(args.plan, request.settings, work.title)
      const initial = 'skipped'
      work.title = plan.title
      work.noteMetadata = { ...work.noteMetadata, sources: [{ ...(work.url ? { url: work.url } : {}), label: work.source ?? '' }, ...args.result.sources ?? args.plan.sources ?? []] }
      work.production = { title: plan.title, coverText: plan.coverText, facts: plan.facts, outline: plan.outline, characters: plan.characters,
        format: request.format, withImages: request.withImages, status: 'done', stage: 'done', current: true,
        startedAt: request.createdAt, finishedAt: new Date().toISOString(), skillResultId: request.id,
        article: args.result.article, aiArticle: args.result.article, engine: typeof args.engine === 'string' ? args.engine : 'current-assistant',
        sources: args.result.sources ?? args.plan.sources ?? [], ruleChecks: args.result.ruleChecks ?? [], preferenceVersions: request.preferenceVersions,
        cover: { prompt: plan.cover, status: initial }, images: plan.images.map(row => ({ ...row, status: initial })), shots: plan.shots.map(row => ({ ...row, status: initial })) }
      for (const row of Object.values(work.drafts ?? {})) row.current = false
      if (['idea', 'outline'].includes(work.status)) work.status = 'draft'
      current.status = 'accepted'
      return { accepted: true, workId: work.id }
    }, { expectedContent: request.expectedContent, resultKey: 'skill:' + request.id, payloadHash })
  }

  /** @param {string} action - Skill action. @param {object} args - JSON input, with versions for registered edits. @returns {Promise<object>} Saved outcome or read result. */
  async execute(action, args = {}) {
    if (!args || typeof args !== 'object' || Array.isArray(args) || JSON.stringify(args).length > 4000000) throw fail('Provide a bounded JSON input object', 400)
    if (action === 'read') return this.read(args)
    if (action === 'begin') return this.begin(args)
    if (action === 'commit') return this.commit(args)
    if (action === 'insights') return computeInsights(await this.store.read())
    if (action === 'settings') return publicSettings(args.patch ? await this.desk.settings.update(args.patch) : await this.desk.settings.read())
    if (action === 'undo') return { label: await this.store.undoLast(args.id) }
    if (action === 'validate') {
      const state = await this.store.read()
      const work = state.items.find(row => row.id === args.id)
      if (!work?.content) throw fail('Registered work not found', 404)
      return this.store.notes.validate(work.content, work.id, 'work')
    }
    if (action === 'capture') {
      const info = args.textOnly ? await harvestText(args.url) : await harvest(args.url)
      if (args.textOnly) return info
      return this.execute('ops', { operations: [{ op: 'add_item', kind: 'web', title: args.title ?? info.title ?? args.url,
        body: args.note ?? info.description ?? '', url: info.url, source: info.siteName, tags: args.tags ?? [], language: args.language ?? 'und' }], resultId: args.resultId })
    }
    if (action === 'ops') {
      if (!Array.isArray(args.operations) || !args.operations.length || args.operations.length > 24
        || args.operations.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw fail('Provide 1–24 operation objects', 400)
      return this.store.mutate(args.label ?? 'Skill edit', draft => {
        for (const op of args.operations) if (op.id && draft.items.some(row => row.id === op.id)) {
          this.assertIdle(draft, op.id)
          if (draft.items.find(row => row.id === op.id).content && !args.expectedContent?.[op.id]) throw fail('Read the current work and supply expectedContent')
        }
        for (const op of args.operations) {
          const kind = /^(update|delete)_(style|skill)$/.exec(op.op)?.[2]
          const row = kind && (kind === 'style' ? draft.styles : draft.skills).find(row => row.id === op.id)
          if (!row?.content) continue
          const expected = args.expectedPreferences?.[(kind === 'style' ? 'style:' : 'rule:') + row.id]
          if (row.content.status !== 'ready' || row.content.revision !== expected?.revision || row.content.sha256 !== expected?.sha256) throw fail('Read and supply the current writing preference version')
        }
        const result = applyOps(draft, args.operations)
        if (result.errors.length) throw fail(result.errors.join('; '), 400)
        return result
      }, { expectedContent: args.expectedContent ?? {}, resultKey: args.resultId, payloadHash: args.resultId ? hash(args) : undefined })
    }
    if (action === 'rules' || action === 'style') {
      if (!args.result || typeof args.result !== 'object' || Array.isArray(args.result)) throw fail('Provide a result object', 400)
      const result = action === 'style' ? normalizeStyle(args.result, args.name) : args.result
      this.validator.validateResult({ kind: action, data: {} }, result)
      return this.store.mutate('Save skill proposals', draft => {
        const source = args.learningSource
        if (source) {
          const work = draft.items.find(row => row.id === source.id)
          if (!work?.content || work.content.sha256 !== source.current?.sha256) throw fail('Learning source changed; reread the work')
        }
        const selectedStyle = draft.activeStyleId
        this.validator.accept(draft, { kind: action, data: { name: args.name, source: args.source ?? 'Skill', sourceUrls: args.sourceUrls ?? [], sampleMaterial: args.sampleMaterial,
          learningSource: source }, candidate: result })
        if (action === 'style') draft.activeStyleId = selectedStyle
        return { saved: true, ids: (action === 'style' ? draft.styles : draft.skills).filter(row => !row.sample).map(row => row.id) }
      }, { undoable: false, resultKey: args.resultId, payloadHash: args.resultId ? hash(args) : undefined })
    }
    if (action === 'cancel') return this.store.mutate('Cancel skill request', draft => {
      const request = draft.skillRequests?.find(row => row.id === args.requestId)
      if (!request || request.status !== 'prepared') throw fail('Prepared request not found')
      request.status = 'cancelled'; return { cancelled: true }
    }, { undoable: false })
    if (action === 'asset') {
      const state = await this.store.read()
      const work = state.items.find(row => row.id === args.id)
      this.assertAccepted(state, work)
      if (!assetAt(work?.production, args.target)) throw fail('Image target not found', 404)
      if (!args.expectedContent?.[args.id]) throw fail('Read the current work and supply expectedContent')
      const image = imageBuffer(await readFile(args.file))
      const renderId = args.renderId ?? randomUUID()
      await this.store.mutate('Prepare skill image', draft => {
        this.assertAccepted(draft, draft.items.find(row => row.id === args.id))
        assetAt(draft.items.find(row => row.id === args.id).production, args.target).renderId = renderId
      }, { undoable: false, expectedContent: args.expectedContent ?? {} })
      return this.desk.mediaFiles.save(args.id, args.target, image, { attemptId: work.production.attemptId, renderId })
    }
    if (action === 'redraw') {
      const state = await this.store.read()
      this.assertAccepted(state, state.items.find(row => row.id === args.id))
      await this.desk.producer.regenerate(args.id, args.target)
      return { admitted: true }
    }
    if (action === 'revise') {
      return this.store.mutate('Revise skill production', draft => {
        const work = draft.items.find(row => row.id === args.id)
        if (!work?.production || !args.expectedContent?.[args.id]) throw fail('Read a produced work and supply expectedContent')
        if (!args.revision || typeof args.revision !== 'object' || Array.isArray(args.revision)) throw fail('Provide a revision object', 400)
        this.assertAccepted(draft, work)
        const production = work.production
        const updated = { ...production, article: work.body }
        const previousText = updated.article
        const assets = [production.cover, ...production.images ?? [], ...production.shots ?? []].filter(Boolean).map(row => [row, row.prompt])
        const result = applyRevision(updated, args.revision, { canDraw: false })
        if (result.errors.length) throw fail(result.errors.join('; '), 400)
        for (const [asset, prompt] of assets) if (asset.prompt !== prompt) {
          asset.renderId = randomUUID()
          asset.status = asset.media ? 'done' : 'idle'
          asset.error = null; delete asset.pendingId
        }
        if (updated.article !== previousText) {
          updated.current = true
          for (const row of Object.values(work.drafts ?? {})) row.current = false
        } else updated.article = production.article
        if (updated.title !== production.title) work.title = updated.title
        Object.assign(production, updated)
        return result
      }, { expectedContent: args.expectedContent, resultKey: args.resultId, payloadHash: args.resultId ? hash(args) : undefined })
    }
    if (action === 'upload') {
      const ext = extname(args.file).toLowerCase()
      if (!['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.webm', '.mov'].includes(ext)) throw fail('Unsupported media type', 400)
      const bytes = await readFile(args.file)
      if (bytes.length > 250000000) throw fail('Media exceeds 250 MB', 400)
      const name = newId('f') + ext
      await this.store.run(() => writeFile(join(this.store.filesDir, name), bytes, { flag: 'wx', mode: 0o600 }))
      return { src: 'media-desk/files/' + name, kind: ['.mp4', '.webm', '.mov'].includes(ext) ? 'video' : 'image' }
    }
    if (action === 'export') {
      const state = await this.store.read()
      const work = state.items.find(row => row.id === args.id)
      this.assertAccepted(state, work)
      if (work.content && !args.expectedContent?.[work.id]) throw fail('Read the current work and supply expectedContent')
      this.store.notes.assertExpected(state, args.expectedContent ?? {})
      return saveProduction({ ...work.production, title: work.title, article: work.body }, { filesDir: this.store.filesDir,
        exportDir: resolveExportDir(args.directory ?? (await this.desk.settings.read()).exportDir ?? defaultExportDir()),
        resolveMedia: id => this.desk.mediaFiles.resolve(id), snapshot: { workId: work.id, content: work.content, skillResultId: work.production.skillResultId } })
    }
    if (action === 'voice-export') return exportSkill(await this.store.read(), args.home ?? process.env.DSH_HOME)
    if (action === 'recovery') return { notes: await this.store.saves(), media: await this.desk.mediaFiles.saves() }
    if (action === 'retry') return args.kind === 'media' ? this.desk.mediaFiles.retry(args.id) : this.store.retrySave(args.id)
    if (action === 'version') return this.store.savedVersion(args)
    if (action === 'resolve') return this.store.resolveSave(args)
    if (action === 'register') return this.store.registerNotes(args)
    if (action === 'language') return this.store.mutate('Select work language', async draft => {
      const work = draft.items.find(row => row.id === args.id)
      if (!work) throw fail('Work not found', 404)
      if (work.content && !args.expectedContent?.[work.id]) throw fail('Read the current work and supply expectedContent')
      this.assertIdle(draft, work.id)
      await this.store.notes.switchLanguage(work, args.language)
      return { workId: work.id, language: args.language }
    }, { undoable: false, expectedContent: args.expectedContent ?? {} })
    if (action === 'migrate') return this.store.migrateNotes([], (await this.desk.settings.read()).voice)
    throw fail('Unknown skill action: ' + action, 400)
  }
}
