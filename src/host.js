// dsh-media-desk host 半片：/media-desk/* 接口、文件服务和模型调用。
import { createReadStream } from 'node:fs'
import { execFile } from 'node:child_process'
import { stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Service } from '@deepseek-ai/cordis'
import { assistantModelOverride, defaultSelection, modelInfo, setAssistantModel } from './ai.js'
import { defaultExportDir, resolveExportDir, saveProduction } from './export.js'
import { harvest, harvestText } from './harvest.js'
import { generateImage } from './images.js'
import { generateToolImage, imageTool } from './image-tool.js'
import { computeInsights, exportSkill } from './learn.js'
import { applyOps, newId } from './ops.js'
import { Producer } from './produce.js'
import { publicSettings, Settings, imageReady } from './settings.js'
import { stylePrompts } from './style.js'
import { dshHome, Store } from './store.js'
import { currentLang, platformName, tr, withLang } from './i18n.js'
import { samplesNeedLocale } from './seed.js'
import { NativeSessions } from './native-sessions.js'
import { NativeWork } from './native-work.js'
import { MediaFiles } from './media-files.js'
import { Notes, notesSaveMessage } from './notes.js'
import { WriteOwner } from './write-owner.js'

const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets')
const MAX_JSON = 4_000_000
const MAX_UPLOAD = 250_000_000
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' }
const UPLOAD_EXT = Object.fromEntries(Object.entries(MIME).filter(([ext]) => ext !== '.jpeg').map(([ext, type]) => [type, ext]))
const SERIAL_ROUTES = new Set(['ops', 'undo', 'settings', 'upload', 'produce', 'produce/regen', 'produce/save', 'skills/export', 'notes/register', 'notes/relink', 'notes/retry', 'notes/resolve', 'notes/version', 'notes/saves', 'notes/migrate', 'notes/migrations', 'notes/language', 'sessions/open', 'sessions', 'state', 'production'])
const editsPreferenceText = ops => (Array.isArray(ops) ? ops : []).some(op => op?.op === 'update_style'
  || op?.op === 'update_skill' && ['name', 'rule', 'source', 'evidence'].some(key => op[key] !== undefined))

function json(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

async function jsonState(res, store, result) {
  const state = await store.read()
  return json(res, 200, { ...result, state, canUndo: store.canUndo, undoId: store.undoId })
}

async function readBuffer(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw Object.assign(new Error(tr('内容太大')), { status: 413 })
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function readJson(req) {
  const raw = await readBuffer(req, MAX_JSON)
  if (!raw.length) return {}
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    throw Object.assign(new Error(tr('请求不是有效的 JSON')), { status: 400 })
  }
}

/** 支持 Range，视频才能正常拖动和循环。 */
async function sendFile(req, res, file, signal) {
  const type = MIME[extname(file).toLowerCase()]
  if (!type) return json(res, 404, { error: tr('不支持的文件类型') })
  let info
  try {
    info = await stat(file)
  } catch {
    return json(res, 404, { error: tr('文件不存在') })
  }
  res.setHeader('content-type', type)
  res.setHeader('accept-ranges', 'bytes')
  res.setHeader('cache-control', 'private, max-age=3600')
  res.setHeader('x-content-type-options', 'nosniff')
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '')
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]))
    const end = range[1] && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1
    if (start >= info.size || start > end) {
      res.statusCode = 416
      res.setHeader('content-range', `bytes */${info.size}`)
      return res.end()
    }
    res.statusCode = 206
    res.setHeader('content-range', `bytes ${start}-${end}/${info.size}`)
    res.setHeader('content-length', end - start + 1)
    return pipeline(createReadStream(file, { start, end }), res, { signal })
  }
  res.statusCode = 200
  res.setHeader('content-length', info.size)
  if (req.method === 'HEAD') return res.end()
  return pipeline(createReadStream(file), res, { signal })
}

function engineLabel(ctx) {
  const info = modelInfo(ctx)
  return info ? info.label : null
}

async function chatTurn(ctx, store, desk, body) {
  const message = String(body.message || '').trim()
  if (!message || message.length > 200000) throw Object.assign(new Error(tr('消息为空')), { status: 400 })
  const workId = typeof body.focusId === 'string' ? body.focusId : null
  const state = await store.read()
  store.notes.assertExpected(state, body.expectedContent ?? {})
  const association = await desk.nativeSessions.open(workId)
  const requestId = newId('native-chat')
  await desk.nativeSessions.service('sessionController').prompt({ sessionId: association.sessionId, requestId, mode: body.mode === 'steer' ? 'steer' : 'queue',
    content: [{ type: 'text', text: message }] }, desk.ownership.signal)
  return { association, requestId, state }
}

async function extractStyle(ctx, store, body, signal) {
  const urls = (Array.isArray(body.urls) ? body.urls : []).map(row => String(row).trim()).filter(Boolean).slice(0, 5)
  const parts = [String(body.text ?? '').trim()].filter(Boolean)
  const failures = []
  for (const url of urls) {
    try {
      const page = await harvestText(url, fetch, signal)
      if (page.text.length >= 80) parts.push(`${page.title ?? ''}\n${page.text}`)
      else failures.push(tr('{url}：页面上几乎没有文字，可能需要登录', { url }))
    } catch (err) {
      signal.throwIfAborted()
      failures.push(tr('{url}：{error}', { url, error: err.message }))
    }
  }
  const material = parts.join('\n\n---\n\n')
  if (material.length < 80) {
    throw Object.assign(new Error(failures.length ? tr('抓不到内容。{reason}。可以把内容直接贴进来。', { reason: failures[0] }) : tr('内容太少了，至少贴一段完整的文字')), { status: 400 })
  }
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 20) : ''
  const source = urls.length && parts.length === urls.length ? tr('链接') : urls.length ? tr('内容和链接') : tr('内容')
  return styleFromMaterial(ctx, store, { material, name, source, sourceUrls: urls, failures, signal })
}

async function styleFromMaterial(ctx, store, { material, name, source, sourceUrls = [], failures = [], signal }) {
  signal.throwIfAborted()
  const sampleMaterial = { title: name || tr('作者样文'), body: material, source, url: sourceUrls[0], collectedAt: new Date().toISOString(),
    materialType: 'author-sample', completeness: sourceUrls.length ? 'complete' : 'excerpt', selectedAuthorSample: true }
  const prompts = stylePrompts(material, name)
  const stage = await ctx.mediaDesk.nativeWork.request('style', null, prompts.system + '\n' + prompts.user, { data: { name, source, sourceUrls, sampleMaterial } })
  return { stage, failures }
}

async function addFromUrl(ctx, store, body, signal) {
  const url = String(body.url || '').trim()
  const info = await harvest(url, fetch, signal)
  signal.throwIfAborted()
  const op = {
    op: 'add_item', kind: 'web', title: body.title || info.title || url, body: body.note || info.description || '', url: info.url, source: info.siteName, tags: Array.isArray(body.tags) ? body.tags : [],
    media: info.image ? { src: info.image } : null,
  }
  return store.mutate(tr('收藏《{title}》', { title: op.title.slice(0, 12) }), (draft) => {
    const { receipts, errors } = applyOps(draft, [op])
    return { receipts, errors, id: receipts[0]?.target, state: draft }
  })
}

async function handleUpload(req, store, res) {
  const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
  const ext = UPLOAD_EXT[type]
  if (!ext) return json(res, 415, { error: tr('不支持这种文件：{type}', { type: type || tr('未知') }) })
  const buffer = await readBuffer(req, MAX_UPLOAD)
  await store.read()
  const name = `${newId('f')}${ext}`
  await store.run(() => { store.owner.signal.throwIfAborted(); return writeFile(join(store.filesDir, name), buffer) })
  return json(res, 200, { src: `media-desk/files/${name}`, kind: type.startsWith('video/') ? 'video' : 'image' })
}

async function route(ctx, store, desk, req, res) {
  const url = new URL(req.url || '/', 'http://local')
  const path = url.pathname.replace(/^\/media-desk\/?/, '')
  const method = req.method || 'GET'

  if ((method === 'GET' || method === 'HEAD') && path.startsWith('assets/')) {
    const name = path.slice('assets/'.length)
    if (!/^[\w.-]+$/.test(name)) return json(res, 400, { error: tr('路径无效') })
    return sendFile(req, res, join(ASSETS_DIR, name), desk.ownership.signal)
  }
  if ((method === 'GET' || method === 'HEAD') && path.startsWith('files/')) {
    const name = path.slice('files/'.length)
    if (!/^[\w.-]+$/.test(name)) return json(res, 400, { error: tr('路径无效') })
    await store.read()
    return sendFile(req, res, join(store.filesDir, name), desk.ownership.signal)
  }
  if ((method === 'GET' || method === 'HEAD') && path.startsWith('media/')) {
    const id = path.slice('media/'.length)
    if (!/^[a-f0-9-]{36}$/.test(id)) return json(res, 400, { error: tr('路径无效') })
    return sendFile(req, res, await desk.mediaFiles.resolve(id), desk.ownership.signal)
  }
  if (method === 'GET') {
    if (path === 'notes/migrations') return json(res, 200, { migrations: await store.migration.list() })
    if (path === 'notes/saves') return json(res, 200, { writes: await store.saves() })
    if (path === 'media/saves') return json(res, 200, { saves: await desk.mediaFiles.saves() })
    if (path === 'sessions') return json(res, 200, { associations: await desk.nativeSessions.list() })
    if (path === 'state') {
      let state = await store.read()
      // 示例数据跟着界面语言走；用户自己的内容不动
      if (samplesNeedLocale(state, currentLang())) state = await store.localizeNotes(currentLang(), await desk.nativeSessions.list())
      return json(res, 200, { state, model: engineLabel(ctx), modelOk: null, modelError: null, canUndo: store.canUndo, undoId: store.undoId })
    }
    if (path === 'production') {
      const id = url.searchParams.get('id') ?? ''
      const state = await store.read()
      const item = state.items.find(row => row.id === id)
      return json(res, 200, { item: item ?? null, production: item?.production ?? null, status: item?.status, live: desk.producer.status(id) })
    }
    if (path === 'settings') return json(res, 200, { ...publicSettings(await desk.settings.read(), Boolean(imageTool(ctx))), defaultExportDir: defaultExportDir() })
    if (path === 'models') {
      // 列出 Harness 里已接的提供方和它们公布的模型，给工作台的助手模型选择器用
      const llm = ctx.get('llm')
      const providers = llm ? await llm.listProviders() : []
      const settled = await Promise.allSettled(providers.map(async p => ({
        provider: p.id, name: p.name,
        models: (await llm.listModels(p.id)).map(m => ({ id: m.id, name: m.name || m.id })),
      })))
      return json(res, 200, {
        providers: settled.filter(r => r.status === 'fulfilled').map(r => r.value).filter(p => p.models.length),
        default: defaultSelection(ctx),
        current: assistantModelOverride(),
      })
    }
    if (path === 'insights') return json(res, 200, computeInsights(await store.read()))
    return json(res, 404, { error: tr('接口不存在') })
  }
  if (method !== 'POST') return json(res, 405, { error: tr('不支持的方法') })

  // 所有写操作都拒绝跨站请求
  const site = req.headers['sec-fetch-site']
  if (site && site !== 'same-origin' && site !== 'none') return json(res, 403, { error: tr('拒绝跨站请求') })

  if (path === 'upload') return handleUpload(req, store, res)
  const body = await readJson(req)
  switch (path) {
    case 'notes/migrate': {
      const result = await store.migrateNotes(await desk.nativeSessions.list(), (await desk.settings.read()).voice)
      await desk.mediaFiles.migrate()
      result.state = await store.read()
      await desk.settings.clearLegacyVoice()
      return json(res, 200, result)
    }
    case 'notes/language': {
      const result = await store.mutate(tr('切换作品语言'), async draft => {
        const item = draft.items.find(row => row.id === body.id)
        if (!item?.content) throw Object.assign(new Error(tr('作品尚未登记 Notes 文件')), { code: 'notes/not-registered', status: 409 })
        await store.notes.switchLanguage(item, body.language)
        return { state: draft }
      }, { undoable: false, expectedContent: { [body.id]: body.expectedContent } })
      return json(res, 200, result)
    }
    case 'notes/version': return json(res, 200, await store.savedVersion(body))
    case 'notes/resolve': return json(res, 200, await store.resolveSave(body))
    case 'notes/retry': return json(res, 200, await store.retrySave(body.id))
    case 'notes/register': {
      return json(res, 200, await store.registerNotes(body, await desk.nativeSessions.list()))
    }
    case 'notes/relink': {
      const result = await store.mutate(tr('重新关联作品文件'), async draft => {
        const item = draft.items.find(row => row.id === body.id)
        if (!item?.content) throw Object.assign(new Error(tr('作品尚未登记 Notes 文件')), { code: 'notes/not-registered', status: 409 })
        await store.notes.relink(item, body.relativePath)
        return { state: draft }
      }, { undoable: false })
      return json(res, 200, result)
    }
    case 'sessions/open':
      return json(res, 200, { association: await desk.nativeSessions.open(body.workId ?? null) })
    case 'ops': {
      const label = typeof body.label === 'string' ? body.label : tr('操作')
      const undoable = body.undoable !== false && !editsPreferenceText(body.ops)
      const result = await store.mutate(label, (draft) => {
        const applied = applyOps(draft, body.ops)
        return { ...applied, state: draft }
      }, { undoable, expectedContent: body.expectedContent ?? {}, resultKey: body.resultKey,
        payloadHash: createHash('sha256').update(JSON.stringify({ ops: body.ops, expectedContent: body.expectedContent ?? {} })).digest('hex') })
      return json(res, 200, { ...result, undoable, canUndo: store.canUndo, undoId: store.undoId })
    }
    case 'undo': {
      const label = await store.undoLast(body.id)
      return json(res, 200, { label, state: await store.read(), canUndo: store.canUndo, undoId: store.undoId })
    }
    case 'chat': return jsonState(res, store, await chatTurn(ctx, store, desk, body))
    case 'chat/clear': {
      return json(res, 200, { association: await desk.nativeSessions.newConversation(body.workId ?? null), state: await store.read() })
    }
    case 'produce': {
      const started = await desk.producer.start(String(body.id))
      return json(res, 200, { started, state: await store.read() })
    }
    case 'produce/cancel':
      await desk.producer.cancel(String(body.id))
      return json(res, 200, { ok: true })
    case 'produce/regen':
      await desk.producer.regenerate(String(body.id), body.target)
      return json(res, 200, { state: await store.read() })
    case 'native/retry':
      return json(res, 200, { ...await desk.nativeWork.retry(body.id), state: await store.read() })
    case 'media/retry':
      return json(res, 200, { ...await desk.mediaFiles.retry(body.id), state: await store.read() })
    case 'produce/save': {
      const settings = await desk.settings.read()
      const state = await store.read()
      const item = state.items.find(row => row.id === body.id)
      if (!item?.production?.article) return json(res, 400, { error: tr('还没有可以保存的成稿') })
      if (item.production.attemptId && !state.nativeRequests?.some(row => row.id === item.production.nativeStageId && row.status === 'accepted' && row.data.planId === item.production.attemptId)) {
        return json(res, 409, { error: tr('当前策划的脚本尚未接受，请等待完成后保存') })
      }
      store.notes.assertExpected(state, body.expectedContent ?? {})
      const production = structuredClone(item.production)
      production.article = item.content ? item.body : production.article
      production.title = item.title || production.title
      // 视频封面由浏览器合成（画面叠大字），这里只接受 JPEG
      const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(body.videoCover ?? '')
      const videoCover = match ? Buffer.from(match[1], 'base64') : null
      if (videoCover && !(videoCover[0] === 0xff && videoCover[1] === 0xd8)) return json(res, 400, { error: tr('封面不是有效的图片') })
      if (videoCover && (body.coverSrc !== production.cover?.src || body.coverText !== (production.coverText || production.title))) return json(res, 409, { error: tr('封面已变化，请重新保存') })
      const saved = await saveProduction(production, { filesDir: store.filesDir, exportDir: resolveExportDir(settings.exportDir), videoCover,
        resolveMedia: id => desk.mediaFiles.resolve(id), snapshot: { workId: item.id, content: item.content, attemptId: production.attemptId } })
      const next = await store.mutate('保存成稿', (draft) => {
        const target = draft.items.find(row => row.id === body.id)
        if (target?.production) {
          target.production.savedPath = saved.path
          target.production.savedAt = new Date().toISOString()
        }
        return draft
      }, { undoable: false })
      return json(res, 200, { ...saved, state: next })
    }
    case 'produce/reveal': {
      // 路径只取自保存记录，不接受请求里传来的路径
      const state = await store.read()
      const path = state.items.find(row => row.id === body.id)?.production?.savedPath
      if (!path) return json(res, 400, { error: tr('还没有保存过') })
      const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
      execFile(command, [path], () => {})
      return json(res, 200, { path })
    }
    case 'style/extract': return jsonState(res, store, await extractStyle(ctx, store, body, desk.ownership.signal))
    case 'settings': {
      const updated = await desk.settings.update(body)
      setAssistantModel(updated.assistant)
      return json(res, 200, { ...publicSettings(updated, Boolean(imageTool(ctx))), defaultExportDir: defaultExportDir(), assistantEffective: modelInfo(ctx)?.label ?? null })
    }
    case 'settings/test': {
      const settings = await desk.settings.read()
      if (!desk.producer.ready(settings)) return json(res, 400, { error: tr(settings.image.source === 'tool' ? '未找到订阅生图工具，或默认执行器不支持直接调用；请检查插件和执行器后刷新工作台' : '先填好接口地址、模型和密钥') })
      await store.read()
      const { buffer, ext } = await desk.producer.generate(settings.image, 'A single paper boat on calm water, black and white pencil line art sketch, plain white paper background, no text.')
      desk.ownership.signal.throwIfAborted()
      const name = `${newId('t')}${ext}`
      await store.run(() => writeFile(join(store.filesDir, name), buffer))
      return json(res, 200, { src: `media-desk/files/${name}` })
    }
    case 'capture-url': return jsonState(res, store, await addFromUrl(ctx, store, body, desk.ownership.signal))
    case 'skills/learn': {
      const stage = await desk.nativeWork.request('rules', null, 'Read current Notes work and its fixed AI originals, and the recorded performance metrics. Propose evidence-based writing rules as rules[{name,rule,evidence}]. Treat correlations as observations rather than causation; proposals require user review.')
      return jsonState(res, store, { stage })
    }
    case 'skills/export': {
      const state = await store.read()
      const result = await exportSkill(state, dshHome())
      const next = await store.mutate('导出 Skill', (draft) => {
        applyOps(draft, draft.skills.filter(s => !s.sample && s.status === 'active').map(s => ({ op: 'update_skill', id: s.id, status: 'exported' })))
        return draft
      }, { undoable: false })
      return json(res, 200, { ...result, state: next })
    }
    default: return json(res, 404, { error: tr('接口不存在') })
  }
}

/**
 * Web 服务不会替插件路由鉴权，所以每个请求都要自己走一遍 Host/Origin 和登录凭证检查。
 * 拿不到鉴权服务时一律拒绝。
 * @param {object} ctx - Cordis 上下文。
 * @param {{headers: object}} req - HTTP 请求。
 * @returns {number|undefined} 拒绝时的状态码；可以继续时为 undefined。
 */
export function requestRejection(ctx, req) {
  const connection = ctx.get('connection')
  if (typeof connection?.requestRejection !== 'function') return 403
  return connection.requestRejection({ headers: req.headers })
}

export const name = 'dsh-media-desk'

/** One Host Store and association service, available before native preset recovery. */
export default class MediaDeskHost extends Service {
  static inject = ['webServer', 'connection']

  /**
   * @param {object} ctx - DSH Host context with authenticated Web routes.
   * @param {object} [config] - Optional Wiki path; otherwise WIKI_PATH or ~/wiki.
   */
  constructor(ctx, config = {}) {
    super(ctx, 'mediaDesk')
    this.config = config
  }

  async [Service.init]() {
    const ctx = this.ctx
    const config = this.config
    const ownership = new WriteOwner(join(dshHome(), 'media-desk'), config.wikiPath ?? process.env.WIKI_PATH ?? join(homedir(), 'wiki'))
    this.ownership = ownership
    ctx.effect(() => () => this.close(), 'media-desk: writer ownership')
    await ownership.acquire()
    const store = new Store(ownership.dataRoot, ownership)
    const settings = new Settings(store.root, ownership, store)
    const producer = new Producer({
      store, settings,
      ready: saved => imageReady(saved, Boolean(imageTool(ctx))),
      generate: (image, prompt, options = {}) => {
        const request = { ...options, signal: AbortSignal.any([ownership.signal, ...(options.signal ? [options.signal] : [])]) }
        return image.source === 'tool' ? generateToolImage(ctx, image, prompt, request) : generateImage(image, prompt, request)
      },
      onError: error => ctx.logger.error(error),
    })
    const nativeSessions = new NativeSessions(ctx, store, settings, config)
    store.notes = new Notes(ownership)
    const nativeWork = new NativeWork(ctx, store, nativeSessions)
    producer.native = nativeWork
    const mediaFiles = new MediaFiles(store)
    producer.media = mediaFiles
    Object.assign(this, { store, settings, producer, nativeSessions, nativeWork, mediaFiles })
    const desk = this
    await nativeSessions.init()
    await store.notes.init()
    await store.read()
    await mediaFiles.recover()
    await producer.settleAll()
    await nativeWork.init()
    // 启动时恢复用户在工作台里选过的助手模型
    setAssistantModel((await settings.read()).assistant)
    ctx.inject(['shellEnv'], shellCtx => shellCtx.shellEnv.register({
      name: 'media-desk.wiki',
      variables: { DSH_MEDIA_DESK_WIKI_PATH: { description: 'Wiki root bound to this Media Desk Session; set WIKI_PATH to this value for llm-wiki commands.' } },
      resolve: execution => {
        try { return { DSH_MEDIA_DESK_WIKI_PATH: nativeSessions.requireAssociation(execution.agent).wikiRoot } } catch { return {} }
      },
    }))
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/media-desk',
      handler: async (req, res) => {
        try {
          const rejection = requestRejection(ctx, req)
          if (rejection) {
            json(res, rejection, { error: tr('未授权') })
            return
          }
          await ownership.track(async () => {
            const abort = () => req.destroy?.(ownership.signal.reason)
            ownership.signal.addEventListener('abort', abort, { once: true })
            try {
              const path = new URL(req.url || '/', 'http://local').pathname.replace(/^\/media-desk\/?/, '')
              const request = () => withLang(req.headers['x-media-desk-lang'], () => route(ctx, store, desk, req, res))
              await (SERIAL_ROUTES.has(path) ? ownership.run(request) : request())
            } finally { ownership.signal.removeEventListener('abort', abort) }
          })
        } catch (err) {
          if (res.headersSent) {
            res.end()
            return
          }
          const message = err.pendingId ? withLang(req.headers['x-media-desk-lang'], () => notesSaveMessage(err)) : err.message
          json(res, err.status || 500, { error: message, ...(err.code ? { code: err.code } : {}), ...(err.pendingId ? { pendingId: err.pendingId } : {}) })
        }
      },
    }), 'dsh-media-desk: /media-desk routes')
  }

  /** Stop Host-owned tasks and drain admitted writes before releasing directory ownership. */
  close() {
    if (this.closingPromise) return this.closingPromise
    const nativeClose = this.store && this.ownership.track(async () => {
      await this.nativeWork?.close()
      await this.store.mutate('停止创作任务', draft => {
        for (const stage of draft.nativeRequests ?? []) if (['pending', 'running', 'waiting', 'candidate', 'save-failed'].includes(stage.status)) stage.status = 'interrupted'
        for (const work of draft.items) if (work.production?.status === 'running') work.production.status = 'cancelled'
      }, { undoable: false })
    })
    this.ownership.beginShutdown()
    this.closingPromise = (async () => {
      await Promise.all([nativeClose, this.producer?.close()])
      await this.ownership.drain()
      await this.ownership.release()
    })()
    return this.closingPromise
  }
}
