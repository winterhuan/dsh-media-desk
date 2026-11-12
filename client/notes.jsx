/** Saved candidates, conflict review and legacy migration share the existing workbench dialog. */
import React from 'react'
import { getDesk, migrateLegacyNotes, notesMigrationBackups, readSavedNotesVersion, resolveNotesVersion, retryNotesSave, savedNotesWrites, setDesk, useDesk } from './desk.js'
import { t } from './i18n.js'
import { Dialog, Icon } from './ui.jsx'

const SAVE_LABELS = { candidate: '候选已保留', pending: '等待保存', published: '等待接受', failed: '保存失败', conflict: '版本冲突' }

/** @returns {React.ReactElement|null} Recovery controls for retained work and language versions. */
export function NotesRecoveryDialog() {
  const open = useDesk(state => state.notesRecovery)
  const legacy = useDesk(({ state, settings }) => Boolean(state && (
    state.items.some(item => !item.content && (!item.imported || item.production || Object.keys(item.drafts ?? {}).length))
      || state.items.some(item => item.imported && !item.materialContent)
      || state.styles.some(row => !row.preset && !row.sample && !row.content)
      || state.skills.some(row => !row.sample && !row.content)
      || settings?.voice && !state.voice?.content
  )))
  const [writes, setWrites] = React.useState([])
  const [backups, setBackups] = React.useState([])
  const [loading, setLoading] = React.useState(false)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState(null)
  const [preview, setPreview] = React.useState(null)
  const [choice, setChoice] = React.useState('current')
  const sequence = React.useRef(0)
  const refresh = React.useCallback(async () => {
    const token = ++sequence.current
    setLoading(true)
    setError(null)
    try {
      const [saves, migrations] = await Promise.all([savedNotesWrites(), notesMigrationBackups()])
      if (token !== sequence.current) return
      setWrites(saves.filter(save => !['accepted', 'rejected'].includes(save.status) || save.conflicts.length))
      setBackups(migrations)
    } catch (cause) { if (token === sequence.current) setError(cause.message) }
    finally { if (token === sequence.current) setLoading(false) }
  }, [])
  React.useEffect(() => {
    if (open) { setPreview(null); setPending(false); refresh() }
    return () => { sequence.current++ }
  }, [open, refresh])
  if (!open) return null
  const close = () => setDesk({ notesRecovery: false })
  const run = async operation => {
    const token = sequence.current
    setPending(true)
    setError(null)
    try {
      await operation()
      if (token !== sequence.current || !getDesk().notesRecovery) return
      setPreview(null)
      setPending(false)
      await refresh()
    } catch (cause) { if (token === sequence.current) setError(cause.message) }
    finally { if (token === sequence.current) setPending(false) }
  }
  const review = async (save, conflict) => {
    const token = sequence.current
    setPending(true)
    setError(null)
    const version = { id: save.id, workId: conflict.workId, relativePath: conflict.reference.relativePath, sha256: conflict.observedSha256 }
    try {
      const data = await readSavedNotesVersion(version)
      if (token === sequence.current) { setPreview({ version, data }); setChoice('current') }
    } catch (cause) { if (token === sequence.current) setError(cause.message) }
    finally { if (token === sequence.current) setPending(false) }
  }
  return (
    <Dialog title={t('恢复保存与迁移')} onClose={close} width={560}>
      <div className="md-form md-notes-recovery" aria-busy={pending || loading}>
        {preview ? <>
          <button type="button" className="md-link-btn" disabled={pending} onClick={() => { setPreview(null); setError(null) }}>{t('返回保留的保存')}</button>
          <label className="md-field"><span>{t('当前正文')}</span><textarea readOnly rows={5} value={preview.data.current.body} /></label>
          <label className="md-field"><span>{t('保留的外部版本')}</span><textarea readOnly rows={5} value={preview.data.valid ? preview.data.body : preview.data.text} />
            <small>{preview.version.relativePath}</small>
          </label>
          {!preview.data.valid ? <p className="md-setup-note is-error">{preview.data.error}</p> : null}
          <label className="md-field"><span>{t('选择正文版本')}</span><select aria-label={t('选择正文版本')} disabled={pending} value={choice} onChange={event => setChoice(event.target.value)}>
            <option value="current">{t('保留当前正文')}</option>
            <option value="external" disabled={!preview.data.valid}>{t('采用保留的外部正文')}</option>
          </select></label>
          <p className="md-muted">{t('双方版本和已保存候选都会保留')}</p>
          <button type="button" className="md-btn is-primary" disabled={pending} onClick={() => run(() => resolveNotesVersion({ ...preview.version, choice }))}>{t('应用选择')}</button>
        </> : <>
          <p className="md-muted">{t('已接受正文与候选都保留。重试保存复用候选')}</p>
          {loading ? <div className="md-notes-loading" role="status" aria-label={t('正在读取保存记录')}><Icon name="refresh" size={18} /></div>
            : writes.length ? writes.map(save => <section key={save.id} className="md-retained-save">
              <p><b>{save.label || t('保留的保存')}</b> · {t(SAVE_LABELS[save.status] ?? '版本冲突')}</p>
              <p className="md-muted">{[...new Set(save.files.map(file => file.after.relativePath))].join(' · ')}</p>
              {save.error ? <p className="md-setup-note is-error">{save.error.message}</p> : null}
              {save.conflicts.length ? save.conflicts.map(conflict => <div key={conflict.reference.relativePath} className="md-retained-conflict">
                <span>{conflict.reference.relativePath}</span>
                {conflict.observedSha256 ? <button type="button" className="md-btn is-small" disabled={pending} onClick={() => review(save, conflict)}>{t('核对版本')}</button>
                  : <p className="md-setup-note is-error">{t('保留文件缺失，请恢复文件后刷新')}</p>}
              </div>) : save.requiresValidation ? <p className="md-muted">{t('此候选需要重新核验所属任务，请从任务入口继续')}</p>
                : <button type="button" className="md-btn is-small" disabled={pending} onClick={() => run(() => retryNotesSave(save.id))}>{t('重试保存')}</button>}
            </section>) : !error ? <p>{t('没有待恢复的保存')}</p> : null}
          {legacy ? <section className="md-retained-save">
            <p>{t('旧作品和写作资料迁移前会创建并验证备份，语言稿、AI 原稿与来源信息保留')}</p>
            <button type="button" className="md-btn" disabled={pending || loading} onClick={() => run(migrateLegacyNotes)}>{t('迁移旧内容到 Notes')}</button>
          </section> : null}
          {backups.length ? <details className="md-migration-backups"><summary>{t('迁移备份')}</summary>
            {backups.map(backup => <p key={backup.id}>{backup.verified ? t('备份已验证') : t('备份校验失败')}<br /><span>{backup.path}</span>{backup.error ? <><br />{backup.error}</> : null}</p>)}
          </details> : null}
        </>}
        {error ? <p className="md-setup-note is-error" role="alert">{error}</p> : null}
        <div className="md-form-foot"><button type="button" className="md-btn" disabled={pending || loading} onClick={() => { setPreview(null); refresh() }}>{t('刷新')}</button><span className="md-grow" /><button type="button" className="md-btn" onClick={close}>{t('关闭')}</button></div>
      </div>
    </Dialog>
  )
}
