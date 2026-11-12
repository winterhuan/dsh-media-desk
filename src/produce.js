// 一键成稿流水线：文章 → 标题与画面规划 → 封面、配图、分镜。
// 任务在 Host 里跑，关掉页面也不会中断；每生成一张图就落盘一次。
import { shortCoverText } from './ai.js'
import { tr } from './i18n.js'
import { coverPrompt, figurePrompt, shotPrompt } from './images.js'
import { newId } from './ops.js'
import { imageReady } from './settings.js'

const CONCURRENCY = 3
const RETRY_WAIT_MS = [6000, 14000]

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
      for (const stage of draft.nativeRequests ?? []) if (stage.workId === id && ['pending', 'running', 'waiting', 'candidate', 'save-failed'].includes(stage.status)) stage.status = 'cancelled'
      const work = draft.items.find(row => row.id === id)
      if (work?.production) {
        work.production.status = 'cancelled'
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
      await this.complete(stage.workId)
      return
    }
    if (stage.kind !== 'plan' || this.closing) return
    const state = await this.store.read()
    const item = state.items.find(row => row.id === stage.workId)
    if (!item?.production || item.production.attemptId !== stage.id || item.production.status !== 'running') return
    const settings = await this.native.productionSettings(stage.id)
    const job = { stage: 'making', text: '', planText: '', controller: new AbortController(), attemptId: stage.id }
    this.jobs.set(stage.workId, job)
    const tasks = []
    try {
      const article = await this.native.request('article', stage.workId,
        'Write the complete Markdown script based on the accepted plan, facts and sources. Use llm-wiki to check relevant evidence. Submit article and dated sources through media_desk_submit_result.',
        { data: { planId: stage.id, preferenceVersions: stage.data.preferenceVersions, materialVersion: stage.data.materialVersion, language: stage.data.language } })
      job.articleStageId = article.id
      if (this.ready(settings)) {
        const targets = ['cover', ...item.production.images.map((_, i) => 'image:' + i), ...item.production.shots.map((_, i) => 'shot:' + i)]
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
        await this.complete(stage.workId)
      }, stage.workId)
      completion.catch(error => this.onError?.(error))
    } catch (error) {
      await this.patch(stage.workId, production => { production.status = 'failed'; production.error = error.message })
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
    await this.complete(stage.workId)
  }

  async complete(id) {
    const state = await this.store.read()
    const item = state.items.find(row => row.id === id)
    const production = item?.production
    if (!production) return
    const article = state.nativeRequests?.find(row => row.id === production.nativeStageId && row.kind === 'article' && row.data.planId === production.attemptId)
    const pendingArticle = state.nativeRequests?.some(row => row.workId === id && row.kind === 'article' && ['pending', 'running', 'waiting', 'candidate', 'save-failed'].includes(row.status))
    const assets = [production.cover, ...production.images ?? [], ...production.shots ?? []].filter(Boolean)
    if (pendingArticle || assets.some(row => ['pending', 'running'].includes(row.status))) return
    await this.patch(id, next => {
      if (['cancelled', 'interrupted'].includes(next.status)) return
      next.status = article?.status === 'accepted' && !assets.some(row => ['failed', 'cancelled'].includes(row.status)) ? 'done' : next.article ? 'partial' : 'failed'
      next.stage = 'done'; next.finishedAt = new Date().toISOString()
    })
    this.jobs.delete(id)
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

  /** 单独重画一张。 */
  async regenerate(id, target) {
    if (this.closing) throw Object.assign(new Error(tr('Media Desk 正在关闭，请稍后重试')), { status: 503 })
    const settings = await this.settings.read()
    if (!this.ready(settings)) throw Object.assign(new Error(tr('还没有接入生图模型')), { status: 400 })
    if (!parseTarget(target)) throw Object.assign(new Error(tr('目标无效')), { status: 400 })
    const key = `${id}:${target}`
    if (this.assets.has(key)) return
    const state = await this.store.read()
    const production = state.items.find(row => row.id === id)?.production
    if (this.closing) throw Object.assign(new Error(tr('Media Desk 正在关闭，请稍后重试')), { status: 503 })
    if (!production || !assetAt(production, target)) throw Object.assign(new Error(tr('找不到这张图')), { status: 404 })
    this.assets.add(key)
    const controller = new AbortController()
    this.assetControllers.set(key, controller)
    await this.patch(id, (next) => { assetAt(next, target).status = 'running' })
    const completion = this.launch(() => this.renderAsset(id, target, settings, controller.signal, production.attemptId), id)
    const done = () => { this.assets.delete(key); this.assetControllers.delete(key); this.launch(() => this.complete(id), id) }
    completion.then(done, done)
  }

  /** Host 重启后，把上次没做完的成稿都标成中断，卡片不会一直显示「正在成稿」。 */
  async settleAll() {
    const state = await this.store.read()
    for (const item of state.items) if (item.production?.status === 'running') await this.settle(item.id)
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
