import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { marketInstallTarget, parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index'
import { reconcileDistTags } from '../scripts/index-entry.mjs'

const INDEX_URL = 'https://raw.githubusercontent.com/winterhuan/dsh-media-desk/main/index.json'

test('index.json：官方校验器接受，安装地址指向 fork 固定 Git 提交', () => {
  const index = JSON.parse(readFileSync(new URL('../index.json', import.meta.url), 'utf8'))
  const parsed = parseMarketIndex(index, INDEX_URL)
  assert.equal(parsed.plugins.length, 1)
  const [plugin] = parsed.plugins
  assert.equal(plugin.name, '@winterhuan/dsh-media-desk')
  const [version] = plugin.versions
  // 版本号每次发版都会变，这里只认格式
  assert.equal(version.source.type, 'git')
  assert.match(version.source.commit, /^[a-f0-9]{40}$/)
  assert.ok(marketInstallTarget(plugin.name, version).spec.includes(version.source.commit))
})

test('index.json：列表里的版本和 engines 与 package.json 一致', () => {
  const index = JSON.parse(readFileSync(new URL('../index.json', import.meta.url), 'utf8'))
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const plugin = index.plugins.find(entry => entry.name === manifest.name)
  assert.ok(plugin, 'index.json 里没有当前包名')
  assert.equal(plugin.versions[0].engines.dsh, manifest.engines.dsh)
})

test('官方校验器：engines.dsh 不是 SemVer 区间时整份索引被拒', () => {
  const index = {
    format: 1,
    title: { en: 'Media Desk', zh: '自媒体工作台' },
    metadata: {},
    plugins: [{
      name: 'dsh-media-desk',
      metadata: {},
      versions: [{ version: '2.6.2', publishTimestamp: 1794111213, source: { type: 'npm' }, engines: { dsh: 'not a range at all' } }],
    }],
  }
  assert.throws(() => parseMarketIndex(index, INDEX_URL), /\$\.plugins\[0\]\.versions\[0\]\.engines\.dsh/)
})

test('官方校验器：分类没在 metadata 里声明时整份索引被拒', () => {
  const index = {
    format: 1,
    title: 'Media Desk',
    metadata: {},
    plugins: [{
      name: 'dsh-media-desk',
      metadata: { category: 'content-creation' },
      versions: [{ version: '2.6.2', publishTimestamp: 1794111213, source: { type: 'npm' }, engines: { dsh: '>=0.2.1-rc.5 <0.3.0' } }],
    }],
  }
  assert.throws(() => parseMarketIndex(index, INDEX_URL), /category/)
})

test('reconcileDistTags：保留指向已列出版本的标签，丢掉指空的', () => {
  const warned = []
  const plugin = { 'dist-tags': { latest: '2.6.2', next: '2.7.0-rc.1' } }
  reconcileDistTags(plugin, [{ version: '2.6.2' }], message => warned.push(message))
  assert.deepEqual(plugin['dist-tags'], { latest: '2.6.2' })
  assert.equal(warned.length, 1)
  assert.match(warned[0], /2\.7\.0-rc\.1/)
})

test('reconcileDistTags：全都不指向列出的版本时删掉整个字段', () => {
  const plugin = { 'dist-tags': { next: '2.7.0-rc.1' } }
  reconcileDistTags(plugin, [{ version: '2.6.2' }], () => {})
  assert.equal('dist-tags' in plugin, false)
})

test('reconcileDistTags：没有 dist-tags 时什么都不做', () => {
  const plugin = {}
  reconcileDistTags(plugin, [{ version: '2.6.2' }], () => {})
  assert.deepEqual(plugin, {})
})
