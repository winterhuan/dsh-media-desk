import { Context } from '@deepseek-ai/cordis'
import MediaDeskHost from '../../src/host.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Mount the actual Host service with controlled network and optional image providers.
 * @param {object} [services] - External provider implementations exposed to the Host.
 * @returns {Promise<object>} Mounted context, current authenticated route and awaited disposal.
 */
export async function hostRuntime(services = {}) {
  const ctx = new Context()
  const wiki = await mkdtemp(join(tmpdir(), 'media-desk-host-wiki-'))
  const close = async () => {
    await ctx.fiber.dispose()
    await rm(wiki, { recursive: true, force: true })
  }
  let handler = null
  ctx.provide('webServer', { register: options => {
    handler = options.handler
    return () => { handler = null }
  } })
  ctx.provide('connection', { requestRejection: () => undefined })
  for (const [name, service] of Object.entries(services)) ctx.provide(name, service)
  try {
    await ctx.plugin(MediaDeskHost, { wikiPath: wiki })
    return { ctx, wiki, get handler() { return handler }, close }
  } catch (error) {
    await close()
    throw error
  }
}
