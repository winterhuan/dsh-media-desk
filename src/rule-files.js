/** Read-only discovery of Agent-written proposals; activation remains a user decision in Store. */
import { lstat, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tr } from './i18n.js'

/** New proposals need scope and evidence; legacy registered rules keep their existing format. */
export function validateRuleProposal(value) {
  if (['name', 'rule', 'scope', 'evidence'].some(key => typeof value[key] !== 'string' || !value[key].trim())
    || Boolean(value.before?.trim()) !== Boolean(value.after?.trim())) {
    throw Object.assign(new Error(tr('规则提案需要名称、规则、适用范围和依据；改写示例须同时提供修改前后文本')), { code: 'notes/rule-proposal-invalid' })
  }
}

/**
 * Inspect canonical rule files without writes, following neither symlink directories nor files.
 * @param {object} notes - Notes parser and configured roots.
 * @param {object[]} existing - Projected registered rules, including pending proposals.
 * @param {string[]} [deletedIds] - Deleted identities are not reimported from retained files.
 * @returns {Promise<object>} Valid unregistered proposals and path-specific issues, including exact duplicates.
 */
export async function discoverRuleFiles(notes, existing, deletedIds = []) {
  const rules = [], issues = []
  const deleted = new Set(deletedIds)
  const known = new Map(existing.map(row => [row.id, row]))
  const equivalent = (a, b) => typeof a.rule === 'string' && a.rule.trim() === b.rule.trim()
    && (a.scope ?? '').trim() === b.scope.trim()
  for (const notesRoot of notes.roots) {
    const directory = join(notesRoot, 'preferences/rules')
    let entries
    try {
      if (await realpath(directory) !== directory || !(await lstat(directory)).isDirectory()) {
        throw Object.assign(new Error(tr('规则目录必须是普通目录')), { code: 'notes/path-invalid' })
      }
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') continue
      issues.push({ file: directory, code: error.code, message: error.message })
      continue
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.name.endsWith('.md')) continue
      const reference = { wikiRoot: notes.wikiRoot, notesRoot, relativePath: 'preferences/rules/' + entry.name, kind: 'rule' }
      const file = join(directory, entry.name)
      try {
        const id = decodeURIComponent(entry.name.slice(0, -3))
        if (!id || id.length > 200 || /[\u0000-\u001f]/.test(id) || reference.relativePath !== notes.managedPath('rule', id)) {
          throw Object.assign(new Error(tr('规则文件名必须与规则身份一致')), { code: 'notes/path-invalid' })
        }
        if (deleted.has(id)) continue
        const registered = known.get(id)
        if (registered?.content?.notesRoot === notesRoot && registered.content.relativePath === reference.relativePath) continue
        if (registered) throw Object.assign(new Error(tr('规则身份已在其他位置登记')), { code: 'notes/rule-identity-conflict' })
        const { value, metadata, sha256 } = await notes.readManaged(reference, id, 'rule')
        validateRuleProposal(value)
        if (notes.writes?.pending(id, 'rule')) continue
        const duplicate = [...existing, ...rules].find(row => !row.sample && equivalent(row, value))
        if (duplicate) {
          issues.push({ file, id, code: 'notes/rule-duplicate', duplicateOf: duplicate.id,
            message: tr('规则与「{name}」重复，请合并或删除重复提案', { name: duplicate.name ?? duplicate.id }) })
          continue
        }
        const row = { id, ...value, status: 'proposed', confidence: 0.5, createdAt: metadata.updatedAt,
          content: { ...reference, sha256, revision: 1, status: 'ready' } }
        rules.push(row)
        known.set(id, row)
      } catch (error) {
        issues.push({ file, code: error.code ?? 'notes/metadata-invalid', message: error.message })
      }
    }
  }
  for (;;) {
    const invalid = rules.filter(row => row.relatedRuleId && (row.relatedRuleId === row.id || !known.has(row.relatedRuleId) || known.get(row.relatedRuleId).sample))
    if (!invalid.length) break
    for (const row of invalid) {
      issues.push({ file: join(row.content.notesRoot, row.content.relativePath), id: row.id,
        code: 'notes/rule-related-missing', message: tr('相近规则未登记，请读取已有规则后修正关联') })
      rules.splice(rules.indexOf(row), 1)
      known.delete(row.id)
    }
  }
  return { rules, issues }
}
