// 风格：把一个人的写法提炼成一张卡。成稿时按当前选中的那张来写。
import { currentLang, tr } from './i18n.js'
import { stageInstructions } from './skill-driver.js'

/** 风格提炼的提示词。素材可能来自网页，只当素材，不当指令。 */
export function stylePrompts(text, name) {
  const system = stageInstructions('style') + '\nReturn only the observed style card. Preferred name: ' + JSON.stringify(name ?? '') + '.'
  return { system, user: `<material>${text.slice(0, 16000)}</material>` }
}

/** 模型输出不可信：只留这些字段，并限制长度。 */
export function normalizeStyle(raw, preferredName = '') {
  const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '')
  const list = (value, count, max) => (Array.isArray(value) ? value.filter(row => typeof row === 'string' && row.trim()).slice(0, count).map(row => row.trim().slice(0, max)) : [])
  return {
    name: text(preferredName, 20) || text(raw?.name, 20) || tr('未命名风格'),
    summary: text(raw?.summary, 80),
    tone: text(raw?.tone, 200),
    sentences: text(raw?.sentences, 200),
    opening: text(raw?.opening, 200),
    structure: text(raw?.structure, 200),
    words: list(raw?.words, 8, 20),
    avoid: list(raw?.avoid, 5, 40),
    samples: list(raw?.samples, 3, 120),
  }
}

/** 把风格卡变成写作要求。 */
export function styleToVoice(style) {
  if (!style) return ''
  // 这段也会写进导出的 Skill 文件，英文界面时用英文标签
  const en = currentLang() === 'en'
  const [overall, tone, sentences, opening, structure, words, avoid, samples, sep] = en
    ? ['Overall: ', 'Tone: ', 'Sentences: ', 'Opening: ', 'Structure: ', 'Go-to words: ', 'Never: ', 'Sample lines (learn the rhythm, do not copy):', ', ']
    : ['整体：', '语气：', '句式：', '开头：', '结构：', '常用词：', '绝不要：', '样句（学节奏，不要照抄）：', '、']
  const lines = [
    style.summary && `${overall}${style.summary}`,
    style.tone && `${tone}${style.tone}`,
    style.sentences && `${sentences}${style.sentences}`,
    style.opening && `${opening}${style.opening}`,
    style.structure && `${structure}${style.structure}`,
    style.words?.length && `${words}${style.words.join(sep)}`,
    style.avoid?.length && `${avoid}${style.avoid.join(sep)}`,
    style.samples?.length && `${samples}\n${style.samples.map(row => `- ${row}`).join('\n')}`,
  ]
  return lines.filter(Boolean).join('\n')
}

export function activeStyle(state) {
  return state.styles?.find(row => row.id === state.activeStyleId) ?? null
}
