/** Persistent work/global associations for ordinary Sessions owned by DSH's SessionController. */
import { randomUUID } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { dshHome } from './store.js'
import { tr } from './i18n.js'

const PRESET = 'media-desk-creative'

function failure(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status })
}

async function wikiDirectory(path) {
  try {
    const directory = await realpath(resolve(path))
    if (!(await stat(directory)).isDirectory()) throw new Error('not a directory')
    return directory
  } catch (error) {
    throw failure('wiki/unavailable', tr('Wiki 目录不可用：{path}。请检查 WIKI_PATH', { path }), 503)
  }
}

/** Host-owned association service; disposing a view never disposes its Agents. */
export class NativeSessions {
  /**
   * @param {object} ctx - Host context providing the public native services.
   * @param {object} store - The Host's single content Store.
   * @param {object} settings - The Host's settings reader.
   * @param {object} [config] - Optional Wiki directory for this Host.
   */
  constructor(ctx, store, settings, config = {}) {
    this.ctx = ctx
    this.store = store
    this.settings = settings
    this.wikiPath = config.wikiPath ?? process.env.WIKI_PATH ?? join(homedir(), 'wiki')
    this.file = join(store.root, 'sessions.json')
    this.associations = []
    this.operations = new Map()
    this.resets = new Map()
  }

  /**
   * Load associations before the Host service becomes available to cold native entry.
   * @returns {Promise<void>}
   */
  async init() {
    this.home = await realpath(dshHome())
    await this.reload()
  }

  async reload() {
    let saved
    try { saved = JSON.parse(await readFile(this.file, 'utf8')) } catch (error) {
      if (error.code === 'ENOENT') return
      throw failure('association/unreadable', tr('会话关联文件无法读取：{path}', { path: this.file }), 503)
    }
    if (saved.version !== 1 || !Array.isArray(saved.associations) || saved.associations.some(row =>
      !row || typeof row.id !== 'string' || !['pending', 'bound'].includes(row.status)
      || !(row.workId === null || typeof row.workId === 'string')
      || typeof row.dshHome !== 'string' || typeof row.wikiRoot !== 'string'
      || typeof row.workspaceId !== 'string' || row.preset !== PRESET
      || (row.status === 'bound' && typeof row.sessionId !== 'string'))) {
      throw failure('association/invalid', tr('会话关联文件格式无效：{path}', { path: this.file }), 503)
    }
    this.associations = saved.associations
  }

  async save(associations = this.associations) {
    await writeFileAtomic(this.file, JSON.stringify({ version: 1, associations }), { mode: 0o600, dirMode: 0o700 })
    this.associations = associations
  }

  service(name) {
    const service = this.ctx.get(name)
    if (!service) throw failure('native/service-unavailable', tr('原生创作会话缺少服务：{name}。请使用完整的 DSH Web 组合', { name }), 503)
    return service
  }

  async preset() {
    let preset
    try { preset = await this.service('agentPresets').resolve(PRESET) } catch (error) {
      throw failure(error.code ?? 'native/preset-unavailable', tr('原生创作组合无法使用：{error}', { error: error.message }), 503)
    }
    if (preset.broken) throw failure('native/preset-unavailable', tr('原生创作组合无法使用：{error}', { error: preset.broken }), 503)
    return preset
  }

  /**
   * Inspect durable associations, including failed or interrupted creation.
   * @returns {Promise<object[]>} Detached association records; no inputs are dispatched.
   */
  list() {
    return this.store.run(() => withFileLock(this.file, async () => {
      await this.reload()
      return structuredClone(this.associations)
    }))
  }

  /**
   * Create or recover the object's ordinary Session without sending an input.
   * Pending creation is retained for inspection and never silently retried.
   * @param {string|null} [workId] - Work identity; null selects the separate global assistant.
   * @returns {Promise<object>} Durable actual Session, workspace, home, preset and native model association.
   */
  open(workId = null) {
    return this.resets.get(workId) ?? this.openBound(workId)
  }

  openBound(workId = null) {
    if (workId !== null && (typeof workId !== 'string' || !workId || workId.length > 200)) {
      return Promise.reject(failure('association/invalid-work', tr('作品标识无效'), 400))
    }
    const existing = this.operations.get(workId)
    if (existing) return existing
    const operation = this.store.run(() => withFileLock(this.file, async () => {
      await this.reload()
      const work = workId === null ? null : (await this.store.read()).items.find(row => row.id === workId)
      if (workId !== null && !work) {
        throw failure('association/work-not-found', tr('作品不存在：{id}', { id: workId }), 404)
      }
      const saved = this.associations.find(row => row.workId === workId && row.active !== false)
      if (saved) return this.restore(saved)
      if (work?.content && (work.content.status !== 'ready' || !this.store.notes.roots.has(work.content.notesRoot))) {
        throw failure(work.content.code ?? 'notes/unowned-root', work.content.error ?? tr('作品所在的 Notes 目录尚未取得写入所有权'))
      }
      if (work?.content && typeof work.content.wikiRoot !== 'string') throw failure('association/wiki-binding-missing', tr('作品尚未登记 Wiki 位置，请修复作品关联'))
      return this.create(workId, work?.title?.trim() || workId, work?.content?.wikiRoot ?? this.wikiPath, work?.content?.notesRoot)
    }))
    this.operations.set(workId, operation)
    operation.then(() => this.operations.delete(workId), () => this.operations.delete(workId))
    return operation
  }

  async create(workId, title, wikiPath, registeredNotesRoot) {
    const controller = this.service('sessionController')
    await this.preset()
    const wikiRoot = await wikiDirectory(wikiPath)
    const notesRoot = await realpath(join(wikiRoot, 'notes'))
    if (!this.store.notes.roots.has(notesRoot) || registeredNotesRoot && registeredNotesRoot !== notesRoot) {
      throw failure('association/notes-mismatch', tr('作品文件与 Wiki 位置不一致，请修复作品关联'))
    }
    const { workspace } = await this.service('workspaceController').create({ path: wikiRoot })
    const settings = await this.settings.read()
    const model = settings.assistant.provider && settings.assistant.model
      ? settings.assistant : this.service('agentDefaultModel').currentSelection()
    const pending = { id: randomUUID(), workId, status: 'pending', dshHome: this.home,
      wikiRoot, notesRoot, workspaceId: workspace.workspaceId, preset: PRESET,
      model: { ...model }, createdAt: new Date().toISOString() }
    this.associations.push(pending)
    await this.save()
    try {
      const created = await controller.create({ workspaceId: workspace.workspaceId, agentPreset: PRESET })
      pending.sessionId = created.sessionId
      pending.preset = created.agentPreset
      await this.save()
      const resolved = await controller.resolveAgent(created.sessionId)
      if (resolved.error) throw resolved.error
      const { selected } = await controller.selectModel({ sessionId: created.sessionId, ...model })
      await controller.rename({ sessionId: created.sessionId, title: title ?? tr('Media Desk · 全局助手') })
      if (!await this.service('sessions').flush(resolved.agent.session)) {
        throw failure('native/not-durable', tr('原生会话尚未持久保存，请检查 Session 存储服务'), 503)
      }
      const bound = { ...pending, model: { ...selected }, status: 'bound' }
      await this.save(this.associations.map(row => row.id === pending.id ? bound : row))
      return structuredClone(bound)
    } catch (error) {
      pending.status = 'pending'
      if (typeof error.details?.sessionId === 'string') pending.sessionId = error.details.sessionId
      pending.error = { code: error.code ?? 'native/create-failed', message: error.message }
      await this.save()
      throw failure(error.code ?? 'native/create-failed', error.message, error.status ?? 503)
    }
  }

  async restore(saved) {
    if (saved.dshHome !== this.home) throw failure('association/wrong-home', tr('此会话属于另一个 DSH home，请恢复原来的运行环境'))
    if (saved.status !== 'bound') throw failure('association/pending', tr('会话创建尚未完成，请检查保留的会话关联'))
    await wikiDirectory(saved.wikiRoot)
    await this.preset()
    const resolved = await this.service('sessionController').resolveAgent(saved.sessionId)
    if (resolved.error) throw failure(resolved.error.code, resolved.error.message, 503)
    this.requireAssociation(resolved.agent)
    saved.model = { ...resolved.agent.model.current() }
    await this.save()
    return structuredClone(saved)
  }

  /**
   * Resolve ownership from the actual executing Agent, including native control changes.
   * @param {object} agent - Ordinary live Agent carrying its native Session.
   * @returns {object} Current durable association.
   * @throws {Error} For unbound Sessions, foreign homes, roots, workspaces or presets.
   */
  requireAssociation(agent) {
    const row = this.associations.find(entry => entry.status === 'bound' && entry.active !== false && entry.sessionId === agent?.session?.id)
    if (!row || row.dshHome !== this.home) throw failure('association/unbound', tr('此原生会话尚未绑定 Media Desk 对象，请从工作台打开会话'))
    const workspace = this.service('workspaceRegistry').get(row.workspaceId)
    if (!workspace?.sessionIds.includes(row.sessionId) || workspace.path !== row.wikiRoot
      || agent.session.header.cwd !== row.wikiRoot
      || this.service('workingDirectory').get(agent.session) !== row.wikiRoot) {
      throw failure('association/workspace-changed', tr('会话工作区与作品关联不一致，请恢复原工作区后重试'))
    }
    if (this.service('agentPresets').composedPreset(agent.ctx) !== row.preset) {
      throw failure('association/preset-changed', tr('会话组合与作品关联不一致，请恢复原创作组合后重试'))
    }
    return row
  }

  /** Preserve the old Session and its inbox; future work receives a fresh durable association. */
  newConversation(workId = null) {
    const existing = this.resets.get(workId)
    if (existing) return existing
    const operation = (async () => {
      await this.operations.get(workId)
      await this.ctx.mediaDesk.producer.cancel(workId)
      await this.ctx.mediaDesk.nativeWork.cancel(workId, { all: true })
      await this.store.run(async () => {
        await this.reload()
        await this.save(this.associations.map(row => row.workId === workId && row.active !== false ? { ...row, active: false } : row))
      })
      return this.openBound(workId)
    })()
    this.resets.set(workId, operation)
    const complete = () => this.resets.delete(workId)
    operation.then(complete, complete)
    return operation
  }
}
