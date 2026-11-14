/** The official conversation factory renders tool cards, approval, questions and native input. */
import React from 'react'
import { openItem, openNativeSession, newNativeConversation, report, setDesk, useDesk } from './desk.js'
import { t } from './i18n.js'
import { Icon, IconButton } from './ui.jsx'

/** Link durable accepted work from this association; candidates and other Sessions stay outside the list. */
function AcceptedReceipts({ associationId }) {
  const state = useDesk(snapshot => snapshot.state)
  const stages = new Set(state.nativeRequests?.filter(row => row.associationId === associationId).map(row => 'stage:' + row.id))
  const receipts = (state.receipts ?? []).filter(receipt => receipt.resultKey.startsWith(`native:${associationId}:`) || stages.has(receipt.resultKey))
    .flatMap(receipt => {
      const targets = new Set([receipt.outcome?.workId, ...receipt.outcome?.receipts?.filter(row => row.kind === 'item').map(row => row.target) ?? []].filter(Boolean))
      return [...targets].flatMap(id => {
        const work = state.items.find(row => row.id === id)
        return work ? [{ receipt, work }] : []
      })
    }).slice(-4).reverse()
  if (!receipts.length) return null
  return <section className="md-chat-receipts" aria-label={t('已接受的修改')}>
    {receipts.map(({ receipt, work }) => <button type="button" className="md-receipt" key={`${receipt.id}:${work.id}`} data-receipt-id={receipt.id} data-work-id={work.id} onClick={() => openItem(work.id)}>
      <span className="md-receipt-check"><Icon name="check" size={11} /></span>
      <span>{t('查看已接受作品：{title}', { title: work.title })}</span>
    </button>)}
  </section>
}

/** Bind one ordinary Session reference for the visible work/global panel. */
export function ChatPanel({ itemId = null, head, top, retainSession, SessionProvider, renderSlot, initializeDraft }) {
  const [binding, setBinding] = React.useState(null)
  const [error, setError] = React.useState(null)
  const referenceRef = React.useRef(null)
  const generation = React.useRef(0)
  const quote = useDesk(state => state.chatQuote)
  const [restarting, setRestarting] = React.useState(false)
  React.useEffect(() => {
    let alive = true
    const token = ++generation.current
    openNativeSession(itemId).then(association => {
      if (!alive || generation.current !== token) return
      const reference = retainSession(association.sessionId)
      referenceRef.current = reference
      setBinding({ itemId, association, reference })
      setError(null)
    }).catch(error => { if (alive) setError(error.message) })
    return () => { alive = false; generation.current++;  referenceRef.current?.release(); referenceRef.current = null }
  }, [itemId, retainSession])
  React.useEffect(() => {
    if (!quote || !binding || binding.itemId !== itemId || itemId === null) return
    const selection = quote.version ? `\n[Media Desk selection: ${JSON.stringify({ [itemId]: { revision: quote.version.revision, sha256: quote.version.sha256 } })}]` : ''
    const text = (quote.text ? `${quote.label}:\n${quote.text}` : quote.label) + selection
    if (initializeDraft(binding.reference, text) === 'applied') setDesk({ chatQuote: null })
  }, [binding, quote, itemId, initializeDraft])
  const restart = async () => {
    const token = ++generation.current
    setRestarting(true)
    try {
      const association = await newNativeConversation(itemId)
      if (generation.current !== token) return
      const reference = retainSession(association.sessionId)
      referenceRef.current?.release()
      referenceRef.current = reference
      setBinding({ itemId, association, reference })
    } catch (error) { if (generation.current === token) report(error) }
    finally { if (generation.current === token) setRestarting(false) }
  }
  return <div className="md-chat">
    <header className="md-dock-head">{head}<IconButton icon="refresh" label={t('开始新对话')} disabled={restarting} onClick={restart} /></header>
    {top}
    {error ? <p className="md-msg-error" role="status">{error}</p> : binding?.itemId === itemId ? <SessionProvider session={binding.reference}>{renderSlot('media-desk.conversation', {})}</SessionProvider> : <div className="md-loading" aria-busy="true" />}
    {binding?.itemId === itemId ? <AcceptedReceipts associationId={binding.association.id} /> : null}
  </div>
}

/** Render the native factory inside Media Desk's own strict Session slot. */
export function NativeConversation({ useSession, useConversation, renderFactorySlot }) {
  const session = useSession(value => value)
  const conversation = useConversation(value => value)
  const settling = session.openState === 'loading' && !conversation.activeTargets.size
  return renderFactorySlot('conversation.content', { variant: 'embedded', phase: settling ? 'settling' : 'active', hero: false })
}

/** The global assistant has a Session separate from every work. */
export function ChatDock(props) {
  return <aside className="md-dock" aria-label={t('对话助手')}>
    <ChatPanel {...props} head={<><h2>{t('助手')}</h2><span className="md-grow" /><IconButton icon="close" label={t('收起对话')} onClick={() => setDesk({ dockOpen: false })} /></>} />
  </aside>
}
