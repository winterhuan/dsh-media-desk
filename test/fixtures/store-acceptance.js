/** Public Store caller observes real native claims and supplies a synchronous eligibility check. */
import { createHash } from 'node:crypto'

export const inject = ['mediaDesk', 'webServer', 'connection']

export function apply(ctx) {
  const claims = new Map()
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    const claim = { sessionId: agent.session.id, messageId: message.id, rpcId: message.source?.rpcId, turn }
    claims.set(agent.session.id, claim)
    console.log('MD_STORE_CLAIM ' + JSON.stringify(claim))
  })
    const desk = ctx.get('mediaDesk')
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path: '/md-notes-fixture-save',
      handler: async (req, res) => {
        const reply = (status, value) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)) }
        const rejection = ctx.get('connection').requestRejection({ headers: req.headers })
        if (rejection) return reply(rejection, { error: 'Unauthorized fixture request' })
        try {
          const chunks = []
          for await (const chunk of req) chunks.push(chunk)
          const request = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          const requireClaim = () => {
            const association = desk.nativeSessions.associations.find(row => row.workId === request.id && row.status === 'bound')
            const claim = claims.get(association?.sessionId)
            if (!claim || claim.rpcId !== request.sourceRequestId) throw Object.assign(new Error('The real native input claim changed before Store acceptance'), { code: 'fixture/stale-native-claim', status: 409 })
            return { association, claim }
          }
          const result = await desk.store.mutate('Save text with a structured plan', draft => {
            const { association, claim } = requireClaim()
            const item = draft.items.find(item => item.id === request.id)
            item.body = request.body
            item.production = { ...item.production, article: request.body, current: true, facts: request.facts, outline: request.outline }
            draft.planAssociations = [...(draft.planAssociations ?? []), { id: request.resultKey, workId: item.id, associationId: association.id,
              sessionId: association.sessionId, sourceMessageId: claim.messageId, sourceTurn: claim.turn, inputVersion: request.content }]
            return { planId: request.resultKey }
          }, { undoable: false, expectedContent: { [request.id]: request.content }, resultKey: request.resultKey,
            payloadHash: createHash('sha256').update(JSON.stringify(request)).digest('hex'), validateAcceptance: () => { requireClaim() } })
          reply(200, result)
        } catch (error) { reply(error.status ?? 500, { error: error.message, code: error.code, pendingId: error.pendingId }) }
      },
    }))
}
