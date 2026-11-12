/** Inverse text edits preserve later disjoint changes and reject overlapping replacements. */
import { diff3Merge } from 'node-diff3'
import { tr } from './i18n.js'

/**
 * Merge the inverse accepted edit into current Markdown without inserting conflict markers.
 * @param {string} before - Text preceding the accepted edit.
 * @param {string} after - Text accepted by that edit.
 * @param {string} current - Reconciled current text, including external changes.
 * @returns {string} Current text with only the owned edit reversed.
 * @throws {Error} When a later edit overlaps the inverse change.
 */
export function undoText(before, after, current) {
  const lines = text => text.split(/(?<=\n)/u)
  const result = []
  for (const block of diff3Merge(lines(current), lines(after), lines(before))) {
    if (block.ok) { result.push(...block.ok); continue }
    const { a, o, b } = block.conflict
    for (const detail of diff3Merge(Array.from(a.join('')), Array.from(o.join('')), Array.from(b.join('')))) {
      if (detail.conflict) throw Object.assign(new Error(tr('撤销片段与后来的修改重叠，请先处理冲突')), { code: 'notes/undo-conflict', status: 409 })
      result.push(detail.ok.join(''))
    }
  }
  return result.join('')
}
