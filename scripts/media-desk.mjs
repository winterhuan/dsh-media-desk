#!/usr/bin/env node
/** Execute Media Desk actions using a running Host or its offline storage kernel. */
import { parseArgs } from 'node:util'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { WriteOwner } from '../src/write-owner.js'
import { Store } from '../src/store.js'
import { Notes } from '../src/notes.js'
import { Settings, imageReady } from '../src/settings.js'
import { Producer } from '../src/produce.js'
import { MediaFiles } from '../src/media-files.js'
import { SkillDesk } from '../src/skill-desk.js'
import { generateImage } from '../src/images.js'
import { exportSkill } from '../src/learn.js'
import { withLang } from '../src/i18n.js'

async function loginUrl(base, logFile) {
  if (process.env.MEDIA_DESK_LOGIN_URL) return process.env.MEDIA_DESK_LOGIN_URL
  let logs = logFile ? [resolve(logFile)] : []
  if (!logs.length && base === 'http://127.0.0.1:3085') {
    const dir = join(homedir(), '.dsh/installations/dsh-media/.artifacts')
    try { logs = (await readdir(dir)).filter(name => /^dsh-media-.*\.log$/.test(name)).sort().reverse().slice(0, 1).map(name => join(dir, name)) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  for (const file of logs) {
    const text = await readFile(file, 'utf8')
    const urls = text.match(/https?:\/\/[^\s]+\/\?token=[A-Za-z0-9_-]+/g) ?? []
    const matching = urls.filter(url => new URL(url).origin === new URL(base).origin)
    if (matching.length) return matching.at(-1)
  }
  return null
}

async function connect(base, logFile, language) {
  const login = await loginUrl(base, logFile)
  if (!login) return null
  if (new URL(login).origin !== new URL(base).origin) throw new Error('Login URL belongs to a different Host')
  const response = await fetch(login, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
  if (![302, 303].includes(response.status)) throw new Error('Host login failed; refresh the live login log')
  const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  if (!cookie) throw new Error('Host login did not issue a session cookie')
  return async (path, args) => {
    const result = await fetch(base + '/media-desk/' + path, { method: args === undefined ? 'GET' : 'POST',
      headers: { cookie, origin: base, 'content-type': 'application/json', 'x-media-desk-lang': language },
      ...(args === undefined ? {} : { body: JSON.stringify(args) }), signal: AbortSignal.timeout(60000) })
    const body = await result.json()
    if (!result.ok) throw Object.assign(new Error(body.error ?? 'Host request failed'), { code: body.code, pendingId: body.pendingId, status: result.status })
    return body
  }
}

async function offline(home, wiki, action, args) {
  const owner = new WriteOwner(join(home, 'media-desk'), wiki)
  const timeout = setTimeout(() => owner.controller.abort(), 5000)
  let producer
  try {
    await owner.acquire()
    clearTimeout(timeout)
    const store = new Store(owner.dataRoot, owner)
    store.notes = new Notes(owner)
    store.syncDerivedSkill = state => exportSkill(state, home, { existingOnly: true })
    await store.notes.init()
    await store.read()
    const settings = new Settings(store.root, owner, store)
    const mediaFiles = new MediaFiles(store)
    producer = new Producer({ store, settings, ready: saved => imageReady(saved, false), generate: generateImage })
    producer.media = mediaFiles
    const desk = new SkillDesk({ store, settings, producer, mediaFiles })
    const result = await desk.execute(action, args)
    while (producer.pending.size) await Promise.allSettled([...producer.pending])
    await owner.drain()
    return result
  } finally {
    clearTimeout(timeout)
    await producer?.close()
    owner.beginShutdown()
    await owner.drain()
    await owner.release()
  }
}

/** @param {string[]} argv - CLI arguments. @returns {Promise<void>} Writes a bounded result or a private result-file reference. */
export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    mode: { type: 'string', default: 'auto' }, home: { type: 'string' }, wiki: { type: 'string' },
    url: { type: 'string', default: 'http://127.0.0.1:3085' }, 'login-log': { type: 'string' },
    input: { type: 'string' }, out: { type: 'string' }, lang: { type: 'string', default: 'zh' }, help: { type: 'boolean' },
  } })
  if (values.help || !positionals.length) {
    console.log('media-desk <action> --input <JSON-file> [--mode auto|standalone|plugin] [--home <DSH_HOME>] [--wiki <Wiki>] [--out <result-file>]\nActions: read begin commit ops rules style cancel capture asset redraw revise upload export insights settings validate undo voice-export recovery retry version resolve register language migrate\nplugin-only: api (input: {path, body?}); credentials come from the live login log or MEDIA_DESK_LOGIN_URL.')
    return
  }
  if (!['auto', 'standalone', 'plugin'].includes(values.mode)) throw new Error('mode must be auto, standalone or plugin')
  const args = values.input ? JSON.parse(await readFile(resolve(values.input), 'utf8')) : {}
  const home = resolve(values.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh/profiles/media/data'))
  const wiki = resolve(values.wiki ?? process.env.WIKI_PATH ?? join(homedir(), 'wiki'))
  process.env.DSH_HOME = home
  const action = positionals[0]
  let api
  // An explicit offline directory never falls through to a different running profile.
  if (values.mode !== 'standalone' && (!values.home && !values.wiki || values.mode === 'plugin')) {
    try { api = await connect(values.url.replace(/\/+$/, ''), values['login-log'], values.lang) }
    catch (error) { if (values.mode === 'plugin' || !['ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT'].includes(error.cause?.code)) throw error }
  }
  if (values.mode === 'plugin' && !api) throw new Error('No live login URL found; set --login-log or MEDIA_DESK_LOGIN_URL')
  if (action === 'api' && !api) throw new Error('Native Session and Host-only actions require plugin mode')
  if (action === 'api' && (!/^[\w/-]+(?:\?[^#]*)?$/.test(args.path ?? '') || args.path.includes('..'))) throw new Error('Invalid API path')
  const result = await withLang(values.lang, () => api ? (action === 'api' ? api(args.path, args.body) : api('skill', { action, args })) : offline(home, wiki, action, args))
  const text = JSON.stringify(result ?? { saved: true }, null, 2)
  if (values.out || text.length > 12000) {
    const file = resolve(values.out ?? join(tmpdir(), 'media-desk-result-' + randomUUID() + '.json'))
    await writeFile(file, text, { flag: 'wx', mode: 0o600 })
    console.log(JSON.stringify({ resultFile: file, characters: text.length }))
  } else console.log(text)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(JSON.stringify({ error: error.message, code: error.code, pendingId: error.pendingId })); process.exitCode = 1 })
}
