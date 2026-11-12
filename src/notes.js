/** Registered work Markdown supplies current text; Store projections never become a second primary. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseDocument, stringify } from 'yaml'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { tr } from './i18n.js'

const METADATA = ['title', 'tags', 'source', 'url', 'language', 'noteMetadata']
const fingerprint = bytes => createHash('sha256').update(bytes).digest('hex')
const failure = (code, message, status = 409) => Object.assign(new Error(message), { code, status })

/** Current work files, registered by stable work identity and explicit language. */
export class Notes {
  constructor(owner) {
    this.wikiRoot = owner.wikiRoot
    this.root = owner.notesRoot
    this.roots = new Set(owner.notesRoots)
    this.canCreate = Boolean(owner.selectedNotesRoot)
    this.indexKey = fingerprint(owner.dataRoot).slice(0, 16)
  }

  async init() {
    for (const root of this.roots) if (await realpath(root) !== root) throw failure('notes/unowned-root', tr('作品所在的 Notes 目录尚未取得写入所有权'))
  }

  /** Create only child directories of an existing owned root; vanished Wiki parents stay vanished. */
  async createDirectory(root, relativePath) {
    if (!this.roots.has(root)) throw failure('notes/unowned-root', tr('作品所在的 Notes 目录尚未取得写入所有权'))
    let path = root
    try {
      if (await realpath(root) !== root || !(await lstat(root)).isDirectory()) throw new Error('Notes root is not a regular directory')
      for (const part of relativePath ? relativePath.split('/') : []) {
        path = join(path, part)
        try { await mkdir(path, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
        if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) throw new Error('Notes child is not a regular directory')
      }
    } catch (error) {
      throw failure('notes/directory-unavailable', tr('Notes 目录不可用：{path}。请恢复普通目录后重试', { path }))
    }
  }

  /** Update this data directory's navigation block without adopting other notes or index prose. */
  async syncIndex(state) {
    const start = `<!-- media-desk:works:${this.indexKey} -->`
    const end = `<!-- /media-desk:works:${this.indexKey} -->`
    const link = (title, path) => `- [${title.replace(/[\[\]\\]/g, '\\$&').replace(/[\r\n]/g, ' ')}](<${path.split('/').map(encodeURIComponent).join('/')}>)`
    for (const root of this.roots) {
      const works = state.items.filter(item => item.content?.notesRoot === root).sort((a, b) => a.id.localeCompare(b.id))
      let bytes = null
      try { bytes = await this.readBytes({ notesRoot: root, relativePath: 'index.md' }) } catch (error) { if (error.code !== 'notes/missing') throw error }
      const old = bytes?.toString('utf8') ?? '# Notes\n'
      const opening = old.split(start).length - 1
      const closing = old.split(end).length - 1
      if (opening !== closing || opening > 1 || opening && old.indexOf(end) < old.indexOf(start)) throw failure('notes/index-invalid', tr('Notes 索引中的作品导航标记无效，请修复索引文件'))
      if (!works.length && !opening) continue
      const sources = works.filter(item => item.sourceContent)
      const section = [start, '## Works', '', ...works.map(item => link(item.title, item.content.relativePath)),
        ...(sources.length ? ['', '## Materials', '', ...sources.map(item => link(item.title, item.sourceContent.relativePath))] : []), end].join('\n')
      const next = opening ? old.slice(0, old.indexOf(start)) + section + old.slice(old.indexOf(end) + end.length)
        : old + (old.endsWith('\n') ? '\n' : '\n\n') + section + '\n'
      if (next === old) continue
      const path = join(root, 'index.md')
      await this.createDirectory(root, '')
      if (bytes) await writeFileAtomic(path, next, { mode: 0o600, dirMode: 0o700 })
      else await writeFile(path, next, { flag: 'wx', mode: 0o600 })
    }
  }

  document(item, before = null) {
    let sources = item.noteMetadata?.sources ?? []
    if (!before || item.url !== before.url || item.source !== before.source) {
      const { url, label, ...details } = sources[0] ?? {}
      sources = item.url || item.source ? [{ ...details, ...(item.url ? { url: item.url } : {}), ...(item.source ? { label: item.source } : {}) }, ...sources.slice(1)] : sources.slice(1)
    }
    const metadata = { ...item.noteMetadata, format: 1, kind: 'work', id: item.id, title: item.title,
      createdAt: item.createdAt, updatedAt: new Date().toISOString(), language: item.language ?? 'und',
      tags: item.tags ?? [], sources }
    item.noteMetadata = metadata
    return `---\n${stringify(metadata)}---\n\n${item.body ?? ''}`
  }

  decode(bytes) {
    const text = bytes.toString('utf8')
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n(?:\r?\n)?/.exec(text)
    if (!match) throw failure('notes/metadata-invalid', tr('作品文件缺少有效的 YAML 元数据'))
    const document = parseDocument(match[1], { uniqueKeys: true, customTags: [] })
    if (document.errors.length || document.warnings.length) throw failure('notes/metadata-invalid', tr('作品文件缺少有效的 YAML 元数据'))
    let metadata
    try { metadata = document.toJS({ maxAliasCount: 0 }) } catch (error) {
      throw failure('notes/metadata-invalid', tr('作品文件缺少有效的 YAML 元数据'))
    }
    return { metadata, body: text.slice(match[0].length) }
  }

  parse(bytes, reference, id) {
    const { metadata, body } = this.decode(bytes)
    if (metadata?.id !== id || metadata.language !== reference.language) {
      throw failure('notes/identity-mismatch', tr('作品文件的身份或语言与登记不符'))
    }
    if (metadata.format !== 1 || metadata.kind !== 'work' || typeof metadata.title !== 'string'
      || !Array.isArray(metadata.tags) || metadata.tags.some(tag => typeof tag !== 'string')
      || !Array.isArray(metadata.sources) || metadata.sources.some(source => !source || typeof source !== 'object' || Array.isArray(source)
        || ['label', 'url'].some(key => source[key] !== undefined && typeof source[key] !== 'string'))
      || ![metadata.createdAt, metadata.updatedAt].every(date => typeof date === 'string' && Number.isFinite(Date.parse(date)))) {
      throw failure('notes/metadata-invalid', tr('作品文件缺少有效的 YAML 元数据'))
    }
    return { metadata, body }
  }

  async readBytes(reference) {
    if (!this.roots.has(reference.notesRoot)) throw failure('notes/unowned-root', tr('作品所在的 Notes 目录尚未取得写入所有权'))
    if (typeof reference.relativePath !== 'string' || /[\u0000-\u001f\\]/.test(reference.relativePath)
      || reference.relativePath.split('/').some(part => !part || part === '.' || part === '..')) {
      throw failure('notes/path-invalid', tr('作品文件必须位于 Notes 的 works 目录中'))
    }
    const path = join(reference.notesRoot, reference.relativePath)
    let handle
    try {
      if (await realpath(reference.notesRoot) !== reference.notesRoot
        || await realpath(dirname(path)) !== dirname(path)) {
        throw failure('notes/path-invalid', tr('作品文件必须位于 Notes 的 works 目录中'))
      }
      const entry = await lstat(path)
      if (!entry.isFile()) throw failure('notes/path-invalid', tr('作品文件必须是普通 Markdown 文件'))
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const info = await handle.stat()
      if (!info.isFile() || info.dev !== entry.dev || info.ino !== entry.ino) throw failure('notes/path-invalid', tr('作品文件必须是普通 Markdown 文件'))
      const bytes = await handle.readFile()
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      return bytes
    } catch (error) {
      if (error.code?.startsWith('notes/')) throw error
      if (error.code === 'ENOENT') throw failure('notes/missing', tr('作品文件缺失：{path}。请重新关联文件', { path }))
      throw failure('notes/unreadable', tr('作品文件无法读取：{path}。请检查文件格式与权限', { path }))
    } finally {
      await handle?.close()
    }
  }

  async readWork(reference, id) {
    if (!/^works\/[^/\\]+\.md$/.test(reference.relativePath)) throw failure('notes/path-invalid', tr('作品文件必须位于 Notes 的 works 目录中'))
    const bytes = await this.readBytes(reference)
    return { ...this.parse(bytes, reference, id), sha256: fingerprint(bytes) }
  }

  async writeFixed(item, role, text, details = {}) {
    const root = item.content.notesRoot
    const relativePath = `history/${encodeURIComponent(item.id)}/${randomUUID()}.md`
    const metadata = { format: 1, kind: 'history', workId: item.id, role, ...details }
    const bytes = `---\n${stringify(metadata)}---\n\n${text}`
    const path = join(root, relativePath)
    await this.createDirectory(root, `history/${encodeURIComponent(item.id)}`)
    await writeFile(path, bytes, { mode: 0o600, flag: 'wx' })
    return { notesRoot: root, relativePath, sha256: fingerprint(bytes), role }
  }

  async readFixed(reference, id) {
    if (!reference.relativePath.startsWith(`history/${encodeURIComponent(id)}/`)) throw failure('notes/history-invalid', tr('作品历史版本缺失或无效，请修复历史文件'))
    const bytes = await this.readBytes(reference)
    const { metadata, body } = this.decode(bytes)
    if (fingerprint(bytes) !== reference.sha256 || metadata.format !== 1 || metadata.kind !== 'history' || metadata.workId !== id || metadata.role !== reference.role) {
      throw failure('notes/history-invalid', tr('作品历史版本缺失或无效，请修复历史文件'))
    }
    return body
  }

  async keepSource(item, body) {
    if (item.sourceContent || !body) return
    const id = `${item.id}-source`
    const relativePath = `materials/${encodeURIComponent(id)}.md`
    const metadata = { format: 1, kind: 'material', id, workId: item.id, title: item.title, language: item.language ?? 'und',
      scope: item.imported ? 'saved-post' : 'idea', ...(item.source ? { source: item.source } : {}), ...(item.url ? { url: item.url } : {}),
      ...(item.createdAt ? { originalCreatedAt: item.createdAt } : {}), registeredAt: new Date().toISOString() }
    const bytes = `---\n${stringify(metadata)}---\n\n${body}`
    const path = join(item.content.notesRoot, relativePath)
    await this.createDirectory(item.content.notesRoot, 'materials')
    await writeFile(path, bytes, { mode: 0o600, flag: 'wx' })
    item.sourceContent = { id, notesRoot: item.content.notesRoot, relativePath, revision: 1, sha256: fingerprint(bytes), status: 'ready', scope: metadata.scope }
  }

  async captureDraft(item, format, draft) {
    const { by, at, engine } = draft
    if (typeof draft.text === 'string') draft.textVersion = await this.writeFixed(item, 'draft', draft.text, { draftFormat: format, by, at, engine })
    if (typeof draft.aiText === 'string' && !draft.aiVersion) draft.aiVersion = await this.writeFixed(item, 'ai-original', draft.aiText, { draftFormat: format, at, engine })
  }

  selectText(item, old) {
    const selected = Object.entries(item.drafts ?? {}).find(([format, draft]) => draft.current
      && (!old?.drafts?.[format]?.current || draft.text !== old.drafts[format].text))
    if (selected) {
      item.body = selected[1].text
      if (item.production) item.production.current = false
      return true
    }
    const production = item.production
    if (typeof production?.article === 'string' && (production.article !== old?.production?.article || production.current && !old?.production?.current)) {
      item.body = production.article
      production.current = true
      for (const draft of Object.values(item.drafts ?? {})) draft.current = false
      return true
    }
    return false
  }

  async saveHistory(item, old, selected) {
    const retain = reference => {
      if (!reference) return
      item.textHistory ??= []
      if (!item.textHistory.some(saved => saved.notesRoot === reference.notesRoot && saved.relativePath === reference.relativePath)) item.textHistory.push(reference)
    }
    for (const reference of old?.textHistory ?? []) retain(reference)
    let previousText
    if (old && old.body !== item.body) {
      if (selected) await this.keepSource(item, old.body)
      previousText = await this.writeFixed(item, 'work', old.body, { language: old.content.language, revision: old.content.revision })
      retain(previousText)
    }
    for (const [format, draft] of Object.entries(item.drafts ?? {})) {
      const previous = old?.drafts?.[format]
      if (draft.current) draft.text = item.body
      else if (previous?.current && draft.text === previous.text) {
        draft.textVersion = previousText ?? await this.writeFixed(item, 'draft', draft.text, { draftFormat: format, by: previous.by, at: previous.at, engine: previous.engine })
      } else if (typeof draft.text === 'string' && (!draft.textVersion || draft.text !== previous?.text)) {
        draft.textVersion = await this.writeFixed(item, 'draft', draft.text, { draftFormat: format, by: draft.by, at: draft.at, engine: draft.engine })
      }
      if (typeof draft.aiText === 'string' && (!draft.aiVersion || draft.aiText !== previous?.aiText)) {
        draft.aiVersion = await this.writeFixed(item, 'ai-original', draft.aiText, { draftFormat: format, at: draft.at, engine: draft.engine })
      }
      if (previous?.textVersion?.relativePath !== draft.textVersion?.relativePath) retain(previous?.textVersion)
      if (previous?.aiVersion?.relativePath !== draft.aiVersion?.relativePath) retain(previous?.aiVersion)
    }
    for (const [format, draft] of Object.entries(old?.drafts ?? {})) if (!item.drafts?.[format]) {
      retain(draft.textVersion)
      retain(draft.aiVersion)
    }
    const production = item.production
    const previous = old?.production
    if (production) {
      if (production.current) production.article = item.body
      else if (previous?.current && production.article === previous.article) {
        production.textVersion = previousText ?? await this.writeFixed(item, 'production', production.article)
      } else if (typeof production.article === 'string' && (!production.textVersion || production.article !== previous?.article)) {
        production.textVersion = await this.writeFixed(item, 'production', production.article)
      }
      if (typeof production.aiArticle === 'string' && (!production.aiVersion || production.aiArticle !== previous?.aiArticle)) {
        production.aiVersion = await this.writeFixed(item, 'ai-original', production.aiArticle, { at: production.startedAt, engine: production.engine })
      }
    }
    if (previous?.textVersion?.relativePath !== production?.textVersion?.relativePath) retain(previous?.textVersion)
    if (previous?.aiVersion?.relativePath !== production?.aiVersion?.relativePath) retain(previous?.aiVersion)
  }

  async projectHistory(item) {
    for (const draft of Object.values(item.drafts ?? {})) {
      if (draft.current) draft.text = item.body
      else if (draft.textVersion) draft.text = await this.readFixed(draft.textVersion, item.id)
      if (draft.aiVersion) draft.aiText = await this.readFixed(draft.aiVersion, item.id)
    }
    if (item.production) {
      if (item.production.current) item.production.article = item.body
      else item.production.article = item.production.textVersion ? await this.readFixed(item.production.textVersion, item.id) : ''
      if (item.production.aiVersion) item.production.aiArticle = await this.readFixed(item.production.aiVersion, item.id)
    }
  }

  project(item, metadata, body) {
    Object.assign(item, { title: metadata.title, tags: metadata.tags, language: metadata.language, body, createdAt: metadata.createdAt,
      noteMetadata: structuredClone(metadata),
      source: metadata.sources[0]?.label ?? '', url: metadata.sources[0]?.url ?? null })
  }

  async hydrate(state) {
    const projected = structuredClone(state)
    for (const item of projected.items) {
      if (!item.content) continue
      const reference = item.content
      try {
        const { metadata, body, sha256 } = await this.readWork(reference, item.id)
        if (sha256 !== reference.sha256) {
          reference.sha256 = sha256
          reference.revision += 1
        }
        reference.status = 'ready'
        delete reference.code
        delete reference.error
        this.project(item, metadata, body)
        await this.projectHistory(item)
      } catch (error) {
        reference.status = error.code === 'notes/missing' ? 'missing' : 'invalid'
        reference.code = error.code
        reference.error = error.message
        delete item.body
        item.title = item.id
      }
      const saved = structuredClone(reference)
      delete saved.error
      state.items.find(row => row.id === item.id).content = saved
    }
    return projected
  }

  /** Validate an explicitly selected replacement; changes only the registered reference. */
  async relink(item, relativePath) {
    const reference = { ...item.content, relativePath }
    const { metadata, body, sha256 } = await this.readWork(reference, item.id)
    item.content = { ...reference, sha256, revision: reference.revision + 1, status: 'ready' }
    delete item.content.code
    delete item.content.error
    this.project(item, metadata, body)
    await this.projectHistory(item)
  }

  /** Register a user-selected current file; distinct source and inactive drafts become separate material/history. */
  async register(item, language, relativePath, notesRoot = this.root, wikiRoot = this.wikiRoot) {
    if (item.content) throw failure('notes/already-registered', tr('作品已经登记 Notes 文件，请使用重新关联入口'))
    if (!['zh', 'en', 'und'].includes(language)) throw failure('notes/language-invalid', tr('请选择作品语言，未知语言使用 und'), 400)
    if (Object.keys(item.otherLang ?? {}).length) throw failure('notes/legacy-languages', tr('此作品含有旧语言版本，请先完成 Notes 语言迁移'))
    const reference = { wikiRoot, notesRoot, relativePath, language, revision: 1, status: 'ready', role: 'body' }
    const { metadata, body, sha256 } = await this.readWork(reference, item.id)
    item.content = { ...reference, sha256 }
    if (item.body !== body) await this.keepSource(item, item.body)
    for (const [format, draft] of Object.entries(item.drafts ?? {})) {
      draft.current = false
      await this.captureDraft(item, format, draft)
    }
    if (item.production) {
      item.production.current = false
      if (typeof item.production.article === 'string') item.production.textVersion = await this.writeFixed(item, 'production', item.production.article)
      if (typeof item.production.aiArticle === 'string') item.production.aiVersion = await this.writeFixed(item, 'ai-original', item.production.aiArticle)
    }
    this.project(item, metadata, body)
    await this.projectHistory(item)
  }

  assertExpected(state, expected) {
    if (!expected || typeof expected !== 'object' || Array.isArray(expected)) throw failure('notes/version-invalid', tr('内容版本无效，请重新读取作品'), 400)
    for (const [id, version] of Object.entries(expected)) {
      if (!Number.isSafeInteger(version?.revision) || version.revision < 1 || !/^[a-f0-9]{64}$/.test(version?.sha256)) {
        throw failure('notes/version-invalid', tr('内容版本无效，请重新读取作品'), 400)
      }
      const current = state.items.find(row => row.id === id)?.content
      if (!current || current.status !== 'ready' || current.revision !== version.revision || current.sha256 !== version.sha256) {
        throw failure('notes/conflict', tr('作品内容已变化，请重新读取后再修改'))
      }
    }
  }

  async commit(before, draft) {
    const previous = new Map(before.items.map(item => [item.id, item]))
    for (const item of draft.items) {
      const old = previous.get(item.id)
      if (old?.content) {
        item.content ??= { ...old.content }
        if (old.content.relativePath !== item.content.relativePath) continue
        const selected = this.selectText(item, old)
        const changed = item.body !== old.body || METADATA.some(key => key !== 'noteMetadata' && JSON.stringify(item[key]) !== JSON.stringify(old[key]))
        const versionsChanged = JSON.stringify(item.drafts) !== JSON.stringify(old.drafts) || JSON.stringify(item.production) !== JSON.stringify(old.production)
        item.content = { ...old.content }
        if (!changed && !versionsChanged) continue
        if (old.content.status !== 'ready') throw failure(old.content.code, old.content.error)
        if (item.language !== old.content.language) throw failure('notes/language-change', tr('登记作品的语言不能直接修改'))
        const current = await this.readWork(old.content, item.id)
        if (current.sha256 !== old.content.sha256) throw failure('notes/conflict', tr('作品内容已变化，请重新读取后再修改'))
        await this.saveHistory(item, old, selected)
        if (!changed) continue
        if ((await this.readWork(old.content, item.id)).sha256 !== old.content.sha256) throw failure('notes/conflict', tr('作品内容已变化，请重新读取后再修改'))
        const bytes = this.document(item, old)
        await writeFileAtomic(join(old.content.notesRoot, old.content.relativePath), bytes, { mode: 0o600, dirMode: 0o700 })
        item.content = { ...old.content, revision: old.content.revision + 1, sha256: fingerprint(bytes), status: 'ready' }
        continue
      }
      if (item.content) {
        const { metadata, body, sha256 } = await this.readWork(item.content, item.id)
        if (sha256 !== item.content.sha256) item.content.revision += 1
        item.content.sha256 = sha256
        item.content.status = 'ready'
        delete item.content.code
        delete item.content.error
        this.project(item, metadata, body)
        await this.projectHistory(item)
        continue
      }
      if (old || item.sample || item.imported) continue
      if (!this.canCreate) throw failure('wiki/unavailable', tr('Wiki 目录不可用：{path}。请检查 WIKI_PATH', { path: this.wikiRoot }), 503)
      const source = item.body
      this.selectText(item, null)
      const language = item.language ?? 'und'
      const relativePath = `works/${item.id}-${language}.md`
      item.language = language
      const bytes = this.document(item)
      await this.createDirectory(this.root, 'works')
      await writeFile(join(this.root, relativePath), bytes, { mode: 0o600, flag: 'wx' })
      item.content = { wikiRoot: this.wikiRoot, notesRoot: this.root, relativePath, language, revision: 1, sha256: fingerprint(bytes), status: 'ready' }
      if (source !== item.body) await this.keepSource(item, source)
      await this.saveHistory(item, null, false)
    }
    const durable = structuredClone(draft)
    for (const item of durable.items) {
      if (!item.content) continue
      delete item.body
      for (const key of METADATA) delete item[key]
      for (const draft of Object.values(item.drafts ?? {})) {
        delete draft.text
        delete draft.aiText
      }
      if (item.production) {
        delete item.production.article
        delete item.production.aiArticle
      }
    }
    await this.syncIndex(draft)
    return durable
  }
}
