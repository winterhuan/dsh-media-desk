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
import { assistantModelOverride, callModel, chatPrompts, defaultSelection, extractJson, modelInfo, modelStatus, setAssistantModel } from './ai.js'
import { defaultExportDir, resolveExportDir, saveProduction } from './export.js'
import { harvest, harvestText } from './harvest.js'
import { generateImage } from './images.js'
import { generateToolImage, imageTool } from './image-tool.js'
import { localIntent } from './intents.js'
import { computeInsights, exportSkill, proposeRules } from './learn.js'
import { createMonidRunner, fetchAccount, importPosts, monidStatus, postsToMaterial, resolveAccount, saveCovers } from './monid.js'
import { applyOps, newId } from './ops.js'
import { applyRevision, Producer } from './produce.js'
import { publicSettings, Settings, imageReady } from './settings.js'
import { normalizeStyle, stylePrompts } from './style.js'
import { dshHome, Store } from './store.js'
import { currentLang, platformName, tr, withLang } from './i18n.js'
import { samplesNeedLocale } from './seed.js'
import { NativeSessions } from './native-sessions.js'
import { Notes, notesSaveMessage } from './notes.js'
import { WriteOwner } from './write-owner.js'

const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets')
const MAX_JSON = 4_000_000
const MAX_UPLOAD = 250_000_000
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' }
const UPLOAD_EXT = Object.fromEntries(Object.entries(MIME).filter(([ext]) => ext !== '.jpeg').map(([ext, type]) => [type, ext]))
const SERIAL_ROUTES = new Set(['ops', 'undo', 'settings', 'upload', 'produce', 'produce/cancel', 'produce/regen', 'produce/save', 'skills/export', 'notes/register', 'notes/relink', 'notes/retry', 'notes/resolve', 'notes/version', 'notes/saves', 'notes/migrate', 'notes/migrations', 'notes/language', 'chat/clear', 'sessions/open', 'sessions', 'state', 'production'])
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

/** 同一次故障只提醒一次，用人话说。原始错误放在模型状态的提示里。 */
function outageNotice(ctx, wasDown, fallback) {
  if (wasDown) return null
  return modelInfo(ctx) ? tr('模型暂时用不了，{fallback}。可以到设置里检查账号或密钥。', { fallback }) : tr('当前没有连接模型，{fallback}。', { fallback })
}

async function chatTurn(ctx, store, desk, body) {
  const message = String(body.message || '').trim()
  if (!message) throw Object.assign(new Error(tr('消息为空')), { status: 400 })
  const focusId = typeof body.focusId === 'string' ? body.focusId : undefined
  const state = await store.read()
  store.notes.assertExpected(state, body.expectedContent ?? {})
  const snapshot = JSON.parse(JSON.stringify(state))
  let plan
  let engine = 'local'
  let notice = null
  const wasDown = modelStatus.ok === false
  try {
    const history = snapshot.chat.filter(row => (row.itemId ?? null) === (focusId ?? null))
    const { system, user } = chatPrompts(snapshot, message, { focusId, history })
    const editing = snapshot.items.find(row => row.id === focusId)?.production?.status === 'done'
    const { text, model } = await callModel(ctx, { system, user, maxTokens: editing ? 8000 : 2000, light: true, signal: AbortSignal.any([desk.ownership.signal, AbortSignal.timeout(editing ? 240_000 : 90_000)]) })
    engine = model
    try {
      plan = extractJson(text)
      if (typeof plan.reply !== 'string') plan.reply = tr('处理好了。')
    } catch {
      // 模型只回了一段话时，当成普通回答，不算失败
      plan = { reply: text.trim().slice(0, 1200) || tr('我没有听懂，可以换个说法吗？'), ops: [] }
    }
  } catch {
    desk.ownership.signal.throwIfAborted()
    notice = outageNotice(ctx, wasDown, tr('先用本地规则处理'))
    plan = localIntent(snapshot, message, { focusId })
  }
  const settings = await desk.settings.read()
  const canDraw = desk.producer.ready(settings)
  const affected = new Set((Array.isArray(plan.ops) ? plan.ops : []).map(op => op?.id))
  if (focusId && plan.revise) affected.add(focusId)
  const expectedContent = Object.fromEntries(snapshot.items.filter(item => item.content && affected.has(item.id)).map(item => [item.id, item.content]))
  // 只把真正改了数据的那一步放进撤销；问一句话不占撤销位
  const changed = await store.mutate(tr('对话：{text}', { text: message.slice(0, 18) }), (draft) => {
    const target = focusId ? draft.items.find(row => row.id === focusId) : null
    const production = target?.production?.status === 'done' ? target.production : null
    // 本地规则只会改灵感标题；有成稿时要改的是成稿标题
    const ops = (Array.isArray(plan.ops) ? plan.ops : []).map((op) => {
      if (production && op?.op === 'update_item' && op.id === focusId && typeof op.title === 'string') return { op: 'update_production', id: focusId, title: op.title }
      return op
    })
    const { receipts, errors } = applyOps(draft, ops)
    let targets = []
    if (production && plan.revise) {
      // 没接生图时，图不会重画，回执要说实话
      const revision = applyRevision(production, plan.revise, { canDraw })
      receipts.push(...revision.receipts.map(text => ({ text })))
      errors.push(...revision.errors)
      targets = canDraw ? revision.targets : []
    }
    return { receipts, errors, targets, done: Boolean(production) }
  }, { undoable: !editsPreferenceText(plan.ops), expectedContent, resultKey: newId('chat'),
    payloadHash: createHash('sha256').update(JSON.stringify({ message, focusId, plan, expectedContent })).digest('hex') })
  const result = await store.mutate('对话记录', (draft) => {
    const { receipts, errors, targets, done } = changed
    const at = new Date().toISOString()
    const itemId = focusId ?? undefined
    const undoId = draft.notesUndo?.find(entry => entry.id === changed.acceptance.id)?.id ?? null
    // 已经做好的成稿不会因为一句话被整篇重做，要重做请点「重新成稿」
    const actions = (Array.isArray(plan.actions) ? plan.actions : [])
      .filter(a => a && ['produce', 'open', 'nav'].includes(a.type))
      .filter(a => !(a.type === 'produce' && (done && a.id === focusId || draft.items.find(row => row.id === a.id)?.production?.status === 'done')))
    draft.chat.push({ id: newId('c'), at, role: 'user', text: message, itemId })
    const answer = { id: newId('c'), at, role: 'assistant', text: plan.reply, receipts, errors, engine, notice, undoable: Boolean(undoId), undoId, itemId }
    draft.chat.push(answer)
    draft.chat = draft.chat.slice(-300)
    return { answer, actions, targets, state: draft, modelOk: modelStatus.ok, modelError: modelStatus.error }
  }, { undoable: false })
  if (canDraw) {
    await Promise.all(result.targets.map(target => desk.producer.regenerate(focusId, target).catch(() => {})))
    return { ...result, state: await store.read() }
  }
  return result
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

/** 提炼一张风格卡并设为当前风格。同一个账号再抓一次时更新原来那张。 */
async function styleFromMaterial(ctx, store, { material, name, source, sourceUrls = [], failures = [], accountKey = null, signal }) {
  let style
  try {
    const { system, user } = stylePrompts(material, name)
    const { text } = await callModel(ctx, { system, user, maxTokens: 1500, light: true, signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) })
    style = normalizeStyle(extractJson(text), name)
  } catch (err) {
    throw Object.assign(new Error(tr('提炼风格需要文字模型：{error}', { error: err.message })), { status: 502 })
  }
  return store.mutate(tr('提炼风格「{name}」', { name: style.name }), (draft) => {
    const existing = accountKey ? (draft.styles ?? []).find(row => row.accountKey === accountKey) : null
    const id = existing?.id ?? newId('st')
    const createdAt = existing?.createdAt ?? new Date().toISOString()
    const row = { id, ...style, source, sourceUrls, ...(accountKey ? { accountKey } : {}), createdAt,
      sampleMaterial: { title: `${style.name} · ${tr('作者样文')}`, body: material, source, url: sourceUrls[0], collectedAt: new Date().toISOString(),
        materialType: 'author-sample', completeness: sourceUrls.length ? 'complete' : 'excerpt', externalId: accountKey, styleId: id, selectedAuthorSample: true } }
    draft.styles = existing ? draft.styles.map(entry => (entry.id === id ? row : entry)) : [row, ...(draft.styles ?? [])]
    draft.activeStyleId = id
    return { id, failures, state: draft }
  }, { undoable: false })
}

/** 导入用户自己的账号。钱花在 Monid 上，所以先把内容存好，提炼失败也不会白花。 */
async function importAccountRoute(ctx, store, desk, body) {
  if (desk.importing) throw Object.assign(new Error(tr('上一个账号还在导入，等它结束再试')), { status: 409 })
  desk.importing = true
  try {
    const account = await resolveAccount(body.text)
    const { posts, profile, cost } = await fetchAccount(account, desk.monid)
    const sourceState = await store.read()
    const covers = await store.run(() => saveCovers(posts, account.platform, sourceState, store.filesDir, fetch, desk.ownership.signal))
    desk.ownership.signal.throwIfAborted()
    const added = await store.mutate(tr('导入{platform}账号', { platform: platformName(account.platform) }), draft => importPosts(draft, { account, profile, posts, covers }).added)
    const nickname = profile.nickname || platformName(account.platform)
    let styleError = null
    const material = postsToMaterial(posts)
    if (material.length >= 80) {
      try {
        await styleFromMaterial(ctx, store, { material, name: nickname, source: tr('{platform}账号', { platform: platformName(account.platform) }), sourceUrls: [account.url], accountKey: `${account.platform}:${account.id}`, signal: desk.ownership.signal })
      } catch (err) {
        styleError = err.message
      }
    } else {
      styleError = tr('这个账号的文字太少，提炼不出风格')
    }
    return { platform: account.platform, nickname, count: posts.length, added, cost, styleName: styleError ? null : nickname, styleError, state: await store.read() }
  } finally {
    desk.importing = false
  }
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

async function refreshAccount(store, body, signal) {
  const url = String(body.url || '').trim()
  const now = new Date().toISOString()
  let patch
  try {
    const info = await harvest(url, fetch, signal)
    patch = { url: info.url, title: info.title ?? undefined, description: info.description ?? undefined, avatar: info.image ?? undefined, fetchedAt: now, fetchError: '', ...(info.followers ? { followers: info.followers } : {}) }
  } catch (err) {
    patch = { url, fetchedAt: now, fetchError: err.message }
  }
  signal.throwIfAborted()
  return store.mutate(tr('更新账号档案'), (draft) => {
    const op = body.id ? { op: 'update_account', id: body.id, ...patch } : { op: 'add_account', platform: body.platform ?? '', handle: body.handle ?? '', ...patch }
    const { errors } = applyOps(draft, [op])
    return { state: draft, errors, fetchError: patch.fetchError || null }
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
  if (method === 'GET') {
    if (path === 'notes/migrations') return json(res, 200, { migrations: await store.migration.list() })
    if (path === 'notes/saves') return json(res, 200, { writes: await store.saves() })
    if (path === 'sessions') return json(res, 200, { associations: await desk.nativeSessions.list() })
    if (path === 'state') {
      if (!desk.settled) { desk.settled = true; await desk.producer.settleAll().catch(() => {}) }
      let state = await store.read()
      // 示例数据跟着界面语言走；用户自己的内容不动
      if (samplesNeedLocale(state, currentLang())) state = await store.localizeNotes(currentLang(), await desk.nativeSessions.list())
      return json(res, 200, { state, model: engineLabel(ctx), modelOk: modelStatus.ok, modelError: modelStatus.error, canUndo: store.canUndo, undoId: store.undoId })
    }
    if (path === 'production') {
      const id = url.searchParams.get('id') ?? ''
      await desk.producer.settle(id)
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
    if (path === 'monid/status') return json(res, 200, await monidStatus(desk.monid))
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
      const state = await store.mutate('清空对话', (draft) => { draft.chat = []; return draft }, { undoable: false })
      return json(res, 200, { state })
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
    case 'produce/save': {
      const settings = await desk.settings.read()
      const state = await store.read()
      const item = state.items.find(row => row.id === body.id)
      if (!item?.production?.article) return json(res, 400, { error: tr('还没有可以保存的成稿') })
      await store.read()
      // 视频封面由浏览器合成（画面叠大字），这里只接受 JPEG
      const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(body.videoCover ?? '')
      const videoCover = match ? Buffer.from(match[1], 'base64') : null
      if (videoCover && !(videoCover[0] === 0xff && videoCover[1] === 0xd8)) return json(res, 400, { error: tr('封面不是有效的图片') })
      const saved = await saveProduction(item.production, { filesDir: store.filesDir, exportDir: resolveExportDir(settings.exportDir), videoCover })
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
    case 'monid/import': return jsonState(res, store, await importAccountRoute(ctx, store, desk, body))
    case 'settings': {
      const before = modelInfo(ctx)
      const updated = await desk.settings.update(body)
      setAssistantModel(updated.assistant)
      const after = modelInfo(ctx)
      // 换了模型，上一个模型的失败状态不再算数
      if (before?.provider !== after?.provider || before?.model !== after?.model) Object.assign(modelStatus, { ok: null, error: null })
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
    case 'account/refresh': return jsonState(res, store, await refreshAccount(store, body, desk.ownership.signal))
    case 'skills/learn': {
      const proposals = proposeRules(await store.read())
      if (!proposals.length) return jsonState(res, store, { added: 0 })
      const state = await store.mutate(tr('从数据中学习'), (draft) => {
        // 只用示例数据算出来的建议也算示例，清空示例时一起清掉，也不会被导出
        const fromSamples = !draft.metrics.some(metric => !metric.sample)
        const { receipts } = applyOps(draft, proposals.map(row => ({ op: 'add_skill', ...row, status: 'proposed' })))
        if (fromSamples) for (const receipt of receipts) { const skill = draft.skills.find(row => row.id === receipt?.target); if (skill) skill.sample = true }
        return draft
      })
      return jsonState(res, store, { added: proposals.length, state })
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
      store, settings, callText: options => callModel(ctx, { ...options, signal: AbortSignal.any([ownership.signal, ...(options.signal ? [options.signal] : [])]) }),
      ready: saved => imageReady(saved, Boolean(imageTool(ctx))),
      generate: (image, prompt, options = {}) => {
        const request = { ...options, signal: AbortSignal.any([ownership.signal, ...(options.signal ? [options.signal] : [])]) }
        return image.source === 'tool' ? generateToolImage(ctx, image, prompt, request) : generateImage(image, prompt, request)
      },
      onError: error => ctx.logger.error(error),
    })
    const monid = createMonidRunner(undefined, undefined, ownership.signal)
    const nativeSessions = new NativeSessions(ctx, store, settings, config)
    store.notes = new Notes(ownership)
    Object.assign(this, { store, settings, producer, monid, nativeSessions })
    const desk = this
    await nativeSessions.init()
    await store.notes.init()
    await store.read()
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
    this.ownership.beginShutdown()
    this.closingPromise = (async () => {
      await this.producer?.close()
      await this.ownership.drain()
      await this.ownership.release()
    })()
    return this.closingPromise
  }
}
