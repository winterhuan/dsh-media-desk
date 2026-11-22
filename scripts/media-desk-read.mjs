#!/usr/bin/env node
/** npm CLI for read-only work inspection and file validation. */
import { parseArgs } from 'node:util'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { DeskReader } from '../src/desk-reader.js'

/** @param {string[]} argv - read/validate and location options. @returns {Promise<void>} Prints JSON; never writes files. */
export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    'data-root': { type: 'string' }, wiki: { type: 'string' }, kind: { type: 'string', default: 'works' },
    id: { type: 'string' }, file: { type: 'string' }, sha256: { type: 'string' },
    offset: { type: 'string', default: '0' }, limit: { type: 'string', default: '12000' }, help: { type: 'boolean' },
  } })
  if (values.help || !positionals.length) {
    console.log('media-desk read [--kind works|work|preferences|materials|metrics|people] [--id <id>] [--file <path>]\nmedia-desk validate --file <path> [--sha256 <expected-hash>]\nOptions: --data-root <plugin-data-directory> --wiki <wiki-directory> --offset <characters> --limit <1-20000>. Agent edits files directly; read and validate never save, register, repair or accept content.')
    return
  }
  const action = positionals[0]
  if (positionals.length !== 1 || !['read', 'validate'].includes(action)) throw new Error('Use read or validate; write operations are not available')
  if (action === 'validate' && !values.file) throw new Error('validate requires --file')
  if (values.sha256 && !/^[a-f0-9]{64}$/.test(values.sha256)) throw new Error('sha256 must be a lowercase SHA-256 fingerprint')
  const offset = Number(values.offset), limit = Number(values.limit)
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20000) throw new Error('Use a nonnegative offset and a limit of 1–20000 characters')
  const reader = await new DeskReader({
    dataRoot: values['data-root'] ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'media-desk'),
    wikiRoot: values.wiki ?? process.env.WIKI_PATH ?? join(homedir(), 'wiki'),
  }).load()
  const result = action === 'validate' ? await reader.file(values.file, values.sha256)
    : await reader.read({ kind: values.kind, id: values.id, file: values.file })
  if (action === 'validate') { delete result.text; delete result.metadata; delete result.body; delete result.value }
  const text = JSON.stringify(result)
  console.log(text.length <= limit && offset === 0 ? text : JSON.stringify({ text: text.slice(offset, offset + limit),
    nextOffset: offset + limit < text.length ? offset + limit : null, totalCharacters: text.length }))
  if (action === 'validate' && !result.valid) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch(error => { console.error(JSON.stringify({ error: error.message, code: error.code })); process.exitCode = 1 })
}
