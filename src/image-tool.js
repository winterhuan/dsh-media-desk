/** Media Desk supplies its home and diagnostics to the global skill's DSH adapter. */
import { generateToolImage as generate } from '../skills/image-generation/scripts/dsh-tool.mjs'
import { tr } from './i18n.js'
import { dshHome } from './store.js'

/** Discover the public image tool without making a generation request. */
export { imageTool } from '../skills/image-generation/scripts/dsh-tool.mjs'
/** Generate with the host's executor policy and register no business state. */
export function generateToolImage(ctx, image, prompt, options = {}) {
  return generate(ctx, image, prompt, { ...options, home: dshHome(), translate: tr })
}
