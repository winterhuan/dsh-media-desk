// 阿里云百炼同步生图：端点归一、请求/响应形状、错误映射与设置兼容。
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bailianEndpoint, generateImage } from '../src/images.js'
import { imageReady, publicSettings, Settings } from '../src/settings.js'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const KEY = 'sk-bailian-test-1234'
const IMAGE = { protocol: 'bailian', baseUrl: 'https://dashscope.aliyuncs.com', model: 'qwen-image-2.0-pro', apiKey: KEY, size: '1536x1024', quality: '', extra: '{"prompt_extend":false}' }

test('百炼端点：域名、带 /api/v1、完整端点都归一成同一地址', () => {
  const endpoint = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'
  assert.equal(bailianEndpoint('https://dashscope.aliyuncs.com'), endpoint)
  assert.equal(bailianEndpoint('https://dashscope.aliyuncs.com/api/v1'), endpoint)
  assert.equal(bailianEndpoint(`${endpoint}/`), endpoint)
  assert.equal(bailianEndpoint('https://token-plan.cn-beijing.maas.aliyuncs.com'), 'https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation')
})

test('百炼：请求走 multimodal-generation，尺寸转 宽*高，响应取 output...image', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push([String(url), init])
    if (init?.method === 'POST') {
      return new Response(JSON.stringify({
        output: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: [{ image: 'https://93.184.216.34/generated/a.png' }] } }] },
        usage: { image_count: 1, width: 1536, height: 1024 },
        request_id: 'r1',
      }))
    }
    return new Response(PNG)
  }
  const result = await generateImage(IMAGE, 'a paper boat', { fetchImpl })
  assert.equal(result.ext, '.png')
  assert.equal(calls[0][0], 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation')
  assert.equal(calls[0][1].headers.authorization, `Bearer ${KEY}`)
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    model: 'qwen-image-2.0-pro',
    input: { messages: [{ role: 'user', content: [{ text: 'a paper boat' }] }] },
    parameters: { size: '1536*1024', prompt_extend: false },
  })
  // 下载图片走返回的 URL，跨域时不带用户密钥
  assert.equal(calls[1][0], 'https://93.184.216.34/generated/a.png')
  assert.equal(calls[1][1].headers, undefined)
})

test('百炼：错误信息脱敏，200 里的业务错误码也报出来，缺图明确提示', async () => {
  const denied = async () => new Response(JSON.stringify({ code: 'InvalidApiKey', message: `bad key ${KEY}` }), { status: 401 })
  await assert.rejects(generateImage(IMAGE, 'p', { fetchImpl: denied }), err => /密钥无效/.test(err.message) && !err.message.includes(KEY))

  const business = async () => new Response(JSON.stringify({ code: 'InvalidParameter', message: 'size must be 宽*高' }))
  await assert.rejects(generateImage(IMAGE, 'p', { fetchImpl: business }), /百炼返回错误：size must be 宽\*高/)

  const empty = async () => new Response(JSON.stringify({ output: { choices: [] } }))
  await assert.rejects(generateImage(IMAGE, 'p', { fetchImpl: empty }), /没有返回图片/)
})

test('设置：protocol 默认 openai，切百炼时完整端点归一，无效协议拒绝', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'media-desk-bailian-'))
  try {
    const settings = new Settings(dir)
    assert.equal((await settings.read()).image.protocol, 'openai')
    const saved = await settings.update({ image: { protocol: 'bailian', baseUrl: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation/', model: 'qwen-image-2.0-pro', apiKey: KEY } })
    assert.equal(saved.image.protocol, 'bailian')
    assert.equal(saved.image.baseUrl, 'https://dashscope.aliyuncs.com')
    assert.equal(imageReady(saved), true)
    const open = publicSettings(saved)
    assert.equal(open.image.protocol, 'bailian')
    assert.equal(open.image.keyHint, '1234')
    assert.ok(!JSON.stringify(open).includes(KEY))
    await assert.rejects(settings.update({ image: { protocol: 'unknown' } }), /协议/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
