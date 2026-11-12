/** Bounded Store changes retain expected values so recovery cannot replace later work. */
import { tr } from './i18n.js'

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const keyed = value => Array.isArray(value) && value.every(row => object(row) && typeof row.id === 'string')
const saved = (present, value) => present ? { present, value: structuredClone(value) } : { present }

/**
 * Describe only changed fields and identified rows; absent values remain distinct from null.
 * @param {object} before - Accepted reference state.
 * @param {object} after - Prepared reference state.
 * @returns {object[]} Expected and replacement values addressed by stable row identity.
 */
export function stateChanges(before, after) {
  const changes = []
  const visit = (a, b, path, aPresent = true, bPresent = true, index) => {
    if (aPresent === bPresent && same(a, b)) return
    if (aPresent && bPresent && object(a) && object(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (!path.length && ['receipts', 'notesUndo'].includes(key)) continue
        visit(a[key], b[key], [...path, key], Object.hasOwn(a, key), Object.hasOwn(b, key))
      }
    } else if (aPresent && bPresent && keyed(a) && keyed(b) && (a.length || b.length)) {
      const was = new Map(a.map(row => [row.id, row]))
      const next = new Map(b.map(row => [row.id, row]))
      for (const id of new Set([...was.keys(), ...next.keys()])) {
        visit(was.get(id), next.get(id), [...path, { id }], was.has(id), next.has(id), next.has(id) ? b.findIndex(row => row.id === id) : a.findIndex(row => row.id === id))
      }
    } else changes.push({ path, before: saved(aPresent, a), after: saved(bPresent, b), ...(index >= 0 ? { index } : {}) })
  }
  visit(before, after, [])
  return changes
}

/**
 * Apply a saved edit to a detached current state, rejecting changed dependencies.
 * @param {object} state - Current accepted reference state.
 * @param {object[]} changes - Previously prepared bounded changes.
 * @returns {object} Detached replacement, retaining fields outside the edit.
 */
export function applyStateChanges(state, changes) {
  const next = structuredClone(state)
  for (const change of changes) {
    let parent = next
    for (const part of change.path.slice(0, -1)) {
      parent = typeof part === 'string' ? parent?.[part] : parent?.find(row => row.id === part.id)
      if (!parent) throw Object.assign(new Error(tr('保存所需对象已变化，请核对当前作品后重试')), { code: 'notes/save-conflict', status: 409 })
    }
    const part = change.path.at(-1)
    const key = typeof part === 'string' ? part : parent.findIndex(row => row.id === part.id)
    const present = typeof part === 'string' ? Object.hasOwn(parent, key) : key >= 0
    const current = saved(present, parent[key])
    if (!same(current, change.before) && !same(current, change.after)) {
      throw Object.assign(new Error(tr('保存所需内容已变化，请核对当前作品后重试')), { code: 'notes/save-conflict', status: 409 })
    }
    if (typeof part === 'string') {
      if (change.after.present) parent[key] = structuredClone(change.after.value)
      else delete parent[key]
    } else if (!change.after.present) {
      if (key >= 0) parent.splice(key, 1)
    } else if (key >= 0) parent[key] = structuredClone(change.after.value)
    else parent.splice(Math.min(change.index ?? parent.length, parent.length), 0, structuredClone(change.after.value))
  }
  return next
}

/**
 * Reverse unchanged owned fields while preserving later values and unrelated rows.
 * @param {object} state - Current reference state.
 * @param {object[]} changes - Authored changes from one accepted edit.
 * @param {Function} [compare] - Projects a value to the same authored fields stored in its inverse.
 * @returns {object} Detached inverse; a changed added row remains a recoverable conflict.
 */
export function reverseStateChanges(state, changes, compare = value => value) {
  const next = structuredClone(state)
  for (const change of [...changes].reverse()) {
    let parent = next
    for (const part of change.path.slice(0, -1)) {
      parent = typeof part === 'string' ? parent?.[part] : parent?.find(row => row.id === part.id)
      if (!parent) break
    }
    if (!parent) continue
    const part = change.path.at(-1)
    const key = typeof part === 'string' ? part : parent.findIndex(row => row.id === part.id)
    const present = typeof part === 'string' ? Object.hasOwn(parent, key) : key >= 0
    if (!same(saved(present, compare(parent[key], change.path)), change.after)) {
      if (typeof part !== 'string' && !change.before.present && present) {
        throw Object.assign(new Error(tr('新增对象已有后续修改，请先处理修改再撤销创建')), { code: 'notes/undo-conflict', status: 409 })
      }
      continue
    }
    if (typeof part === 'string') {
      if (change.before.present) parent[key] = structuredClone(change.before.value)
      else delete parent[key]
    } else if (!change.before.present) {
      if (key >= 0) parent.splice(key, 1)
    } else if (key >= 0) parent[key] = structuredClone(change.before.value)
    else parent.splice(Math.min(change.index ?? parent.length, parent.length), 0, structuredClone(change.before.value))
  }
  return next
}
