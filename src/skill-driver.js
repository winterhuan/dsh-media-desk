/** Creative workflow instructions are owned by the bundled, independently invocable skill. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Filesystem provider root containing the canonical skill. */
export const skillRoot = fileURLToPath(new URL('../skills/', import.meta.url))
/** Entry shared by the plugin and independent assistants. */
export const skillEntry = fileURLToPath(new URL('../skills/media-desk/SKILL.md', import.meta.url))
const references = { plan: ['production', '研究与策划'], article: ['production', '成稿与自检'],
  style: ['learning', '从作者样文提炼风格'], rules: ['learning', '从修改中学习'] }

/** @returns {string} The same entry instructions used by an independent assistant. */
export function skillInstructions() {
  return readFileSync(skillEntry, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '')
}

/** @param {string} kind - Structured creation stage. @returns {string} Shared task instructions and their source path. */
export function stageInstructions(kind) {
  if (!references[kind]) throw new Error('Unknown Media Desk skill stage: ' + kind)
  const [reference, heading] = references[kind]
  const path = fileURLToPath(new URL('../skills/media-desk/references/' + reference + '.md', import.meta.url))
  const section = readFileSync(path, 'utf8').split('\n## ').find(text => text.startsWith(heading + '\n'))
  if (!section) throw new Error('Media Desk skill section missing: ' + heading)
  return `Use the media-desk skill for the ${kind} stage. Skill directory: ${fileURLToPath(new URL('../skills/media-desk/', import.meta.url))}\n`
    + '## ' + section
}
