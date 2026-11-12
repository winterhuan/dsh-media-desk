import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { assertPublicUrl, harvest, harvestText } from '../src/harvest.js'
import { activeStyle, normalizeStyle, stylePrompts, styleToVoice } from '../src/style.js'
import { migrateState } from '../src/seed.js'
import { requestRejection } from '../src/host.js'
import { computeInsights, exportSkill } from '../src/learn.js'
import { applyOps } from '../src/ops.js'
import { buildSeed } from '../src/seed.js'
import { Store } from '../src/store.js'
import { generateImage } from '../src/images.js'
import { applyRevision, normalizePlan, Producer } from '../src/produce.js'
import { saveProduction, resolveExportDir } from '../src/export.js'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { publicSettings, Settings } from '../src/settings.js'
import { stat } from 'node:fs/promises'

const NOW = new Date('2026-10-31T15:00:00+08:00') // 周六

function seed() {
  return buildSeed(NOW)
}

test('applyOps 拒绝未知操作和原型链上的名字', () => {
  const state = seed()
  const { errors } = applyOps(state, [{ op: 'constructor' }, { op: 'rm_rf' }])
  assert.equal(errors.length, 2)
})

test('applyOps 过滤非法字段和危险媒体地址', () => {
  const state = seed()
  const { receipts } = applyOps(state, [{ op: 'add_item', title: 'x', media: { src: 'javascript:alert(1)' }, url: 'javascript:alert(1)', status: 'nope', evil: 1 }])
  const item = state.items.find(i => i.id === receipts[0].target)
  assert.equal(item.media, undefined)
  assert.equal(item.url, undefined)
  assert.equal(item.status, 'idea')
  assert.equal(item.evil, undefined)
})

test('applyOps 部分失败不影响其余操作', () => {
  const state = seed()
  const { receipts, errors } = applyOps(state, [{ op: 'set_status', id: 'nope', status: 'draft' }, { op: 'set_status', id: 'seed_2', status: 'draft' }])
  assert.equal(errors.length, 1)
  assert.equal(receipts.length, 1)
  assert.equal(state.items.find(i => i.id === 'seed_2').status, 'draft')
})

test('删除父卡片时子卡片接到上一级', () => {
  const state = seed()
  applyOps(state, [{ op: 'update_item', id: 'seed_2', parentId: 'seed_1' }, { op: 'update_item', id: 'seed_3', parentId: 'seed_2' }, { op: 'delete_item', id: 'seed_2' }])
  assert.equal(state.items.find(i => i.id === 'seed_3').parentId, 'seed_1')
})

test('clear_samples 清空示例但保留用户内容', () => {
  const state = seed()
  applyOps(state, [{ op: 'add_item', title: '我自己的' }, { op: 'clear_samples' }])
  assert.deepEqual(state.items.map(i => i.title), ['我自己的'])
  assert.equal(state.metrics.length, 0)
})

test('Store 持久化、撤销，并能感知另一进程的写入', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'media-desk-'))
  try {
    const a = new Store(dir)
    const before = (await a.read()).items.length
    await a.mutate('add', s => applyOps(s, [{ op: 'add_item', title: '新灵感' }]))
    assert.equal((await a.read()).items.length, before + 1)
    assert.equal(await a.undoLast(), 'add')
    assert.equal((await a.read()).items.length, before)

    const b = new Store(dir)
    await b.mutate('b', s => applyOps(s, [{ op: 'add_item', title: '来自桌面端' }]))
    assert.equal((await a.read()).items[0].title, '来自桌面端')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('computeInsights 汇总与逐日数据一致', () => {
  const state = seed()
  const data = computeInsights(state)
  assert.equal(data.daily.reduce((a, b) => a + b.views, 0), data.views)
  assert.equal(data.platforms.reduce((a, b) => a + b.views, 0), data.views)
})

test('requestRejection 没有鉴权服务时拒绝，有服务时听它的', () => {
  const req = { headers: { cookie: 'x' } }
  assert.equal(requestRejection({ get: () => undefined }, req), 403)
  assert.equal(requestRejection({ get: () => ({ requestRejection: () => 401 }) }, req), 401)
  let seen = null
  const allowed = requestRejection({ get: () => ({ requestRejection: (r) => { seen = r; return undefined } }) }, req)
  assert.equal(allowed, undefined)
  assert.equal(seen.headers, req.headers)
})

test('exportSkill 不导出示例规则和示例人物', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'media-desk-skill-'))
  try {
    const state = seed()
    await assert.rejects(exportSkill(state, dir), /示例规则和模板不会被导出/)
    applyOps(state, [{ op: 'add_skill', name: '我的规则', rule: '标题不超过 20 字', status: 'active' }])
    const result = await exportSkill(state, dir)
    assert.equal(result.rules, 1)
    const body = await readFile(result.path, 'utf8')
    assert.match(body, /^---\nname: media-desk-voice\n/)
    assert.match(body, /我的规则/)
    assert.doesNotMatch(body, /开头先给数字/)
    assert.doesNotMatch(body, /想入门的小林/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('assertPublicUrl 拒绝本机和内网地址', async () => {
  for (const url of ['http://localhost:3000', 'http://127.0.0.1', 'http://10.0.0.1', 'http://192.168.1.1', 'http://169.254.169.254/latest', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'file:///etc/passwd']) {
    await assert.rejects(assertPublicUrl(url), url)
  }
})

test('harvest 解析元信息，并拦截跳转到内网', async () => {
  const page = '<html><head><title>备用标题</title><meta property="og:title" content="主页 &amp; 档案"><meta name="description" content="粉丝 1.2万"><meta property="og:image" content="/a.jpg"></head></html>'
  const ok = async () => new Response(page, { headers: { 'content-type': 'text/html' } })
  const info = await harvest('https://93.184.216.34/u', ok)
  assert.equal(info.title, '主页 & 档案')
  assert.equal(info.image, 'https://93.184.216.34/a.jpg')
  assert.equal(info.followers, 12000)

  const redirect = async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } })
  await assert.rejects(harvest('https://93.184.216.34/u', redirect), /本机|内网/)
})

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const IMAGE = { baseUrl: 'https://img.example/v1', model: 'm', apiKey: 'secret-key-1234', size: '1536x1024', quality: '', extra: '{"output_format":"jpeg"}' }

test('generateImage 发送标准请求，支持 b64 和 images[0].url 两种返回', async () => {
  const calls = []
  const b64 = async (url, init) => {
    calls.push([String(url), init])
    return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }), { status: 200 })
  }
  const one = await generateImage(IMAGE, 'p', { fetchImpl: b64 })
  assert.equal(one.ext, '.png')
  assert.equal(calls[0][0], 'https://img.example/v1/images/generations')
  assert.equal(calls[0][1].headers.authorization, 'Bearer secret-key-1234')
  assert.deepEqual(JSON.parse(calls[0][1].body), { model: 'm', prompt: 'p', n: 1, size: '1536x1024', output_format: 'jpeg' })

  const viaUrl = async (url) => (String(url).endsWith('/generations')
    ? new Response(JSON.stringify({ images: [{ url: 'https://93.184.216.34/a.png' }] }))
    : new Response(PNG))
  assert.equal((await generateImage(IMAGE, 'p', { fetchImpl: viaUrl })).ext, '.png')
})

test('generateImage 拒绝内网下载地址、非图片内容，报错里不带密钥', async () => {
  const internal = async () => new Response(JSON.stringify({ data: [{ url: 'http://127.0.0.1/x.png' }] }))
  await assert.rejects(generateImage(IMAGE, 'p', { fetchImpl: internal }), /本机|内网/)
  const html = async () => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('<html>').toString('base64') }] }))
  await assert.rejects(generateImage(IMAGE, 'p', { fetchImpl: html }), /不是图片/)
  const leak = async () => new Response(JSON.stringify({ error: { message: 'bad key secret-key-1234' } }), { status: 400 })
  await assert.rejects(generateImage(IMAGE, 'p', { fetchImpl: leak }), err => !err.message.includes('secret-key') && err.message.includes('***'))
  const denied = async () => new Response('{}', { status: 401 })
  await assert.rejects(generateImage(IMAGE, 'p', { fetchImpl: denied }), /密钥无效/)
})

test('generateImage 遇到 5xx 重试一次', async () => {
  let n = 0
  const flaky = async () => {
    n += 1
    return n === 1 ? new Response('<html>', { status: 502 }) : new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }))
  }
  assert.equal((await generateImage(IMAGE, 'p', { fetchImpl: flaky })).ext, '.png')
  assert.equal(n, 2)
})

test('Settings 权限 600，密钥不外泄，空密钥不覆盖', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'media-desk-set-'))
  try {
    const settings = new Settings(dir)
    await settings.update({ image: { baseUrl: 'https://x.example/v1/images/generations/', model: 'm', apiKey: 'sk-abcdefgh1234' }, imageCount: 99 })
    assert.equal((await stat(join(dir, 'settings.json'))).mode & 0o777, 0o600)
    const open = publicSettings(await settings.read())
    assert.equal(open.image.baseUrl, 'https://x.example/v1')
    assert.equal(open.image.keyHint, '1234')
    assert.equal(open.imageCount, 4)
    assert.equal(open.imageReady, true)
    assert.ok(!JSON.stringify(open).includes('abcdefgh'))
    await settings.update({ image: { apiKey: '  ', model: 'n' } })
    assert.equal((await settings.read()).image.apiKey, 'sk-abcdefgh1234')
    await assert.rejects(settings.update({ image: { baseUrl: 'javascript:alert(1)' } }), /http/)
    await assert.rejects(settings.update({ image: { extra: '[1]' } }), /JSON/)
    await settings.update({ image: { clearKey: true } })
    assert.equal(publicSettings(await settings.read()).imageReady, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('normalizePlan 丢弃多余字段并按设置截断', () => {
  const plan = normalizePlan({ title: 'T', cover: 'c', images: [{ prompt: 'a', evil: 1 }, { prompt: 'b' }, { prompt: 'c' }], shots: [{ prompt: 'x', seconds: 999 }, 'bad', null] }, { imageCount: 2, shotCount: 6 }, 'fallback')
  assert.equal(plan.images.length, 2)
  assert.equal(plan.images[0].evil, undefined)
  assert.equal(plan.shots.length, 1)
  assert.equal(plan.shots[0].seconds, 60)
  assert.equal(normalizePlan(null, { imageCount: 1, shotCount: 1 }, 'F').title, 'F')
})

function revisable() {
  return {
    status: 'done', title: '旧标题', article: '开头一段。\n\n## 第一节\n\n这里要改。',
    cover: { prompt: 'c', status: 'done' }, images: [{ caption: '图', prompt: 'i', status: 'done', anchor: '第一节' }],
    shots: [{ no: 1, shot: '中景', visual: 'v', voice: 'x', seconds: 5, prompt: 'p', status: 'done' }],
  }
}

test('applyRevision 改标题、局部替换、只重画改了画面的图', () => {
  const p = revisable()
  const { receipts, errors, targets } = applyRevision(p, {
    title: '新标题', edits: [{ find: '这里要改', replace: '$& 改好了' }, { find: '不存在的句子', replace: 'x' }],
    cover: { prompt: 'night' }, images: [{ no: 1, caption: '新图注' }], shots: [{ no: 1, voice: '新口播', prompt: 'top' }, { no: 9, prompt: '越界' }],
  })
  assert.equal(p.title, '新标题')
  // replace 里的 $& 不能被当成替换语法
  assert.match(p.article, /\$& 改好了/)
  assert.equal(p.images[0].caption, '新图注')
  assert.equal(p.images[0].prompt, 'i')
  assert.equal(p.shots[0].voice, '新口播')
  assert.deepEqual(targets, ['cover', 'shot:0'])
  assert.equal(errors.length, 1)
  assert.ok(receipts.length >= 4)
})

test('applyRevision 忽略垃圾输入，整篇重写时去掉一级标题', () => {
  const p = revisable()
  const before = JSON.stringify(p)
  assert.deepEqual(applyRevision(p, null), { receipts: [], errors: [], targets: [] })
  applyRevision(p, { images: 'x', shots: [null, 3], edits: [1, { find: 2 }], title: 5 })
  assert.equal(JSON.stringify(p), before)
  applyRevision(p, { article: '# 标题\n\n新的正文' })
  assert.equal(p.article, '新的正文')
})

test('saveProduction 写出文章、脚本和素材，标题里的路径字符被清掉', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'media-desk-save-'))
  try {
    const filesDir = join(dir, 'files')
    await mkdir(filesDir)
    await writeFile(join(filesDir, 'a.jpg'), PNG)
    await writeFile(join(filesDir, 'b.jpg'), PNG)
    const p = revisable()
    p.title = '../危险/标题: 测试'
    p.cover.src = 'media-desk/files/a.jpg'
    p.images[0].src = 'media-desk/files/b.jpg'
    p.shots[0].src = 'media-desk/assets/../../secret.jpg'
    p.shots[0].voice = '带|竖线'
    const saved = await saveProduction(p, { filesDir, exportDir: join(dir, 'out'), videoCover: Buffer.from([0xff, 0xd8, 0xff]) })
    assert.ok(saved.path.startsWith(join(dir, 'out', '危险 标题 测试-')))
    const names = await readdir(saved.path)
    assert.deepEqual(names.sort(), ['manifest.json', 'sources.md', '分镜脚本.md', '封面原图.jpg', '视频封面.jpg', '脚本.md', '配图1.jpg'].sort())
    const article = await readFile(join(saved.path, '脚本.md'), 'utf8')
    assert.match(article, /^# \.\.\/危险/)
        assert.match(article, /这里要改。\n\n!\[图\]\(配图1\.jpg\)/)
    assert.match(await readFile(join(saved.path, '分镜脚本.md'), 'utf8'), /带｜竖线/)
    p.savedPath = saved.path
    assert.notEqual((await saveProduction({ ...p, title: '改名了' }, { filesDir, exportDir: join(dir, 'out') })).path, saved.path)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('resolveExportDir 展开 ~，空值用默认位置', () => {
  assert.match(resolveExportDir(''), /Documents\/自媒体工作台$/)
  assert.ok(!resolveExportDir('~/x').startsWith('~'))
  assert.equal(resolveExportDir('/tmp/x'), '/tmp/x')
})

test('风格：只留白名单字段，能变成写作要求，并进入提示词', () => {
  const style = normalizeStyle({ name: '慢半拍', summary: 's', tone: 't', words: ['那天', 3, ''], samples: ['样句'], evil: 1 })
  assert.equal(style.evil, undefined)
  assert.deepEqual(style.words, ['那天'])
  assert.match(styleToVoice(style), /常用词：那天/)
  assert.equal(normalizeStyle(null, '备用').name, '备用')
  assert.equal(styleToVoice(null), '')
  assert.match(stylePrompts('素材', '').system, /文风分析师/)

  const state = seed()
  const item = state.items[0]
  const { receipts } = applyOps(state, [{ op: 'add_style', name: '我的', tone: '很独特的语气' }])
  assert.equal(activeStyle(state), null)
  // 没选风格时用设置里的语气
  assert.equal(activeStyle(state), null)
  applyOps(state, [{ op: 'set_style', id: receipts[0].target }])
  applyOps(state, [{ op: 'delete_style', id: receipts[0].target }])
  assert.equal(state.activeStyleId, null)
})

test('风格预设：旧模板换成新预设，清空示例也不会删预设', async () => {
  const { STYLE_CATEGORIES, STYLE_PRESETS } = await import('../src/style-presets.js')
  for (const row of STYLE_PRESETS) {
    assert.ok(STYLE_CATEGORIES.includes(row.category), row.name)
    for (const key of ['icon', 'name', 'summary', 'tone', 'sentences', 'opening', 'structure']) assert.ok(row[key], `${row.name} 缺 ${key}`)
    assert.ok(row.words.length && row.avoid.length && row.samples.length, row.name)
    assert.ok(!/[\u4e00-\u9fff]/.test(row.icon), `${row.name} 的图标不能是汉字`)
  }
  assert.equal(new Set(STYLE_PRESETS.map(row => row.icon)).size, STYLE_PRESETS.length)
  for (const category of STYLE_CATEGORIES) assert.ok(STYLE_PRESETS.some(row => row.category === category), category)

  const old = { items: [], activeStyleId: 'seed_style_story', styles: [{ id: 'seed_style_story', name: '松弛讲故事', sample: true }, { id: 'st_1', name: '我的' }] }
  migrateState(old)
  assert.equal(old.activeStyleId, 'preset_story')
  assert.equal(old.styles.some(row => row.id.startsWith('seed_style_')), false)
  assert.equal(old.styles[0].name, '我的')
  assert.equal(old.styles.filter(row => row.preset).length, STYLE_PRESETS.length)

  // 预设删过之后不再补回来
  const deleted = migrateState({ items: [], sampleCleared: true })
  assert.equal(deleted.styles.length, STYLE_PRESETS.length)
  applyOps(deleted, [{ op: 'delete_style', id: 'preset_news' }])
  assert.equal(migrateState(deleted).styles.some(row => row.id === 'preset_news'), false)

  const state = seed()
  assert.equal(state.styles.length, STYLE_PRESETS.length)
  assert.ok(state.items.some(row => row.sample))
  applyOps(state, [{ op: 'add_style', name: '我的' }, { op: 'set_style', id: 'preset_travel' }, { op: 'clear_samples' }])
  assert.equal(state.items.some(row => row.sample), false)
  assert.equal(state.metrics.some(row => row.sample), false)
  assert.equal(state.skills.some(row => row.sample), false)
  assert.equal(state.accounts.some(row => row.sample), false)
  assert.equal(state.styles.length, STYLE_PRESETS.length + 1)
  assert.equal(state.activeStyleId, 'preset_travel')
})

test('harvestText 抽出正文，去掉脚本和导航', async () => {
  const page = '<html><head><title>标题</title><style>x{}</style></head><body><nav>导航内容不要这段内容</nav><script>var a=1</script><p>这是第一段正文内容，足够长。</p><div>这是第二段&amp;正文内容，足够长。</div></body></html>'
  const { text, title } = await harvestText('https://93.184.216.34/a', async () => new Response(page, { headers: { 'content-type': 'text/html' } }))
  assert.equal(title, '标题')
  assert.match(text, /第一段正文/)
  assert.match(text, /第二段&正文/)
  assert.doesNotMatch(text, /导航|var a/)
  await assert.rejects(harvestText('http://127.0.0.1/x'), /本机|内网/)
})

test('applyRevision 能改封面大字', () => {
  const p = revisable()
  const { receipts } = applyRevision(p, { coverText: '新大字' })
  assert.equal(p.coverText, '新大字')
  assert.match(receipts[0], /新大字/)
})

test('提炼风格时，用户起的名字优先于模型起的名字', async () => {
  const { normalizeStyle } = await import('../src/style.js')
  assert.equal(normalizeStyle({ name: '慢半拍' }, '我自己').name, '我自己')
  assert.equal(normalizeStyle({ name: '慢半拍' }, '').name, '慢半拍')
  assert.equal(normalizeStyle({}, '').name, '未命名风格')
})

test('排期：排上日历就是待发布，取消排期退回草稿，已发布不动', () => {
  const state = seed()
  const [ideaR, doneR] = applyOps(state, [{ op: 'add_item', title: '只有灵感' }, { op: 'add_item', title: '已成稿' }]).receipts
  const done = state.items.find(row => row.id === doneR.target)
  done.production = { status: 'done', title: '已成稿' }
  applyOps(state, [{ op: 'schedule_item', id: ideaR.target, scheduledAt: '2026-12-01T12:00:00Z' }, { op: 'schedule_item', id: doneR.target, scheduledAt: '2026-12-01T12:00:00Z' }])
  assert.equal(state.items.find(row => row.id === ideaR.target).status, 'outline')
  assert.equal(done.status, 'ready')
  applyOps(state, [{ op: 'schedule_item', id: doneR.target, scheduledAt: null }])
  assert.equal(done.status, 'draft')
  applyOps(state, [{ op: 'update_item', id: doneR.target, status: 'published' }, { op: 'schedule_item', id: doneR.target, scheduledAt: null }])
  assert.equal(done.status, 'published')
  const [media] = applyOps(state, [{ op: 'add_item', kind: 'image', media: { src: 'media-desk/files/x.png' } }]).receipts
  assert.match(state.items.find(row => row.id === media.target).title, /的图片$/)
})

test('撤销只撤回那一步：之后生成的成稿和画好的图不受影响', async () => {
  const { Store, revertChange } = await import('../src/store.js')
  const dir = await mkdtemp(join(tmpdir(), 'md-undo-'))
  try {
    const store = new Store(dir)
    const state = await store.read()
    const id = state.items[0].id
    // 1. 切换风格（可撤销）
    await store.mutate('切换风格', (draft) => { draft.activeStyleId = 'preset_travel' })
    // 2. 之后生成了成稿（不可撤销的后台写入）
    await store.mutate('成稿', (draft) => { draft.items[0].production = { status: 'done', title: '原标题', shots: [{ no: 1, prompt: 'a', status: 'done', src: 'old.png' }] } }, { undoable: false })
    // 3. 对话改了标题和第 1 镜的画面（可撤销）
    await store.mutate('对话', (draft) => { const p = draft.items[0].production; p.title = '新标题'; p.shots[0].prompt = 'b'; p.shots[0].status = 'running' })
    // 4. 第 1 镜重画完成（不可撤销）
    await store.mutate('成稿', (draft) => { const shot = draft.items[0].production.shots[0]; shot.status = 'done'; shot.src = 'new.png' }, { undoable: false })

    assert.equal(await store.undoLast(), '对话')
    let p = (await store.read()).items.find(row => row.id === id).production
    assert.equal(p.title, '原标题')
    assert.equal(p.shots[0].prompt, 'a')
    assert.equal(p.shots[0].src, 'new.png')
    assert.equal(p.shots[0].status, 'done')

    assert.equal(await store.undoLast(), '切换风格')
    const after = await store.read()
    assert.equal(after.activeStyleId, null)
    p = after.items.find(row => row.id === id).production
    assert.equal(p.status, 'done', '撤销切换风格不能抹掉成稿')

    // 什么都没改的操作不进撤销栈
    await store.mutate('空操作', () => {})
    assert.equal(store.undo.length, 0)

    // 新增和删除也能撤回，删掉的行回到原位
    const removed = after.items[1]
    await store.mutate('删除', (draft) => { draft.items.splice(1, 1) })
    await store.mutate('新增', (draft) => { draft.items.unshift({ id: 'new_1', title: '新灵感' }) })
    await store.undoLast()
    await store.undoLast()
    const back = await store.read()
    assert.equal(back.items.some(row => row.id === 'new_1'), false)
    assert.equal(back.items[1].id, removed.id)

    assert.deepEqual(revertChange({ a: 1 }, { a: 2 }, { a: 3 }), { a: 3 }, '之后又被改过就保留现在的值')
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('状态规则：发布时间、排期与取消排期、清空示例不留悬空数据', () => {
  const state = seed()
  const [r] = applyOps(state, [{ op: 'add_item', title: '只有灵感' }]).receipts
  const item = state.items.find(row => row.id === r.target)
  applyOps(state, [{ op: 'schedule_item', id: item.id, scheduledAt: '2026-12-01T12:00:00Z' }])
  assert.equal(item.status, 'outline')
  applyOps(state, [{ op: 'schedule_item', id: item.id, scheduledAt: null }])
  assert.equal(item.status, 'idea', '没成稿的灵感取消排期回到灵感')
  applyOps(state, [{ op: 'update_item', id: item.id, status: 'published' }])
  assert.ok(item.publishedAt, '用 update_item 发布也要记发布时间')
  applyOps(state, [{ op: 'set_status', id: item.id, status: 'draft' }])
  assert.equal(item.publishedAt, undefined, '离开已发布要清掉发布时间')
  const sample = state.items.find(row => row.sample)
  const [child] = applyOps(state, [{ op: 'add_item', title: '挂在示例下面', parentId: sample.id }, { op: 'add_metric', itemId: sample.id, platform: '抖音', date: '2026-11-01T12:00:00Z', views: 10 }]).receipts
  applyOps(state, [{ op: 'clear_samples' }])
  assert.equal(state.items.find(row => row.id === child.target).parentId, null)
  assert.equal(state.metrics.length, 0)
})
