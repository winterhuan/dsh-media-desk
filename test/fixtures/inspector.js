/** External source breakpoints observe actual filesystem steps without replacing their owners. */
import assert from 'node:assert/strict'
import WebSocket from 'ws'

/**
 * Attach to the owned runtime's atomically allocated Inspector listener.
 * @param {object} t - Test context owning awaited socket cleanup.
 * @param {object} runtime - Actual DSH process started with NODE_OPTIONS=--inspect=127.0.0.1:0.
 * @returns {Promise<object>} Inspector requests, source breakpoints and observed pauses.
 */
export async function inspectRuntime(t, runtime) {
  const url = /ws:\/\/127\.0\.0\.1:\d+\/[\w-]+/.exec(runtime.log)?.[0]
  assert.ok(url, 'The owned runtime must expose its allocated Inspector endpoint')
  const socket = new WebSocket(url)
  const closed = new Promise(resolve => socket.once('close', resolve))
  const requests = new Map()
  const events = []
  const waits = new Set()
  const scripts = new Map()
  let counter = 0
  const fail = error => {
    for (const request of requests.values()) request.reject(error)
    requests.clear()
    for (const wait of waits) { clearTimeout(wait.timer); wait.reject(error) }
    waits.clear()
  }
  socket.on('error', fail)
  socket.on('close', () => fail(new Error('Inspector connection closed')))
  socket.on('message', bytes => {
    const message = JSON.parse(bytes.toString())
    if (message.id) {
      const request = requests.get(message.id)
      requests.delete(message.id)
      if (request) message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result)
      return
    }
    if (message.method === 'Debugger.scriptParsed') scripts.set(message.params.scriptId, message.params)
    for (const wait of waits) {
      if (wait.method !== message.method || !wait.predicate(message.params)) continue
      waits.delete(wait)
      clearTimeout(wait.timer)
      wait.resolve(message.params)
      return
    }
    events.push(message)
  })
  const close = async () => {
    release()
    if (socket.readyState === WebSocket.CLOSED) return
    socket.close()
    const timer = setTimeout(() => socket.terminate(), 2000)
    try { await closed } finally { clearTimeout(timer) }
  }
  // A deliberate crash must kill the paused child before disconnecting its debugger.
  const release = runtime.trackConnection(signal => signal === 'SIGKILL' ? undefined : close())
  t.after(close)
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  const client = {
    scripts, close,
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++counter
        const timer = setTimeout(() => { requests.delete(id); reject(new Error('Inspector request timed out: ' + method)) }, 20000)
        requests.set(id, { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } })
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
    next(method, predicate = () => true) {
      const index = events.findIndex(event => event.method === method && predicate(event.params))
      if (index >= 0) return Promise.resolve(events.splice(index, 1)[0].params)
      return new Promise((resolve, reject) => {
        const wait = { method, predicate, resolve, reject }
        wait.timer = setTimeout(() => { waits.delete(wait); reject(new Error('Inspector event timed out: ' + method)) }, 20000)
        waits.add(wait)
      })
    },
    async breakAt(suffix, snippet, condition, occurrence = 0) {
      const script = [...scripts.values()].find(row => row.url.endsWith(suffix))
      assert.ok(script, 'The production source must already be loaded: ' + suffix)
      const source = (await client.send('Debugger.getScriptSource', { scriptId: script.scriptId })).scriptSource.split('\n')
      const matches = source.map((line, index) => line.includes(snippet) ? index : -1).filter(index => index >= 0)
      const line = matches[occurrence]
      assert.ok(line >= 0, 'The requested executable source point must exist: ' + snippet)
      const breakpoint = await client.send('Debugger.setBreakpointByUrl', { url: script.url, lineNumber: line, condition })
      assert.ok(breakpoint.locations.some(location => location.lineNumber === line), 'The breakpoint must resolve to the selected statement')
      return {
        id: breakpoint.breakpointId,
        next: () => client.next('Debugger.paused', event => event.hitBreakpoints?.includes(breakpoint.breakpointId)),
        remove: () => client.send('Debugger.removeBreakpoint', { breakpointId: breakpoint.breakpointId }),
      }
    },
    async value(paused, expression) {
      const result = await client.send('Debugger.evaluateOnCallFrame', { callFrameId: paused.callFrames[0].callFrameId, expression, returnByValue: true })
      assert.equal(result.exceptionDetails, undefined, expression)
      return result.result.value
    },
  }
  await client.send('Runtime.enable')
  await client.send('Debugger.enable')
  return client
}
