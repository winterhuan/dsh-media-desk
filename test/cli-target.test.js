import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readLoginUrl, resolveHostTarget } from '../src/cli-target.js'

const execute = promisify(execFile)
const cli = fileURLToPath(new URL('../scripts/media-desk.mjs', import.meta.url))
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'media-target-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const put = async (file, value) => {
    const path = join(root, file)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value))
    return path
  }
  return { root, put, environment: { root, platform: 'win32', loginUrl: '' } }
}

test('Windows discovers the installed daily Media Desk profile and its recorded port', async t => {
  const { root, put, environment } = await fixture(t)
  await put('services/windows-config.json', { dailyProfiles: ['student', 'web'] })
  await put('profiles/student/package.json', { dependencies: {} })
  await put('profiles/web/package.json', { dependencies: { '@winterhuan/dsh-media-desk': 'github:example/fixed' } })
  await put('services/windows-web.json', { profile: 'web', port: 4100 })
  const expected = { base: 'http://127.0.0.1:4100', logFile: join(root, 'logs/windows-web.log') }
  assert.deepEqual(await resolveHostTarget({}, environment), expected)
  await put('profiles/custom/package.json', { dependencies: { '@winterhuan/dsh-media-desk': 'link:local' } })
  await put('services/windows-custom.json', { profile: 'custom', port: 4101 })
  assert.equal((await resolveHostTarget({ profile: 'custom' }, environment)).base, 'http://127.0.0.1:4101')
  await put('services/windows-config.json', { dailyProfiles: ['web', 'custom'] })
  await assert.rejects(resolveHostTarget({}, environment), /Multiple Media Desk/)
  assert.deepEqual(await resolveHostTarget({ url: expected.base }, environment), expected)
  await assert.rejects(resolveHostTarget({ profile: '../web' }, environment), /Invalid profile/)
})

test('explicit targets and login logs override discovery; login tokens are origin-bound', async t => {
  const { put, environment } = await fixture(t)
  const log = await put('live.log', 'http://127.0.0.1:4102/?token=old\nhttp://127.0.0.1:4102/?token=current\nhttp://127.0.0.1:4103/?token=other\n')
  assert.equal(await readLoginUrl(log, 'http://127.0.0.1:4102'), 'http://127.0.0.1:4102/?token=current')
  assert.equal(await readLoginUrl(log, 'http://127.0.0.1:4999'), null)
  assert.deepEqual(await resolveHostTarget({ url: 'http://127.0.0.1:4102/', 'login-log': log }, environment), { base: 'http://127.0.0.1:4102', logFile: log })
  assert.equal((await resolveHostTarget({ 'login-log': log }, environment)).base, 'http://127.0.0.1:4103')
  assert.equal((await resolveHostTarget({}, { ...environment, loginUrl: 'http://127.0.0.1:4104/?token=private' })).base, 'http://127.0.0.1:4104')
})

test('other platforms retain the independent media service discovery', async t => {
  const { put, environment } = await fixture(t)
  const log = await put('installations/dsh-media/.artifacts/dsh-media-20261126.log', 'http://127.0.0.1:3085/?token=fixture')
  for (const platform of ['darwin', 'linux']) {
    assert.deepEqual(await resolveHostTarget({}, { ...environment, platform }), { base: 'http://127.0.0.1:3085', logFile: log })
  }
})

test('auto refuses a missing login or unavailable Host without initializing offline storage', async t => {
  const { root, environment } = await fixture(t)
  await assert.rejects(resolveHostTarget({}, environment), /No managed Media Desk/)
  const env = { ...process.env, DSH_HOME: join(root, 'home'), WIKI_PATH: join(root, 'wiki'), MEDIA_DESK_LOGIN_URL: '' }
  await assert.rejects(execute(process.execPath, [cli, 'read', '--url', 'http://127.0.0.1:1'], { env }), error => {
    assert.match(error.stderr, /No live login URL/)
    return true
  })
  await assert.rejects(execute(process.execPath, [cli, 'read', '--url', 'http://127.0.0.1:1'], { env: { ...env, MEDIA_DESK_LOGIN_URL: 'http://127.0.0.1:1/?token=fixture' } }))
  for (const path of [env.DSH_HOME, env.WIKI_PATH]) await assert.rejects(stat(path), { code: 'ENOENT' })
})
