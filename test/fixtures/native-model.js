/** Deterministic model adapter; Loader, Sessions, skills and native tools execute normally. */
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
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
  const replies = new Map()
  const waitForFile = async (path, signal) => {
    for (;;) {
      signal?.throwIfAborted()
      try { await readFile(path); return } catch (error) { if (error.code !== 'ENOENT') throw error }
      await setTimeout(25, undefined, { signal })
    }
  }
  class NativeModel extends LlmAdapter {
    async listModels(provider) {
      return ['native-fixture', 'native-second'].map(id => ({ provider, id, name: id, contextWindow: 100000, maxTokens: 16000 }))
    }

    async *stream(options) {
      options.signal?.throwIfAborted()
      const textOf = message => message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      const inputIndex = options.messages.findLastIndex(message => message.role === 'user' && /MD_FIXTURE_\w+|Media Desk stage/.test(textOf(message)))
      const inputText = inputIndex < 0 ? '' : textOf(options.messages[inputIndex])
      const marker = /MD_FIXTURE_\w+/.exec(inputText)?.[0] ?? (inputText.includes('Media Desk stage') ? 'MD_STAGE_' + /\((\w+)\)/.exec(inputText)?.[1] : null)
      const recipe = config.recipes?.[marker] ?? { calls: [], reply: 'Native Session fixture completed.' }
      const calls = options.messages.slice(Math.max(0, inputIndex)).flatMap(message => message.content).filter(block => block.type === 'tool-call')
      const call = recipe.calls[calls.length]
      if (config.telemetryPath) {
        await appendFile(config.telemetryPath, JSON.stringify({
          marker, model: options.model, action: call?.name ?? 'finish',
          tools: (options.tools ?? []).map(tool => tool.name), sessionId: options.sessionId,
          context: options.messages,
        }) + '\n')
      }
      if (recipe.failAt === calls.length) throw new Error('The configured external model failed after candidate submission')
      if (recipe.barrier && (recipe.barrier.at === undefined || recipe.barrier.at === calls.length)) {
        const { enteredPath, releasePath, abortedPath, cleanupReleasePath, settledPath } = recipe.barrier
        await writeFileAtomic(enteredPath, 'entered\n', { mode: 0o600 })
        try {
          await waitForFile(releasePath, options.signal)
        } finally {
          if (options.signal?.aborted) await writeFileAtomic(abortedPath, 'aborted\n', { mode: 0o600 })
          if (cleanupReleasePath) await waitForFile(cleanupReleasePath)
          await writeFileAtomic(settledPath, options.signal?.aborted ? 'aborted\n' : 'completed\n', { mode: 0o600 })
        }
      }
      if (call) {
        const id = 'native-fixture-' + (++nextCall)
        const readResult = options.messages.slice(Math.max(0, inputIndex)).filter(message => message.role === 'tool').map(message => {
          try { return JSON.parse(textOf(message)) } catch (error) { return null }
        }).findLast(value => value?.stage || value?.content)
        const args = JSON.stringify(call.arguments, (key, value) => value === '$stageId' ? readResult?.stage?.id
          : value === '$versions' ? JSON.stringify({ [readResult.id]: readResult.content }) : value)
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: call.name, argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: call.name, arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        const count = replies.get(marker) ?? 0
        const reply = recipe.replies ? recipe.replies[count] : recipe.reply
        if (typeof reply !== 'string') throw new Error(`External model recipe exhausted: ${marker}`)
        replies.set(marker, count + 1)
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: reply }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['media-desk-fixture'], new NativeModel()))
}
