// 持久化：$DSH_HOME/media-desk/state.json。桌面端和 Web 端读同一份数据。
// Host 持有数据与 Notes 目录的协作写锁；正文每次读取都核对实际字节。
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises'
import { readFileSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { buildSeed, localizeSamples, migrateState, sampleText } from './seed.js'
import { NotesWrites } from './notes-writes.js'
import { applyStateChanges, reverseStateChanges } from './state-changes.js'
import { undoText } from './undo-text.js'
import { readUndoChanges, undoValue } from './notes-undo.js'
import { NotesMigration } from './notes-migration.js'
import { LANGUAGE_FIELDS } from './notes.js'
import { tr } from './i18n.js'

const MAX_UNDO = 30
const fingerprint = bytes => createHash('sha256').update(bytes).digest('hex')

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const keyed = list => list.every(row => isObject(row) && typeof row.id === 'string')

function revertList(before, after, current) {
  const was = new Map(before.map(row => [row.id, row]))
  const now = new Map(after.map(row => [row.id, row]))
  // 这一步新增的行撤掉，两边都有的行逐字段撤回，其余（之后才加的）原样保留
  const result = current
    .filter(row => !(now.has(row.id) && !was.has(row.id)))
    .map(row => (was.has(row.id) && now.has(row.id) ? revertChange(was.get(row.id), now.get(row.id), row) : row))
  // 这一步删掉的行放回原来的位置
  const present = new Set(result.map(row => row.id))
  before.forEach((row, index) => {
    if (now.has(row.id) || present.has(row.id)) return
    result.splice(Math.min(index, result.length), 0, structuredClone(row))
    present.add(row.id)
  })
  return result
}

/**
 * 三方合并式撤销：只撤回这一步改过、之后又没被别的操作改动的部分。
 * 撤销「切换风格」不会抹掉之后生成的成稿；撤销「对话改标题」不会把之后画好的图退回去。
 * @param {*} before - 这一步之前的值。
 * @param {*} after - 这一步之后的值。
 * @param {*} current - 现在的值。
 * @returns {*} 撤销后的值。
 */
export function revertChange(before, after, current) {
  if (same(before, after)) return current
  if (same(current, after)) return before === undefined ? undefined : structuredClone(before)
  if (isObject(before) && isObject(after) && isObject(current)) {
    const result = { ...current }
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const value = revertChange(before[key], after[key], current[key])
      if (value === undefined) delete result[key]
      else result[key] = value
    }
    return result
  }
  if (Array.isArray(before) && Array.isArray(after) && Array.isArray(current)) {
    if (keyed(before) && keyed(after) && keyed(current) && (before.length || after.length)) return revertList(before, after, current)
    if (before.length === after.length && after.length === current.length) return current.map((row, index) => revertChange(before[index], after[index], row))
  }
  // 之后又被改过且无法逐项合并时，保留现在的值
  return current
}

export function dshHome(env = process.env) {
  return env.DSH_HOME || join(homedir(), '.dsh')
}

export class Store {
  constructor(root = join(dshHome(), 'media-desk'), owner = null) {
    this.root = root
    this.file = join(root, 'state.json')
    this.filesDir = join(root, 'files')
    this.state = null
    this.diskHash = null
    this.mtimeMs = 0
    this.undo = []
    this.queue = Promise.resolve()
    this.owner = owner
  }

  async refresh() {
    await mkdir(this.filesDir, { recursive: true })
    let info = null
    try {
      info = await stat(this.file)
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
    if (!info) {
      this.state = buildSeed(new Date())
      if (this.notes) this.state.notesRoot = this.notes.root
      await this.persist()
      return
    }
    const bytes = await readFile(this.file, 'utf8')
    const hash = fingerprint(bytes)
    if (this.state && hash === this.diskHash) return
    this.state = migrateState(JSON.parse(bytes))
    this.diskHash = hash
    this.mtimeMs = info.mtimeMs
  }

  async persist(state = this.state, validate = null) {
    const temporary = this.file + '.' + randomUUID() + '.tmp'
    const bytes = JSON.stringify(state)
    let handle
    try {
      handle = await open(temporary, 'wx', 0o600)
      await handle.writeFile(bytes)
      await handle.close()
      handle = null
      for (let attempt = 0; ; attempt++) {
        try {
          if (this.diskHash !== null && fingerprint(readFileSync(this.file)) !== this.diskHash) {
            throw Object.assign(new Error(tr('已接受的数据在保存准备期间变化，请重新读取')), { code: 'notes/state-conflict', status: 409 })
          }
          validate?.()
          renameSync(temporary, this.file)
          this.state = state
          this.diskHash = fingerprint(bytes)
          this.mtimeMs = statSync(this.file).mtimeMs
          return
        } catch (error) {
          if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5) throw error
          await delay(20 * (attempt + 1))
        }
      }
    } finally {
      await handle?.close()
      try { await unlink(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }

  get writes() {
    if (!this.noteWrites) {
      this.noteWrites = new NotesWrites(this)
      this.notes.writes = this.noteWrites
    }
    return this.noteWrites
  }

  get undoEntries() { return this.notes ? this.state?.notesUndo ?? [] : this.undo }
  get undoId() { return this.undoEntries.at(-1)?.id ?? null }
  get canUndo() { return this.undoEntries.length > 0 }
  get migration() { return this.notesMigration ??= new NotesMigration(this) }

  async hydrated() {
    if (!this.notes) return structuredClone(this.state)
    await this.writes.recover()
    const next = structuredClone(this.state)
    const projected = await this.notes.hydrate(next)
    await this.notes.syncIndex(projected)
    await this.syncDerivedSkill?.(projected)
    if (!same(next, this.state)) {
      await this.persist(next)
      this.state = next
    }
    return projected
  }

  /** 串行执行，避免同一进程内的并发写互相覆盖。 */
  run(task) {
    if (this.owner) return this.owner.run(task)
    const next = this.queue.then(task, task)
    this.queue = next.catch(() => {})
    return next
  }

  read() {
    if (this.activeDraft) return Promise.resolve(structuredClone(this.activeDraft))
    return this.run(async () => {
      await this.refresh()
      return this.hydrated()
    })
  }

  updateVoice(text) {
    if (this.activeDraft) {
      this.activeDraft.voice = { ...(this.activeDraft.voice ?? {}), text }
      return Promise.resolve(this.activeDraft.voice)
    }
    return this.mutate(tr('更新个人语气'), draft => { draft.voice = { ...(draft.voice ?? {}), text }; return draft.voice }, { undoable: false })
  }

  /**
   * @param {string} label - 显示在撤销入口上的说明。
   * @param {(state: object) => any} mutate - 就地修改状态。
   * @param {{undoable?: boolean, expectedContent?: object, resultKey?: string, payloadHash?: string, validateAcceptance?: Function}} [options] - Optional content versions reject stale edits; a result identity returns its receipt on retry. A synchronous validator runs immediately before receipt replacement; its saved candidate requires revalidation after restart.
   * @returns {Promise<any>} mutate 的返回值。
   */
  mutate(label, mutate, { undoable = true, expectedContent = {}, resultKey, payloadHash, validateAcceptance } = {}) {
    return this.run(async () => {
      await this.refresh()
      const draft = await this.hydrated()
      if (resultKey !== undefined) {
        if (typeof resultKey !== 'string' || !resultKey || resultKey.length > 200 || !/^[a-f0-9]{64}$/.test(payloadHash)) {
          throw Object.assign(new Error(tr('保存身份无效，请重新提交编辑')), { code: 'notes/result-invalid', status: 400 })
        }
        const receipt = this.state.receipts?.find(row => row.resultKey === resultKey)
        if (receipt) {
          if (receipt.payloadHash !== payloadHash) throw Object.assign(new Error(tr('此保存身份已有不同结果，请核对原回执')), { code: 'notes/result-conflict', status: 409 })
          return { ...structuredClone(receipt.outcome), acceptance: structuredClone(receipt), state: draft }
        }
        const pending = this.notes && this.writes.records.find(row => row.resultKey === resultKey)
        if (pending) {
          if (pending.payloadHash !== payloadHash) throw Object.assign(new Error(tr('此保存身份已有不同结果，请核对原回执')), { code: 'notes/result-conflict', status: 409 })
          return this.resumeSaved(pending, validateAcceptance)
        }
      }
      this.notes?.assertExpected(draft, expectedContent)
      const previous = structuredClone(draft)
      const before = undoable && !this.notes ? JSON.stringify(draft) : null
      const parentDraft = this.activeDraft
      this.activeDraft = draft
      let result
      try { result = await mutate(draft) } finally { this.activeDraft = parentDraft }
      const acceptance = await this.commitEdit(previous, draft, { resultKey, payloadHash, label, result, validateAcceptance, undoable, expectedContent })
      if (undoable && !this.notes) {
        const after = JSON.stringify(draft)
        // 什么都没改的操作不占撤销位，免得用户点撤销却没反应
        if (after !== before) {
          this.undo.push({ label, before, after })
          if (this.undo.length > MAX_UNDO) this.undo.shift()
        }
      }
      return resultKey !== undefined ? { ...result, acceptance } : result
    })
  }

  undoLast(id) {
    return this.run(async () => {
      await this.refresh()
      const previous = await this.hydrated()
      if (this.notes) {
        if (id !== undefined && (typeof id !== 'string' || !id)) throw Object.assign(new Error(tr('撤销身份无效，请重新读取撤销记录')), { code: 'notes/undo-invalid', status: 400 })
        const undoId = id ?? this.undoId
        const accepted = this.state.receipts?.find(receipt => receipt.undoOf === undoId)
        if (accepted) return accepted.outcome.label
        const entry = id === undefined ? this.undoEntries.at(-1) : this.undoEntries.find(entry => entry.id === id)
        if (!entry) {
          if (id !== undefined) throw Object.assign(new Error(tr('此编辑的撤销记录不可用，请核对当前作品')), { code: 'notes/undo-not-found', status: 404 })
          return null
        }
        const resultKey = 'undo:' + entry.id + ':' + fingerprint(JSON.stringify(this.notes.durable(previous)))
        const pending = this.writes.records.find(record => record.resultKey === resultKey)
        if (pending) { await this.resumeSaved(pending); return entry.label }
        const languages = { ...entry.languages, ...Object.fromEntries(entry.files.map(file => [file.workId, file.primary.language])) }
        const durable = this.notes.durable(previous)
        const changes = (await readUndoChanges(entry, this.filesDir)).map(change => {
          const id = change.path[0] === 'items' && change.path[1]?.id
          const language = languages[id]
          const current = previous.items.find(item => item.id === id)
          if (language && current?.content && current.content.language !== language && LANGUAGE_FIELDS.includes(change.path[2])) {
            return { ...change, path: [...change.path.slice(0, 2), 'otherLang', language, ...change.path.slice(2)] }
          }
          return change
        })
        for (const change of changes) {
          if (change.path[0] !== 'items' || !['body', 'text', 'article'].includes(change.path.at(-1))) continue
          let current = previous
          for (const part of change.path) current = typeof part === 'string' ? current?.[part] : current?.find(row => row.id === part.id)
          if (typeof current !== 'string' || typeof change.before.value !== 'string' || typeof change.after.value !== 'string') continue
          change.before.value = undoText(change.before.value, change.after.value, current)
          change.after.value = current
        }
        let draft = await this.notes.hydrate(reverseStateChanges(durable, changes, undoValue))
        const migrated = changes.filter(change => change.path[0] === 'items' && change.path.length > 2 && entry.languages?.[change.path[1]?.id]
          && previous.items.find(item => item.id === change.path[1].id)?.content)
        draft = reverseStateChanges(draft, migrated, undoValue)
        const files = []
        for (const [id, language] of Object.entries(entry.languages ?? {})) {
          const target = draft.items.find(item => item.id === id)
          if (!target?.content || target.content.language === language) continue
          const variant = target.otherLang[language]
          files.push(...await this.notes.prepareLanguage(previous, draft, id, language, { metadata: variant.noteMetadata, body: variant.body }))
        }
        for (const file of entry.files) {
          const work = previous.items.find(item => item.id === file.workId)
          const target = draft.items.find(item => item.id === file.workId)
          if (!work || !target) continue
          const current = await this.notes.readLanguage(work, file.primary.language, previous.notesRevisions)
          if (current.content.status !== 'ready') throw Object.assign(new Error(current.content.error), { code: current.content.code, status: 409 })
          if (current.content.notesRoot !== file.primary.notesRoot || current.content.relativePath !== file.primary.relativePath) {
            throw Object.assign(new Error(tr('编辑所属语言或文件关联已变化，请恢复关联后撤销')), { code: 'notes/undo-conflict', status: 409 })
          }
          const before = await this.notes.readSnapshot(file.before, file.workId, file.primary.language)
          const after = await this.notes.readSnapshot(file.after, file.workId, file.primary.language)
          const inverse = { metadata: revertChange(before.metadata, after.metadata, current.noteMetadata), body: undoText(before.body, after.body, current.body) }
          if (target.content.language === file.primary.language) {
            this.notes.project(target, inverse.metadata, inverse.body)
            await this.notes.projectHistory(target)
          } else files.push(...await this.notes.prepareLanguage(previous, draft, file.workId, file.primary.language, inverse))
        }
        files.push(...await this.notes.prepare(previous, draft))
        await this.commitFiles(previous, draft, files, { label: entry.label, result: { label: entry.label }, resultKey, payloadHash: fingerprint(entry.id), undoOf: entry.id })
        return entry.label
      }
      const entry = this.undo.at(-1)
      if (!entry) return null
      const before = JSON.parse(entry.before)
      const after = JSON.parse(entry.after)
      const draft = revertChange(before, after, previous)
      await this.commitEdit(previous, draft, { label: entry.label, result: null })
      this.undo.pop()
      return entry.label
    })
  }

  async commitEdit(previous, draft, { resultKey, payloadHash, label, result, validateAcceptance, undoable = false, undoOf, expectedContent }) {
    if (!this.notes) { await this.persist(draft, validateAcceptance); return null }
    const files = await this.notes.prepare(previous, draft)
    return this.commitFiles(previous, draft, files, { resultKey, payloadHash, label, result, validateAcceptance, undoable, undoOf, expectedContent })
  }

  async commitFiles(previous, draft, files, { resultKey, payloadHash, label, result, validateAcceptance, undoable = false, undoOf, expectedContent }) {
    const { state, ...outcome } = result === draft ? {} : result && typeof result === 'object' && !Array.isArray(result) ? result : { value: result }
    const record = await this.writes.prepare(previous, draft, files, { resultKey, payloadHash, label, outcome, requiresValidation: Boolean(validateAcceptance), undoable, undoOf, expectedContent })
    try {
      await this.writes.publish(record)
      const receipt = await this.acceptSaved(record, validateAcceptance)
      await this.notes.syncIndex(draft)
      await this.syncDerivedSkill?.(draft)
      return receipt
    } catch (error) {
      try { await this.writes.restoreAccepted(record, error) } catch (restoreError) { error.cause = restoreError }
      throw Object.assign(error, { pendingId: record.id })
    }
  }

  /** Migrate populated work/language text after a verified backup; repeat requests reuse its receipt. */
  migrateNotes(associations = [], legacyVoice = '') {
    return this.run(async () => {
      await this.refresh()
      const previous = await this.hydrated()
      const needsContent = (previous.styles ?? []).some(row => !row.preset && !row.sample && !row.content)
        || (previous.skills ?? []).some(row => !row.sample && !row.content)
        || (previous.items ?? []).some(row => row.imported && !row.materialContent)
        || Boolean(legacyVoice && !previous.voice?.content)
      if (this.state.notesMigration && this.state.contentMigration && !needsContent) {
        const acceptance = this.state.receipts?.find(row => row.resultKey === 'migrate:' + this.state.contentMigration.id)
        if (acceptance) return { migration: structuredClone(this.state.notesMigration), acceptance: structuredClone(acceptance), state: previous }
      }
      const backup = await this.migration.backup()
      const resultKey = 'migrate:' + backup.id
      const pending = this.writes.records.find(row => row.resultKey === resultKey)
      if (pending) return { ...await this.resumeSaved(pending), migration: this.state.notesMigration }
      const draft = structuredClone(previous)
      if (legacyVoice && !draft.voice?.content) draft.voice = { text: legacyVoice }
      const plan = this.notes.migrationPlan(draft, associations, backup.original)
      await this.notes.preflightMigration(plan)
      const files = await this.notes.prepareMigration(draft, plan)
      files.push(...await this.notes.prepareManaged(previous, draft))
      for (const item of draft.items) if (item.sample && plan.some(entry => entry.workId === item.id) && sampleText(item.id, 'zh')) item.localeLinked = true
      draft.version = 2
      draft.notesMigration ??= { id: backup.id, completedAt: new Date().toISOString(), workIds: [...new Set(plan.map(entry => entry.workId))] }
      draft.contentMigration = { id: backup.id, completedAt: new Date().toISOString(), styleIds: draft.styles.filter(row => row.content && !row.preset && !row.sample).map(row => row.id),
        ruleIds: draft.skills.filter(row => row.content && !row.sample).map(row => row.id), materialIds: draft.items.filter(row => row.materialContent).map(row => row.id), voice: Boolean(draft.voice?.content) }
      const acceptance = await this.commitFiles(previous, draft, files, { resultKey, payloadHash: backup.sourceHash, label: tr('迁移作品到 Notes'), result: { migration: draft.notesMigration } })
      return { migration: draft.notesMigration, acceptance, state: await this.hydrated() }
    })
  }

  /** Adopt a selected existing file and migrate its remaining legacy languages in the same save. */
  registerNotes({ id, language, relativePath }, associations = []) {
    return this.run(async () => {
      await this.refresh()
      const previous = await this.hydrated()
      const draft = structuredClone(previous)
      const item = draft.items.find(item => item.id === id)
      if (!item) throw Object.assign(new Error(tr('作品不存在：{id}', { id })), { status: 404 })
      if (item.content) throw Object.assign(new Error(tr('作品已经登记 Notes 文件，请使用重新关联入口')), { code: 'notes/already-registered', status: 409 })
      const saved = associations.find(row => row.workId === id)
      const notesRoot = saved?.notesRoot ?? this.notes.root
      const wikiRoot = saved?.wikiRoot ?? this.notes.wikiRoot
      const hasLanguages = Object.keys(item.otherLang ?? {}).length > 0
      let backup
      if (hasLanguages) {
        const planned = structuredClone(draft)
        const selected = planned.items.find(row => row.id === id)
        selected.content = { wikiRoot, notesRoot, relativePath, language }
        delete selected.otherLang[language]
        await this.notes.preflightMigration(this.notes.migrationPlan(planned, associations, planned, [id]))
        backup = await this.migration.backup()
      }
      await this.notes.register(item, language, relativePath, notesRoot, wikiRoot)
      const files = await this.notes.prepare(previous, draft)
      if (hasLanguages) {
        const plan = this.notes.migrationPlan(draft, associations, draft, [id])
        await this.notes.preflightMigration(plan)
        files.push(...await this.notes.prepareMigration(draft, plan))
        draft.notesRegistrationMigrations = [...(draft.notesRegistrationMigrations ?? []), backup.id]
        draft.version = 2
      }
      const acceptance = await this.commitFiles(previous, draft, files, { label: tr('登记作品文件'), result: { registeredId: id } })
      return { acceptance, state: await this.hydrated() }
    })
  }

  /** Preserve legacy sample languages before a request-local locale switch changes their text. */
  localizeNotes(language, associations = []) {
    return this.run(async () => {
      await this.refresh()
      const previous = await this.hydrated()
      const draft = structuredClone(previous)
      const legacy = draft.items.filter(item => item.sample && !item.content && sampleText(item.id, language))
      const managed = draft.items.filter(item => item.sample && item.content && item.localeLinked && sampleText(item.id, language))
      const missing = managed.filter(item => item.content.language !== language && !item.otherLang?.[language]?.content)
      const backup = legacy.length || missing.length ? await this.migration.backup() : null
      const plan = legacy.length ? this.notes.migrationPlan(draft, associations, backup.original, legacy.map(item => item.id)) : []
      for (const item of missing) {
        item.otherLang ??= {}
        item.otherLang[language] = sampleText(item.id, language)
        plan.push(...this.notes.migrationPlan(draft, associations, draft, [item.id]))
      }
      for (const item of [...legacy, ...missing]) {
        if (!plan.some(entry => entry.workId === item.id && entry.language === language)) {
          const current = plan.find(entry => entry.workId === item.id && entry.current)
          plan.push({ ...current, language, current: false, registered: false,
            reference: { ...current.reference, relativePath: `works/${encodeURIComponent(item.id)}-${language}.md`, language },
            source: { id: item.id, createdAt: item.createdAt, ...sampleText(item.id, language) }, languageBasis: { kind: 'sample', language, source: 'packaged' } })
        }
        for (const entry of plan.filter(entry => entry.workId === item.id)) entry.current = entry.language === language
      }
      await this.notes.preflightMigration(plan)
      const files = await this.notes.prepareMigration(draft, plan)
      for (const item of draft.items) if (plan.some(entry => entry.workId === item.id)) item.localeLinked = true
      for (const item of managed) if (!missing.includes(item)) await this.notes.switchLanguage(draft.items.find(row => row.id === item.id), language)
      if (backup) {
        draft.version = 2
        draft.notesLocaleMigrations = [...(draft.notesLocaleMigrations ?? []), backup.id]
      }
      localizeSamples(draft, language)
      for (const item of draft.items) {
        const before = previous.items.find(row => row.id === item.id)?.content
        if (!before || item.content?.relativePath === before.relativePath || files.some(file => file.after === item.content)) continue
        item.content.revision = Math.max(draft.notesRevisions[item.id] ?? 0, before.revision) + 1
        draft.notesRevisions[item.id] = item.content.revision
      }
      await this.commitFiles(previous, draft, files, { label: tr('切换示例语言'), result: null })
      return this.hydrated()
    })
  }

  async acceptSaved(record, validateAcceptance) {
    const existing = this.state.receipts?.find(row => row.id === record.id)
    if (existing) return existing
    if (record.requiresValidation && !validateAcceptance) throw Object.assign(new Error(tr('此候选需要重新核验所属任务，请从任务入口继续')), { code: 'notes/validation-required', status: 409, pendingId: record.id })
    const next = applyStateChanges(this.state, record.changes)
    next.receipts = [...(next.receipts ?? []), record.receipt]
    if (record.undoOf) {
      if (!next.notesUndo?.some(entry => entry.id === record.undoOf)) throw Object.assign(new Error(tr('此编辑的撤销记录不可用，请核对当前作品')), { code: 'notes/undo-conflict', status: 409 })
      next.notesUndo = next.notesUndo.filter(entry => entry.id !== record.undoOf)
    }
    if (record.undoEntry && !next.notesUndo?.some(entry => entry.id === record.undoEntry.id)) next.notesUndo = [...(next.notesUndo ?? []), record.undoEntry].slice(-MAX_UNDO)
    await this.persist(next, () => {
      this.writes.validateSync(record)
      const validation = validateAcceptance?.()
      if (validation && typeof validation.then === 'function') {
        Promise.resolve(validation).catch(() => {})
        throw Object.assign(new Error(tr('保存校验必须同步完成，请恢复任务校验后重试')), { code: 'notes/validation-invalid', status: 409 })
      }
      if (validation === false) throw Object.assign(new Error(tr('此候选已不适用，请核对当前任务与作品')), { code: 'notes/validation-conflict', status: 409 })
    })
    record.status = 'accepted'
    return structuredClone(record.receipt)
  }

  async resumeSaved(record, validateAcceptance) {
    const existing = this.state.receipts?.find(row => row.id === record.id)
    if (!existing) {
      if (record.status === 'rejected') throw Object.assign(new Error(tr('此候选已退回，请提交新编辑来采用其内容')), { code: 'notes/save-conflict', status: 409, pendingId: record.id })
      if (record.requiresValidation && !validateAcceptance) throw Object.assign(new Error(tr('此候选需要重新核验所属任务，请从任务入口继续')), { code: 'notes/validation-required', status: 409, pendingId: record.id })
      try {
        await this.writes.publish(record)
        await this.acceptSaved(record, validateAcceptance)
      } catch (error) {
        try { await this.writes.restoreAccepted(record, error) } catch (restoreError) { error.cause = restoreError }
        throw Object.assign(error, { pendingId: record.id })
      }
    }
    return { ...structuredClone(record.receipt.outcome), acceptance: structuredClone(record.receipt), state: await this.hydrated() }
  }

  /**
   * Retry a retained save without invoking its mutation or any external generation again.
   * @param {string} id - Durable candidate/save identity returned by the failed request.
   * @param {object} [options] - A synchronous task validator is required for task-owned candidates.
   * @returns {Promise<object>} Original durable receipt and current hydrated state.
   */
  retrySave(id, { validateAcceptance } = {}) {
    return this.run(async () => {
      await this.refresh()
      await this.writes.recover()
      const record = this.writes.records.find(row => row.id === id)
      if (!record) throw Object.assign(new Error(tr('保留的候选不存在，请刷新保存记录')), { code: 'notes/save-not-found', status: 404 })
      return this.resumeSaved(record, validateAcceptance)
    })
  }

  /** @returns {Promise<object[]>} Pending saves and accepted receipts; no external requests are replayed. */
  saves() {
    return this.run(async () => { await this.refresh(); await this.writes.recover(); return this.writes.list() })
  }

  /**
   * Inspect observed conflict bytes; unrelated paths cannot expose arbitrary Notes files.
   * @param {object} request - Save/work identity, observed path and exact hash.
   * @returns {Promise<object>} Current body and retained bytes, including invalid Markdown for review.
   */
  savedVersion({ id, workId, relativePath, sha256 }) {
    return this.run(async () => {
      await this.refresh()
      await this.writes.recover()
      const record = this.writes.records.find(record => record.id === id)
      const conflict = record?.observedConflicts.find(conflict => conflict.workId === workId && conflict.reference.relativePath === relativePath && conflict.observedSha256 === sha256)
      if (!conflict) throw Object.assign(new Error(tr('所选保留版本不属于此冲突，请刷新后重选')), { code: 'notes/resolution-conflict', status: 409 })
      const bytes = await this.notes.readBytes(conflict.reference)
      if (fingerprint(bytes) !== sha256) throw Object.assign(new Error(tr('保留的外部版本已变化，请重新读取后选择')), { code: 'notes/resolution-conflict', status: 409 })
      const state = await this.hydrated()
      const current = await this.notes.readLanguage(state.items.find(item => item.id === workId), conflict.language, state.notesRevisions)
      if (current.body === undefined) throw Object.assign(new Error(current.content.error), { code: current.content.code, status: 409 })
      let parsed
      try { parsed = this.notes.parse(bytes, { language: conflict.language }, workId) } catch (error) {
        return { current: { body: current.body, title: current.title }, text: bytes.toString('utf8'), valid: false, error: error.message }
      }
      return { current: { body: current.body, title: current.title }, text: bytes.toString('utf8'), body: parsed.body, valid: true }
    })
  }

  /**
   * Resolve one observed external version, retaining a fixed copy and its live inode.
   * @param {object} request - Save/work identity, retained path and observed hash, with current or external selection.
   * @returns {Promise<object>} New accepted edit and current state; changed or unrelated evidence is rejected.
   */
  resolveSave({ id, workId, relativePath, sha256, choice }) {
    return this.run(async () => {
      if (!['current', 'external'].includes(choice) || !/^[a-f0-9]{64}$/.test(sha256)) throw Object.assign(new Error(tr('请选择当前正文或保留的外部版本')), { code: 'notes/resolution-invalid', status: 400 })
      await this.refresh()
      await this.writes.recover()
      const record = this.writes.records.find(row => row.id === id)
      if (!record) throw Object.assign(new Error(tr('保留的候选不存在，请刷新保存记录')), { code: 'notes/save-not-found', status: 404 })
      const resultKey = 'resolve:' + id + ':' + fingerprint(JSON.stringify({ workId, relativePath, sha256, choice }))
      const existing = this.state.receipts?.find(receipt => receipt.resultKey === resultKey)
      if (existing) return { acceptance: existing, state: await this.hydrated() }
      const conflict = record.observedConflicts.find(conflict => conflict.workId === workId && conflict.reference.relativePath === relativePath)
      const prior = record.resolutions?.[relativePath]
      const file = record.files.find(file => file.workId === workId && file.language === (conflict?.language ?? prior?.language))
      if (!file || !conflict && (!prior || prior.sha256 !== sha256 || prior.choice !== choice)) {
        throw Object.assign(new Error(tr('所选保留版本不属于此冲突，请刷新后重选')), { code: 'notes/resolution-conflict', status: 409 })
      }
      const reference = conflict?.reference ?? prior.liveReference
      const bytes = await this.notes.readBytes(reference)
      if (fingerprint(bytes) !== sha256) throw Object.assign(new Error(tr('保留的外部版本已变化，请重新读取后选择')), { code: 'notes/resolution-conflict', status: 409 })
      const external = choice === 'external' ? this.notes.parse(bytes, { language: file.language }, workId) : null
      const state = await this.hydrated()
      const current = await this.notes.readLanguage(state.items.find(item => item.id === workId), file.language, state.notesRevisions)
      await this.notes.readWork(current.content, workId)
      const snapshot = prior?.snapshot ?? await this.notes.saveSnapshot(reference, workId, bytes)
      record.resolutions ??= {}
      for (const alias of conflict?.aliases ?? [reference]) record.resolutions[alias.relativePath] = { sha256, choice, language: file.language, snapshot, liveReference: alias }
      if (!this.state.receipts?.some(receipt => receipt.id === record.id)) record.status = 'rejected'
      await this.writes.save(record)
      const previous = await this.hydrated()
      const draft = structuredClone(previous)
      const item = draft.items.find(item => item.id === workId)
      if (item.content.status !== 'ready') throw Object.assign(new Error(item.content.error), { code: item.content.code, status: 409 })
      const files = await this.notes.prepareLanguage(previous, draft, workId, file.language, external)
      const result = { state: draft }
      const acceptance = await this.commitFiles(previous, draft, files, { resultKey, payloadHash: fingerprint(JSON.stringify({ workId, relativePath, sha256, choice })), label: tr('选择保留的正文版本'), result, expectedContent: { [workId]: item.content } })
      return { acceptance, state: await this.hydrated() }
    })
  }
}
