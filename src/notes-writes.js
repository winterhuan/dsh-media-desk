/** Recoverable Notes publication preserves candidates and every displaced editor inode for managed content. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, link, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { stateChanges } from './state-changes.js'
import { notesUndoEntry } from './notes-undo.js'
import { notesSaveMessage } from './notes.js'
import { tr } from './i18n.js'
import { historyDirectory } from './notes-paths.js'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const failure = (code, message) => Object.assign(new Error(message), { code, status: 409 })

/** Persisted save proposals and publication records, owned by the Host's Store queue. */
export class NotesWrites {
  constructor(store) {
    this.store = store
    this.root = join(store.root, 'notes-writes')
    this.records = []
  }

  path(record, name) { return join(this.root, record.id, name) }

  async load() {
    let names
    try { names = await readdir(this.root) } catch (error) {
      if (error.code === 'ENOENT') { this.records = []; return }
      throw error
    }
    const records = []
    for (const id of names.sort()) {
      if (!/^[a-f0-9-]{36}$/.test(id)) continue
      let bytes
      try { bytes = await readFile(join(this.root, id, 'pending.json'), 'utf8') } catch (error) {
        if (error.code !== 'ENOENT') throw error
        try { bytes = await readFile(join(this.root, id, 'proposal.json'), 'utf8') } catch (error) {
          if (error.code === 'ENOENT' && !(await readdir(join(this.root, id))).length) continue
          throw error
        }
      }
      const record = JSON.parse(bytes)
      if (record.version !== 1 || record.id !== id || !Array.isArray(record.files) || !Array.isArray(record.changes)
        || record.receipt?.id !== id || typeof record.resultKey !== 'string' || !/^[a-f0-9]{64}$/.test(record.payloadHash)) {
        throw failure('notes/save-invalid', tr('Notes 保存记录无效，请修复保留的记录文件'))
      }
      records.push(record)
    }
    this.records = records
  }

  async save(record) {
    await writeFileAtomic(this.path(record, 'pending.json'), JSON.stringify(record), { mode: 0o600, dirMode: 0o700 })
    await rm(this.path(record, 'proposal.json'), { force: true })
  }

  async bytes(reference) {
    try { return await this.store.notes.readBytes(reference) } catch (error) { if (error.code === 'notes/missing') return null; throw error }
  }

  /** Navigation uses the same retained inodes and exclusive publication as creative content, without a business receipt. */
  async syncIndex(reference, beforeBytes, bytes, indexKey) {
    const before = beforeBytes ? { ...reference, sha256: hash(beforeBytes) } : null
    const after = { ...reference, sha256: hash(bytes) }
    const state = { items: [] }
    const record = await this.prepare(state, structuredClone(state), [{ kind: 'index', subjectId: `index:${indexKey}`, before, after, beforeBytes, bytes }], { label: 'Notes index', outcome: {} })
    try {
      await this.publish(record)
      this.validateSync(record)
      record.status = 'accepted'
      await this.save(record)
      this.validateSync(record)
    } catch (error) {
      await this.restoreAccepted(record, error)
      throw Object.assign(error, { pendingId: record.id })
    }
  }

  /** A changed unaccepted publication remains a candidate even when an editor changes its bytes. */
  async isPublication(entry) {
    try {
      const [primary, publication] = await Promise.all([lstat(join(entry.after.notesRoot, entry.after.relativePath)), lstat(join(entry.publication.notesRoot, entry.publication.relativePath))])
      return primary.dev === publication.dev && primary.ino === publication.ino
    } catch (error) { if (error.code === 'ENOENT') return false; throw error }
  }

  /**
   * Save independent file inodes before the pending record authorizes primary displacement.
   * @param {object} before - Hydrated accepted state.
   * @param {object} draft - Hydrated proposed state; its references gain fixed snapshots.
   * @param {object[]} files - Proposed work, material or preference changes with accepted preimage bytes.
   * @param {object} options - Save identity, label, caller outcome and recovery eligibility.
   * @returns {Promise<object>} Complete immutable proposal with a durable pending record.
   */
  async prepare(before, draft, files, { resultKey = randomUUID(), payloadHash, label, outcome, requiresValidation = false, undoable = false, undoOf, expectedContent = {} }) {
    const id = randomUUID()
    const entries = files.map(file => {
      const subjectId = file.subjectId ?? file.workId
      const kind = file.kind ?? 'work'
      const language = file.after.language ?? 'und'
      const location = `${historyDirectory(subjectId)}/${id}-${kind}-${language}`
      const reference = suffix => ({ wikiRoot: file.after.wikiRoot, notesRoot: file.after.notesRoot,
        relativePath: `${location}-${suffix}.md`, ...(kind === 'work' ? { language } : { kind, id: subjectId }),
        ...(['candidate', 'before'].includes(suffix) ? { role: 'work-snapshot' } : {}),
        sha256: suffix === 'displaced' || suffix === 'before' ? file.before?.sha256 : file.after.sha256 })
      const candidate = reference('candidate')
      file.after.snapshot = candidate
      return { subjectId, kind, ...(kind === 'work' ? { workId: subjectId, language } : {}), before: file.before, after: structuredClone(file.after), candidate,
        publication: reference('publication'), ...(file.before ? { displaced: reference('displaced'), displacements: [], beforeSnapshot: file.before.snapshot ?? reference('before') } : {}), phase: 'prepared' }
    })
    const after = this.store.notes.durable(draft)
    const changes = stateChanges(this.store.notes.durable(before), after)
    const subjects = new Set([...changes.filter(change => change.path[0] === 'items').map(change => change.path[1]?.id), ...Object.keys(expectedContent)])
    const references = new Map()
    for (const state of [before, draft]) for (const item of state.items) if (subjects.has(item.id) && item.content) {
      const selected = draft.items.find(row => row.id === item.id)?.content
      // Relinking validates the selected replacement; a missing old path stays missing.
      if (state === before && selected && (selected.notesRoot !== item.content.notesRoot || selected.relativePath !== item.content.relativePath)) continue
      references.set(join(item.content.notesRoot, item.content.relativePath), structuredClone(item.content))
    }
    payloadHash ??= hash(JSON.stringify(changes))
    const receipt = { id, resultKey, payloadHash, acceptedAt: new Date().toISOString(),
      contentVersions: [...entries.filter(entry => entry.kind === 'work').map(entry => ({ workId: entry.workId, ...entry.after })),
        ...draft.items.filter(item => item.content && !entries.some(entry => entry.workId === item.id && entry.language === item.content.language)
          && JSON.stringify(item.content) !== JSON.stringify(before.items.find(row => row.id === item.id)?.content)).map(item => ({ workId: item.id, ...item.content }))],
      resources: entries.filter(entry => entry.kind !== 'work').map(entry => ({ subjectId: entry.subjectId, kind: entry.kind, ...entry.after })), outcome }
    const record = { version: 1, id, resultKey, payloadHash, label, createdAt: receipt.acceptedAt,
      status: 'candidate', files: entries, changes, references: [...references.values()], receipt, requiresValidation }
    if (undoable) record.undoEntry = await notesUndoEntry(record, this.store.filesDir, before)
    if (undoOf) { record.undoOf = undoOf; receipt.undoOf = undoOf }
    await mkdir(join(this.root, id), { recursive: true, mode: 0o700 })
    await this.save(record)
    this.records.push(record)
    try {
      for (let index = 0; index < files.length; index++) {
        const file = files[index]
        const entry = entries[index]
        await this.store.notes.createDirectory(entry.after.notesRoot, historyDirectory(entry.subjectId))
        await writeFile(join(entry.candidate.notesRoot, entry.candidate.relativePath), file.bytes, { flag: 'wx', mode: 0o600 })
        if (entry.beforeSnapshot && !file.before.snapshot) {
          await writeFile(join(entry.beforeSnapshot.notesRoot, entry.beforeSnapshot.relativePath), file.beforeBytes, { flag: 'wx', mode: 0o600 })
        }
        await copyFile(join(entry.candidate.notesRoot, entry.candidate.relativePath), join(entry.publication.notesRoot, entry.publication.relativePath), constants.COPYFILE_EXCL)
      }
      record.status = 'pending'
      await this.save(record)
      return record
    } catch (error) { throw Object.assign(error, { pendingId: id }) }
  }

  async restore(entry) {
    const captured = entry.phase === 'restoring' && entry.rejectedPrimary && await this.bytes(entry.rejectedPrimary)
    const references = captured && hash(captured) !== entry.candidate.sha256 ? [entry.rejectedPrimary]
      : entry.kind === 'index' ? [entry.displaced, entry.restoration] : [entry.restoration, entry.displaced]
    for (const reference of references) {
      if (!reference || !await this.bytes(reference)) continue
      try { await link(join(reference.notesRoot, reference.relativePath), join(entry.after.notesRoot, entry.after.relativePath)) } catch (error) {
        if (error.code !== 'EEXIST') throw error
      }
      return
    }
  }

  /** Restore failed publication exclusively, retaining editor writes and original absence. */
  async restoreAccepted(record, error) {
    if (this.store.state.receipts?.some(receipt => receipt.id === record.id)) {
      record.status = 'accepted'
      return
    }
    record.status = error.code?.includes('conflict') ? 'conflict' : 'failed'
    record.error = { code: error.code ?? 'notes/save-failed', message: error.message }
    await this.save(record)
    for (const entry of record.files) {
      const primary = await this.bytes(entry.after)
      if (!primary) { await this.restore(entry); continue }
      if (hash(primary) !== entry.candidate.sha256) continue
      entry.rejectedPrimaries ??= []
      if (entry.rejectedPrimary) entry.rejectedPrimaries.push(entry.rejectedPrimary)
      entry.rejectedPrimary = { ...entry.publication, relativePath: entry.publication.relativePath.replace(/[^/]+$/, `${randomUUID()}-unaccepted.md`) }
      if (entry.beforeSnapshot) {
        entry.restoration = { ...entry.beforeSnapshot, role: 'restoration', relativePath: entry.beforeSnapshot.relativePath.replace(/[^/]+$/, `${randomUUID()}-restoration.md`) }
        const preimage = entry.kind === 'index' && await this.bytes(entry.displaced) ? entry.displaced : entry.beforeSnapshot
        await copyFile(join(preimage.notesRoot, preimage.relativePath), join(entry.restoration.notesRoot, entry.restoration.relativePath), constants.COPYFILE_EXCL)
      }
      entry.phase = 'restoring'
      await this.save(record)
      await rename(join(entry.after.notesRoot, entry.after.relativePath), join(entry.rejectedPrimary.notesRoot, entry.rejectedPrimary.relativePath))
      await this.restore(entry)
      entry.phase = 'restored'
      await this.save(record)
    }
  }

  /** Publish exclusively; an editor-created primary or a changed displaced inode remains intact. */
  async publish(record) {
    try {
      if (record.status === 'candidate') { record.status = 'pending'; await this.save(record) }
      for (const entry of record.files) {
        const candidate = await this.bytes(entry.candidate)
        if (!candidate || hash(candidate) !== entry.candidate.sha256) throw failure('notes/candidate-invalid', tr('保留的候选缺失或已变化，请修复候选文件'))
        if (entry.phase === 'restored') {
          entry.publication = { ...entry.publication, relativePath: entry.publication.relativePath.replace(/[^/]+$/, `${randomUUID()}-publication.md`) }
          entry.phase = 'prepared'
          await this.save(record)
        }
        let publication = await this.bytes(entry.publication)
        if (!publication) {
          await copyFile(join(entry.candidate.notesRoot, entry.candidate.relativePath), join(entry.publication.notesRoot, entry.publication.relativePath), constants.COPYFILE_EXCL)
          publication = await this.bytes(entry.publication)
        }
        if (hash(publication) !== entry.candidate.sha256) throw failure('notes/publication-conflict', tr('外部编辑器修改了保留的发布文件，请先核对版本'))
        const primary = await this.bytes(entry.after)
        let displaced = entry.displaced && await this.bytes(entry.displaced)
        if (primary && hash(primary) === entry.candidate.sha256 && (!entry.before || displaced)) {
          entry.phase = 'published'
          continue
        }
        if (primary && displaced) {
          entry.displacements ??= []
          if (!entry.displacements.some(reference => reference.relativePath === entry.displaced.relativePath)) entry.displacements.push(entry.displaced)
          entry.displaced = { ...entry.displaced, relativePath: entry.displaced.relativePath.replace(/[^/]+$/, `${randomUUID()}-displaced.md`) }
          await this.save(record)
          displaced = null
        }
        if (entry.before && !displaced) {
          if (!primary) throw failure('notes/missing', tr('已接受作品文件缺失，请重新关联后重试'))
          await this.store.notes.readPrimary(entry.before, entry.subjectId, entry.kind)
          await rename(join(entry.before.notesRoot, entry.before.relativePath), join(entry.displaced.notesRoot, entry.displaced.relativePath))
          entry.phase = 'displaced'
          entry.displacements ??= []
          entry.displacements.push(entry.displaced)
          await this.save(record)
          displaced = await this.bytes(entry.displaced)
        }
        if (entry.before && (!displaced || hash(displaced) !== entry.before.sha256)) {
          await this.restore(entry)
          throw failure('notes/publication-conflict', tr('捕获的外部版本与已接受作品不同，双方版本已保留'))
        }
        await this.store.notes.createDirectory(entry.after.notesRoot, dirname(entry.after.relativePath))
        try { await link(join(entry.publication.notesRoot, entry.publication.relativePath), join(entry.after.notesRoot, entry.after.relativePath)) } catch (error) {
          if (error.code === 'EEXIST') throw failure('notes/publication-conflict', tr('发布期间外部编辑器保存了正文，外部文件已保留'))
          await this.restore(entry)
          throw error
        }
        entry.phase = 'published'
        await this.save(record)
      }
      record.status = 'published'
      delete record.error
      await this.save(record)
    } catch (error) {
      record.status = error.code?.includes('conflict') ? 'conflict' : 'failed'
      record.error = { code: error.code ?? 'notes/save-failed', message: error.message }
      try { await this.save(record) } catch (saveError) { error.cause = saveError }
      throw Object.assign(error, { pendingId: record.id })
    }
  }

  /** Final byte checks run in the same non-yielding section as Store's receipt replacement. */
  validateSync(record) {
    for (const reference of record.references ?? []) {
      if (hash(this.store.notes.readBytesSync(reference)) !== reference.sha256) throw failure('notes/conflict', tr('接受前作品已有新版本，请重新读取后保存'))
    }
    for (const entry of record.files) {
      for (const reference of [entry.after, entry.candidate, ...(entry.before ? [entry.displaced, ...(entry.displacements ?? [])] : [])]) {
        const bytes = this.store.notes.readBytesSync(reference)
        if (hash(bytes) !== reference.sha256) throw failure('notes/publication-conflict', tr('接受前正文或保留的外部版本已变化，请先核对版本'))
      }
    }
    const subjects = new Set([...record.files.map(entry => entry.subjectId ?? entry.workId), ...record.changes.filter(change => change.path[0] === 'items').map(change => change.path[1]?.id)])
    for (const saved of this.records) for (const entry of saved.files) {
      if (!subjects.has(entry.subjectId ?? entry.workId)) continue
      // A later navigation refresh incorporates the restored editor version; earlier inodes stay retained.
      if (entry.kind === 'index' && saved !== record) continue
      for (const reference of entry.displacements ?? []) {
        const expected = saved.resolutions?.[reference.relativePath]?.sha256 ?? reference.sha256
        if (hash(this.store.notes.readBytesSync(reference)) !== expected) {
          throw failure('notes/displaced-conflict', tr('外部编辑器修改了保留版本，请先核对冲突再保存'))
        }
      }
    }
  }

  async inspect() {
    for (const record of this.records) {
      record.observedConflicts = []
      const inodes = new Map()
      for (const entry of record.files) {
        const references = [...(entry.displacements ?? [])]
        if (entry.displaced && !references.some(reference => reference.relativePath === entry.displaced.relativePath)) {
          if (await this.bytes(entry.displaced)) references.push(entry.displaced)
        }
        if (record.status !== 'accepted' && await this.bytes(entry.publication)) references.push(entry.publication)
        references.push(...(entry.rejectedPrimaries ?? []))
        if (entry.rejectedPrimary) references.push(entry.rejectedPrimary)
        if (record.status === 'conflict') {
          const primary = await this.bytes(entry.after)
          if (primary && ![entry.before?.sha256, entry.candidate.sha256].includes(hash(primary))) references.push({ ...entry.after, sha256: entry.before?.sha256 ?? entry.candidate.sha256 })
        }
        for (const reference of references) {
          const bytes = await this.bytes(reference)
          const observedSha256 = bytes ? hash(bytes) : null
          const expectedSha256 = record.resolutions?.[reference.relativePath]?.sha256 ?? reference.sha256
          if (observedSha256 !== expectedSha256) {
            let identity = reference.relativePath
            if (bytes) { const info = await lstat(join(reference.notesRoot, reference.relativePath)); identity = `${entry.subjectId ?? entry.workId}:${entry.language ?? entry.kind}:${info.dev}:${info.ino}:${observedSha256}` }
            const existing = inodes.get(identity)
            if (existing) existing.aliases.push(structuredClone(reference))
            else {
              const conflict = { ...(entry.workId ? { workId: entry.workId } : { subjectId: entry.subjectId, kind: entry.kind }), language: entry.language, reference: structuredClone(reference), aliases: [structuredClone(reference)], expectedSha256, observedSha256 }
              record.observedConflicts.push(conflict)
              inodes.set(identity, conflict)
            }
          }
        }
      }
    }
  }

  /** Recover only already published known edits; unstarted candidates require an explicit save retry. */
  async recover() {
    await this.load()
    const indexes = new Map()
    for (const record of [...this.records].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
      if (!record.files.length || !record.files.every(entry => entry.kind === 'index')) continue
      const key = join(record.files[0].after.notesRoot, record.files[0].after.relativePath)
      if (!indexes.has(key)) indexes.set(key, record)
    }
    // Only the newest index journal can restore navigation; older editor inodes remain historical evidence.
    for (const record of indexes.values()) {
      if (record.status === 'accepted') continue
      for (const entry of record.files) if (!await this.bytes(entry.after)) await this.restore(entry)
      if (['published', 'pending'].includes(record.status)) {
        try { this.validateSync(record); record.status = 'accepted'; await this.save(record) }
        catch (error) { await this.restoreAccepted(record, error) }
      }
    }
    for (const record of this.records) {
      if (record.files.length && record.files.every(entry => entry.kind === 'index')) continue
      const receipt = this.store.state.receipts?.find(row => row.id === record.id)
      if (receipt) { record.status = 'accepted'; continue }
      if (['candidate', 'conflict', 'rejected'].includes(record.status) || record.requiresValidation) continue
      const published = await Promise.all(record.files.map(async entry => {
        const primary = await this.bytes(entry.after)
        if (!primary) await this.restore(entry)
        return primary && hash(primary) === entry.candidate.sha256
      }))
      if (!published.every(Boolean)) continue
      try { await this.store.acceptSaved(record) } catch (error) {
        record.status = error.code?.includes('conflict') ? 'conflict' : 'failed'
        record.error = { code: error.code ?? 'notes/save-failed', message: error.message }
        try { await this.save(record) } catch (saveError) { record.error.persistence = saveError.code }
      }
    }
    await this.inspect()
  }

  pending(subjectId, kind = 'work') {
    return this.records.find(record => !['accepted', 'rejected'].includes(record.status)
      && record.files.some(file => (file.subjectId ?? file.workId) === subjectId && (file.kind ?? 'work') === kind))
  }

  conflicts(subjectId, kind = 'work') {
    return this.records.flatMap(record => (record.observedConflicts ?? []).filter(conflict => kind === 'work'
      ? conflict.workId === subjectId : conflict.subjectId === subjectId && conflict.kind === kind).map(conflict => ({ ...conflict, saveId: record.id })))
  }

  /**
   * Inspect candidates, known publication steps and durable receipts without external replay.
   * @returns {Promise<object[]>} Detached recovery records suitable for repair and save retry.
   */
  async list() {
    return this.records.map(record => ({ id: record.id, resultKey: record.resultKey, label: record.label,
      status: record.observedConflicts?.length ? 'conflict' : record.status, requiresValidation: record.requiresValidation, files: structuredClone(record.files),
      conflicts: structuredClone(record.observedConflicts ?? []), ...(record.error ? { error: { ...record.error, message: notesSaveMessage(record.error) } } : {}),
      ...(this.store.state.receipts?.find(row => row.id === record.id) ? { receipt: structuredClone(record.receipt) } : {}) }))
  }
}
