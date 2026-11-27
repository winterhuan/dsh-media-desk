// GitHub issue 回归：#3 生图网关返回相对路径，#4 会话外调用缺少会话标识。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { generateImage, imageUrlCandidates } from '../src/images.js'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const GATEWAY = { baseUrl: 'http://gw.test:11435/qwenimage/v1', model: 'Qwen-Image-2.1', apiKey: 'secret-key-1234', size: '', quality: '', extra: '{"output_format":"png"}' }

test('#3 图片地址候选：保留挂载前缀，已带前缀和完整链接原样用，危险协议不要', () => {
  assert.deepEqual(imageUrlCandidates('/v1/images/x/content', GATEWAY.baseUrl), [
    'http://gw.test:11435/qwenimage/v1/images/x/content',
    'http://gw.test:11435/qwenimage/v1/v1/images/x/content',
    'http://gw.test:11435/v1/images/x/content',
  ])
  assert.deepEqual(imageUrlCandidates('/qwenimage/v1/images/x/content', GATEWAY.baseUrl), ['http://gw.test:11435/qwenimage/v1/images/x/content'])
  assert.deepEqual(imageUrlCandidates('/v1/images/x', 'https://api.example/v1'), ['https://api.example/v1/images/x'])
  assert.deepEqual(imageUrlCandidates('https://cdn.example/a.png', GATEWAY.baseUrl), ['https://cdn.example/a.png'])
  assert.deepEqual(imageUrlCandidates('javascript:alert(1)', GATEWAY.baseUrl), [])
  assert.deepEqual(imageUrlCandidates('', GATEWAY.baseUrl), [])
})

test('#3 网关返回 b64_json: null 和相对 url：跳过 404 的拼法，下到图，不重画', async () => {
  const seen = []
  const gateway = async (url, init) => {
    const href = String(url)
    seen.push([init?.method ?? 'GET', href, init?.headers?.authorization])
    if (href.endsWith('/images/generations')) return new Response(JSON.stringify({ data: [{ b64_json: null, url: '/v1/images/abc/content', file_path: '/srv/abc.png' }] }))
    if (href === 'http://gw.test:11435/qwenimage/v1/images/abc/content') return new Response(PNG)
    return new Response('not found', { status: 404 })
  }
  const result = await generateImage(GATEWAY, 'a paper boat', { fetchImpl: gateway })
  assert.equal(result.ext, '.png')
  assert.equal(seen.filter(([method]) => method === 'POST').length, 1)
  // 同源下载带上用户填的密钥
  assert.deepEqual(seen[1], ['GET', 'http://gw.test:11435/qwenimage/v1/images/abc/content', 'Bearer secret-key-1234'])
})

test('#3 地址确定拿不到时不重画，也不说成「连不上生图服务」', async () => {
  let posts = 0
  const missing = async (url) => {
    if (String(url).endsWith('/images/generations')) {
      posts += 1
      return new Response(JSON.stringify({ data: [{ b64_json: null, url: '/v1/images/abc/content' }] }))
    }
    return new Response('', { status: 404 })
  }
  await assert.rejects(generateImage(GATEWAY, 'p', { fetchImpl: missing }), err => /下载图片失败（404）/.test(err.message) && !/连不上/.test(err.message))
  assert.equal(posts, 1)

  posts = 0
  const garbage = async () => {
    posts += 1
    return new Response(JSON.stringify({ data: [{ url: 'http://' }] }))
  }
  await assert.rejects(generateImage(GATEWAY, 'p', { fetchImpl: garbage }), err => !/连不上/.test(err.message))
  assert.equal(posts, 1)

  const onlyPath = async () => new Response(JSON.stringify({ data: [{ b64_json: null, url: null, file_path: '/srv/abc.png' }] }))
  await assert.rejects(generateImage(GATEWAY, 'p', { fetchImpl: onlyPath }), /本机的文件路径/)
})

test('#3 别的域名的下载地址照样拦内网', async () => {
  const internal = async (url) => (String(url).endsWith('/images/generations')
    ? new Response(JSON.stringify({ data: [{ url: 'http://127.0.0.1/x.png' }] }))
    : new Response(PNG))
  await assert.rejects(generateImage(GATEWAY, 'p', { fetchImpl: internal }), /本机|内网/)
})

test('移除旧助手模型覆盖时保留设置，显示模型跟随原生默认', async t => {
  const { modelInfo } = await import('../src/ai.js')
  const { Settings } = await import('../src/settings.js')
  const { mkdtemp, rm, writeFile, readFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  let selection = { provider: 'deepseek', model: 'deepseek-chat' }
  const ctx = { get: name => (name === 'llm' ? {} : name === 'agentDefaultModel' ? { currentSelection: () => selection } : undefined) }
  assert.equal(modelInfo(ctx).model, 'deepseek-chat')
  selection = { provider: 'changed', model: 'new-default' }
  assert.equal(modelInfo(ctx).model, 'new-default')
  const dir = await mkdtemp(join(tmpdir(), 'media-desk-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'settings.json')
  const saved = { assistant: { provider: 'removed', model: 'missing' }, image: { apiKey: 'private-fixture' }, language: 'en', imageCount: 1 }
  await writeFile(file, JSON.stringify(saved))
  const settings = new Settings(dir)
  assert.equal(Object.hasOwn(await settings.read(), 'assistant'), false)
  delete saved.assistant
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), saved)
  await settings.update({ voice: 'x', assistant: { provider: 'removed', model: 'missing' } })
  assert.equal(Object.hasOwn(await settings.read(), 'assistant'), false)
  assert.equal((await settings.read()).image.apiKey, 'private-fixture')
})

test('#16 Notes exports retain external edits and isolate same-title snapshots', async t => {
  const { saveProduction } = await import('../src/export.js')
  const dir = await mkdtemp(join(tmpdir(), 'media-export-upstream-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const options = { filesDir: dir, exportDir: join(dir, 'out') }
  const work = { title: 'Same title', article: 'First draft' }
  const first = await saveProduction(work, options)
  await writeFile(join(first.path, '脚本.md'), 'Externally edited draft')
  const second = await saveProduction({ ...work, article: 'Second draft', savedPath: first.path }, options)
  assert.notEqual(second.path, first.path)
  assert.equal(await readFile(join(first.path, '脚本.md'), 'utf8'), 'Externally edited draft')
  assert.match(await readFile(join(second.path, '脚本.md'), 'utf8'), /Second draft/)
  const third = await saveProduction(work, options)
  assert.notEqual(third.path, first.path)
  assert.notEqual(third.path, second.path)
})

test('#15 一篇内容有导入的累计数据时，手动再录的不重复计算', async () => {
  const { computeInsights } = await import('../src/learn.js')
  const state = {
    items: [
      { id: 'a', title: '导入的', platform: '抖音', status: 'published' },
      { id: 'b', title: '手动的', platform: '公众号', status: 'published' },
    ],
    accounts: [], skills: [],
    metrics: [
      { id: 'm1', itemId: 'a', platform: '抖音', date: '2026-11-01T04:00:00Z', views: 120, likes: 12, externalId: '抖音:1', fetchedAt: '2026-11-10T00:00:00Z' },
      { id: 'm2', itemId: 'a', platform: '抖音', date: '2026-11-05T04:00:00Z', views: 100, likes: 10 },
      // 手动数据按天录，同一篇的几条相加
      { id: 'm3', itemId: 'b', platform: '公众号', date: '2026-11-02T04:00:00Z', views: 30, likes: 1 },
      { id: 'm4', itemId: 'b', platform: '公众号', date: '2026-11-03T04:00:00Z', views: 20, likes: 2 },
      // 不关联内容的平台数据照常计入
      { id: 'm5', itemId: null, platform: '公众号', date: '2026-11-04T04:00:00Z', views: 5 },
    ],
  }
  const data = computeInsights(state)
  assert.equal(data.views, 175)
  assert.deepEqual(data.top.map(row => [row.id, row.views]), [['a', 120], ['b', 50]])
  assert.deepEqual(data.platforms.map(row => [row.platform, row.views]), [['抖音', 120], ['公众号', 55]])
  assert.equal(data.daily.reduce((total, day) => total + day.views, 0), 175)
  assert.equal(data.imported, true)
  assert.equal(data.skipped, 1)

  // 没有导入数据时和原来一样全部相加
  const manual = computeInsights({ ...state, metrics: state.metrics.filter(row => !row.externalId) })
  assert.equal(manual.views, 155)
  assert.equal(manual.imported, false)
  assert.equal(manual.skipped, 0)
})
