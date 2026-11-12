/** Isolated official Web assembly driven through Media Desk HTTP and native Session RPC. */
import { execFile, spawn } from 'node:child_process'
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'

const execute = promisify(execFile)
const repository = fileURLToPath(new URL('../../', import.meta.url))
const model = fileURLToPath(new URL('./native-model.js', import.meta.url))
const profile = 'media-desk-test'

/**
 * Install the built package into a private official Web profile.
 * @param {object} t - Node test context which owns cleanup.
 * @param {object} [options] - External model recipes and environment overrides.
 * @returns {Promise<object>} Fixture with Host and native RPC callers, restart and cleanup.
 */
export async function nativeRuntime(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'media-desk-native-'))
  const wiki = join(root, 'wiki')
  const home = join(root, 'home')
  const agents = join(root, 'agents')
  const telemetryPath = join(root, 'model-requests.jsonl')
  const overlay = join(root, 'overlay.json')
  const env = { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: agents, WIKI_PATH: wiki, ...options.env }
  let child, exited, cookie, baseUrl
  const connections = new Set()
  let log = ''
  const stop = async () => {
    await Promise.all([...connections].map(close => close()))
    if (!child) return
    const current = child
    child = undefined
    current.kill('SIGTERM')
    const deadline = setTimeout(() => current.kill('SIGKILL'), 8000)
    try { await exited } finally { clearTimeout(deadline) }
  }
  t.after(async () => {
    await stop()
    await rm(root, { recursive: true, force: true })
  })
  await Promise.all([mkdir(wiki), mkdir(agents), mkdir(join(root, 'documents'))])
  await cp(fileURLToPath(new URL('./llm-wiki', import.meta.url)), join(agents, 'skills', 'llm-wiki'), { recursive: true })
  await writeFile(join(wiki, 'AGENTS.md'), 'Use the llm-wiki skill. Keep source dates and uncertainty.\n')
  const dsh = (...args) => execute('dsh', args, { cwd: wiki, env, timeout: 60000, maxBuffer: 8 * 1024 * 1024 })
  await dsh('--profile', profile, '--from-default-profile', 'web', '--dump-config')
  await dsh('plugin', '--profile', profile, 'add', 'link:' + repository)

  const start = async (patch = [], environment = {}) => {
    if (child) throw new Error('Stop the fixture before restarting it')
    await writeFile(overlay, JSON.stringify([
      { id: 'agent-default-model', config: { provider: 'media-desk-fixture', model: 'native-fixture' } },
      { id: 'workspace-controller', config: { documentsDirectory: join(root, 'documents') } },
      { insert: [{ id: 'media-desk-model-fixture', name: model, config: { recipes: options.recipes ?? {}, telemetryPath } }] },
      ...patch,
    ]))
    log = ''
    const port = options.reusePort && baseUrl ? new URL(baseUrl).port : '0'
    child = spawn('dsh', ['--profile', profile, '--patch', overlay, '--host', '127.0.0.1', '--port', port, '--no-open'], {
      cwd: wiki, env: { ...env, ...environment }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const current = child
    exited = new Promise((resolve, reject) => {
      current.once('error', reject)
      current.once('exit', (code, signal) => resolve({ code, signal }))
    })
    const authenticatedUrl = await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => finish(new Error('Web readiness timed out\n' + log)), 60000)
      const finish = (error, url) => {
        clearTimeout(deadline)
        current.stdout.off('data', output)
        current.stderr.off('data', output)
        current.off('exit', earlyExit)
        current.off('error', finish)
        error ? reject(error) : resolve(url)
      }
      const output = chunk => {
        log = (log + chunk.toString()).slice(-4 * 1024 * 1024)
        const url = /http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s\u001b]+/.exec(log)?.[0]
        if (url) finish(null, url)
      }
      const earlyExit = (code, signal) => finish(new Error('Web exited before readiness: ' + code + '/' + signal + '\n' + log))
      current.stdout.on('data', output)
      current.stderr.on('data', output)
      current.once('error', finish)
      current.once('exit', earlyExit)
    })
    current.stdout.on('data', chunk => { log = (log + chunk.toString()).slice(-4 * 1024 * 1024) })
    current.stderr.on('data', chunk => { log = (log + chunk.toString()).slice(-4 * 1024 * 1024) })
    baseUrl = new URL(authenticatedUrl).origin
    const login = await fetch(authenticatedUrl, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
    cookie = login.headers.get('set-cookie')?.split(';')[0]
    if (login.status !== 303 || !cookie) throw new Error('Fixture login failed: ' + login.status)
    await login.arrayBuffer()
    return baseUrl
  }
  const host = async (path, body) => {
    const response = await fetch(baseUrl + '/media-desk/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000),
    })
    return { status: response.status, value: await response.json() }
  }
  const rpc = async (endpoint, args) => {
    const response = await fetch(baseUrl + '/api/' + endpoint, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args } }),
      signal: AbortSignal.timeout(60000),
    })
    if (!response.ok) throw new Error(endpoint + ' HTTP ' + response.status + ': ' + await response.text())
    return (await response.json()).result
  }
  const events = async sessionId => {
    const page = await rpc('session/events', { request: { address: { kind: 'session', sessionId }, maxMessages: 1000 } })
    if (!page.ok) throw new Error(JSON.stringify(page.error))
    return page.value.records.filter(record => record.type === 'event').map(record => record.event)
  }
  const interactions = async () => {
    const socket = new WebSocket(baseUrl.replace(/^http/, 'ws') + '/api/remote.mux', { headers: { cookie, origin: baseUrl } })
    const closed = new Promise(resolve => socket.once('close', resolve))
    const streamId = randomUUID()
    const frames = []
    let clientId, waiter, resolveReady, rejectReady
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
    const fail = error => {
      rejectReady(error)
      if (waiter) { waiter.reject(error); waiter = undefined }
    }
    const close = async () => {
      connections.delete(close)
      if (socket.readyState === WebSocket.CLOSED) return
      socket.close()
      const deadline = setTimeout(() => socket.terminate(), 8000)
      try { await closed } finally { clearTimeout(deadline) }
    }
    connections.add(close)
    socket.on('error', fail)
    socket.on('close', () => fail(new Error('Native Remote event stream closed')))
    socket.on('open', () => socket.send(JSON.stringify({ type: 'open', streamId, endpoint: '$events', payload: { args: {} } })))
    socket.on('message', data => {
      let frame
      try { frame = JSON.parse(data.toString()) } catch (error) { fail(error); return }
      if (frame.type === 'error') { fail(new Error(JSON.stringify(frame.error))); return }
      if (frame.type !== 'item') return
      const value = frame.value
      if (value.type === 'ready') { clientId = value.clientId; resolveReady(); return }
      if (value.type !== 'waterfall') return
      if (waiter && waiter.event === value.event && waiter.agentId === value.agentId) {
        waiter.resolve(value)
        waiter = undefined
      } else frames.push(value)
    })
    const deadline = setTimeout(() => fail(new Error('Native Remote event stream readiness timed out')), 15000)
    try { await ready } finally { clearTimeout(deadline) }
    return {
      close,
      next: async (event, agentId) => {
        const index = frames.findIndex(frame => frame.event === event && frame.agentId === agentId)
        if (index >= 0) return frames.splice(index, 1)[0]
        if (waiter) throw new Error('One interaction wait at a time')
        let timer
        try {
          return await new Promise((resolve, reject) => {
            waiter = { event, agentId, resolve, reject }
            timer = setTimeout(() => { waiter = undefined; reject(new Error('Native event timed out: ' + event)) }, 15000)
          })
        } finally { clearTimeout(timer) }
      },
      answer: async (frame, value) => {
        const result = await rpc('$events/result', { clientId, eventId: frame.eventId, outcome: { kind: 'result', value } })
        if (!result.ok) throw new Error(JSON.stringify(result.error))
      },
    }
  }
  const prompt = async (sessionId, message) => {
    const requestId = randomUUID()
    const accepted = await rpc('session/prompt', { request: { sessionId, requestId, mode: 'queue', content: [{ type: 'text', text: message }] } })
    if (!accepted.ok) throw new Error(JSON.stringify(accepted.error))
    return requestId
  }
  const turn = async (sessionId, requestId) => {
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
      const log = await events(sessionId)
      const index = log.findIndex(event => event.type === 'user/message' && event.data.source?.rpcId === requestId)
      if (index >= 0) {
        const start = log.slice(0, index).findLast(event => event.type === 'turn/start')
        const end = log.find(event => event.type === 'turn/end' && event.data.turn === start?.data.turn)
        if (end) return { start, end, events: log.filter(event => event.seq >= start.seq && event.seq <= end.seq) }
      }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error('Native input did not reach a persisted turn end: ' + requestId + '\n' + log)
  }
  return { root, wiki, home, agents, telemetryPath, dsh, start, stop, host, rpc, events, interactions, prompt, turn, get url() { return baseUrl }, get log() { return log } }
}
