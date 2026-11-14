/** Verified work-migration backups and rollback evidence remain outside the shared Wiki. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, link, lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { tr } from './i18n.js'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const failure = (message, code = 'notes/backup-invalid') => Object.assign(new Error(message), { code, status: 409 })

async function optional(path) {
  try {
    if (!(await lstat(path)).isFile()) throw failure(tr('备份来源必须是普通文件：{path}', { path }))
    return await readFile(path)
  } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

async function files(path) {
  let names
  try { names = await readdir(path, { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  const result = []
  for (const entry of names) {
    const file = join(path, entry.name)
    if (entry.isDirectory()) result.push(...await files(file))
    else if (entry.isFile()) result.push(file)
    else throw failure(tr('备份来源必须是普通文件：{path}', { path: file }))
  }
  return result
}

function references(value, result = new Map()) {
  if (!value || typeof value !== 'object') return result
  if (typeof value.notesRoot === 'string' && typeof value.relativePath === 'string') result.set(join(value.notesRoot, value.relativePath), value)
  for (const child of Object.values(value)) if (child && typeof child === 'object') references(child, result)
  return result
}

/** Backups of accepted metadata, owned files and registered Notes are verified before migration. */
export class NotesMigration {
  constructor(store) {
    this.store = store
    this.root = join(store.root, 'notes-migrations')
  }

  async load(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw failure(tr('迁移备份身份无效'))
    const path = join(this.root, id)
    const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'))
    if (manifest.version !== 1 || manifest.id !== id || !Array.isArray(manifest.entries)) throw failure(tr('迁移备份清单无效'))
    return { ...manifest, path: join(path, 'backup') }
  }

  /** Verify actual backup bytes against the complete manifest, including the source state. */
  async verify(backup) {
    for (const entry of backup.entries) {
      if (typeof entry.saved !== 'string' || entry.saved.split('/').some(part => !part || ['.', '..'].includes(part))
        || !/^[a-f0-9]{64}$/.test(entry.sha256) || typeof entry.source !== 'string') throw failure(tr('迁移备份清单无效'))
      const bytes = await optional(join(backup.path, entry.saved))
      if (!bytes || hash(bytes) !== entry.sha256) throw failure(tr('迁移备份校验失败：{path}', { path: entry.saved }))
    }
    if (!backup.entries.some(entry => entry.saved === 'state.json' && entry.sha256 === backup.sourceHash)) throw failure(tr('迁移备份缺少已接受的原始状态'))
    return true
  }

  /** Inspect only verified backup metadata; file contents and settings are never returned. */
  async list() {
    let names
    try { names = await readdir(this.root) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
    const result = []
    for (const id of names.sort()) {
      if (!/^[a-f0-9-]{36}$/.test(id)) continue
      let backup
      try { backup = await this.load(id) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
      let verified = false, error
      try { verified = await this.verify(backup) } catch (cause) { error = cause.message }
      result.push({ id, path: backup.path, createdAt: backup.createdAt, sourceHash: backup.sourceHash, packageVersion: backup.packageVersion, verified,
        fileCount: backup.entries.length, ...(error ? { error } : {}) })
    }
    return result
  }

  /**
   * Retain an independent verified snapshot of the accepted data before any migration files.
   * @returns {Promise<object>} Reusable backup identity and parsed original work metadata.
   */
  async backup({ retainMissing = false, reuse = true } = {}) {
    const state = await readFile(this.store.file)
    const sourceHash = hash(state)
    if (this.store.diskHash !== sourceHash) throw failure(tr('已接受的数据在迁移准备期间变化，请重新读取'), 'notes/state-conflict')
    const existing = reuse && (await this.list()).find(row => row.sourceHash === sourceHash && row.verified)
    if (existing) return { ...await this.load(existing.id), original: JSON.parse(state) }
    const id = randomUUID()
    const root = join(this.root, id)
    const path = join(root, 'backup')
    await mkdir(path, { recursive: true, mode: 0o700 })
    const original = JSON.parse(state)
    const packageVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version
    const manifest = { version: 1, id, sourceHash, createdAt: new Date().toISOString(), packageVersion, entries: [] }
    const retain = async (source, saved, bytes, kind = 'data') => {
      if (!bytes) return
      await mkdir(dirname(join(path, saved)), { recursive: true, mode: 0o700 })
      await writeFile(join(path, saved), bytes, { flag: 'wx', mode: 0o600 })
      manifest.entries.push({ source, saved, kind, sha256: hash(bytes), size: bytes.length })
    }
    await retain(this.store.file, 'state.json', state)
    for (const name of ['settings.json', 'sessions.json']) await retain(join(this.store.root, name), name, await optional(join(this.store.root, name)))
    const registered = references(original)
    for (const directory of ['files', 'notes-writes', 'media-writes', 'native-candidates', 'native-settings']) for (const source of await files(join(this.store.root, directory))) {
      const saved = source.slice(this.store.root.length + 1).split('\\').join('/')
      const bytes = await optional(source)
      await retain(source, saved, bytes)
      if (directory === 'notes-writes' && source.endsWith('.json')) references(JSON.parse(bytes), registered)
    }
    const roots = [...this.store.notes.roots].sort()
    for (const [index, notesRoot] of roots.entries()) {
      try { const reference = { notesRoot, relativePath: 'index.md' }; await retain(join(notesRoot, 'index.md'), `notes/${index}/index.md`, await this.store.notes.readBytes(reference), 'index') }
      catch (error) { if (error.code !== 'notes/missing') throw error }
      registered.delete(join(notesRoot, 'index.md'))
    }
    for (const [source, reference] of registered) {
      try { await retain(source, `notes/${roots.indexOf(reference.notesRoot)}/${reference.relativePath}`, await this.store.notes.readBytes(reference, { binary: reference.relativePath.startsWith('assets/') }), reference.relativePath.startsWith('assets/') ? 'media' : 'notes') }
      catch (error) {
        if (!retainMissing || error.code !== 'notes/missing') throw error
        manifest.missingSources ??= []
        manifest.missingSources.push(source)
      }
    }
    await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 })
    const backup = { ...manifest, path }
    await this.verify(backup)
    if (hash(await readFile(this.store.file)) !== sourceHash) throw failure(tr('已接受的数据在迁移准备期间变化，请重新读取'), 'notes/state-conflict')
    return { ...backup, original }
  }

  /**
   * Restore verified pre-migration data with the Host stopped, retaining later files and logs.
   * @param {string} id - Original verified migration backup identity.
   * @returns {Promise<object>} Verified rollback and retained post-migration evidence paths.
   */
  async rollback(id) {
    const backup = await this.load(id)
    await this.verify(backup)
    const root = dirname(backup.path)
    const marker = join(root, 'rollback.json')
    const completed = await optional(marker)
    if (completed) return JSON.parse(completed)
    const pendingPath = join(root, 'rollback-pending.json')
    let pending
    const pendingBytes = await optional(pendingPath)
    if (pendingBytes) pending = JSON.parse(pendingBytes)
    else {
      const retained = await this.backup({ retainMissing: true, reuse: false })
      const sessions = await optional(join(retained.path, 'sessions.json'))
      pending = { version: 1, id, retainedId: retained.id, restored: [],
        nativeSessionIds: sessions ? JSON.parse(sessions).associations.flatMap(row => row.sessionId ? [row.sessionId] : []) : [] }
      await writeFileAtomic(pendingPath, JSON.stringify(pending), { mode: 0o600, dirMode: 0o700 })
    }
    const retained = await this.load(pending.retainedId)
    await this.verify(retained)
    const live = join(root, 'rollback-live')
    await mkdir(live, { recursive: true, mode: 0o700 })
    const capture = async (source, saved, entry) => {
      let present
      try { present = await lstat(source) } catch (error) { if (error.code === 'ENOENT') return; throw error }
      if (!present.isFile()) throw failure(tr('回滚来源必须是普通文件：{path}', { path: source }))
      let target = join(live, saved + '.' + randomUUID())
      if (entry?.kind === 'notes') {
        const reference = [...references(JSON.parse(await readFile(join(backup.path, 'state.json'), 'utf8'))).values()].find(reference => join(reference.notesRoot, reference.relativePath) === source)
        const { metadata } = this.store.notes.decode(await readFile(join(backup.path, entry.saved)))
        const directory = `history/${encodeURIComponent(metadata.workId ?? metadata.id ?? id)}`
        await this.store.notes.createDirectory(reference.notesRoot, directory)
        target = join(reference.notesRoot, directory, randomUUID() + '-rollback-external.md')
        pending.liveNotes ??= []
        pending.liveNotes.push(target)
        await writeFileAtomic(pendingPath, JSON.stringify(pending), { mode: 0o600, dirMode: 0o700 })
      }
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      await rename(source, target)
    }
    const restore = async (entry, source, saved) => {
      const current = await optional(source)
      if (!current || hash(current) !== entry.sha256) {
        const temporary = source + '.' + randomUUID() + '.rollback'
        await mkdir(dirname(source), { recursive: true, mode: 0o700 })
        await copyFile(join(backup.path, entry.saved), temporary, constants.COPYFILE_EXCL)
        try {
          await capture(source, saved, entry)
          try { await link(temporary, source) } catch (error) {
            if (error.code === 'EEXIST') throw failure(tr('回滚期间文件被外部保存，请核对保留证据后重试：{path}', { path: source }), 'notes/rollback-conflict')
            throw error
          }
        } finally { await unlink(temporary) }
      }
      if (hash(await readFile(source)) !== entry.sha256) throw failure(tr('回滚文件校验失败：{path}', { path: source }))
      pending.restored.push(entry.saved)
      await writeFileAtomic(pendingPath, JSON.stringify(pending), { mode: 0o600, dirMode: 0o700 })
    }
    const dataEntries = backup.entries.filter(entry => entry.kind === 'data')
    const names = new Set(dataEntries.map(entry => entry.saved))
    for (const directory of ['files', 'notes-writes', 'media-writes', 'native-candidates', 'native-settings']) for (const source of await files(join(this.store.root, directory))) {
      const saved = source.slice(this.store.root.length + 1).split('\\').join('/')
      if (!names.has(saved)) await capture(source, saved)
    }
    for (const name of ['settings.json', 'sessions.json']) if (!names.has(name)) await capture(join(this.store.root, name), name)
    for (const entry of dataEntries.filter(entry => entry.saved !== 'state.json')) await restore(entry, join(this.store.root, entry.saved), entry.saved)
    for (const entry of backup.entries.filter(entry => ['notes', 'media'].includes(entry.kind))) {
      const reference = [...references(JSON.parse(await readFile(join(backup.path, 'state.json'), 'utf8'))).values()].find(reference => join(reference.notesRoot, reference.relativePath) === entry.source)
      if (!reference || !this.store.notes.roots.has(reference.notesRoot)) continue
      await this.store.notes.createDirectory(reference.notesRoot, reference.relativePath.split('/').slice(0, -1).join('/'))
      await restore(entry, entry.source, entry.saved)
    }
    const state = dataEntries.find(entry => entry.saved === 'state.json')
    await restore(state, this.store.file, 'state.json')
    const original = JSON.parse(await readFile(this.store.file, 'utf8'))
    await this.store.writes.load()
    await this.store.notes.syncIndex(await this.store.notes.hydrate(original))
    const result = { id, retainedId: retained.id, retainedPath: retained.path, livePath: live, liveNotes: pending.liveNotes ?? [], nativeSessionIds: pending.nativeSessionIds,
      packageVersion: backup.packageVersion, restoredSourceHash: backup.sourceHash, verified: hash(await readFile(this.store.file)) === backup.sourceHash, completedAt: new Date().toISOString() }
    if (!result.verified) throw failure(tr('回滚后的原始状态校验失败'))
    await writeFileAtomic(marker, JSON.stringify(result), { mode: 0o600, dirMode: 0o700 })
    return result
  }
}
