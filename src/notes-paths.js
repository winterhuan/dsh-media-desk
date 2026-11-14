/** Readable Notes and media paths; directory owners publish planned filenames exclusively. */
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'

/** Maximum recent history and undo entries; live references and conflicts retain their files. */
export const HISTORY_LIMIT = 5
/**
 * @param {string} id - Work or managed subject identity.
 * @returns {string} Relative internal history directory.
 */
export const historyDirectory = id => `.media-desk/history/${encodeURIComponent(id)}`

/**
 * @param {string} title - Work title or preferred file stem.
 * @returns {string} Normalized bounded stem, with Untitled for an empty title.
 */
export function readableName(title) {
  return String(title ?? '').normalize('NFC').replace(/[\u0000-\u001f\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 60) || 'Untitled'
}

/**
 * Plan an unused filename, checking case-insensitive names; publication must still create exclusively.
 * @param {string} root - Owned Notes root.
 * @param {string} directory - Relative destination directory.
 * @param {string} name - Preferred file stem.
 * @param {string} ext - File extension including its dot.
 * @param {string} identity - Stable identity for collision suffixes.
 * @param {string[]} [reserved] - Other paths planned by the current write.
 * @returns {string} Relative path without adopting an existing file.
 */
export function unusedPath(root, directory, name, ext, identity, reserved = []) {
  const stem = readableName(name)
  let existing = []
  try { existing = readdirSync(join(root, directory)).map(name => name.normalize('NFC').toLowerCase()) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const short = createHash('sha256').update(identity).digest('hex').slice(0, 6)
  for (let index = 0; ; index++) {
    const path = `${directory}/${stem}${index ? '-' + short + (index > 1 ? '-' + index : '') : ''}${ext}`
    if (existing.includes(path.slice(directory.length + 1).normalize('NFC').toLowerCase())) continue
    if (reserved.some(value => value.normalize('NFC').toLowerCase() === path.toLowerCase())) continue
    try { lstatSync(join(root, path)) } catch (error) { if (error.code === 'ENOENT') return path; throw error }
  }
}

/**
 * @param {object} work - Registered work with its current Notes reference.
 * @param {string} target - Cover, illustration or storyboard target.
 * @param {string} ext - Detected image extension.
 * @param {string} id - Retained media identity.
 * @returns {string} Planned asset path grouped under the work filename.
 */
export function mediaPath(work, target, ext, id) {
  const name = target === 'cover' ? 'cover' : target.replace(':', '-').replace(/-(\d+)$/, (_, n) => '-' + String(Number(n) + 1).padStart(2, '0'))
  const folder = readableName(basename(work.content.relativePath, '.md'))
  return unusedPath(work.content.notesRoot, `assets/${folder}`, name, ext, id)
}
