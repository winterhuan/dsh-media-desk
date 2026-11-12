/** The official conversation factory renders tool cards, approval, questions and native input. */
import React from 'react'
import { openNativeSession, newNativeConversation, report, setDesk, useDesk } from './desk.js'
import { t } from './i18n.js'
import { IconButton } from './ui.jsx'

/** Bind one ordinary Session reference for the visible work/global panel. */
export function ChatPanel({ itemId = null, head, top, retainSession, renderConversation, initializeDraft }) {
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
    const selection = quote.version ? `\n[Media Desk selection: ${JSON.stringify({ [itemId]: quote.version })}]` : ''
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
    {error ? <p className="md-msg-error" role="status">{error}</p> : binding?.itemId === itemId ? renderConversation(binding.reference) : <div className="md-loading" aria-busy="true" />}
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
