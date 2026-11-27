// 万相异步文生图：端点归一、提交、轮询、成功后下载与失败映射。
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateImage, wanSubmitEndpoint, wanTaskEndpoint } from '../src/images.js'
import { imageReady, publicSettings, Settings } from '../src/settings.js'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const KEY = '{{SECRET_w4nq8z6k}}'
const SUBMIT = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis'
const IMAGE = { protocol: 'wan', baseUrl: 'https://dashscope.aliyuncs.com', model: 'wan2.5-t2i-preview', apiKey: KEY, size: '1280x1280', quality: '', extra: '{"negative_prompt":"人物","prompt_extend":false}' }

test('万相端点：域名、/api/v1、完整提交或查询地址都归一成域名', () => {
  assert.equal(wanSubmitEndpoint('https://dashscope.aliyuncs.com'), SUBMIT)
  assert.equal(wanSubmitEndpoint('https://dashscope.aliyuncs.com/api/v1'), SUBMIT)
  assert.equal(wanSubmitEndpoint(`${SUBMIT}/`), SUBMIT)
  assert.equal(wanSubmitEndpoint('https://dashscope.aliyuncs.com/api/v1/tasks/abc-123'), SUBMIT)
  assert.equal(wanTaskEndpoint('https://dashscope.aliyuncs.com', 'abc-123'), 'https://dashscope.aliyuncs.com/api/v1/tasks/abc-123')
})

test('万相：提交任务带 X-DashScope-Async，轮询到 SUCCEEDED 后下载 results[].url', async () => {
  const calls = []
  let polls = 0
  const fetchImpl = async (url, init) => {
    calls.push([String(url), init])
    if (init?.method === 'POST') {
      return new Response(JSON.stringify({ output: { task_id: 't1', task_status: 'PENDING' }, request_id: 'r1' }))
    }
    if (String(url).endsWith('/api/v1/tasks/t1')) {
      polls += 1
      return new Response(JSON.stringify(polls === 1
        ? { output: { task_id: 't1', task_status: 'RUNNING' } }
        : { output: { task_id: 't1', task_status: 'SUCCEEDED', results: [{ url: 'https://93.184.216.34/a.png' }], task_metrics: { TOTAL: 1, SUCCEEDED: 1, FAILED: 0 } } }))
    }
    return new Response(PNG)
  }
  const result = await generateImage(IMAGE, 'a paper boat', { fetchImpl, pollIntervalMs: 1 })
  assert.equal(result.ext, '.png')
  assert.equal(calls[0][0], SUBMIT)
  assert.equal(calls[0][1].headers.authorization, `Bearer ${KEY}`)
  assert.equal(calls[0][1].headers['x-dashscope-async'], 'enable')
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    model: 'wan2.5-t2i-preview',
    input: { prompt: 'a paper boat', negative_prompt: '人物' },
    parameters: { n: 1, size: '1280*1280', prompt_extend: false },
  })
  assert.equal(calls[1][0], 'https://dashscope.aliyuncs.com/api/v1/tasks/t1')
  assert.equal(calls[1][1].headers.authorization, `Bearer ${KEY}`)
  assert.equal(calls[1][1].headers['x-dashscope-async'], undefined)
  assert.equal(polls, 2)
  assert.equal(calls[3][0], 'https://93.184.216.34/a.png')
})

test('万相：任务失败、过期、缺少 task_id 都有明确提示', async () => {
  const failed = async (url, init) => (init?.method === 'POST'
    ? new Response(JSON.stringify({ output: { task_id: 't2', task_status: 'PENDING' } }))
    : new Response(JSON.stringify({ output: { task_id: 't2', task_status: 'FAILED', code: 'DataInspectionFailed', message: '内容审核未通过' } })))
  await assert.rejects(generateImage(IMAGE, 'p', { fetchImpl: failed, pollIntervalMs: 1 }), /万相任务失败：内容审核未通过/)

  const unknown = async (url, init) => (init?.method === 'POST'
    ? new Response(JSON.stringify({ output: { task_id: 't3', task_status: 'PENDING' } }))
    : new Response(JSON.stringify({ output: { task_id: 't3', task_status: 'UNKNOWN' } })))
  await assert.rejects(generateImage(IMAGE, 'p', { fetchImpl: unknown, pollIntervalMs: 1 }), /不存在或已过期/)

  const noTask = async () => new Response(JSON.stringify({ output: { task_status: 'PENDING' } }))
  await assert.rejects(generateImage(IMAGE, 'p', { fetchImpl: noTask }), /没有返回任务 ID/)

  const denied = async () => new Response(JSON.stringify({ code: 'InvalidApiKey', message: `bad key ${KEY}` }), { status: 401 })
  await assert.rejects(generateImage(IMAGE, 'p', { fetchImpl: denied }), err => /密钥无效/.test(err.message) && !err.message.includes(KEY))
})

test('设置：protocol 支持 wan，完整提交地址归一，无效协议拒绝', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'media-desk-wan-'))
  try {
    const settings = new Settings(dir)
    const saved = await settings.update({ image: { protocol: 'wan', baseUrl: `${SUBMIT}/`, model: 'wan2.5-t2i-preview', apiKey: KEY } })
    assert.equal(saved.image.protocol, 'wan')
    assert.equal(saved.image.baseUrl, 'https://dashscope.aliyuncs.com')
    assert.equal(imageReady(saved), true)
    assert.equal(publicSettings(saved).image.protocol, 'wan')
    const taskUrl = await settings.update({ image: { baseUrl: 'https://dashscope.aliyuncs.com/api/v1/tasks/abc-123' } })
    assert.equal(taskUrl.image.baseUrl, 'https://dashscope.aliyuncs.com')
    await assert.rejects(settings.update({ image: { protocol: 'unknown' } }), /协议/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
