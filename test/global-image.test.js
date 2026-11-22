/** The global image skill executes from a detached folder with no Media Desk runtime. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'

const execute = promisify(execFile)
const skill = new URL('../skills/image-generation/', import.meta.url)
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3foAAAAASUVORK5CYII=', 'base64')

test('生图 skill 单独复制后能生成并保存回执，重复目录不请求，失败不泄露密钥', async t => {
  const root = await mkdtemp(join(tmpdir(), 'global-image-skill-'))
  let server
  t.after(async () => { server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }) })
  await cp(skill, join(root, 'skill'), { recursive: true })
  let calls = 0
  const key = 'private-isolated-image-key'
  server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    calls += 1
    assert.equal(req.headers.authorization, 'Bearer ' + key)
    assert.equal(JSON.parse(Buffer.concat(chunks)).prompt, 'A paper boat; no reference image is required.')
    res.setHeader('content-type', 'application/json')
    if (req.url.startsWith('/denied')) { res.statusCode = 401; res.end(JSON.stringify({ error: { message: 'Rejected ' + key } })); return }
    if (req.url.startsWith('/error')) { res.statusCode = 500; res.end(JSON.stringify({ error: { message: 'x'.repeat(290) + key } })); return }
    res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = 'http://127.0.0.1:' + server.address().port
  const config = join(root, 'private-config.json')
  const prompt = join(root, 'prompt.txt')
  await writeFile(config, JSON.stringify({ baseUrl, model: 'fixture', apiKeyEnv: 'ISOLATED_IMAGE_KEY' }), { mode: 0o600 })
  await writeFile(prompt, 'A paper boat; no reference image is required.')
  const run = out => execute(process.execPath, [join(root, 'skill/scripts/generate.mjs'), '--config', config, '--prompt-file', prompt, '--out', out], {
    cwd: root, env: { ...process.env, XDG_CONFIG_HOME: join(root, 'config'), ISOLATED_IMAGE_KEY: key }, timeout: 20000,
  })
  const output = join(root, 'result')
  const result = JSON.parse((await run(output)).stdout)
  assert.deepEqual(await readFile(result.file), png)
  const receipt = JSON.parse(await readFile(result.receiptFile, 'utf8'))
  assert.equal(receipt.status, 'saved')
  assert.equal(receipt.model, 'fixture')
  assert.equal(calls, 1)
  assert.ok(!JSON.stringify(receipt).includes(key))
  await assert.rejects(run(output), /EEXIST/)
  assert.equal(calls, 1)
  await writeFile(config, JSON.stringify({ baseUrl: baseUrl + '/denied', model: 'fixture', apiKeyEnv: 'ISOLATED_IMAGE_KEY' }), { mode: 0o600 })
  const denied = join(root, 'denied')
  await assert.rejects(run(denied), error => !error.stderr.includes(key) && error.stderr.includes('密钥无效'))
  assert.equal(calls, 2)
  const failure = await readFile(join(denied, 'receipt.json'), 'utf8')
  assert.match(failure, /uncertain/)
  assert.ok(!failure.includes(key))
  await assert.rejects(run(denied), /EEXIST/)
  assert.equal(calls, 2)
  await writeFile(config, JSON.stringify({ baseUrl: baseUrl + '/error', model: 'fixture', apiKeyEnv: 'ISOLATED_IMAGE_KEY' }), { mode: 0o600 })
  const serviceError = join(root, 'service-error')
  await assert.rejects(run(serviceError), error => !error.stderr.includes('private-is') && error.stderr.includes('500'))
  assert.equal(calls, 4)
  assert.ok(!(await readFile(join(serviceError, 'receipt.json'), 'utf8')).includes('private-is'))
  await writeFile(config, '{"apiKey":"' + key + '" INVALID}', { mode: 0o600 })
  await assert.rejects(run(join(root, 'invalid-config')), error => !error.stderr.includes(key) && error.stderr.includes('valid JSON'))
  assert.equal(calls, 4)
})

test('生图读取全局与项目 .env，支持指定环境文件和模型，导出环境优先且缺配置不请求', async t => {
  const root = await mkdtemp(join(tmpdir(), 'global-image-env-'))
  let server
  t.after(async () => { server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }) })
  await cp(skill, join(root, 'skill'), { recursive: true })
  const requests = []
  server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    requests.push({ path: req.url, key: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) })
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = 'http://127.0.0.1:' + server.address().port
  const envFile = join(root, '.env')
  const key = 'private-env-$key#value'
  const prompt = join(root, 'prompt.txt')
  await writeFile(envFile, `IMAGE_URL="${baseUrl}/v1/images/generations" # full endpoint\nIMAGE_API_KEY='${key}'\n`, { mode: 0o600 })
  const originalEnv = await readFile(envFile, 'utf8')
  await writeFile(prompt, 'A paper boat.')
  const env = { ...process.env, XDG_CONFIG_HOME: join(root, 'config') }
  for (const name of ['IMAGE_URL', 'IMAGE_API_KEY', 'IMAGE_MODEL']) delete env[name]
  const run = (name, args = [], options = {}) => execute(process.execPath,
    [join(root, 'skill/scripts/generate.mjs'), '--prompt-file', prompt, '--out', join(root, name), ...args],
    { cwd: root, env, timeout: 20000, ...options })
  const result = JSON.parse((await run('default')).stdout)
  assert.deepEqual(await readFile(result.file), png)
  assert.equal(result.model, 'gpt-image-2')
  assert.deepEqual(requests[0], { path: '/v1/images/generations', key: 'Bearer ' + key,
    body: { model: 'gpt-image-2', prompt: 'A paper boat.', n: 1 } })
  assert.ok(!(await readFile(result.receiptFile, 'utf8')).includes(key))
  const other = join(root, 'other')
  await mkdir(other)
  await run('explicit-env', ['--dotenv', envFile, '--model', 'chosen-model'], { cwd: other })
  assert.equal(requests[1].body.model, 'chosen-model')
  await run('exported', [], { env: { ...env, IMAGE_URL: baseUrl + '/override', IMAGE_API_KEY: 'exported-key', IMAGE_MODEL: 'exported-model' } })
  assert.equal(requests[2].path, '/override/images/generations')
  assert.equal(requests[2].key, 'Bearer exported-key')
  assert.equal(requests[2].body.model, 'exported-model')
  await assert.rejects(run('missing', [], { cwd: other }), error => error.stderr.includes('IMAGE_URL and IMAGE_API_KEY'))
  await assert.rejects(run('missing-env', ['--dotenv', join(root, 'absent.env')]), error => error.stderr.includes('Cannot read image environment file'))
  assert.equal(requests.length, 3)
  const globalDirectory = join(env.XDG_CONFIG_HOME, 'image-generation')
  await mkdir(globalDirectory, { recursive: true })
  await writeFile(join(globalDirectory, '.env'), `IMAGE_URL=${baseUrl}/global\nIMAGE_API_KEY=global-key\nIMAGE_MODEL=global-model\n`, { mode: 0o600 })
  await run('global', [], { cwd: other })
  assert.equal(requests[3].path, '/global/images/generations')
  assert.equal(requests[3].key, 'Bearer global-key')
  assert.equal(requests[3].body.model, 'global-model')
  await run('project-over-global')
  assert.equal(requests[4].path, '/v1/images/generations')
  assert.equal(requests[4].key, 'Bearer ' + key)
  await run('explicit-over-global', ['--dotenv', envFile], { cwd: other })
  assert.equal(requests[5].key, 'Bearer ' + key)
  await run('exported-over-global', [], { cwd: other, env: { ...env, IMAGE_URL: baseUrl + '/exported', IMAGE_API_KEY: 'exported-key' } })
  assert.equal(requests[6].path, '/exported/images/generations')
  assert.equal(requests[6].key, 'Bearer exported-key')
  assert.equal(requests.length, 7)
  assert.equal(await readFile(envFile, 'utf8'), originalEnv)
})
