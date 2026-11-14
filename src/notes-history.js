/** Bounded history keeps current text, active candidates, recent inverses and observed editor conflicts. */
import { readdir, readFile, rename, rm, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { HISTORY_LIMIT } from './notes-paths.js'
import { readUndoChanges } from './notes-undo.js'

const key = reference => join(reference.notesRoot, reference.relativePath)
const isHistory = reference => /^(?:\.media-desk\/)?history\/[^/]+\/[^/]+\.md$/.test(reference.relativePath ?? '')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

function references(value, result = new Map()) {
  if (!value || typeof value !== 'object') return result
  if (typeof value.notesRoot === 'string' && isHistory(value)) result.set(key(value), value)
  for (const child of Object.values(value)) references(child, result)
  return result
}

/**
 * Current content and retained recovery records must remain readable even when older receipts expire.
 * @param {object} store - Loaded Store with its saved write records.
 * @returns {Promise<Map<string, object>>} Required history references indexed by absolute path.
 */
export async function requiredHistory(store) {
  const state = store.state
  const keep = references([state.items, state.styles, state.skills, state.voice, state.notesUndo,
    state.nativeRequests?.filter(row => !['accepted', 'rejected', 'failed', 'cancelled', 'superseded'].includes(row.status))])
  for (const entry of state.notesUndo ?? []) references(await readUndoChanges(entry, store.filesDir), keep)
  const accepted = new Set(state.receipts?.map(receipt => receipt.id))
  for (const record of store.writes.records) {
    if (!accepted.has(record.id) && record.status !== 'accepted' || record.observedConflicts?.length) references(record, keep)
    else for (const file of record.files) references([file.candidate, file.beforeSnapshot, file.displacements, file.displaced], keep)
  }
  return keep
}

/**
 * Run under the Store queue; retiring a journal precedes deletion so a restart cannot replay it.
 * @param {object} store - Owned Store whose accepted state and journals may be trimmed.
 * @returns {Promise<void>} Rejects on incomplete cleanup; accepted receipts remain durable.
 */
export async function pruneNotesHistory(store) {
  await store.writes.inspect()
  const expired = references(store.state)
  const next = structuredClone(store.state)
  for (const item of next.items) for (const version of [item, ...Object.values(item.otherLang ?? {})]) {
    if (version.textHistory) version.textHistory = version.textHistory.slice(-HISTORY_LIMIT)
  }
  if (next.notesUndo) next.notesUndo = next.notesUndo.slice(-HISTORY_LIMIT)
  if (JSON.stringify(next) !== JSON.stringify(store.state)) await store.persist(next)

  const accepted = new Set(store.state.receipts?.map(receipt => receipt.id))
  const keep = references([next.items, next.styles, next.skills, next.voice, next.notesUndo,
    next.nativeRequests?.filter(row => !['accepted', 'rejected', 'failed', 'cancelled', 'superseded'].includes(row.status))])
  for (const entry of next.notesUndo ?? []) references(await readUndoChanges(entry, store.filesDir), keep)
  const retained = new Set()
  const counts = new Map()
  for (const record of [...store.writes.records].reverse().sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const done = accepted.has(record.id) || record.status === 'accepted'
    if (!done || record.observedConflicts?.length) { retained.add(record); references(record, keep); continue }
    const subjects = record.files.map(file => `${file.after.notesRoot}:${file.subjectId ?? file.workId}:${file.language ?? file.kind}`)
    if (subjects.some(subject => (counts.get(subject) ?? 0) < (record.files.every(file => file.kind === 'index') ? 1 : HISTORY_LIMIT))) {
      retained.add(record)
      for (const subject of subjects) counts.set(subject, (counts.get(subject) ?? 0) + 1)
      for (const file of record.files) references([file.candidate, file.beforeSnapshot, file.displacements, file.displaced], keep)
    }
    references(record, expired)
  }

  const retired = []
  for (const record of store.writes.records) {
    if (retained.has(record)) continue
    const directory = join(store.writes.root, '.retired-' + record.id)
    await rename(join(store.writes.root, record.id), directory)
    retired.push(directory)
  }
  store.writes.records = store.writes.records.filter(record => retained.has(record))
  // An interrupted cleanup retains its manifest until the next pass can finish removing its files.
  let names = []
  try { names = await readdir(store.writes.root) } catch (error) { if (error.code !== 'ENOENT') throw error }
  for (const name of names) if (/^\.retired-[a-f0-9-]{36}$/.test(name)) {
    const directory = join(store.writes.root, name)
    if (!retired.includes(directory)) retired.push(directory)
    let bytes
    try { bytes = await readFile(join(directory, 'pending.json'), 'utf8') }
    catch (error) { if (error.code !== 'ENOENT') throw error; bytes = await readFile(join(directory, 'proposal.json'), 'utf8') }
    references(JSON.parse(bytes), expired)
  }
  for (const record of retained) if (accepted.has(record.id) || record.status === 'accepted') {
    for (const file of record.files) references(file.publication, expired)
  }
  for (const [path, reference] of expired) {
    if (keep.has(path)) continue
    let bytes
    try { bytes = await store.notes.readBytes(reference) }
    catch (error) { if (error.code === 'notes/missing') continue; throw error }
    if (hash(bytes) !== reference.sha256) continue
    await unlink(path)
  }
  for (const directory of retired) await rm(directory, { recursive: true })
}
