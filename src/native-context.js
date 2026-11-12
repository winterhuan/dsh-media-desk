/** Creative preset context consumes the single Host service and actual Agent association. */
import { defineTool } from '@deepseek-ai/dsh-tools'

export const inject = ['mediaDesk', 'systemPrompt', 'tools']

/**
 * Add bounded ownership and Wiki instructions to the creative Agent's runtime context.
 * @param {object} ctx - Creative preset scope, with the already initialized Host service.
 * @returns {void}
 */
export function apply(ctx) {
  const work = ctx.mediaDesk.nativeWork
  work.attach(ctx)
  const parse = (text, limit) => {
    if (text.length > limit) throw new Error('JSON input exceeds its size limit')
    return JSON.parse(text)
  }
  const register = (name, description, parameters, execute) => ctx.tools.register(defineTool({
    name, description, parameters,
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    execute: async (args, exec) => JSON.parse(JSON.stringify(await execute(args, exec))),
    presentCall: () => ({ card: 'generic', title: name.replaceAll('_', ' '), kind: 'other' }),
  }))
  register('media_desk_read', 'Read the current registered work, writing preferences, materials or metrics and the owned structured stage. Long work text returns a continuation offset; large collections return paged JSON text with a continuation offset.', {
    kind: { type: 'string', enum: ['work', 'preferences', 'materials', 'metrics'] },
    id: { type: 'string', description: 'Work identity. A work Session can read its own work only; the global assistant can select a listed work.' },
    offset: { type: 'integer', description: 'Text offset, defaults to 0.' },
    limit: { type: 'integer', description: 'Text characters to return, 1–20000, defaults to 12000.' },
  }, (args, exec) => work.read(exec, args))
  register('media_desk_edit', 'Apply ordinary edits to registered objects and return durable save receipts. Use media_desk_submit_result for an active structured stage. Writing rules are proposals for user review.', {
    operations: { type: 'string', required: true, description: 'JSON array of 1–24 operations: update_item, save_draft, update_production, schedule_item, set_status, delete_item; global assistant also supports add_item, add/update/delete_skill, add/update/delete_style, set_style, add_metric, add/update/delete_person, add/update/delete_angle. Fields match the object returned by media_desk_read. Maximum 200000 characters.' },
    expectedContent: { type: 'string', description: 'JSON object mapping work identities to their current content versions from media_desk_read. Required for edits to a registered work.' },
    expectedPreferences: { type: 'string', description: 'JSON object mapping style:<id> or rule:<id> to its content version from media_desk_read preferences. Required for updating or deleting registered preferences.' },
    resultId: { type: 'string', description: 'Optional stable operation identity, at most 100 characters. Reuse it with identical arguments to recover the existing receipt.' },
  }, (args, exec) => work.edit(exec, { ...args, operations: parse(args.operations, 200000), expectedContent: args.expectedContent ? parse(args.expectedContent, 20000) : {}, expectedPreferences: args.expectedPreferences ? parse(args.expectedPreferences, 20000) : {} }))
  register('media_desk_produce', 'Start a production attempt, redraw one image or cancel owned production. The Host retains accepted work and returns immediately after admission.', {
    action: { type: 'string', required: true, enum: ['start', 'redraw', 'cancel'] },
    id: { type: 'string', required: true, description: 'Work identity owned by this Session, or selected by the global assistant.' },
    target: { type: 'string', description: 'Required for redraw: cover, image:0 through image:7, or shot:0 through shot:23.' },
  }, async (args, exec) => {
    const { association, state } = await work.actor(exec, true)
    if (association.workId !== null && association.workId !== args.id) throw new Error('This Session owns another work')
    if (!state.items.some(row => row.id === args.id)) throw new Error('Work not found')
    if (args.action === 'start') return { started: await ctx.mediaDesk.producer.start(args.id) }
    if (args.action === 'redraw') { await ctx.mediaDesk.producer.regenerate(args.id, args.target); return { admitted: true } }
    // A tool cannot await quiescence of the Agent currently executing it.
    await ctx.mediaDesk.producer.invalidate(args.id)
    await work.cancel(args.id, { wait: false })
    return { cancelled: true }
  })
  register('media_desk_submit_result', 'Submit a structured stage candidate. Matching duplicates return the existing candidate or receipt; acceptance requires the corresponding native turn to finish successfully and the Notes save to succeed.', {
    stageId: { type: 'string', required: true, description: 'Current owned stage identity from media_desk_read.' },
    result: { type: 'string', required: true, description: 'JSON object, at most 200000 characters. plan: title, coverText, facts[], outline[], cover, characters, images[{caption,anchor,prompt}], shots[{shot,visual,voice,seconds,prompt}], sources[]; article: article and sources[]; style: name, summary, tone, sentences, opening, structure, words[], avoid[], samples[]; rules: rules[{name,rule,evidence}]. Each source has title, reference, date and limitations.' },
  }, (args, exec) => work.submit(exec, { stageId: args.stageId, result: parse(args.result, 200000) }))
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
          + '\nStart with media_desk_read. Use its stage instructions for production, style analysis and rule learning. '
          + 'Do not interpret streaming prose or a candidate acknowledgement as an accepted work. Report unresolved source evidence and tool failures plainly.'
      } catch (error) {
        return 'Media Desk association unavailable: ' + error.message + ' Business writes are unavailable.'
      }
    },
  })
}
