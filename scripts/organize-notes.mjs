/** Offline maintenance: preserve a verified backup before moving registered files and their references. */
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, rename, rmdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { Store } from '../src/store.js'
import { Notes } from '../src/notes.js'
import { WriteOwner } from '../src/write-owner.js'
import { readableName, unusedPath } from '../src/notes-paths.js'
import { pruneNotesHistory } from '../src/notes-history.js'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

const [home, wiki] = process.argv.slice(2)
if (!home || !wiki) throw new Error('Usage: node scripts/organize-notes.mjs <DSH_HOME> <WIKI_PATH>; stop DSH first')
const owner = new WriteOwner(join(resolve(home), 'media-desk'), resolve(wiki))
await owner.acquire()
const store = new Store(owner.dataRoot, owner)
store.notes = new Notes(owner)
await store.notes.init()

async function files(directory) {
  let entries
  try { entries = await readdir(directory, { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  const result = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await files(path))
    else if (entry.isFile()) result.push(path)
  }
  return result
}

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const moves = new Map()
const reserve = new Map()
function addMove(root, oldPath, newPath) {
  if (oldPath === newPath) return
  moves.set(join(root, oldPath), { notesRoot: root, oldPath, newPath })
  reserve.set(root, [...reserve.get(root) ?? [], newPath])
}
function remap(value) {
  if (!value || typeof value !== 'object') return
  if (typeof value.notesRoot === 'string' && typeof value.relativePath === 'string') {
    const move = moves.get(join(value.notesRoot, value.relativePath))
    if (move) value.relativePath = move.newPath
  }
  if (value.resolutions && value.files?.length) {
    const root = value.files[0].after.notesRoot
    value.resolutions = Object.fromEntries(Object.entries(value.resolutions).map(([path, resolution]) => [moves.get(join(root, path))?.newPath ?? path, resolution]))
  }
  for (const child of Object.values(value)) remap(child)
}

try {
  const state = await store.read()
  if (state.nativeRequests?.some(row => ['pending', 'queued', 'running', 'waiting', 'candidate'].includes(row.status))
    || state.items.some(item => item.production?.status === 'running')) throw new Error('Stop active production before organizing Notes')
  const backup = await store.migration.backup({ reuse: false })
  const versions = state.items.flatMap(item => [item, ...Object.values(item.otherLang ?? {}).map(version => ({ ...version, id: item.id }))])
  for (const version of versions) {
    const reference = version.content
    if (!reference || reference.relativePath !== `works/${encodeURIComponent(version.id)}-${reference.language}.md`) continue
    const path = unusedPath(reference.notesRoot, 'works', version.title, '.md', version.id + ':' + reference.language, reserve.get(reference.notesRoot))
    addMove(reference.notesRoot, reference.relativePath, path)
  }
  for (const root of store.notes.roots) for (const path of await files(join(root, 'history'))) {
    const oldPath = path.slice(root.length + 1)
    const hidden = '.media-desk/' + oldPath
    const next = unusedPath(root, dirname(hidden), basename(hidden, '.md'), '.md', oldPath, reserve.get(root))
    addMove(root, oldPath, next)
  }
  const mediaRecords = (await files(join(store.root, 'media-writes'))).filter(path => path.endsWith('/pending.json'))
  for (const path of mediaRecords) {
    const record = JSON.parse(await readFile(path, 'utf8'))
    if (!state.mediaReferences?.[record.id]) continue
    if (record.relativePath !== `assets/${encodeURIComponent(record.workId)}/${record.id}${record.ext}`) continue
    const work = versions.find(version => version.id === record.workId && version.content?.language === record.language)
    if (!work) throw new Error('Accepted media has no registered work: ' + record.id)
    const workPath = moves.get(join(work.content.notesRoot, work.content.relativePath))?.newPath ?? work.content.relativePath
    const folder = readableName(basename(workPath, '.md'))
    const name = record.target === 'cover' ? 'cover' : record.target.replace(':', '-').replace(/-(\d+)$/, (_, n) => '-' + String(Number(n) + 1).padStart(2, '0'))
    const next = unusedPath(record.notesRoot, `assets/${folder}`, name, record.ext, record.id, reserve.get(record.notesRoot))
    addMove(record.notesRoot, record.relativePath, next)
  }
  const jsonFiles = (await files(store.root)).filter(path => path.endsWith('.json') && !path.includes('/notes-migrations/'))
  const documents = new Map()
  const originals = new Map()
  for (const path of jsonFiles) {
    const bytes = await readFile(path, 'utf8')
    originals.set(path, bytes)
    const value = JSON.parse(bytes)
    remap(value)
    documents.set(path, value)
  }
  for (const value of documents.values()) {
    const visit = row => {
      if (!row || typeof row !== 'object') return
      if (row.changes?.relativePath?.startsWith('undo/')) {
        const changes = documents.get(join(store.filesDir, row.changes.relativePath))
        if (changes) row.changes.sha256 = hash(JSON.stringify(changes))
      }
      for (const child of Object.values(row)) visit(child)
    }
    visit(value)
  }
  await writeFile(join(dirname(backup.path), 'organization.json'), JSON.stringify([...moves.values()], null, 2), { flag: 'wx', mode: 0o600 })
  const moved = []
  const rewritten = []
  try {
    for (const move of moves.values()) {
      const source = join(move.notesRoot, move.oldPath)
      const target = join(move.notesRoot, move.newPath)
      await store.notes.createDirectory(move.notesRoot, dirname(move.newPath))
      try { await lstat(target); throw new Error('Refusing to overwrite ' + target) } catch (error) { if (error.code !== 'ENOENT') throw error }
      await rename(source, target)
      moved.push(move)
    }
    for (const [path, value] of documents) {
      await writeFileAtomic(path, JSON.stringify(value), { mode: 0o600 })
      rewritten.push(path)
    }
  } catch (error) {
    const failures = [error]
    for (const move of moved.reverse()) {
      try {
        const source = join(move.notesRoot, move.oldPath)
        try { await lstat(source); throw new Error('Refusing to overwrite ' + source) } catch (cause) { if (cause.code !== 'ENOENT') throw cause }
        await rename(join(move.notesRoot, move.newPath), source)
      } catch (cause) { failures.push(cause) }
    }
    for (const path of rewritten.reverse()) {
      try { await writeFileAtomic(path, originals.get(path), { mode: 0o600 }) } catch (cause) { failures.push(cause) }
    }
    throw new AggregateError(failures, 'Notes organization failed; verified backup: ' + backup.path)
  }
  await store.refresh()
  await store.writes.load()
  await store.read()
  for (const record of store.writes.records) await store.writes.save(record)
  await pruneNotesHistory(store)
  const current = await store.read()
  for (const reference of Object.values(current.mediaReferences ?? {})) {
    if (hash(await store.notes.readBytes(reference, { binary: true })) !== reference.sha256) throw new Error('Media verification failed')
  }
  for (const root of store.notes.roots) for (const directory of [join(root, 'history'), ...new Set([...moves.values()].filter(move => move.notesRoot === root).map(move => dirname(join(root, move.oldPath))))].sort((a, b) => b.length - a.length)) {
    try { await rmdir(directory) } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error }
  }
  console.log(JSON.stringify({ backup: backup.path, moved: moves.size, works: current.items.filter(item => item.content).length, media: Object.keys(current.mediaReferences ?? {}).length }))
} finally {
  await owner.drain()
  await owner.release()
}
