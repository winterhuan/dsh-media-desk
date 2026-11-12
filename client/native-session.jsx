import React from 'react'
import { openNativeSession, report } from './desk.js'
import { t } from './i18n.js'
import { Icon } from './ui.jsx'

/**
 * Navigate to DSH's ordinary Session page after Host publishes its durable association.
 * @param {object} props - Work identity and the injected native navigation callback.
 * @param {string|null} [props.workId] - Null opens the separate global assistant.
 * @param {(sessionId: string) => void} props.openSession - Native page navigation.
 * @returns {React.ReactElement} Native Session entry with pending and failure feedback.
 */
export function NativeSessionButton({ workId = null, openSession }) {
  const [busy, setBusy] = React.useState(false)
  const open = async () => {
    setBusy(true)
    try {
      const association = await openNativeSession(workId)
      openSession(association.sessionId)
    } catch (error) {
      report(error)
    } finally {
      setBusy(false)
    }
  }
  return <button type="button" className="md-btn md-native-session" disabled={busy} aria-busy={busy} onClick={open}><Icon name="chat" size={15} /><span>{workId ? t('原生会话') : t('全局原生会话')}</span></button>
}
