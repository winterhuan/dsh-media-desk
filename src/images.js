/** Media-specific visual briefs use the global image skill's transport and byte validation. */
import { generateImage as generate, imageBuffer as validate } from '../skills/image-generation/scripts/http.mjs'
import { tr } from './i18n.js'

/** Generate through the global skill runtime while preserving Media Desk diagnostics. */
export function generateImage(image, prompt, options = {}) { return generate(image, prompt, { ...options, translate: tr }) }
/** Validate incoming image bytes before Media Desk registers them. */
export function imageBuffer(buffer) { return validate(buffer, tr) }
/** Resolve image response paths using the shared transport implementation. */
export { imageUrlCandidates, bailianEndpoint, wanSubmitEndpoint, wanTaskEndpoint } from '../skills/image-generation/scripts/http.mjs'

const COVER_STYLE = 'Editorial cover image, striking composition with calm negative space in the lower third, refined and cinematic, no text, no letters, no logo.'
const FIGURE_STYLE = 'Editorial article illustration, refined and consistent with a modern magazine, no text, no letters, no logo.'
const SHOT_STYLE = 'Film storyboard panel, black and white pencil line art sketch, loose confident lines, no color, plain white paper background, no text, no letters, no captions, no panel numbers.'

export function coverPrompt(prompt) {
  return `${COVER_STYLE} ${prompt}`
}

export function figurePrompt(prompt) {
  return `${FIGURE_STYLE} ${prompt}`
}

export function shotPrompt(prompt, characters) {
  return `${SHOT_STYLE} Widescreen 16:9 landscape framing, the scene fills the whole frame edge to edge, no borders. ${characters ? `Recurring characters and setting: ${characters}. ` : ''}${prompt}`
}
