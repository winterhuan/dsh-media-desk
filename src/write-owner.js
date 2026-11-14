/** Cooperative local Hosts hold canonical data and Notes directory locks for their write lifetime. */
import { mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { tr } from './i18n.js'
import { AsyncLocalStorage } from 'node:async_hooks'

/** Lifetime ownership; acquisition readiness is separate from the long-lived lock callback. */
export class WriteOwner {
  constructor(dataRoot, wikiRoot) {
    this.dataRoot = resolve(dataRoot)
    this.wikiRoot = resolve(wikiRoot)
    this.locks = []
    this.controller = new AbortController()
    this.workController = new AbortController()
    this.context = new AsyncLocalStorage()
    this.queue = Promise.resolve()
    this.tasks = new Set()
    this.closing = false
    this.released = false
  }

  get signal() { return this.workController.signal }

  /** Admit and retain an owned operation until its completion; closing rejects new work. */
  track(task) {
    if (this.closing || this.released) return Promise.reject(Object.assign(new Error(tr('Media Desk 正在关闭，请稍后重试')), { code: 'ownership/closing', status: 503 }))
    const operation = Promise.resolve().then(async () => {
      const scope = { writing: false, active: true }
      try { return await this.context.run(scope, task) } finally { scope.active = false }
    })
    this.tasks.add(operation)
    operation.then(() => this.tasks.delete(operation), () => this.tasks.delete(operation))
    return operation
  }

  /** Serialize storage operations; nested public Store/Settings calls stay in the same write. */
  run(task) {
    const current = this.context.getStore()
    if (this.released) return Promise.reject(Object.assign(new Error(tr('Media Desk 正在关闭，请稍后重试')), { code: 'ownership/closing', status: 503 }))
    if (!current?.active) return this.track(() => this.run(task))
    if (current.writing) return Promise.resolve().then(task)
    const operation = this.queue.then(async () => {
      const scope = { writing: true, active: true }
      try { return await this.context.run(scope, task) } finally { scope.active = false }
    })
    // A failed operation remains rejected for its caller; the owner can still drain later work.
    this.queue = operation.catch(error => undefined)
    return operation
  }

  /** Stop admission and signal owned external work before draining writes. */
  beginShutdown() {
    this.closing = true
    this.workController.abort()
    this.controller.abort()
  }

  async drain() {
    while (this.tasks.size) await Promise.allSettled([...this.tasks])
    await this.queue
  }

  async savedRoots() {
    const roots = new Set()
    const add = root => {
      if (typeof root !== 'string' || !isAbsolute(root)) throw new Error('Saved Notes root must be an absolute directory')
      roots.add(root)
    }
    const references = value => {
      if (!value || typeof value !== 'object') return
      if (value.notesRoot !== undefined) add(value.notesRoot)
      for (const child of Object.values(value)) if (child && typeof child === 'object') references(child)
    }
    for (const name of ['state.json', 'sessions.json']) {
      let saved
      try { saved = JSON.parse(await readFile(join(this.dataRoot, name), 'utf8')) } catch (error) {
        if (error.code === 'ENOENT') continue
        throw error
      }
      if (saved.version !== 1 && !(name === 'state.json' && saved.version === 2)) throw new Error(`Unsupported Media Desk metadata in ${name}`)
      if (name === 'state.json') {
        if (!Array.isArray(saved.items)) throw new Error('Saved work list is invalid')
        references(saved)
      } else {
        if (!Array.isArray(saved.associations)) throw new Error('Saved Session associations are invalid')
        for (const association of saved.associations) add(association.notesRoot ?? join(association.wikiRoot, 'notes'))
      }
    }
    let pending
    try { pending = await readdir(join(this.dataRoot, 'notes-writes')) } catch (error) { if (error.code !== 'ENOENT') throw error }
    for (const id of pending ?? []) {
      if (!/^[a-f0-9-]{36}$/.test(id)) continue
      let bytes
      try { bytes = await readFile(join(this.dataRoot, 'notes-writes', id, 'pending.json'), 'utf8') } catch (error) {
        if (error.code !== 'ENOENT') throw error
        try { bytes = await readFile(join(this.dataRoot, 'notes-writes', id, 'proposal.json'), 'utf8') } catch (error) {
          if (error.code === 'ENOENT' && !(await readdir(join(this.dataRoot, 'notes-writes', id))).length) continue
          throw error
        }
      }
      const saved = JSON.parse(bytes)
      if (saved.version !== 1 || saved.id !== id || !Array.isArray(saved.files)) throw new Error('Saved Notes publication metadata is invalid')
      references(saved)
    }
    return roots
  }

  /**
   * Acquire both canonical roots before any content, defaults or indexes initialize.
   * Only lock parent directories are created. Failure releases every acquired lock.
   * @returns {Promise<void>} Resolves once all lifetime callbacks own their locks.
   */
  async acquire() {
    try {
      await mkdir(this.dataRoot, { recursive: true, mode: 0o700 })
      this.dataRoot = await realpath(this.dataRoot)
      // Saved object/Session roots are read without constructing or migrating their owners.
      const roots = await this.savedRoots()
      this.selectedNotesRoot = null
      try {
        const wiki = await realpath(this.wikiRoot)
        if (!(await stat(wiki)).isDirectory()) throw new Error('Wiki path is not a directory')
        this.wikiRoot = wiki
        this.selectedNotesRoot = join(wiki, 'notes')
        roots.add(this.selectedNotesRoot)
      } catch (error) {
        if (!roots.size) throw new Error(tr('Wiki 目录不可用：{path}。请检查 WIKI_PATH', { path: this.wikiRoot }))
      }
      this.notesRoots = new Set()
      for (const notes of roots) {
        if (!(await stat(dirname(notes))).isDirectory()) throw new Error('Saved Wiki path is not a directory')
        try { await mkdir(notes, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
        this.notesRoots.add(await realpath(notes))
      }
      if (this.selectedNotesRoot) this.selectedNotesRoot = await realpath(this.selectedNotesRoot)
      this.notesRoot = this.selectedNotesRoot ?? [...this.notesRoots][0]
      const keys = [...new Set([this.dataRoot, ...this.notesRoots])].sort()
      for (const root of keys) {
        let ready, failed, release
        const readiness = new Promise((resolveReady, rejectReady) => { ready = resolveReady; failed = rejectReady })
        const lifetime = new Promise(resolveRelease => { release = resolveRelease })
        const lock = { root, release, acquired: false }
        lock.completion = withFileLock(join(root, '.media-desk-owner'), async () => {
          lock.acquired = true
          ready()
          await lifetime
        }, { signal: this.controller.signal })
        lock.completion.catch(failed)
        this.locks.push(lock)
        await readiness
      }
    } catch (error) {
      let cause = error
      try { await this.release() } catch (releaseError) {
        cause = new AggregateError([error, releaseError], `${error.message}; ${releaseError.message}`)
      }
      throw Object.assign(new Error(tr('Media Desk 无法取得数据与 Notes 目录所有权：{error}', { error: cause.message }), { cause }), { code: 'ownership/unavailable', status: 503 })
    }
  }

  /** Release all callbacks and await removal of every owned lock record. */
  async release() {
    this.controller.abort()
    for (const lock of this.locks) lock.release()
    const settled = await Promise.allSettled(this.locks.map(lock => lock.completion))
    this.released = true
    const failures = settled.flatMap((result, index) => result.status === 'rejected' && this.locks[index].acquired ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, tr('Media Desk 目录所有权未能完全释放'))
  }
}
