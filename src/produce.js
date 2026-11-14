// 一键成稿流水线：文章 → 标题与画面规划 → 封面、配图、分镜。
// 任务在 Host 里跑，关掉页面也不会中断；每生成一张图就落盘一次。
import { shortCoverText } from './ai.js'
import { tr } from './i18n.js'
import { coverPrompt, figurePrompt, shotPrompt } from './images.js'
import { newId } from './ops.js'
import { imageReady } from './settings.js'

const CONCURRENCY = 3
const RETRY_WAIT_MS = [6000, 14000]
const languageAt = (item, language) => language === undefined || item?.content?.language === language ? item : item?.otherLang?.[language]

function splitTitle(markdown, fallback) {
  const match = /^\s*#\s+(.+)\n?/.exec(markdown)
  if (!match) return { title: fallback, article: markdown.trim() }
  return { title: match[1].trim(), article: markdown.slice(match[0].length).trim() }
}

/** 模型给的规划不可信：只取需要的字段，数量按设置截断。 */
export function normalizePlan(plan, settings, title) {
  const text = (value, max = 400) => (typeof value === 'string' ? value.trim().slice(0, max) : '')
  const images = (Array.isArray(plan?.images) ? plan.images : []).slice(0, settings.imageCount).map(row => ({ caption: text(row?.caption, 60), anchor: text(row?.anchor, 60), prompt: text(row?.prompt, 1200) })).filter(row => row.prompt)
  const shots = (Array.isArray(plan?.shots) ? plan.shots : []).slice(0, settings.shotCount).map((row, index) => ({
    no: index + 1, shot: text(row?.shot, 12) || tr('中景'), visual: text(row?.visual, 200), voice: text(row?.voice, 200),
    seconds: Number.isFinite(row?.seconds) ? Math.max(1, Math.min(60, Math.round(row.seconds))) : 5, prompt: text(row?.prompt, 1200),
  })).filter(row => row.prompt || row.visual)
  return {
    title: text(plan?.title, 60) || title,
    coverText: text(plan?.coverText, 24) || shortCoverText(title),
    facts: (Array.isArray(plan?.facts) ? plan.facts : []).map(row => text(row, 120)).filter(Boolean).slice(0, 8),
    outline: (Array.isArray(plan?.outline) ? plan.outline : []).map(row => text(row, 40)).filter(Boolean).slice(0, 6),
    cover: text(plan?.cover, 1200) || title,
    characters: text(plan?.characters, 400),
    images,
    shots,
  }
}

function parseTarget(target) {
  if (target === 'cover') return { kind: 'cover' }
  const match = /^(image|shot):(\d{1,2})$/.exec(String(target))
  return match ? { kind: match[1], index: Number(match[2]) } : null
}

function assetAt(production, target) {
  const parsed = parseTarget(target)
  if (!parsed) return null
  if (parsed.kind === 'cover') return production.cover
  return (parsed.kind === 'image' ? production.images : production.shots)?.[parsed.index] ?? null
}

function fullPrompt(production, target, asset) {
  const { kind } = parseTarget(target)
  if (kind === 'cover') return coverPrompt(asset.prompt)
  if (kind === 'image') return figurePrompt(asset.prompt)
  return shotPrompt(asset.prompt || asset.visual, production.characters)
}

/**
 * 把对话里的修改落到成稿上。模型输出不可信：只认这几个字段，序号越界的直接丢弃。
 * @param {object} production - 成稿，会被就地修改。
 * @param {object} revise - 模型给出的修改。
 * @param {{canDraw?: boolean}} [options] - 没接生图时，回执只说更新了画面描述。
 * @returns {{receipts: string[], errors: string[], targets: string[]}} 回执和需要重画的图。
 */
export function applyRevision(production, revise, { canDraw = true } = {}) {
  const receipts = []
  const errors = []
  const targets = []
  const redraw = what => (canDraw ? tr('重画{what}', { what }) : tr('更新了画面描述：{what}（接入生图模型后才会重画）', { what }))
  const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '')
  const title = text(revise?.title, 80)
  if (title && title !== production.title) {
    production.title = title
    receipts.push(tr('标题改成《{title}》', { title }))
  }
  const coverText = text(revise?.coverText, 24)
  if (coverText && coverText !== production.coverText) {
    production.coverText = coverText
    receipts.push(tr('封面大字改成「{text}」', { text: coverText }))
  }
  if (typeof revise?.article === 'string' && revise.article.trim()) {
    production.article = revise.article.replace(/^\s*#\s+.*\n?/, '').trim().slice(0, 200000)
    receipts.push(tr('重写了脚本'))
  } else if (Array.isArray(revise?.edits)) {
    let changed = 0
    for (const edit of revise.edits.slice(0, 20)) {
      if (typeof edit?.find !== 'string' || typeof edit?.replace !== 'string' || !edit.find) continue
      if (production.article.includes(edit.find)) {
        production.article = production.article.replace(edit.find, () => edit.replace)
        changed += 1
      } else {
        errors.push(tr('脚本里没找到「{text}」', { text: edit.find.slice(0, 16) }))
      }
    }
    if (changed) receipts.push(tr(changed === 1 ? '改了脚本的 1 处' : '改了脚本的 {n} 处', { n: changed }))
  }
  const coverPrompt = text(revise?.cover?.prompt, 1200)
  if (coverPrompt && production.cover) {
    production.cover.prompt = coverPrompt
    targets.push('cover')
    receipts.push(redraw(tr('封面')))
  }
  for (const row of Array.isArray(revise?.images) ? revise.images.slice(0, 8) : []) {
    const image = production.images?.[Number(row?.no) - 1]
    if (!image) continue
    const caption = text(row.caption, 40)
    if (caption) image.caption = caption
    const prompt = text(row.prompt, 1200)
    if (prompt) {
      image.prompt = prompt
      targets.push(`image:${Number(row.no) - 1}`)
    }
    receipts.push(prompt ? redraw(tr('配图 {no}', { no: row.no })) : tr('改了配图 {no} 的图注', { no: row.no }))
  }
  for (const row of Array.isArray(revise?.shots) ? revise.shots.slice(0, 24) : []) {
    const shot = production.shots?.[Number(row?.no) - 1]
    if (!shot) continue
    for (const [key, max] of [['shot', 12], ['visual', 200], ['voice', 200]]) {
      const value = text(row[key], max)
      if (value) shot[key] = value
    }
    if (Number.isFinite(row.seconds)) shot.seconds = Math.max(1, Math.min(60, Math.round(row.seconds)))
    const prompt = text(row.prompt, 1200)
    if (prompt) {
      shot.prompt = prompt
      targets.push(`shot:${Number(row.no) - 1}`)
    }
    receipts.push(prompt ? redraw(tr('第 {no} 镜', { no: row.no })) : tr('改了第 {no} 镜的文案', { no: row.no }))
  }
  return { receipts, errors, targets }
}

export class Producer {
  /**
   * @param {{store: object, settings: object, native: object, generate: Function, ready?: Function}} deps - 存储、设置、原生文字任务和生图函数。
   */
  constructor({ store, settings, native, generate, ready = imageReady, onError }) {
    this.store = store
    this.settings = settings
    this.native = native
    this.generate = generate
    this.ready = ready
    this.jobs = new Map()
    this.assets = new Set()
    this.pending = new Set()
    this.pendingByWork = new Map()
    this.assetControllers = new Map()
    this.closing = false
    this.onError = onError
  }

  launch(task, workId) {
    const operation = this.store.owner ? this.store.owner.track(task) : Promise.resolve().then(task)
    this.pending.add(operation)
    const owned = this.pendingByWork.get(workId) ?? new Set()
    this.pendingByWork.set(workId, owned)
    owned.add(operation)
    const settled = () => { this.pending.delete(operation); owned.delete(operation); if (!owned.size) this.pendingByWork.delete(workId) }
    operation.then(settled, error => { settled(); this.onError?.(error) })
    return operation
  }

  /** Stop new production, abort owned text/images, and await their final storage writes. */
  async close() {
    this.closing = true
    for (const job of this.jobs.values()) job.controller.abort()
    for (const controller of this.assetControllers.values()) controller.abort()
    while (this.pending.size) await Promise.allSettled([...this.pending])
  }

  isRunning(id) {
    return this.jobs.has(id)
  }

  status(id) {
    const job = this.jobs.get(id)
    if (!job) return { running: false }
    // 策划案是流式写出来的：标题和分镜一出现就先显示
    const plan = job.planText
    return {
      running: true,
      stage: job.stage,
      text: job.text,
      title: /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(plan)?.[1],
      visuals: [...plan.matchAll(/"visual"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]),
    }
  }

  patch(id, mutate, expectedContent = {}) {
    return this.store.mutate('成稿', (state) => {
      const item = state.items.find(row => row.id === id)
      if (item?.production) mutate(item.production, item)
      return state
    }, { undoable: false, expectedContent })
  }

  async start(id) {
    if (this.closing) throw Object.assign(new Error(tr('Media Desk 正在关闭，请稍后重试')), { status: 503 })
    const stage = await this.native.request('plan', id, 'Research the bound Wiki with llm-wiki, verify sources and prepare a production plan. Use the selected material, style, active writing rules and personal voice. Return the bounded plan described by media_desk_submit_result, with dates and evidence limits.', { producer: true })
    return !stage.reused
  }

  async invalidate(id) {
    for (const [key, controller] of this.assetControllers) if (key.startsWith(id + ':')) controller.abort()
    this.jobs.get(id)?.controller.abort()
    await this.store.mutate('取消成稿', draft => {
      const stages = (draft.nativeRequests ?? []).filter(stage => stage.workId === id && ['pending', 'running', 'waiting', 'candidate', 'save-failed'].includes(stage.status))
      for (const stage of stages) { stage.status = 'cancelled'; stage.pendingInput = [] }
      const work = draft.items.find(row => row.id === id)
      const production = work?.production
      if (production && (stages.length || production.status === 'running' || this.anyAssetActive(id)
        || [production.cover, ...production.images ?? [], ...production.shots ?? []].some(asset => asset && ['pending', 'running'].includes(asset.status)))) {
        work.production.status = 'cancelled'
        work.production.pendingInput = []
        for (const asset of [work.production.cover, ...work.production.images ?? [], ...work.production.shots ?? []]) if (asset && ['pending', 'running'].includes(asset.status)) asset.status = 'cancelled'
      }
    }, { undoable: false })
  }

  async cancel(id) {
    await this.invalidate(id)
    await this.native.cancel(id)
    while (this.pendingByWork.get(id)?.size) await Promise.allSettled([...this.pendingByWork.get(id)])
  }

  validatePlan(raw, settings) {
    const bad = message => { throw Object.assign(new Error(message), { code: 'native/plan-invalid', status: 400 }) }
    for (const key of ['title', 'coverText', 'cover']) if (typeof raw[key] !== 'string' || !raw[key].trim()) bad('Plan requires ' + key)
    for (const key of ['facts', 'outline', 'images', 'shots']) if (!Array.isArray(raw[key])) bad('Plan requires ' + key)
    if (raw.facts.length > 8 || raw.outline.length > 6 || raw.images.length !== settings.imageCount || raw.shots.length !== settings.shotCount) bad('Plan counts must match the requested settings')
    if (raw.images.some(row => typeof row.prompt !== 'string' || !row.prompt.trim()) || raw.shots.some(row => typeof row.prompt !== 'string' || !row.prompt.trim() || typeof row.voice !== 'string' || !Number.isFinite(row.seconds))) bad('Image and storyboard descriptions are incomplete')
  }

  acceptPlan(draft, stage) {
    const item = draft.items.find(row => row.id === stage.workId)
    if (!item) throw Object.assign(new Error('Work no longer exists'), { status: 409 })
    const plan = normalizePlan(stage.candidate, stage.data.settings, item.title)
    item.title = plan.title
    const initial = stage.data.settings.imageReady ? 'pending' : 'skipped'
    item.production = { ...(item.production ?? {}), status: 'running', stage: 'making', startedAt: stage.createdAt,
      attemptId: stage.id, planStageId: stage.id, title: plan.title, coverText: plan.coverText, facts: plan.facts, outline: plan.outline,
      characters: plan.characters, sources: stage.candidate.sources ?? [], current: false,
      cover: { prompt: plan.cover, status: initial }, images: plan.images.map(row => ({ ...row, status: initial })),
      shots: plan.shots.map(row => ({ ...row, status: initial })), preferenceVersions: stage.data.preferenceVersions,
      requestedModel: stage.requestedModel, actualModels: stage.actualModels }
  }

  async nativeAccepted(stage) {
    if (stage.kind === 'article') {
      await this.complete(stage.workId, { attemptId: stage.data.planId })
      return
    }
    if (stage.kind !== 'plan' || this.closing) return
    const state = await this.store.read()
    const item = state.items.find(row => row.id === stage.workId)
    if (!item?.production || item.production.attemptId !== stage.id || item.production.status !== 'running') return
    const job = { stage: 'making', text: '', planText: '', controller: new AbortController(), attemptId: stage.id }
    const tasks = []
    try {
      const settings = await this.native.productionSettings(stage.id)
      const owned = await this.store.run(async () => {
        await this.store.refresh()
        const current = this.store.state.items.find(row => row.id === stage.workId)?.production
        if (this.closing || current?.attemptId !== stage.id || current.status !== 'running') return false
        this.jobs.set(stage.workId, job)
        return true
      })
      if (!owned) return
      const article = await this.native.request('article', stage.workId,
        'Write the complete Markdown script based on the accepted plan, facts and sources. Use llm-wiki to check relevant evidence. Submit article and dated sources through media_desk_submit_result.',
        { data: { planId: stage.id, preferenceVersions: stage.data.preferenceVersions, materialVersion: stage.data.materialVersion, language: stage.data.language } })
      job.articleStageId = article.id
      const current = await this.store.read()
      const latest = current.items.find(row => row.id === stage.workId)?.production
      if (this.jobs.get(stage.workId) !== job || job.controller.signal.aborted || latest?.attemptId !== stage.id || latest.status !== 'running') {
        if (this.jobs.get(stage.workId) === job) this.jobs.delete(stage.workId)
        return
      }
      if (this.ready(settings)) {
        const targets = ['cover', ...latest.images.map((_, i) => 'image:' + i), ...latest.shots.map((_, i) => 'shot:' + i)]
        let next = 0
        const worker = async () => {
          while (next < targets.length && !job.controller.signal.aborted) {
            await this.renderAsset(stage.workId, targets[next++], settings, job.controller.signal, stage.id)
          }
        }
        for (let i = 0; i < CONCURRENCY; i++) tasks.push(this.launch(worker, stage.workId))
      }
      const completion = this.launch(async () => {
        await Promise.allSettled(tasks)
        await this.complete(stage.workId, { attemptId: stage.id })
      }, stage.workId)
      completion.catch(error => this.onError?.(error))
    } catch (error) {
      await this.patch(stage.workId, production => {
        if (production.attemptId !== stage.id || production.status !== 'running') return
        production.status = 'failed'; production.error = error.message
      })
      if (this.jobs.get(stage.workId) === job) this.jobs.delete(stage.workId)
    }
  }

  async nativeEnded(stage) {
    if (!['plan', 'article'].includes(stage.kind)) return
    const state = await this.store.read()
    const row = state.nativeRequests?.find(row => row.id === stage.id)
    if (row?.status === 'accepted') return
    await this.patch(stage.workId, production => {
      if (stage.kind === 'article' && stage.data.planId !== production.attemptId || stage.kind === 'plan' && stage.id !== production.attemptId) return
      production.status = production.article ? 'partial' : row?.status ?? 'failed'
      production.error = row?.error
    })
    await this.complete(stage.workId, { attemptId: stage.kind === 'plan' ? stage.id : stage.data.planId })
  }

  /** Reconcile the selected attempt's accepted article with settled media; recovery never resumes external work. */
  async complete(id, { recover = false, attemptId, language } = {}) {
    const state = await this.store.read()
    const item = state.items.find(row => row.id === id)
    const production = languageAt(item, language)?.production
    if (!production) return
    const expectedAttempt = attemptId === undefined ? production.attemptId : attemptId
    const job = this.jobs.get(id)?.attemptId === expectedAttempt ? this.jobs.get(id) : null
    const completed = await this.store.mutate('成稿', draft => {
      const next = languageAt(draft.items.find(row => row.id === id), language)?.production
      if (!next || (next.attemptId ?? null) !== (expectedAttempt ?? null) || next.nativeStageId !== production.nativeStageId) return false
      const article = draft.nativeRequests?.find(row => row.id === next.nativeStageId && row.kind === 'article' && row.data.planId === next.attemptId)
      const accepted = article?.status === 'accepted' && draft.receipts?.some(row => row.resultKey === 'stage:' + article.id)
      if (recover && (!accepted || ['cancelled', 'failed'].includes(next.status))) return false
      const pendingText = draft.nativeRequests?.some(row => row.workId === id && ['plan', 'article'].includes(row.kind)
        && (row.kind === 'plan' ? row.id : row.data.planId) === next.attemptId && ['pending', 'running', 'waiting', 'candidate', 'save-failed'].includes(row.status))
      const assets = [next.cover, ...next.images ?? [], ...next.shots ?? []].filter(Boolean)
      if (pendingText || assets.some(row => ['pending', 'running'].includes(row.status))) return false
      if (next.status === 'cancelled' || next.status === 'interrupted' && !recover) return false
      next.status = accepted && assets.every(row => ['done', 'skipped'].includes(row.status)) ? 'done' : next.article ? 'partial' : 'failed'
      next.stage = 'done'; next.finishedAt = new Date().toISOString()
      if (next.status === 'done') delete next.error
      return true
    }, { undoable: false })
    if (this.jobs.get(id) === job && (completed || job?.controller.signal.aborted)) this.jobs.delete(id)
  }

  /** 生图服务限流（429）时等一会儿再试，最多再试两次；其他错误直接报。 */
  async generateWithRetry(image, prompt, signal) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.generate(image, prompt, { signal })
      } catch (err) {
        const limited = err?.status === 429 || /429/.test(String(err?.message))
        if (err.permanent || !limited || attempt >= RETRY_WAIT_MS.length || signal?.aborted) throw err
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, RETRY_WAIT_MS[attempt] * (this.retryScale ?? 1))
          signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('cancelled')) }, { once: true })
        })
      }
    }
  }

  async renderAsset(id, target, settings, signal, attemptId) {
    let prompt = null
    let renderId
    await this.patch(id, (production) => {
      const asset = assetAt(production, target)
      if (!asset || attemptId && production.attemptId !== attemptId || ['cancelled'].includes(production.status)) return
      renderId = newId('render')
      asset.renderId = renderId
      asset.status = 'running'
      asset.error = null
      prompt = fullPrompt(production, target, asset)
    })
    if (!prompt) return
    try {
      const result = await this.generateWithRetry(settings.image, prompt, signal)
      signal?.throwIfAborted()
      if (this.media) {
        await this.media.save(id, target, result, { attemptId, renderId })
      } else {
        throw new Error('Accepted media requires the Notes media service')
      }
    } catch (err) {
      await this.patch(id, (production) => {
        const asset = assetAt(production, target)
        if (!asset || asset.renderId !== renderId || attemptId && production.attemptId !== attemptId) return
        asset.status = signal?.aborted ? 'cancelled' : 'failed'
        asset.error = err.message
        if (err.mediaPendingId) asset.pendingId = err.mediaPendingId
      })
    }
  }

  /** 单独重画一张；异步准备前领取目标，重复受理复用当前任务，准备失败释放目标。 */
  async regenerate(id, target) {
    if (this.closing) throw Object.assign(new Error(tr('Media Desk 正在关闭，请稍后重试')), { status: 503 })
    if (!parseTarget(target)) throw Object.assign(new Error(tr('目标无效')), { status: 400 })
    const key = `${id}:${target}`
    if (this.assets.has(key)) return
    this.assets.add(key)
    const controller = new AbortController()
    this.assetControllers.set(key, controller)
    const release = () => { this.assets.delete(key); this.assetControllers.delete(key) }
    try {
      const settings = await this.settings.read()
      if (!this.ready(settings)) throw Object.assign(new Error(tr('还没有接入生图模型')), { status: 400 })
      const state = await this.store.read()
      const production = state.items.find(row => row.id === id)?.production
      if (this.closing) throw Object.assign(new Error(tr('Media Desk 正在关闭，请稍后重试')), { status: 503 })
      controller.signal.throwIfAborted()
      if (!production || !assetAt(production, target)) throw Object.assign(new Error(tr('找不到这张图')), { status: 404 })
      await this.patch(id, (next) => {
        controller.signal.throwIfAborted()
        if (next.attemptId === production.attemptId) assetAt(next, target).status = 'running'
      })
      const completion = this.launch(() => this.renderAsset(id, target, settings, controller.signal, production.attemptId), id)
      const done = () => { release(); this.launch(() => this.complete(id, { attemptId: production.attemptId }), id) }
      completion.then(done, done)
    } catch (error) { release(); throw error }
  }

  /** Recover accepted article/media outcomes and mark unfinished work without restarting it. */
  async settleAll() {
    const state = await this.store.read()
    for (const item of state.items) if (['running', 'interrupted'].includes(item.production?.status)) {
      await this.settle(item.id)
      await this.complete(item.id, { recover: true, attemptId: item.production.attemptId })
    }
  }

  async settle(id) {
    const state = await this.store.read()
    const production = state.items.find(row => row.id === id)?.production
    if (!production || this.jobs.has(id)) return
    const stuck = !this.anyAssetActive(id) && [production.cover, ...production.images ?? [], ...production.shots ?? []].some(asset => asset?.status === 'running')
    if (production.status !== 'running' && !stuck) return
    await this.patch(id, (next) => {
      if (next.status === 'running') {
        next.status = 'interrupted'
        next.pendingInput = []
        next.stage = 'done'
        next.error = tr('上次成稿被中断了，可以重新开始')
      }
      for (const asset of [next.cover, ...next.images ?? [], ...next.shots ?? []]) {
        if (asset && ['pending', 'running'].includes(asset.status)) asset.status = 'idle'
      }
    })
  }

  anyAssetActive(id) {
    return [...this.assets].some(key => key.startsWith(`${id}:`))
  }
}
