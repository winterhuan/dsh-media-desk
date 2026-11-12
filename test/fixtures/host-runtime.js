import { Context } from '@deepseek-ai/cordis'
import MediaDeskHost from '../../src/host.js'

/**
 * Mount the actual Host service with controlled network and optional image providers.
 * @param {object} [services] - External provider implementations exposed to the Host.
 * @returns {Promise<object>} Mounted context, current authenticated route and awaited disposal.
 */
export async function hostRuntime(services = {}) {
  const ctx = new Context()
  let handler = null
  ctx.provide('webServer', { register: options => {
    handler = options.handler
    return () => { handler = null }
  } })
  ctx.provide('connection', { requestRejection: () => undefined })
  for (const [name, service] of Object.entries(services)) ctx.provide(name, service)
  try {
    await ctx.plugin(MediaDeskHost)
    return { ctx, get handler() { return handler }, close: () => ctx.fiber.dispose() }
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}
