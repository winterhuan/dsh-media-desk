// 浏览器侧的状态：Host 状态的本地镜像，加上只属于界面的选中、视图等。
import React from 'react'
import { coverDataUrl } from './cover.js'
import { lang, plural, setLanguagePreference, t } from './i18n.js'

const BASE = 'media-desk/'

let snapshot = {
  state: null, model: null, modelOk: null, modelError: null, canUndo: false, undoId: null, error: null,
  view: 'home', mode: 'scatter', focusId: null, sheetOrigin: null, dockOpen: true, studioDock: false, chatQuote: null, query: '', kindFilter: 'all', related: null,
  live: {}, settings: null, settingsOpen: false, notesRecovery: false, modelPickOpen: false, thinking: false, toast: null, capture: null, dialog: null,
}
const listeners = new Set()

export function getDesk() {
  return snapshot
}

export function setDesk(patch) {
  snapshot = { ...snapshot, ...(typeof patch === 'function' ? patch(snapshot) : patch) }
  listeners.forEach(fn => fn())
}

function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function useDesk(selector) {
  return React.useSyncExternalStore(subscribe, () => selector(snapshot))
}

async function request(path, body) {
  const res = await fetch(BASE + path, body === undefined ? { headers: { 'x-media-desk-lang': lang() } } : {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-media-desk-lang': lang() }, body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(data.error || t('请求失败（{status}）', { status: res.status })), { code: data.code, pendingId: data.pendingId })
  return data
}

let toastTimer = null
export function toast(text, { undo = false, error = false } = {}) {
  clearTimeout(toastTimer)
  setDesk({ toast: { text, undo, undoId: snapshot.undoId, error, key: Date.now() } })
  toastTimer = setTimeout(() => setDesk({ toast: null }), undo || text.length > 24 ? 6000 : 3200)
}

export function report(err) {
  toast(err.message || String(err), { error: true })
}

export async function loadDesk() {
  try {
    // 先读设置拿到语言偏好，示例数据按这个语言返回
    const settings = await request('settings')
    setLanguagePreference(settings.language)
    const data = await request('state')
    setDesk({ settings, state: data.state, model: data.model, modelOk: data.modelOk, modelError: data.modelError, canUndo: data.canUndo, undoId: data.undoId, error: null })
  } catch (err) {
    setDesk({ error: err.message })
  }
}

/**
 * Open or restore the durable native Session for a work or the global assistant.
 * @param {string|null} workId - Work identity, or null for the global assistant.
 * @returns {Promise<object>} Bound association with the actual native Session identity.
 */
export async function openNativeSession(workId) {
  const { association } = await request('sessions/open', { workId })
  return association
}

/** Start a fresh conversation while retaining the old native Session and draft. */
export async function newNativeConversation(workId) {
  return (await request('chat/clear', { workId })).association
}

export async function dispatchOps(ops, { label = t('操作'), undoable = true, silent = false, expectedContent, throwOnError = false } = {}) {
  try {
    const versions = expectedContent ?? Object.fromEntries(ops.flatMap(op => {
      const content = snapshot.state?.items.find(item => item.id === op.id)?.content
      return content ? [[op.id, { revision: content.revision, sha256: content.sha256 }]] : []
    }))
    const data = await request('ops', { ops, label, undoable, expectedContent: versions })
    setDesk({ state: data.state, canUndo: data.canUndo, undoId: data.undoId })
    if (data.errors?.length && throwOnError) throw new Error(data.errors[0])
    if (data.errors?.length) toast(data.errors[0], { error: true })
    else if (!silent && data.receipts?.[0]) toast(data.receipts[0].text, { undo: undoable && data.undoable !== false })
    return data
  } catch (err) {
    if (throwOnError) throw err
    report(err)
    return null
  }
}

/** Register an explicitly selected existing Markdown file; validation failures stay with the form. */
export async function registerWorkFile(id, language, relativePath) {
  const data = await request('notes/register', { id, language, relativePath })
  setDesk({ state: data.state })
  toast(t('作品文件已登记'))
}

/** Relink a registered work without copying or rebuilding its primary text. */
export async function relinkWorkFile(id, relativePath) {
  const data = await request('notes/relink', { id, relativePath })
  setDesk({ state: data.state })
  toast(t('作品文件已重新关联'))
}

export async function undo(id = snapshot.undoId) {
  if (!id) return
  try {
    const data = await request('undo', { id })
    setDesk({ state: data.state, canUndo: data.canUndo, undoId: data.undoId, toast: null })
    if (data.label) toast(t('已撤销：{label}', { label: data.label }))
  } catch (err) {
    report(err)
  }
}

/** @returns {Promise<object[]>} Retained saves, conflicts and accepted receipts. */
export async function savedNotesWrites() { return (await request('notes/saves')).writes }
export async function savedMediaWrites() { return (await request('media/saves')).saves }

/** @returns {Promise<object[]>} Verified migration metadata without settings or file contents. */
export async function notesMigrationBackups() { return (await request('notes/migrations')).migrations }

/**
 * Inspect only the selected save's observed version before resolving it.
 * @param {object} version - Save/work identity, retained path and observed hash.
 * @returns {Promise<object>} Current body and retained bytes with their validation status.
 */
export function readSavedNotesVersion(version) { return request('notes/version', version) }

function installNotesState(data) {
  setDesk({ state: data.state, canUndo: Boolean(data.state.notesUndo?.length), undoId: data.state.notesUndo?.at(-1)?.id ?? null })
}

/**
 * Retry existing files without starting generation.
 * @param {string} id - Retained save identity.
 * @returns {Promise<void>} Resolves after the durable receipt and state return.
 */
export async function retryNotesSave(id) {
  installNotesState(await request('notes/retry', { id }))
  toast(t('已保存保留的候选'))
}

/**
 * Select a reviewed external or current body while retaining both versions.
 * @param {object} version - Observed save/work/path/hash and current or external choice.
 * @returns {Promise<void>} Resolves after the selection is accepted.
 */
export async function resolveNotesVersion(version) {
  installNotesState(await request('notes/resolve', version))
  toast(t('正文版本已选择，其他版本仍保留'))
}

/** @returns {Promise<void>} Verified backup and legacy work/language migration complete. */
export async function migrateLegacyNotes() {
  installNotesState(await request('notes/migrate', {}))
  toast(t('旧作品和各语言版本已迁移到 Notes'))
}

/**
 * Select an existing language using the current content identity.
 * @param {string} id - Work identity.
 * @param {string} language - Saved language to select.
 * @param {object} expectedContent - Version observed before selection.
 * @returns {Promise<void>} Resolves after the new selection and monotonic version return.
 */
export async function selectWorkLanguage(id, language, expectedContent) {
  installNotesState(await request('notes/language', { id, language, expectedContent }))
  toast(t('作品语言已切换'))
}

export function openItem(id, origin = null) {
  setDesk({ focusId: id, sheetOrigin: origin })
}

export function closeItem() {
  setDesk({ focusId: null, sheetOrigin: null, studioDock: false, chatQuote: null })
}

/** 一键成稿。任务在 Host 里跑，这里只负责启动和看进度。 */
export async function runProduce(id) {
  try {
    const data = await request('produce', { id })
    setDesk({ state: data.state })
  } catch (err) {
    report(err)
  }
}

export async function cancelProduce(id) {
  try {
    await request('produce/cancel', { id })
  } catch (err) {
    report(err)
  }
}

export async function regenAsset(id, target) {
  try {
    const data = await request('produce/regen', { id, target })
    setDesk({ state: data.state })
  } catch (err) {
    report(err)
  }
}

function mergeWork(id, item) {
  setDesk(s => ({ state: { ...s.state, items: item ? s.state.items.map(current => {
    if (current.id !== id || (current.content?.revision ?? 0) > (item.content?.revision ?? 0)) return current
    return item
  }) : s.state.items.filter(current => current.id !== id) } }))
}

/** Refresh current Markdown, metadata and repair status through the existing production read. */
export async function readWork(id) {
  const data = await request(`production?id=${encodeURIComponent(id)}`)
  mergeWork(id, data.item)
  setDesk(s => ({ live: { ...s.live, [id]: data.live } }))
  return data.item
}

/** 轮询进度，返回停止函数。 */
export function watchProduction(id) {
  let stopped = false
  const tick = async () => {
    while (!stopped) {
      try {
        const data = await request(`production?id=${encodeURIComponent(id)}`)
        if (stopped) return
        setDesk(s => ({ live: { ...s.live, [id]: data.live } }))
        mergeWork(id, data.item)
      } catch {
        // 连接抖动时下一轮再试
      }
      await new Promise(r => setTimeout(r, 700))
    }
  }
  tick()
  return () => { stopped = true }
}

export async function saveSettings(payload) {
  try {
    const settings = await request('settings', payload)
    setLanguagePreference(settings.language)
    setDesk({ settings })
    toast(t('设置已保存'))
    return true
  } catch (err) {
    report(err)
    return false
  }
}

export async function fetchModels() {
  return request('models')
}

/** 切换助手模型；两个字段都空表示跟随默认。 */
export async function saveAssistant(assistant) {
  try {
    const settings = await request('settings', { assistant })
    setDesk({ settings, model: settings.assistantEffective ?? snapshot.model })
    toast(t('助手模型已切换'))
    return true
  } catch (err) {
    report(err)
    return false
  }
}

export async function testImage(payload) {
  try {
    const settings = await request('settings', payload)
    setLanguagePreference(settings.language)
    setDesk({ settings })
    const { src } = await request('settings/test', {})
    return src
  } catch (err) {
    report(err)
    return null
  }
}

export async function saveProduced(id) {
  try {
    const production = snapshot.state.items.find(row => row.id === id)?.production
    // 视频封面在浏览器里合成，一起存进文件夹
    const videoCover = await coverDataUrl({ src: production.cover?.src, text: production.coverText || production.title }).catch(() => undefined)
    const item = snapshot.state.items.find(row => row.id === id)
    const data = await request('produce/save', { id, videoCover, expectedContent: item.content ? { [id]: item.content } : {}, coverSrc: production.cover?.src, coverText: production.coverText || production.title })
    setDesk({ state: data.state })
    toast(t('已保存到 {path}', { path: data.path }))
  } catch (err) {
    report(err)
  }
}

export async function revealSaved(id) {
  try {
    await request('produce/reveal', { id })
  } catch (err) {
    report(err)
  }
}

export async function clearChat() {
  try {
    const data = await request('chat/clear', {})
    setDesk({ state: data.state })
  } catch (err) {
    report(err)
  }
}

export async function captureUrl(url, extra = {}) {
  try {
    const data = await request('capture-url', { url, ...extra })
    installNotesState(data)
    toast(t('已收藏到灵感墙'), { undo: true })
    return data.id
  } catch (err) {
    report(err)
    return null
  }
}

export async function uploadFile(file) {
  const res = await fetch(`${BASE}upload`, { method: 'POST', headers: { 'content-type': file.type, 'x-media-desk-lang': lang() }, body: file })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || t('上传失败'))
  return data
}

export async function captureFiles(files) {
  for (const file of files) {
    try {
      const { src, kind } = await uploadFile(file)
      const title = file.name.replace(/\.[^.]+$/, '')
      await dispatchOps([{ op: 'add_item', kind, title, media: { src } }], { label: t('收藏 {title}', { title }), silent: true })
      toast(t('已放到灵感墙'), { undo: true })
    } catch (err) {
      report(err)
    }
  }
}

export async function extractStyle(payload) {
  try {
    const data = await request('style/extract', payload)
    installNotesState(data)
    setDesk({ dockOpen: true })
    return true
  } catch (err) {
    report(err)
    return false
  }
}

export async function learnSkills() {
  try {
    const data = await request('skills/learn', {})
    installNotesState(data)
    setDesk({ dockOpen: true })
  } catch (err) {
    report(err)
  }
}

export async function exportSkills() {
  try {
    const data = await request('skills/export', {})
    setDesk({ state: data.state })
    toast(t(plural(data.rules, '已导出 Skill：{name}（1 条规则）', '已导出 Skill：{name}（{n} 条规则）'), { name: data.name, n: data.rules }))
  } catch (err) {
    report(err)
  }
}

export function fetchInsights() {
  return request('insights')
}



/** Poll accepted Host data while the workbench is visible, including asynchronous global edits. */
export function watchDesk() {
  let stopped = false
  const poll = async () => {
    while (!stopped) {
      try {
        const data = await request('state')
        if (!stopped) { installNotesState(data); setDesk({ error: null }) }
      } catch (error) { if (!stopped) setDesk({ error: error.message }) }
      await new Promise(resolve => setTimeout(resolve, 1500))
    }
  }
  poll()
  return () => { stopped = true }
}

/** @returns {Promise<void>} Retained native or image save accepted without another generation request. */
export async function retryCreativeSave(kind, id) {
  installNotesState(await request(kind === 'media' ? 'media/retry' : 'native/retry', { id }))
}
