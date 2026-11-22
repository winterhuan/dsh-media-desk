/** DSH default model display and cover text formatting; execution belongs to native Sessions. */
import { currentLang } from './i18n.js'

export function defaultSelection(ctx) {
  try {
    const selection = ctx.get('agentDefaultModel')?.currentSelection()
    return selection?.provider && selection?.model ? { provider: selection.provider, model: selection.model } : null
  } catch {
    return null
  }
}

export function modelInfo(ctx) {
  if (!ctx.get('llm')) return null
  const route = defaultSelection(ctx)
  if (!route) return null
  return { provider: route.provider, model: route.model, label: route.model }
}

export function shortCoverText(title, max = 12) {
  if (currentLang() !== 'en') return title.slice(0, max)
  const words = String(title).split(/\s+/).filter(Boolean)
  let text = ''
  for (const word of words) {
    const next = text ? `${text} ${word}` : word
    if (next.length > max * 2) break
    text = next
  }
  return text || String(title).slice(0, max * 2)
}
