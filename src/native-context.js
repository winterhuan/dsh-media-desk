/** Creative preset context consumes the single Host service and actual Agent association. */
export const inject = ['mediaDesk', 'systemPrompt']

/**
 * Add bounded ownership and Wiki instructions to the creative Agent's runtime context.
 * @param {object} ctx - Creative preset scope, with the already initialized Host service.
 * @returns {void}
 */
export function apply(ctx) {
  ctx.systemPrompt.context({
    name: 'media-desk:association', order: 60, required: true, interpolate: false,
    text: ({ agent }) => {
      if (!agent) return ''
      try {
        const association = ctx.mediaDesk.nativeSessions.requireAssociation(agent)
        const wikiCommand = process.platform === 'win32'
          ? '$env:WIKI_PATH = $env:DSH_MEDIA_DESK_WIKI_PATH' : 'WIKI_PATH="$DSH_MEDIA_DESK_WIKI_PATH"'
        return 'Media Desk association: ' + JSON.stringify({
          id: association.id, workId: association.workId, wikiRoot: association.wikiRoot, notesRoot: association.notesRoot,
        }) + '\nUse the effective llm-wiki skill to search relevant summaries, read selected full pages and check sources. '
          + 'Use absolute paths under the bound Wiki. For skill Shell commands set ' + wikiCommand + ' explicitly. '
          + 'Keep source dates and uncertainty. Knowledge summaries supply facts; only selected author samples supply personal writing style. '
          + 'Read-only requests forbid material and knowledge writes. Registered creative materials use Media Desk business operations.'
      } catch (error) {
        return 'Media Desk association unavailable: ' + error.message + ' Business writes are unavailable.'
      }
    },
  })
}
