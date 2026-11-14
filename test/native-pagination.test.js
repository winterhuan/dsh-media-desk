/** Native read results page complete JSON, including large metadata and every collection row. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeRuntime } from './fixtures/native-runtime.js'

test('真实原生读取按完整 JSON 分页，微小和精确限额及大集合仍可继续读取', { timeout: 180000 }, async t => {
  const largeTitle = 'Large work metadata '.repeat(2000)
  const largeFacts = 'Long production fact '.repeat(1900)
  const calls = []
  const groups = []
  const add = (label, requests) => { groups.push({ label, start: calls.length, count: requests.length }); calls.push(...requests.map(arguments_ => ({ name: 'media_desk_read', arguments: arguments_ }))) }
  add('tiny', ['work', 'preferences', 'materials', 'metrics'].map(kind => ({ kind, limit: 1 })))
  add('exact', [{ kind: 'work', id: 'collection-1' }, { kind: 'work', id: 'collection-1', limit: '$resultLength' }, { kind: 'work', id: 'collection-1', offset: '$resultLength', limit: 1 }])
  const pages = (kind, id, count) => Array.from({ length: count }, (_, index) => ({ kind, ...(id ? { id } : {}), offset: index * 20000, limit: 20000 }))
  add('works', pages('work', null, 4))
  add('metadata', pages('work', 'collection-0', 6))
  add('preferences', pages('preferences', null, 4))
  add('materials', pages('materials', null, 6))
  add('metrics', [{ kind: 'metrics', limit: 20000 }])
  const runtime = await nativeRuntime(t, { recipes: { MD_FIXTURE_PAGED_READ: { calls, reply: 'The complete bounded JSON pages were read.' } } })
  const data = join(runtime.home, 'media-desk')
  await mkdir(data)
  await writeFile(join(data, 'state.json'), JSON.stringify({ version: 1, sampleCleared: true,
    items: Array.from({ length: 81 }, (_, index) => ({ id: 'collection-' + index, kind: 'note', imported: true, title: index === 0 ? largeTitle : 'Collection ' + index,
      body: 'Collected source ' + index, source: 'Original source', createdAt: '2026-11-01T12:00:00Z', status: 'ready', drafts: {},
      ...(index === 0 ? { production: { status: 'done', article: 'The small current article.', facts: [largeFacts] } } : {}) })),
    styles: [{ id: 'large-style', name: 'A large style', summary: 'Style evidence '.repeat(2800) }], activeStyleId: 'large-style',
    skills: Array.from({ length: 25 }, (_, index) => ({ id: 'rule-' + index, name: 'Rule ' + index, rule: 'Accepted rule ' + index, status: 'active' })),
    metrics: Array.from({ length: 101 }, (_, index) => ({ id: 'metric-' + index, views: index })),
    people: [], angles: [], accounts: [], chat: [],
  }))
  await runtime.start()
  assert.equal((await runtime.host('notes/migrate', {})).status, 200)
  const association = (await runtime.host('sessions/open', { workId: null })).value.association
  const requestId = await runtime.prompt(association.sessionId, 'Read-only MD_FIXTURE_PAGED_READ: read complete collections and metadata through bounded pages.')
  const turn = await runtime.turn(association.sessionId, requestId)
  assert.equal(turn.end.data.reason.kind, 'completed')
  const seen = new Set()
  // The result pruner can rewrite the same toolCallId; pagination uses the original persisted result.
  const results = turn.events.filter(event => {
    if (event.type !== 'tool/result' || seen.has(event.data.message.toolCallId)) return false
    seen.add(event.data.message.toolCallId)
    return true
  })
  assert.equal(results.length, calls.length)
  assert.ok(results.every(event => !event.data.message.isError))
  const group = label => {
    const { start, count } = groups.find(group => group.label === label)
    return results.slice(start, start + count).map(event => ({ raw: event.data.message.content[0].text, value: JSON.parse(event.data.message.content[0].text) }))
  }
  for (const { raw, value } of group('tiny')) {
    assert.ok(raw.length < 100, 'A tiny page must not emit unbounded metadata')
    assert.equal(value.text.length, 1)
    assert.equal(value.truncated, true)
    assert.equal(value.nextOffset, 1)
  }
  const exact = group('exact').map(result => result.value)
  assert.deepEqual(exact[1], exact[0])
  assert.deepEqual(exact[2], { text: '', truncated: false, nextOffset: null })
  const reconstruct = label => {
    const chunks = group(label).map(({ value }, index) => {
      assert.equal(typeof value.text, 'string')
      assert.ok(value.text.length <= 20000)
      assert.equal(value.nextOffset, value.truncated ? (index + 1) * 20000 : null)
      return value.text
    })
    assert.equal(group(label).at(-1).value.truncated, false)
    return JSON.parse(chunks.join(''))
  }
  const works = reconstruct('works').works
  assert.equal(works.length, 81)
  assert.equal(works.at(-1).id, 'collection-80')
  const work = reconstruct('metadata')
  assert.equal(work.title, largeTitle)
  assert.equal(work.production.facts[0], largeFacts)
  assert.equal(work.body, 'The small current article.')
  assert.equal(reconstruct('preferences').rules.length, 25)
  const materials = reconstruct('materials').materials
  assert.equal(materials.length, 81)
  assert.equal(materials.at(-1).id, 'collection-80')
  assert.equal(group('metrics')[0].value.metrics.length, 101)
  assert.equal(group('metrics')[0].value.metrics[0].id, 'metric-0')
})
