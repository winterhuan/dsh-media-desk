/** The official Web assembly invokes the Host's awaited public shutdown method. */
export const inject = ['webServer', 'mediaDesk']

/**
 * @param {object} ctx - Actual Host service and the fixture-owned Web route.
 * @returns {void}
 */
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/md-host-close',
    handler: async (_req, res) => {
      res.setHeader('content-type', 'application/json')
      try {
        await ctx.mediaDesk.close()
        res.end(JSON.stringify({ closed: true }))
      } catch (error) {
        res.statusCode = 500
        res.end(JSON.stringify({ error: error.message, causes: error.errors?.map(cause => cause.message) }))
      }
    },
  }))
}
