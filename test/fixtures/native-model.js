/** Deterministic model adapter; Loader, Sessions, skills and native tools execute normally. */
import { appendFile } from 'node:fs/promises'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

/** External model provider used by the isolated runtime assembly. */
export const inject = ['llm']

/**
 * Register the external model route used by the assembled Web fixture.
 * @param {object} ctx - Live DSH Host context.
 * @param {object} config - Recipes and optional request telemetry path.
 * @returns {void}
 */
export function apply(ctx, config) {
  let nextCall = 0
  class NativeModel extends LlmAdapter {
    async listModels(provider) {
      return ['native-fixture', 'native-second'].map(id => ({ provider, id, name: id, contextWindow: 100000, maxTokens: 16000 }))
    }

    async *stream(options) {
      options.signal?.throwIfAborted()
      const textOf = message => message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      const inputIndex = options.messages.findLastIndex(message => message.role === 'user' && /MD_FIXTURE_\w+/.test(textOf(message)))
      const marker = inputIndex < 0 ? null : /MD_FIXTURE_\w+/.exec(textOf(options.messages[inputIndex]))?.[0]
      const recipe = config.recipes?.[marker] ?? { calls: [], reply: 'Native Session fixture completed.' }
      const calls = options.messages.slice(Math.max(0, inputIndex)).flatMap(message => message.content).filter(block => block.type === 'tool-call')
      const call = recipe.calls[calls.length]
      if (config.telemetryPath) {
        await appendFile(config.telemetryPath, JSON.stringify({
          marker, model: options.model, action: call?.name ?? 'finish',
          tools: (options.tools ?? []).map(tool => tool.name),
          context: options.messages,
        }) + '\n')
      }
      if (call) {
        const id = 'native-fixture-' + (++nextCall)
        const args = JSON.stringify(call.arguments)
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: call.name, argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: call.name, arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: recipe.reply }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: recipe.reply } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['media-desk-fixture'], new NativeModel()))
}
