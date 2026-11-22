/** Read current Notes bytes and registration without Store hydration or filesystem writes. */
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, relative, resolve } from 'node:path'
import { Notes } from './notes.js'
import { discoverRuleFiles, validateRuleProposal } from './rule-files.js'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')

/** Read-only access to the plugin's registration and the Agent's editable files. */
export class DeskReader {
  /** @param {object} options - Existing dataRoot and wikiRoot; neither directory is created. */
  constructor({ dataRoot, wikiRoot }) {
    this.dataRoot = resolve(dataRoot)
    this.wikiRoot = resolve(wikiRoot)
  }

  async load() {
    try { this.state = JSON.parse(await readFile(join(this.dataRoot, 'state.json'), 'utf8')) }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      this.state = { items: [], styles: [], skills: [], metrics: [], accounts: [], people: [], angles: [] }
    }
    this.files = []
    const add = (reference, id, kind, workId) => { if (reference) this.files.push({ reference, id, kind, workId }) }
    for (const row of this.state.items ?? []) {
      for (const work of [row, ...Object.values(row.otherLang ?? {})]) add(work.content, row.id, 'work')
      add(row.materialContent, row.id, 'material')
      add(row.sourceContent, row.sourceContent?.id, 'source', row.id)
    }
    for (const row of this.state.styles ?? []) {
      add(row.content, row.id, 'style')
      add(row.sampleContent, row.id + '-samples', 'material')
    }
    for (const row of this.state.skills ?? []) add(row.content, row.id, 'rule')
    add(this.state.voice?.content, 'personal-voice', 'voice')
    const root = join(this.wikiRoot, 'notes')
    this.notes = new Notes({ dataRoot: this.dataRoot, wikiRoot: this.wikiRoot, notesRoot: root,
      notesRoots: new Set([root, ...this.files.map(file => file.reference.notesRoot)]) })
    return this
  }

  async file(path, expectedSha256) {
    const absolute = resolve(path)
    const registered = this.files.find(file => join(file.reference.notesRoot, file.reference.relativePath) === absolute)
    let reference = registered?.reference
    if (!reference) {
      const root = [...this.notes.roots].find(root => {
        const rel = relative(root, absolute)
        return rel && !rel.startsWith('..') && !rel.startsWith('/')
      })
      if (!root) throw new Error('File must be inside a configured or registered Notes directory')
      reference = { notesRoot: root, relativePath: relative(root, absolute).split('\\').join('/') }
    }
    let bytes
    try {
      bytes = await this.notes.readBytes(reference)
      const { metadata } = this.notes.decode(bytes)
      const kind = registered?.kind ?? metadata.kind
      const id = registered?.id ?? metadata.id
      if (typeof id !== 'string' || !id) throw new Error('File metadata requires a nonempty id')
      if (kind === 'source') {
        if (metadata.format !== 1 || metadata.kind !== 'material' || metadata.id !== id || metadata.workId !== registered.workId
          || reference.relativePath !== this.notes.managedPath('material', id)) throw new Error('Retained source metadata does not match registration')
      } else if (kind === 'work') {
        if (!/^works\/[^/]+\.md$/.test(reference.relativePath)) throw new Error('Work file must be in notes/works')
        if (!registered) {
          reference.language = metadata.language
          if (typeof metadata.language !== 'string' || !metadata.language) throw new Error('Work metadata requires a language')
        }
      } else if (reference.relativePath !== this.notes.managedPath(kind, id)) throw new Error('File path does not match its kind and id')
      const parsed = kind === 'source' ? this.notes.decode(bytes)
        : kind === 'work' ? this.notes.parse(bytes, reference, id) : this.notes.parseManaged(bytes, reference, id, kind)
      if (kind === 'rule' && !registered) validateRuleProposal(parsed.value)
      const sha256 = hash(bytes)
      const matches = (expectedSha256 === undefined || sha256 === expectedSha256)
        && (kind !== 'source' || sha256 === reference.sha256)
      return { file: absolute, registered: Boolean(registered), kind, id, sha256,
        ...(registered ? { registeredVersion: { revision: reference.revision, sha256: reference.sha256 }, changed: sha256 !== reference.sha256 } : {}),
        valid: matches, errors: matches ? [] : [{ code: 'notes/version-changed', message: 'File changed; read it again before editing' }],
        ...parsed, text: bytes.toString('utf8') }
    } catch (error) {
      return { file: absolute, registered: Boolean(registered), valid: false,
        ...(bytes ? { sha256: hash(bytes), text: bytes.toString('utf8') } : {}),
        errors: [{ code: error.code ?? 'notes/metadata-invalid', message: error.message }] }
    }
  }

  /** Read current bytes, immutable originals or bounded domain catalogs without accepting edits. */
  async read({ kind = 'works', id, file } = {}) {
    if (file) return this.file(file)
    if (kind === 'work') {
      const work = this.state.items?.find(row => row.id === id)
      if (!work) throw new Error('Work not found')
      if (!work.content) return { work, registered: false, originals: [] }
      const current = await this.file(join(work.content.notesRoot, work.content.relativePath))
      const originals = []
      for (const ref of [work.production?.aiVersion, ...Object.values(work.drafts ?? {}).map(row => row.aiVersion),
        ...(work.textHistory ?? []).filter(row => row.role === 'ai-original')].filter(Boolean)) {
        if (!originals.some(row => row.reference.sha256 === ref.sha256)) originals.push({ reference: ref, text: await this.notes.readFixed(ref, id) })
      }
      const source = work.sourceContent ? await this.file(join(work.sourceContent.notesRoot, work.sourceContent.relativePath)) : null
      return { work: { id: work.id, status: work.status, platform: work.platform, scheduledAt: work.scheduledAt }, current, originals, source }
    }
    if (kind === 'works') return { works: await Promise.all((this.state.items ?? []).map(async row => ({
      id: row.id, status: row.status, platform: row.platform, scheduledAt: row.scheduledAt,
      ...(row.content ? await this.file(join(row.content.notesRoot, row.content.relativePath)) : { title: row.title, registered: false }),
    }))) }
    if (kind === 'preferences') {
      const readRow = async (row, type) => row.content
        ? { id: row.id, status: row.status, ...await this.file(join(row.content.notesRoot, row.content.relativePath)) }
        : { ...row, registered: false, kind: type }
      const rules = await Promise.all((this.state.skills ?? []).filter(row => !row.sample).map(row => readRow(row, 'rule')))
      const discovered = await discoverRuleFiles(this.notes, rules.map(row => ({ ...row, ...row.value,
        content: this.state.skills.find(saved => saved.id === row.id)?.content })), this.state.deletedRuleIds)
      for (const row of discovered.rules) rules.push({ id: row.id, status: 'proposed',
        ...await this.file(join(row.content.notesRoot, row.content.relativePath)) })
      return { activeStyleId: this.state.activeStyleId ?? null,
        voice: this.state.voice ? await readRow(this.state.voice, 'voice') : null,
        styles: await Promise.all((this.state.styles ?? []).filter(row => !row.sample).map(row => readRow(row, 'style'))),
        rules, ruleFileIssues: discovered.issues }
    }
    if (kind === 'materials') return { materials: await Promise.all(this.files.filter(row => ['material', 'source'].includes(row.kind))
      .map(row => this.file(join(row.reference.notesRoot, row.reference.relativePath)))) }
    if (kind === 'metrics') return { metrics: this.state.metrics ?? [], accounts: this.state.accounts ?? [] }
    if (kind === 'people') return { people: this.state.people ?? [], angles: this.state.angles ?? [] }
    throw new Error('Unknown read kind')
  }
}
