/** Accepted media uses a single Notes file; private pending saves retain service results for recovery. */
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, lstat, readFile, readdir, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { mediaPath } from './notes-paths.js'

const fingerprint = bytes => createHash('sha256').update(bytes).digest('hex')
const failure = message => Object.assign(new Error(message), { code: 'media/save-conflict', status: 409 })
const languageAt = (work, language) => work?.content?.language === language ? work : work?.otherLang?.[language]
const assetAt = (production, target) => target === 'cover' ? production?.cover
  : /^(image|shot):\d+$/.test(target) ? production?.[target.startsWith('image:') ? 'images' : 'shots']?.[Number(target.split(':')[1])] : null

/** Binary candidates and their idempotent Store acceptance, owned by the Host writer. */
export class MediaFiles {
  constructor(store, { onError } = {}) { this.store = store; this.root = join(store.root, 'media-writes'); this.onError = onError }

  async records() {
    let ids
    try { ids = await readdir(this.root) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
    const records = []
    for (const id of ids) {
      if (!/^[a-f0-9-]{36}$/.test(id)) continue
      let bytes
      try { bytes = await readFile(join(this.root, id, 'pending.json'), 'utf8') } catch (error) { if (error.code === 'ENOENT') continue; throw error }
      const record = JSON.parse(bytes)
      if (record.version !== 1 || record.id !== id || !/^[a-f0-9]{64}$/.test(record.sha256) || !['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(record.ext)
        || typeof record.workId !== 'string' || typeof record.notesRoot !== 'string' || typeof record.target !== 'string'
        || !/^assets\/[^/\\]+\/[^/\\]+$/.test(record.relativePath) || !record.relativePath.endsWith(record.ext)
        || /[\u0000-\u001f]/.test(record.relativePath) || record.relativePath.split('/').some(part => part === '.' || part === '..')) throw failure('Invalid saved media record')
      records.push(record)
    }
    return records
  }

  /** List retained unaccepted saves, including candidates whose process ended before publication. */
  async saves() {
    const state = await this.store.read()
    return (await this.records()).filter(row => !state.receipts?.some(receipt => receipt.resultKey === 'media:' + row.id))
      .map(row => ({ id: row.id, workId: row.workId, target: row.target, phase: row.phase, createdAt: row.createdAt }))
  }

  /** Save the result once before attempting Notes publication; retries reuse these bytes. */
  async save(workId, target, { buffer, ext }, expected) {
    if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext) || !Buffer.isBuffer(buffer) || !buffer.length) throw failure('Invalid generated media')
    return this.store.run(async () => {
      const state = await this.store.read()
      const work = state.items.find(row => row.id === workId)
      const asset = assetAt(work?.production, target)
      if (!work?.content || !asset || work.production.attemptId !== expected.attemptId || asset.renderId !== expected.renderId) throw failure('The media attempt is no longer current')
      const id = randomUUID()
      const record = { version: 1, id, workId, target, notesRoot: work.content.notesRoot, language: work.content.language,
        attemptId: expected.attemptId ?? null, renderId: expected.renderId, sha256: fingerprint(buffer), ext,
        phase: 'candidate', createdAt: new Date().toISOString(), relativePath: mediaPath(work, target, ext, id) }
      await writeFileAtomic(join(this.root, id, 'candidate' + ext), buffer, { mode: 0o600, dirMode: 0o700 })
      await writeFileAtomic(join(this.root, id, 'pending.json'), JSON.stringify(record), { mode: 0o600, dirMode: 0o700 })
      try { return await this.retry(id) } catch (error) { throw Object.assign(error, { mediaPendingId: id }) }
    })
  }

  /** Publish retained bytes; a durable receipt stays accepted if private journal cleanup fails. */
  async retry(id) {
    return this.store.run(async () => {
      const record = (await this.records()).find(row => row.id === id)
      if (!record) throw failure('Media save not found')
      const state = await this.store.read()
      const work = state.items.find(row => row.id === record.workId)
      const version = languageAt(work, record.language)
      const asset = assetAt(version?.production, record.target)
      const receipt = state.receipts?.find(row => row.resultKey === 'media:' + id)
      if (receipt) {
        const warnings = []
        if (asset?.media?.id === id && version.content.notesRoot === record.notesRoot
          && (version.production.attemptId ?? null) === record.attemptId && asset.renderId === record.renderId
          && version.production.status !== 'cancelled' && (asset.status !== 'done' || asset.error || asset.pendingId)) {
          try {
            await this.store.mutate('核对已接受图片', draft => {
              const current = languageAt(draft.items.find(row => row.id === record.workId), record.language)
              const selected = assetAt(current?.production, record.target)
              if (selected?.media?.id !== id || selected.renderId !== record.renderId || (current.production.attemptId ?? null) !== record.attemptId
                || current.content.notesRoot !== record.notesRoot || current.production.status === 'cancelled') return
              selected.status = 'done'; selected.error = null; delete selected.pendingId
            }, { undoable: false })
          } catch (error) { warnings.push(error) }
        }
        return this.finish(record, receipt, warnings)
      }
      if (!version?.content || version.content.notesRoot !== record.notesRoot
        || version.production.attemptId !== record.attemptId && !(version.production.attemptId === undefined && record.attemptId === null)
        || asset?.renderId !== record.renderId || ['cancelled'].includes(version.production.status)) throw failure('Current work cannot accept this retained image')
      if (!this.store.notes.roots.has(record.notesRoot)) throw failure('Notes root is not owned')
      const candidate = await readFile(join(this.root, id, 'candidate' + record.ext))
      if (fingerprint(candidate) !== record.sha256) throw failure('Retained media bytes have changed')
      const target = join(record.notesRoot, record.relativePath)
      await this.store.notes.createDirectory(record.notesRoot, dirname(record.relativePath))
      try { await copyFile(join(this.root, id, 'candidate' + record.ext), target, constants.COPYFILE_EXCL) } catch (error) {
        if (error.code !== 'EEXIST') throw error
        if ((await lstat(target)).isSymbolicLink() || fingerprint(await readFile(target)) !== record.sha256) throw failure('Notes media destination has changed')
      }
      record.phase = 'published'
      await writeFileAtomic(join(this.root, id, 'pending.json'), JSON.stringify(record), { mode: 0o600, dirMode: 0o700 })
      let accepted
      try { accepted = await this.store.mutate('接受成稿图片', draft => {
        const current = languageAt(draft.items.find(row => row.id === record.workId), record.language)
        const selected = assetAt(current?.production, record.target)
        if (!selected || selected.renderId !== record.renderId) throw failure('Media attempt changed before acceptance')
        selected.media = { id, notesRoot: record.notesRoot, relativePath: record.relativePath, sha256: record.sha256 }
        ;(draft.mediaReferences ??= {})[id] = { ...selected.media, workId: record.workId }
        selected.src = 'media-desk/media/' + id
        selected.status = 'done'; selected.error = null; delete selected.pendingId
      }, { undoable: false, resultKey: 'media:' + id, payloadHash: record.sha256,
        validateAcceptance: () => {
          const current = languageAt(this.store.state.items.find(row => row.id === record.workId), record.language)
          if (current?.content?.notesRoot !== record.notesRoot || assetAt(current?.production, record.target)?.renderId !== record.renderId
            || (current.production.attemptId ?? null) !== record.attemptId || ['cancelled'].includes(current.production.status)) throw failure('Media attempt changed before acceptance')
          if (fingerprint(this.store.notes.readBytesSync(record, { binary: true })) !== record.sha256) throw failure('Notes media bytes changed before acceptance')
        } }) } catch (error) {
        const receipt = this.store.state.receipts?.find(row => row.resultKey === 'media:' + id)
        if (!receipt) throw error
        return this.finish(record, receipt, [error])
      }
      return this.finish(record, accepted.acceptance)
    })
  }

  async finish(record, receipt, warnings = []) {
    record.phase = 'accepted'
    try { await writeFileAtomic(join(this.root, record.id, 'pending.json'), JSON.stringify(record), { mode: 0o600, dirMode: 0o700 }) }
    catch (error) { warnings.push(error) }
    try { await unlink(join(this.root, record.id, 'candidate' + record.ext)) }
    catch (error) { if (error.code !== 'ENOENT') warnings.push(error) }
    for (const error of warnings) this.onError?.(error)
    return { id: record.id, accepted: true, acceptance: receipt, workId: record.workId, language: record.language, attemptId: record.attemptId,
      ...(warnings.length ? { warnings: warnings.map(error => ({ code: error.code, message: error.message })) } : {}) }
  }

  /** Recover published or receipted saves; return their attempt identities without restarting external work. */
  async recover() {
    const state = await this.store.read()
    const accepted = []
    for (const record of await this.records()) if (record.phase === 'published' || state.receipts?.some(row => row.resultKey === 'media:' + record.id)) {
      try { accepted.push(await this.retry(record.id)) } catch (error) {
        await this.store.mutate('恢复图片保存', draft => {
          const version = languageAt(draft.items.find(row => row.id === record.workId), record.language)
          const asset = assetAt(version?.production, record.target)
          if (asset?.renderId === record.renderId) { asset.pendingId = record.id; asset.error = error.message; asset.status = 'failed' }
        }, { undoable: false })
      }
    }
    return accepted
  }

  /** Migrate accepted legacy files after a verified backup, preserving their original rollback bytes. */
  async migrate() {
    return this.store.run(async () => {
      const state = await this.store.read()
      const targets = []
      for (const work of state.items) for (const version of [work, ...Object.values(work.otherLang ?? {})]) {
        if (!version.content) continue
        const production = version.production
        for (const target of ['cover', ...production?.images?.map((_, i) => 'image:' + i) ?? [], ...production?.shots?.map((_, i) => 'shot:' + i) ?? []]) {
          const asset = assetAt(production, target)
          if (asset?.media || asset?.status !== 'done' || !/^media-desk\/files\/[\w.-]+$/.test(asset.src ?? '')) continue
          targets.push({ workId: work.id, version, target, asset })
        }
      }
      if (!targets.length) return
      const backup = await this.store.migration.backup()
      const retained = await this.records()
      for (const { workId, version, target, asset } of targets) {
        const previous = retained.find(row => row.backupId && row.workId === workId && row.language === version.content.language && row.target === target && row.renderId === asset.renderId && row.phase !== 'accepted')
        if (previous) { await this.retry(previous.id); continue }
        const filename = asset.src.slice('media-desk/files/'.length)
        const ext = /\.[^.]+$/.exec(filename)?.[0]?.toLowerCase()
        if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) throw failure('Unsupported legacy image format')
        const source = join(this.store.filesDir, filename)
        if (!(await lstat(source)).isFile()) throw failure('Legacy media must be a regular file')
        const bytes = await readFile(source)
        const id = randomUUID()
        const renderId = 'migration:' + id
        const record = { version: 1, id, workId, target, language: version.content.language, notesRoot: version.content.notesRoot,
          attemptId: version.production.attemptId ?? null, renderId, sha256: fingerprint(bytes), ext, phase: 'candidate',
          createdAt: new Date().toISOString(), backupId: backup.id, relativePath: mediaPath(version, target, ext, id) }
        await writeFileAtomic(join(this.root, id, 'candidate' + ext), bytes, { mode: 0o600, dirMode: 0o700 })
        await writeFileAtomic(join(this.root, id, 'pending.json'), JSON.stringify(record), { mode: 0o600, dirMode: 0o700 })
        await this.store.mutate('迁移已接受媒体', draft => {
          assetAt(languageAt(draft.items.find(row => row.id === workId), record.language)?.production, target).renderId = renderId
        }, { undoable: false })
        await this.retry(id)
      }
    })
  }

  /** Resolve only an accepted, registered media identity; shared Notes neighbors remain inaccessible. */
  async resolve(id) {
    const state = await this.store.read()
    const retained = state.mediaReferences?.[id]
    if (retained) {
      if (fingerprint(await this.store.notes.readBytes(retained, { binary: true })) !== retained.sha256) throw failure('Accepted media is missing or changed')
      return join(retained.notesRoot, retained.relativePath)
    }
    for (const work of state.items) for (const language of [work, ...Object.values(work.otherLang ?? {})]) {
      for (const asset of [language.production?.cover, ...language.production?.images ?? [], ...language.production?.shots ?? []]) {
        if (asset?.media?.id !== id) continue
        const reference = asset.media
        const path = join(reference.notesRoot, reference.relativePath)
        if (fingerprint(await this.store.notes.readBytes(reference, { binary: true })) !== reference.sha256) throw failure('Accepted media is missing or changed')
        return path
      }
    }
    throw Object.assign(new Error('Media not found'), { status: 404 })
  }
}
