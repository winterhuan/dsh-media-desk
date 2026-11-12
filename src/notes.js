/** Registered work, material and preference Markdown supplies editable text; Store retains references and operational state. */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseDocument, stringify } from 'yaml'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { tr } from './i18n.js'

const METADATA = ['title', 'tags', 'source', 'url', 'language', 'noteMetadata']
const STYLE_TEXT = ['name', 'icon', 'summary', 'tone', 'sentences', 'opening', 'structure', 'words', 'avoid', 'samples', 'source', 'sourceUrls']
const RULE_TEXT = ['name', 'rule', 'source', 'evidence']
const MATERIAL_TEXT = ['title', 'body', 'source', 'url', 'createdAt', 'publishedAt', 'collectedAt', 'materialType', 'completeness', 'externalId', 'styleId', 'selectedAuthorSample']
/** Fields retained with a work's language when selection or undo targets another language. */
export const LANGUAGE_FIELDS = [...METADATA, 'body', 'content', 'media', 'drafts', 'production', 'sourceContent', 'textHistory', 'languageBasis']
const fingerprint = bytes => createHash('sha256').update(bytes).digest('hex')
const failure = (code, message, status = 409) => Object.assign(new Error(message), { code, status })

/**
 * @param {object} error - Rejected or retained save error; its diagnostic code stays intact.
 * @returns {string} Localized filesystem guidance or the domain's specific repair instruction.
 */
export function notesSaveMessage(error) {
  return /^E[A-Z0-9]+$/.test(error.code ?? '') ? tr('保存失败，请检查保存位置和写入权限后重试') : error.message
}

/** Owned Notes files, registered by stable domain identity and explicit work language where applicable. */
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
      const materials = [
        ...state.items.filter(item => item.sourceContent?.notesRoot === root).map(item => ({ id: `source:${item.id}`, title: item.title, path: item.sourceContent.relativePath })),
        ...state.items.filter(item => item.materialContent?.notesRoot === root).map(item => ({ id: `material:${item.id}`, title: item.title, path: item.materialContent.relativePath })),
        ...state.styles.filter(row => row.sampleContent?.notesRoot === root && !row.preset && !row.sample).map(row => ({ id: `style-samples:${row.id}`, title: `${row.name} · ${tr('作者样文')}`, path: row.sampleContent.relativePath })),
      ].sort((a, b) => a.id.localeCompare(b.id))
      const preferences = [
        ...state.styles.filter(row => row.content?.notesRoot === root && !row.preset && !row.sample).map(row => ({ id: `style:${row.id}`, title: row.name, path: row.content.relativePath })),
        ...state.skills.filter(row => row.content?.notesRoot === root && !row.sample).map(row => ({ id: `rule:${row.id}`, title: row.name, path: row.content.relativePath })),
        ...(state.voice?.content?.notesRoot === root ? [{ id: 'voice', title: tr('个人语气'), path: state.voice.content.relativePath }] : []),
      ].sort((a, b) => a.id.localeCompare(b.id))
      let bytes = null
      try { bytes = await this.readBytes({ notesRoot: root, relativePath: 'index.md' }) } catch (error) { if (error.code !== 'notes/missing') throw error }
      const old = bytes?.toString('utf8') ?? '# Notes\n'
      const opening = old.split(start).length - 1
      const closing = old.split(end).length - 1
      if (opening !== closing || opening > 1 || opening && old.indexOf(end) < old.indexOf(start)) throw failure('notes/index-invalid', tr('Notes 索引中的作品导航标记无效，请修复索引文件'))
      if (!works.length && !materials.length && !preferences.length && !opening) continue
      const section = [start, '## Works', '', ...works.map(item => link(item.title, item.content.relativePath)),
        ...(materials.length ? ['', '## Materials', '', ...materials.map(item => link(item.title, item.path))] : []),
        ...(preferences.length ? ['', '## Preferences', '', ...preferences.map(item => link(item.title, item.path))] : []), end].join('\n')
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

  /** Read and validate a regular owned file without yielding at receipt acceptance. */
  readBytesSync(reference) {
    if (!this.roots.has(reference.notesRoot)) throw failure('notes/unowned-root', tr('作品所在的 Notes 目录尚未取得写入所有权'))
    if (typeof reference.relativePath !== 'string' || /[\u0000-\u001f\\]/.test(reference.relativePath)
      || reference.relativePath.split('/').some(part => !part || part === '.' || part === '..')) {
      throw failure('notes/path-invalid', tr('作品文件必须位于 Notes 的 works 目录中'))
    }
    const path = join(reference.notesRoot, reference.relativePath)
    let descriptor
    try {
      if (realpathSync(reference.notesRoot) !== reference.notesRoot || realpathSync(dirname(path)) !== dirname(path)) {
        throw failure('notes/path-invalid', tr('作品文件必须位于 Notes 的 works 目录中'))
      }
      const entry = lstatSync(path)
      if (!entry.isFile()) throw failure('notes/path-invalid', tr('作品文件必须是普通 Markdown 文件'))
      descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const info = fstatSync(descriptor)
      if (!info.isFile() || info.dev !== entry.dev || info.ino !== entry.ino) throw failure('notes/path-invalid', tr('作品文件必须是普通 Markdown 文件'))
      const bytes = readFileSync(descriptor)
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      return bytes
    } catch (error) {
      if (error.code?.startsWith('notes/')) throw error
      if (error.code === 'ENOENT') throw failure('notes/missing', tr('作品文件缺失：{path}。请重新关联文件', { path }))
      throw failure('notes/unreadable', tr('作品文件无法读取：{path}。请检查文件格式与权限', { path }))
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
    }
  }

  async readWork(reference, id) {
    if (!/^works\/[^/\\]+\.md$/.test(reference.relativePath)) throw failure('notes/path-invalid', tr('作品文件必须位于 Notes 的 works 目录中'))
    const bytes = await this.readBytes(reference)
    return { ...this.parse(bytes, reference, id), sha256: fingerprint(bytes), bytes }
  }

  managedPath(kind, id) {
    if (kind === 'voice') return 'preferences/voice.md'
    if (kind === 'style') return `preferences/styles/${encodeURIComponent(id)}.md`
    if (kind === 'rule') return `preferences/rules/${encodeURIComponent(id)}.md`
    if (kind === 'material') return `materials/${encodeURIComponent(id)}.md`
    throw new Error(`Unsupported Notes content kind: ${kind}`)
  }

  managedDocument(kind, id, row) {
    const updatedAt = new Date().toISOString()
    if (kind === 'voice') return `---\n${stringify({ format: 1, kind, id, updatedAt })}---\n\n${row.text ?? ''}`
    const fields = kind === 'style' ? STYLE_TEXT : kind === 'rule' ? RULE_TEXT : MATERIAL_TEXT.filter(key => key !== 'body')
    const data = Object.fromEntries(fields.filter(key => row[key] !== undefined).map(key => [key, structuredClone(row[key])]))
    const metadata = { format: 1, kind, id, updatedAt, data }
    return `---\n${stringify(metadata)}---\n\n${kind === 'material' ? row.body ?? '' : ''}`
  }

  parseManaged(bytes, reference, id, kind) {
    const { metadata, body } = this.decode(bytes)
    if (metadata?.format !== 1 || metadata.kind !== kind || metadata.id !== id
      || typeof metadata.updatedAt !== 'string' || !Number.isFinite(Date.parse(metadata.updatedAt))) {
      throw failure('notes/metadata-invalid', tr('Notes 内容文件缺少有效的 YAML 元数据'))
    }
    if (kind === 'voice') return { metadata, value: { text: body } }
    if (!metadata.data || typeof metadata.data !== 'object' || Array.isArray(metadata.data)) {
      throw failure('notes/metadata-invalid', tr('Notes 内容文件缺少有效的 YAML 元数据'))
    }
    const fields = kind === 'style' ? STYLE_TEXT : kind === 'rule' ? RULE_TEXT : MATERIAL_TEXT.filter(key => key !== 'body')
    const value = Object.fromEntries(fields.filter(key => metadata.data[key] !== undefined).map(key => [key, structuredClone(metadata.data[key])]))
    if (kind === 'style') {
      const lists = new Set(['words', 'avoid', 'samples', 'sourceUrls'])
      if (typeof value.name !== 'string' || fields.some(key => value[key] !== undefined && (lists.has(key)
        ? !Array.isArray(value[key]) || value[key].some(entry => typeof entry !== 'string') : typeof value[key] !== 'string'))) {
        throw failure('notes/metadata-invalid', tr('Notes 风格文件缺少有效内容'))
      }
    } else if (kind === 'rule') {
      if (typeof value.name !== 'string' || typeof value.rule !== 'string' || fields.some(key => value[key] !== undefined && typeof value[key] !== 'string')) {
        throw failure('notes/metadata-invalid', tr('Notes 规则文件缺少有效内容'))
      }
    } else if (typeof value.title !== 'string' || fields.some(key => value[key] !== undefined && (key === 'selectedAuthorSample'
      ? typeof value[key] !== 'boolean' : typeof value[key] !== 'string'))
      || ['createdAt', 'publishedAt', 'collectedAt'].some(key => value[key] !== undefined && !Number.isFinite(Date.parse(value[key])))
      || value.completeness !== undefined && !['complete', 'excerpt', 'summary'].includes(value.completeness)) {
      throw failure('notes/metadata-invalid', tr('Notes 材料文件缺少有效内容'))
    }
    if (kind === 'material') value.body = body
    return { metadata, value }
  }

  async readManaged(reference, id, kind) {
    if (reference.relativePath !== this.managedPath(kind, id)) throw failure('notes/path-invalid', tr('Notes 内容文件路径与登记身份不符'))
    const bytes = await this.readBytes(reference)
    return { ...this.parseManaged(bytes, reference, id, kind), sha256: fingerprint(bytes), bytes }
  }

  async readPrimary(reference, id, kind = 'work') {
    return kind === 'work' ? this.readWork(reference, id) : this.readManaged(reference, id, kind)
  }

  async saveManagedSnapshot(reference, id, kind, bytes) {
    const relativePath = `history/${encodeURIComponent(id)}/${randomUUID()}-${kind}.md`
    await this.createDirectory(reference.notesRoot, `history/${encodeURIComponent(id)}`)
    await writeFile(join(reference.notesRoot, relativePath), bytes, { mode: 0o600, flag: 'wx' })
    return { wikiRoot: reference.wikiRoot, notesRoot: reference.notesRoot, relativePath, sha256: fingerprint(bytes), role: `${kind}-snapshot`, kind, id }
  }

  async saveSnapshot(reference, id, bytes) {
    const relativePath = `history/${encodeURIComponent(id)}/${randomUUID()}-snapshot.md`
    await this.createDirectory(reference.notesRoot, `history/${encodeURIComponent(id)}`)
    await writeFile(join(reference.notesRoot, relativePath), bytes, { mode: 0o600, flag: 'wx' })
    return { wikiRoot: reference.wikiRoot, notesRoot: reference.notesRoot, relativePath,
      language: reference.language, sha256: fingerprint(bytes), role: 'work-snapshot' }
  }

  async readSnapshot(reference, id, language) {
    const bytes = await this.readBytes(reference)
    if (fingerprint(bytes) !== reference.sha256) throw failure('notes/history-invalid', tr('作品历史版本缺失或无效，请修复历史文件'))
    return this.parse(bytes, { ...reference, language }, id)
  }

  async writeFixed(item, role, text, details = {}) {
    const root = item.content.notesRoot
    const relativePath = `history/${encodeURIComponent(item.id)}/${randomUUID()}.md`
    const metadata = { format: 1, kind: 'history', workId: item.id, role, ...details }
    const bytes = `---\n${stringify(metadata)}---\n\n${text}`
    const path = join(root, relativePath)
    await this.createDirectory(root, `history/${encodeURIComponent(item.id)}`)
    await writeFile(path, bytes, { mode: 0o600, flag: 'wx' })
    return { wikiRoot: item.content.wikiRoot, notesRoot: root, relativePath, sha256: fingerprint(bytes), role }
  }

  async readFixed(reference, id) {
    if (!reference.relativePath.startsWith(`history/${encodeURIComponent(id)}/`)) throw failure('notes/history-invalid', tr('作品历史版本缺失或无效，请修复历史文件'))
    const bytes = await this.readBytes(reference)
    if (reference.role === 'work-snapshot') return (await this.readSnapshot(reference, id, reference.language)).body
    const { metadata, body } = this.decode(bytes)
    if (fingerprint(bytes) !== reference.sha256 || metadata.format !== 1 || metadata.kind !== 'history' || metadata.workId !== id || metadata.role !== reference.role) {
      throw failure('notes/history-invalid', tr('作品历史版本缺失或无效，请修复历史文件'))
    }
    return body
  }

  async keepSource(item, body) {
    if (item.sourceContent || !body) return
    const id = `${item.id}-${item.content.language}-source`
    const relativePath = `materials/${encodeURIComponent(id)}.md`
    const metadata = { format: 1, kind: 'material', id, workId: item.id, title: item.title, language: item.language ?? 'und',
      scope: item.imported ? 'saved-post' : 'idea', ...(item.source ? { source: item.source } : {}), ...(item.url ? { url: item.url } : {}),
      ...(item.createdAt ? { originalCreatedAt: item.createdAt } : {}), registeredAt: new Date().toISOString() }
    const bytes = `---\n${stringify(metadata)}---\n\n${body}`
    const path = join(item.content.notesRoot, relativePath)
    await this.createDirectory(item.content.notesRoot, 'materials')
    await writeFile(path, bytes, { mode: 0o600, flag: 'wx' })
    item.sourceContent = { id, wikiRoot: item.content.wikiRoot, notesRoot: item.content.notesRoot, relativePath, revision: 1, sha256: fingerprint(bytes), status: 'ready', scope: metadata.scope }
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

  managedFields(kind) {
    return kind === 'style' ? STYLE_TEXT : kind === 'rule' ? RULE_TEXT : kind === 'voice' ? ['text'] : MATERIAL_TEXT
  }

  async hydrateManagedRow(state, stored, projected, kind, referenceKey = 'content') {
    const reference = projected?.[referenceKey]
    if (!reference) return
    const subjectId = kind === 'voice' ? 'personal-voice' : projected.id
    state.contentRevisions ??= {}
    const revisionKey = `${kind}:${subjectId}`
    if (!Number.isSafeInteger(reference.revision)) reference.revision = Math.max(1, state.contentRevisions[revisionKey] ?? 0)
    try {
      const { value, sha256, bytes } = await this.readManaged(reference, subjectId, kind)
      if (sha256 !== reference.sha256) {
        reference.sha256 = sha256
        reference.revision = Math.max(reference.revision, state.contentRevisions[revisionKey] ?? 0) + 1
        reference.snapshot = await this.saveManagedSnapshot(reference, subjectId, kind, bytes)
      }
      if (!reference.snapshot) reference.snapshot = await this.saveManagedSnapshot(reference, subjectId, kind, bytes)
      reference.status = 'ready'
      delete reference.code
      delete reference.error
      for (const field of this.managedFields(kind)) {
        if (value[field] === undefined) delete projected[field]
        else projected[field] = structuredClone(value[field])
      }
    } catch (error) {
      reference.status = error.code === 'notes/missing' ? 'missing' : 'invalid'
      reference.code = error.code
      reference.error = error.message
      for (const field of this.managedFields(kind)) delete projected[field]
    }
    const saved = structuredClone(reference)
    delete saved.error
    stored[referenceKey] = saved
    state.contentRevisions[revisionKey] = Math.max(state.contentRevisions[revisionKey] ?? 0, saved.revision)
  }

  async hydrate(state) {
    if (state.items.some(item => item.content)) state.notesRevisions ??= {}
    const projected = structuredClone(state)
    for (const item of projected.items) {
      if (!item.content) continue
      const reference = item.content
      if (!Number.isSafeInteger(reference.revision)) reference.revision = Math.max(1, state.notesRevisions[item.id] ?? 0)
      try {
        let { metadata, body, sha256, bytes } = await this.readWork(reference, item.id)
        const pending = this.writes?.pending(item.id)
        const pendingFile = pending?.files.find(file => file.workId === item.id && file.after.relativePath === reference.relativePath)
        const unacceptedPrimary = pendingFile && sha256 !== reference.sha256
          && (sha256 === pendingFile.candidate.sha256 || await this.writes.isPublication(pendingFile))
        if (unacceptedPrimary && pendingFile.beforeSnapshot) {
          ;({ metadata, body } = await this.readSnapshot(pendingFile.beforeSnapshot, item.id, reference.language))
          sha256 = reference.sha256
        }
        if (sha256 !== reference.sha256) {
          if (reference.snapshot) {
            item.textHistory ??= []
            item.textHistory.push(reference.snapshot)
          }
          reference.sha256 = sha256
          reference.revision = Math.max(reference.revision, state.notesRevisions[item.id] ?? 0) + 1
          reference.snapshot = await this.saveSnapshot(reference, item.id, bytes)
        }
        if (!reference.snapshot && !unacceptedPrimary) reference.snapshot = await this.saveSnapshot(reference, item.id, bytes)
        const conflicts = this.writes?.conflicts(item.id) ?? []
        reference.status = conflicts.length ? 'conflict' : pending ? pending.status === 'conflict' ? 'conflict' : 'pending' : 'ready'
        if (pending) reference.pendingId = pending.id
        else delete reference.pendingId
        delete reference.code
        delete reference.error
        delete reference.conflicts
        if (pending) {
          reference.code = pending.error?.code ?? 'notes/save-pending'
          reference.error = pending.error ? notesSaveMessage(pending.error) : tr('作品有待保存的候选，请重试保存或处理冲突')
        }
        if (conflicts.length) {
          reference.code = 'notes/displaced-conflict'
          reference.error = tr('外部编辑器修改了保留版本，请选择要保留为正文的版本')
          reference.conflicts = conflicts.map(conflict => ({ saveId: conflict.saveId, relativePath: conflict.reference.relativePath, sha256: conflict.observedSha256 }))
        }
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
      delete saved.pendingId
      delete saved.conflicts
      if (['pending', 'conflict'].includes(saved.status)) { saved.status = 'ready'; delete saved.code }
      const row = state.items.find(row => row.id === item.id)
      row.content = saved
      state.notesRevisions[item.id] = Math.max(state.notesRevisions[item.id] ?? 0, saved.revision)
      if (item.textHistory) row.textHistory = structuredClone(item.textHistory)
      for (const [language, variant] of Object.entries(row.otherLang ?? {})) {
        if (!variant.content) continue
        const source = { id: item.id, createdAt: item.createdAt, ...structuredClone(variant) }
        const current = (await this.hydrate({ items: [source], notesRevisions: state.notesRevisions })).items[0]
        row.otherLang[language] = Object.fromEntries(LANGUAGE_FIELDS.filter(field => source[field] !== undefined).map(field => [field, source[field]]))
        item.otherLang[language] = Object.fromEntries(LANGUAGE_FIELDS.filter(field => current[field] !== undefined).map(field => [field, current[field]]))
      }
    }
    for (let index = 0; index < (projected.styles ?? []).length; index++) {
      const row = projected.styles[index]
      if (!row.preset && !row.sample) {
        await this.hydrateManagedRow(state, state.styles[index], row, 'style')
        if (row.sampleContent) {
          const storedSample = { id: `${row.id}-samples`, sampleContent: state.styles[index].sampleContent }
          const projectedSample = { id: `${row.id}-samples`, sampleContent: row.sampleContent }
          await this.hydrateManagedRow(state, storedSample, projectedSample, 'material', 'sampleContent')
          state.styles[index].sampleContent = storedSample.sampleContent
          row.sampleContent = projectedSample.sampleContent
          row.sampleMaterial = Object.fromEntries(MATERIAL_TEXT.filter(field => projectedSample[field] !== undefined).map(field => [field, projectedSample[field]]))
        }
      }
    }
    for (let index = 0; index < (projected.skills ?? []).length; index++) {
      const row = projected.skills[index]
      if (!row.sample) await this.hydrateManagedRow(state, state.skills[index], row, 'rule')
    }
    if (projected.voice?.content) await this.hydrateManagedRow(state, state.voice, projected.voice, 'voice')
    for (let index = 0; index < projected.items.length; index++) {
      const row = projected.items[index]
      if (row.imported && row.materialContent) await this.hydrateManagedRow(state, state.items[index], row, 'material', 'materialContent')
    }
    if (state.notesRevisions) projected.notesRevisions = structuredClone(state.notesRevisions)
    if (state.contentRevisions) projected.contentRevisions = structuredClone(state.contentRevisions)
    return projected
  }

  async prepareManagedRow(before, row, kind, referenceKey = 'content') {
    const id = kind === 'voice' ? 'personal-voice' : row.id
    if (kind === 'material') {
      row.collectedAt ??= new Date().toISOString()
      row.materialType ??= 'source'
      row.completeness ??= 'complete'
    }
    const oldReference = before?.[referenceKey]
    const fields = this.managedFields(kind)
    const changed = !oldReference || !before || fields.some(key => JSON.stringify(row[key]) !== JSON.stringify(before[key]))
    if (oldReference && !changed) {
      row[referenceKey] = structuredClone(oldReference)
      return null
    }
    if (!oldReference && !this.canCreate) throw failure('wiki/unavailable', tr('Wiki 目录不可用：{path}。请检查 WIKI_PATH', { path: this.wikiRoot }), 503)
    let current = null
    if (oldReference) {
      if (oldReference.status !== 'ready') throw failure(oldReference.code, oldReference.error)
      current = await this.readManaged(oldReference, id, kind)
      if (current.sha256 !== oldReference.sha256) throw failure('notes/conflict', tr('Notes 内容已变化，请重新读取后再修改'))
    }
    const bytes = this.managedDocument(kind, id, row)
    const revisionKey = `${kind}:${id}`
    const revision = Math.max((row[referenceKey]?.revision ?? 0) + 1, (before?.[referenceKey]?.revision ?? 0) + 1)
    const reference = oldReference
      ? { ...oldReference, revision, sha256: fingerprint(bytes), status: 'ready' }
      : { wikiRoot: this.wikiRoot, notesRoot: this.root, relativePath: this.managedPath(kind, id), revision: Math.max(1, revision), sha256: fingerprint(bytes), status: 'ready', kind }
    delete reference.code
    delete reference.error
    row[referenceKey] = reference
    return { subjectId: id, kind, before: oldReference ?? null, after: reference, beforeBytes: current?.bytes, bytes, revisionKey }
  }

  async prepareManaged(before, draft) {
    const files = []
    draft.contentRevisions ??= {}
    const previousStyles = new Map((before.styles ?? []).map(row => [row.id, row]))
    for (const row of draft.styles ?? []) if (!row.preset && !row.sample) {
      const file = await this.prepareManagedRow(previousStyles.get(row.id), row, 'style')
      if (file) files.push(file)
      const old = previousStyles.get(row.id)
      const sample = row.sampleMaterial ?? (!row.sampleContent && row.samples?.length ? {
        title: `${row.name} · ${tr('作者样文')}`, body: row.samples.join('\n\n'), source: row.source,
        url: row.sourceUrls?.[0], collectedAt: row.createdAt, materialType: 'author-sample', completeness: 'excerpt',
        externalId: row.accountKey, styleId: row.id, selectedAuthorSample: true,
      } : null)
      if (sample) {
        const sampleRow = { id: `${row.id}-samples`, ...sample, sampleContent: row.sampleContent }
        const oldSample = old ? { id: sampleRow.id, ...(old.sampleMaterial ?? {}), sampleContent: old.sampleContent } : undefined
        const sampleFile = await this.prepareManagedRow(oldSample, sampleRow, 'material', 'sampleContent')
        row.sampleContent = sampleRow.sampleContent
        row.sampleMaterial = Object.fromEntries(MATERIAL_TEXT.filter(field => sampleRow[field] !== undefined).map(field => [field, sampleRow[field]]))
        if (sampleFile) files.push(sampleFile)
      }
    }
    const previousRules = new Map((before.skills ?? []).map(row => [row.id, row]))
    for (const row of draft.skills ?? []) if (!row.sample) {
      const file = await this.prepareManagedRow(previousRules.get(row.id), row, 'rule')
      if (file) files.push(file)
    }
    if (draft.voice) {
      const file = await this.prepareManagedRow(before.voice, draft.voice, 'voice')
      if (file) files.push(file)
    }
    const previousItems = new Map((before.items ?? []).map(row => [row.id, row]))
    for (const row of draft.items ?? []) if (row.imported) {
      const file = await this.prepareManagedRow(previousItems.get(row.id), row, 'material', 'materialContent')
      if (file) files.push(file)
    }
    for (const file of files) draft.contentRevisions[file.revisionKey] = file.after.revision
    return files
  }

  /** Validate an explicitly selected replacement; changes only the registered reference. */
  async relink(item, relativePath) {
    const reference = { ...item.content, relativePath }
    const { metadata, body, sha256 } = await this.readWork(reference, item.id)
    item.content = { ...reference, sha256, revision: reference.revision + 1, status: 'ready' }
    item.content.snapshot = await this.saveSnapshot(item.content, item.id, (await this.readWork(item.content, item.id)).bytes)
    delete item.content.code
    delete item.content.error
    this.project(item, metadata, body)
    await this.projectHistory(item)
  }

  /** Register a user-selected current file; distinct source and inactive drafts become separate material/history. */
  async register(item, language, relativePath, notesRoot = this.root, wikiRoot = this.wikiRoot) {
    if (item.content) throw failure('notes/already-registered', tr('作品已经登记 Notes 文件，请使用重新关联入口'))
    if (!['zh', 'en', 'und'].includes(language)) throw failure('notes/language-invalid', tr('请选择作品语言，未知语言使用 und'), 400)
    const reference = { wikiRoot, notesRoot, relativePath, language, revision: 1, status: 'ready', role: 'body' }
    const { metadata, body, sha256, bytes } = await this.readWork(reference, item.id)
    item.content = { ...reference, sha256 }
    item.content.snapshot = await this.saveSnapshot(item.content, item.id, bytes)
    if (item.otherLang?.[language]) {
      const version = await this.writeFixed(item, 'legacy-language', JSON.stringify(item.otherLang[language]), { language })
      item.languageHistory = [...(item.languageHistory ?? []), { language, version }]
      delete item.otherLang[language]
    }
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
    item.languageBasis = { kind: 'explicit', language }
    await this.projectHistory(item)
  }

  /** Describe every legacy language before preparing files; unregistered paths are never adopted. */
  migrationPlan(state, associations = [], original = state, ids) {
    const plan = []
    for (const item of state.items) {
      if (ids && !ids.includes(item.id) || item.imported && !item.production && !Object.keys(item.drafts ?? {}).length) continue
      const legacy = original.items.find(row => row.id === item.id) ?? item
      const language = item.content?.language ?? (['zh', 'en', 'und'].includes(legacy.language) ? legacy.language
        : legacy.sample && ['zh', 'en'].includes(original.sampleLang) ? original.sampleLang : 'und')
      const saved = associations.find(row => row.workId === item.id)
      const root = item.content ?? saved ?? { notesRoot: this.root, wikiRoot: this.wikiRoot }
      const variants = [[language, item.content ? item : legacy], ...Object.entries(item.content ? item.otherLang ?? {} : legacy.otherLang ?? {})]
      if (new Set(variants.map(([language]) => language)).size !== variants.length) throw failure('notes/legacy-languages', tr('旧语言版本的身份重复，请先明确各版本语言'))
      if (variants.every(([, variant]) => variant.content)) continue
      for (const [language, variant] of variants) {
        if (!['zh', 'en', 'und'].includes(language)) throw failure('notes/language-invalid', tr('请选择作品语言，未知语言使用 und'), 400)
        const reference = variant.content ?? { wikiRoot: root.wikiRoot, notesRoot: root.notesRoot, relativePath: `works/${encodeURIComponent(item.id)}-${language}.md`, language }
        if (!this.roots.has(reference.notesRoot) || typeof reference.wikiRoot !== 'string') throw failure('notes/unowned-root', tr('作品所在的 Notes 目录尚未取得写入所有权'))
        plan.push({ workId: item.id, language, current: variant === variants[0][1], source: { createdAt: legacy.createdAt, ...structuredClone(variant), id: item.id, language },
          reference, registered: Boolean(variant.content), languageBasis: variant.content || variant.language === language ? { kind: 'explicit', language }
            : legacy.sample && original.sampleLang === language ? { kind: 'legacy-sample', language, source: 'sampleLang' }
              : language === 'und' ? { kind: 'unknown', language } : { kind: 'explicit', language, source: 'otherLang' } })
      }
    }
    return plan
  }

  /** Verify all intended primary paths before migration creates any work or history file. */
  async preflightMigration(plan) {
    for (const entry of plan) {
      if (entry.registered) { await this.readWork(entry.reference, entry.workId); continue }
      try {
        await lstat(join(entry.reference.notesRoot, entry.reference.relativePath))
        throw failure('notes/migration-path-conflict', tr('迁移目标已有未登记文件：{path}。请先登记该文件或保留后改名', { path: entry.reference.relativePath }))
      } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (typeof entry.source.createdAt !== 'string' || !Number.isFinite(Date.parse(entry.source.createdAt))) {
        throw failure('notes/migration-date-invalid', tr('旧作品缺少有效创建日期，请修复原数据后迁移'))
      }
    }
  }

  /** Prepare all language primaries and fixed originals without replacing accepted files. */
  async prepareMigration(draft, plan) {
    const files = []
    draft.notesRevisions ??= {}
    const variants = new Map()
    for (const entry of plan) {
      const source = entry.source
      source.languageBasis ??= entry.languageBasis
      if (entry.registered) {
        const { metadata, body } = await this.readWork(source.content, source.id)
        this.project(source, metadata, body)
        await this.projectHistory(source)
      } else {
        source.content = { ...entry.reference, revision: (draft.notesRevisions[source.id] ?? 0) + 1, status: 'ready' }
        draft.notesRevisions[source.id] = source.content.revision
        const idea = source.body ?? ''
        const explicit = Object.entries(source.drafts ?? {}).find(([, draft]) => draft.current && typeof draft.text === 'string')
        const latest = Object.entries(source.drafts ?? {}).filter(([, draft]) => typeof draft.text === 'string' && Number.isFinite(Date.parse(draft.at)))
          .sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at))[0]
        const production = typeof source.production?.article === 'string' && (source.production.current || source.production.status === 'done')
        const selected = production ? null : explicit ?? latest
        for (const [format, draft] of Object.entries(source.drafts ?? {})) { await this.captureDraft(source, format, draft); draft.current = selected?.[0] === format }
        if (source.production) {
          source.production.current = production
          if (typeof source.production.article === 'string') source.production.textVersion = await this.writeFixed(source, 'production', source.production.article)
          if (typeof source.production.aiArticle === 'string') source.production.aiVersion = await this.writeFixed(source, 'ai-original', source.production.aiArticle, { at: source.production.startedAt, engine: source.production.engine })
        }
        source.body = production ? source.production.article : selected ? selected[1].text : idea
        if (source.body !== idea) await this.keepSource(source, idea)
        if (source.noteMetadata?.updatedAt) source.noteMetadata.originalUpdatedAt = source.noteMetadata.updatedAt
        const bytes = this.document(source)
        source.content.sha256 = fingerprint(bytes)
        files.push({ workId: source.id, before: null, after: source.content, bytes })
      }
      if (!variants.has(source.id)) variants.set(source.id, {})
      variants.get(source.id)[entry.language] = source
    }
    for (const [id, versions] of variants) {
      const item = draft.items.find(item => item.id === id)
      const current = plan.find(entry => entry.workId === id && entry.current).language
      for (const field of LANGUAGE_FIELDS) {
        if (versions[current][field] === undefined) delete item[field]
        else item[field] = versions[current][field]
      }
      item.otherLang = {}
      for (const [language, variant] of Object.entries(versions)) if (language !== current) item.otherLang[language] = Object.fromEntries(LANGUAGE_FIELDS.filter(field => variant[field] !== undefined).map(field => [field, variant[field]]))
      if (!Object.keys(item.otherLang).length) delete item.otherLang
    }
    return files
  }

  /** Select an existing language file while retaining the outgoing language's references. */
  async switchLanguage(item, language) {
    if (!['zh', 'en', 'und'].includes(language)) throw failure('notes/language-invalid', tr('请选择作品语言，未知语言使用 und'), 400)
    if (item.content.language === language) return
    const target = item.otherLang?.[language]
    if (!target?.content) throw failure('notes/language-unavailable', tr('此作品尚未保存 {language} 版本', { language }))
    if (item.content.status !== 'ready') throw failure(item.content.code, item.content.error)
    if ((await this.readWork(item.content, item.id)).sha256 !== item.content.sha256) throw failure('notes/conflict', tr('作品内容已变化，请重新读取后再修改'))
    const outgoing = Object.fromEntries(LANGUAGE_FIELDS.filter(field => item[field] !== undefined).map(field => [field, item[field]]))
    const stash = { ...item.otherLang, [item.content.language]: outgoing }
    delete stash[language]
    const { metadata, body, sha256, bytes } = await this.readWork(target.content, item.id)
    for (const field of LANGUAGE_FIELDS) {
      if (target[field] === undefined) delete item[field]
      else item[field] = structuredClone(target[field])
    }
    item.otherLang = stash
    item.content.sha256 = sha256
    item.content.snapshot = await this.saveSnapshot(item.content, item.id, bytes)
    this.project(item, metadata, body)
    await this.projectHistory(item)
  }

  /** Read an active or retained language without changing the work's selected language. */
  async readLanguage(item, language, notesRevisions) {
    const variant = item?.content?.language === language ? item : item?.otherLang?.[language]
    if (!variant?.content) throw failure('notes/language-unavailable', tr('此作品尚未保存 {language} 版本', { language }))
    const source = { id: item.id, createdAt: item.createdAt, ...structuredClone(variant) }
    return (await this.hydrate({ items: [source], notesRevisions: { ...notesRevisions } })).items[0]
  }

  /** Prepare a reviewed language edit; inactive-language changes preserve the active selection. */
  async prepareLanguage(before, draft, id, language, external) {
    const item = draft.items.find(item => item.id === id)
    const original = before.items.find(item => item.id === id)
    const reference = original.content.language === language ? original.content : original.otherLang[language].content
    const previous = await this.readLanguage(original, language, before.notesRevisions)
    if (previous.content.sha256 !== reference.sha256) throw failure('notes/conflict', tr('作品内容已变化，请重新读取后再修改'))
    const target = item.content.language === language ? item : { ...previous, ...structuredClone(item.otherLang[language]) }
    if (target !== item) await this.projectHistory(target)
    if (external) this.project(target, external.metadata, external.body)
    else target.noteMetadata.updatedAt = new Date().toISOString()
    if (target === item) return this.prepare(before, draft)
    const proposed = { ...draft, items: [target] }
    const files = await this.prepare({ ...before, items: [previous] }, proposed)
    draft.notesRevisions = proposed.notesRevisions
    item.otherLang[language] = Object.fromEntries(LANGUAGE_FIELDS.filter(field => target[field] !== undefined).map(field => [field, target[field]]))
    return files
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

  async prepare(before, draft) {
    const files = []
    draft.notesRevisions ??= {}
    const nextRevision = id => (draft.notesRevisions[id] ?? 0) + 1
    const previous = new Map(before.items.map(item => [item.id, item]))
    for (const item of before.items) if (item.content && !draft.items.some(row => row.id === item.id)) {
      draft.notesRevisions[item.id] = Math.max(draft.notesRevisions[item.id] ?? 0, item.content.revision) + 1
    }
    for (const item of draft.items) {
      const old = previous.get(item.id)
      if (old?.content) {
        item.content ??= { ...old.content }
        if (old.content.relativePath !== item.content.relativePath) {
          item.content.revision = Math.max(nextRevision(item.id), item.content.revision)
          draft.notesRevisions[item.id] = item.content.revision
          continue
        }
        const selected = this.selectText(item, old)
        const changed = item.body !== old.body || METADATA.some(key => JSON.stringify(item[key]) !== JSON.stringify(old[key]))
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
        item.content = { ...old.content, revision: Math.max(nextRevision(item.id), old.content.revision + 1), sha256: fingerprint(bytes), status: 'ready' }
        draft.notesRevisions[item.id] = item.content.revision
        files.push({ workId: item.id, before: old.content, after: item.content, beforeBytes: current.bytes, bytes })
        continue
      }
      if (item.content) {
        const { metadata, body, sha256 } = await this.readWork(item.content, item.id)
        item.content.revision = Math.max(nextRevision(item.id), item.content.revision + 1)
        draft.notesRevisions[item.id] = item.content.revision
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
      item.content = { wikiRoot: this.wikiRoot, notesRoot: this.root, relativePath, language, revision: nextRevision(item.id), sha256: fingerprint(bytes), status: 'ready' }
      draft.notesRevisions[item.id] = item.content.revision
      if (source !== item.body) await this.keepSource(item, source)
      await this.saveHistory(item, null, false)
      files.push({ workId: item.id, before: null, after: item.content, bytes })
    }
    files.push(...await this.prepareManaged(before, draft))
    return files
  }

  durable(draft) {
    const durable = structuredClone(draft)
    const strip = item => {
      if (!item.content) return
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
      for (const variant of Object.values(item.otherLang ?? {})) strip(variant)
    }
    for (const item of durable.items) strip(item)
    for (const style of durable.styles ?? []) if (style.content && !style.preset && !style.sample) {
      for (const field of STYLE_TEXT) delete style[field]
      delete style.sampleMaterial
    }
    for (const skill of durable.skills ?? []) if (skill.content && !skill.sample) {
      for (const field of RULE_TEXT) delete skill[field]
    }
    if (durable.voice?.content) delete durable.voice.text
    for (const item of durable.items) if (item.materialContent) {
      for (const field of MATERIAL_TEXT) delete item[field]
    }
    return durable
  }
}
