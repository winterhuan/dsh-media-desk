/** Durable undo records contain authored fields and fixed text references. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tr } from './i18n.js'

const COLLECTIONS = new Set(['items', 'people', 'angles', 'styles', 'activeStyleId', 'skills', 'metrics', 'accounts', 'sampleCleared'])
const ITEM_FIELDS = new Set(['kind', 'title', 'body', 'noteMetadata', 'language', 'url', 'source', 'tags', 'status', 'publishedAt', 'angleId', 'personaIds', 'parentId', 'rel', 'scheduledAt', 'platform', 'pinned', 'media', 'pos', 'score', 'drafts'])
const PRODUCTION_FIELDS = new Set(['title', 'article', 'coverText', 'current', 'textVersion', 'aiVersion'])
const WORK_FIELDS = new Set(['id', 'kind', 'createdAt', 'sample', 'localeLinked', 'imported', 'externalId', 'language', 'languageBasis', 'content', 'sourceContent', 'textHistory', 'languageHistory', 'otherLang',
  'title', 'body', 'noteMetadata', 'customMetadata', 'legacyMetadata', ...ITEM_FIELDS, 'production'])
const ACCEPTED_PRODUCTION = new Set([...PRODUCTION_FIELDS, 'article', 'aiArticle', 'facts', 'outline', 'characters', 'cover', 'images', 'shots', 'engine', 'notice'])
const RUNTIME_FIELDS = new Set(['revision', 'status', 'stage', 'error', 'code', 'pendingId', 'conflicts', 'taskId', 'attemptId', 'sessionId', 'turnId', 'stepId', 'generationId', 'startedAt', 'finishedAt', 'savedPath', 'savedAt'])
const pick = (row, fields) => Object.fromEntries(Object.entries(row).filter(([key]) => fields.has(key)))
const withoutRuntime = value => Array.isArray(value) ? value.map(withoutRuntime) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([key]) => !RUNTIME_FIELDS.has(key)).map(([key, child]) => [key, withoutRuntime(child)])) : value

/**
 * Project a whole work's authored data for removal/restoration, excluding native execution.
 * @param {object} value - Durable work row.
 * @param {Array<string|object>} path - Stable Store address; other addresses retain their value.
 * @returns {object} Authored row with reference counters and repair state omitted.
 */
export function undoValue(value, path) {
  if (!value || path[0] !== 'items' || path.length !== 2) return value
  const row = structuredClone(pick(value, WORK_FIELDS))
  if (row.content) row.content = withoutRuntime(row.content)
  if (row.sourceContent) row.sourceContent = withoutRuntime(row.sourceContent)
  if (row.production) row.production = withoutRuntime(pick(row.production, ACCEPTED_PRODUCTION))
  if (row.otherLang) for (const [language, variant] of Object.entries(row.otherLang)) row.otherLang[language] = undoValue(variant, path)
  return row
}

/**
 * Retain only one edit's authored inverse, excluding execution state and conflict counters.
 * @param {object} record - Save identity and fixed candidate/preimage file references.
 * @param {string} filesDir - Owned private files directory; fixed inverses are included in backups.
 * @param {object} before - Accepted work state; legacy inverse text retains its original language.
 * @returns {Promise<object|null>} Fixed inverse references, or null for an unchanged authored result.
 */
export async function notesUndoEntry(record, filesDir, before) {
  const changes = record.changes.filter(change => {
    if (!COLLECTIONS.has(change.path[0])) return false
    if (change.path[0] !== 'items' || change.path.length === 2) return true
    const field = change.path[2]
    return ITEM_FIELDS.has(field) || field === 'production' && PRODUCTION_FIELDS.has(change.path[3])
  }).map(change => ({ ...change, before: change.before.present ? { present: true, value: undoValue(change.before.value, change.path) } : change.before,
    after: change.after.present ? { present: true, value: undoValue(change.after.value, change.path) } : change.after }))
  const files = record.files.filter(file => (file.kind ?? 'work') === 'work' && file.before).map(file => ({ workId: file.workId, before: file.beforeSnapshot, after: file.candidate, primary: withoutRuntime(file.after) }))
  const languages = Object.fromEntries(before.items.filter(item => !item.content && changes.some(change => change.path[0] === 'items' && change.path[1]?.id === item.id))
    .map(item => [item.id, item.language ?? (item.sample ? before.sampleLang : 'und') ?? 'und']))
  if (!changes.length && !files.length) return null
  const bytes = JSON.stringify(changes)
  const relativePath = `undo/${record.id}.json`
  await mkdir(join(filesDir, 'undo'), { recursive: true, mode: 0o700 })
  await writeFile(join(filesDir, relativePath), bytes, { flag: 'wx', mode: 0o600 })
  return { id: record.id, label: record.label, createdAt: record.createdAt,
    changes: { relativePath, sha256: createHash('sha256').update(bytes).digest('hex') }, files, languages }
}

/**
 * Read one immutable authored inverse; changed or missing snapshots cannot be applied.
 * @param {object} entry - Durable undo identity with its fixed change reference.
 * @param {string} filesDir - Owned private files directory.
 * @returns {Promise<object[]>} Authored field changes from the accepted edit.
 */
export async function readUndoChanges(entry, filesDir) {
  if (!/^[a-f0-9-]{36}$/.test(entry.id) || entry.changes?.relativePath !== `undo/${entry.id}.json`) {
    throw Object.assign(new Error(tr('撤销历史缺失或无效，请修复固定历史文件')), { code: 'notes/undo-invalid', status: 409 })
  }
  let bytes
  try { bytes = await readFile(join(filesDir, entry.changes.relativePath)) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    throw Object.assign(new Error(tr('撤销历史缺失或无效，请修复固定历史文件')), { code: 'notes/undo-invalid', status: 409 })
  }
  if (createHash('sha256').update(bytes).digest('hex') !== entry.changes.sha256) {
    throw Object.assign(new Error(tr('撤销历史缺失或无效，请修复固定历史文件')), { code: 'notes/undo-invalid', status: 409 })
  }
  return JSON.parse(bytes)
}
