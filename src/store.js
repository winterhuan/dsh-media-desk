// 持久化：$DSH_HOME/media-desk/state.json。桌面端和 Web 端读同一份数据。
// Host 持有数据与 Notes 目录的协作写锁；正文每次读取都核对实际字节。
import { mkdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { buildSeed, migrateState } from './seed.js'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

const MAX_UNDO = 30

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
    if (this.state && info.mtimeMs === this.mtimeMs) return
    this.state = migrateState(JSON.parse(await readFile(this.file, 'utf8')))
    this.mtimeMs = info.mtimeMs
  }

  async persist(state = this.state) {
    await writeFileAtomic(this.file, JSON.stringify(state), { mode: 0o600, dirMode: 0o700 })
    this.mtimeMs = (await stat(this.file)).mtimeMs
  }

  async hydrated() {
    if (!this.notes) return structuredClone(this.state)
    const next = structuredClone(this.state)
    const projected = await this.notes.hydrate(next)
    await this.notes.syncIndex(projected)
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
    return this.run(async () => {
      await this.refresh()
      return this.hydrated()
    })
  }

  /**
   * @param {string} label - 显示在撤销入口上的说明。
   * @param {(state: object) => any} mutate - 就地修改状态。
   * @param {{undoable?: boolean, expectedContent?: object}} [options] - Optional previously read content versions; mismatches reject before edits.
   * @returns {Promise<any>} mutate 的返回值。
   */
  mutate(label, mutate, { undoable = true, expectedContent = {} } = {}) {
    return this.run(async () => {
      await this.refresh()
      const draft = await this.hydrated()
      this.notes?.assertExpected(draft, expectedContent)
      const previous = structuredClone(draft)
      const before = undoable ? JSON.stringify(draft) : null
      const result = await mutate(draft)
      const next = this.notes ? await this.notes.commit(previous, draft) : draft
      await this.persist(next)
      this.state = next
      if (undoable) {
        const after = JSON.stringify(draft)
        // 什么都没改的操作不占撤销位，免得用户点撤销却没反应
        if (after !== before) {
          this.undo.push({ label, before, after })
          if (this.undo.length > MAX_UNDO) this.undo.shift()
        }
      }
      return result
    })
  }

  undoLast() {
    return this.run(async () => {
      const entry = this.undo.at(-1)
      if (!entry) return null
      await this.refresh()
      const previous = await this.hydrated()
      const draft = revertChange(JSON.parse(entry.before), JSON.parse(entry.after), previous)
      const next = this.notes ? await this.notes.commit(previous, draft) : draft
      await this.persist(next)
      this.state = next
      this.undo.pop()
      return entry.label
    })
  }
}
