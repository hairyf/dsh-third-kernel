/**
 * Protocol regressions that need no vendor binary: a stub app-server drives the
 * three shapes a real one produces and the normal fixture does not cover.
 *
 *  - a native error with nothing after it must end the turn (not strand it),
 *    and must leave the session reusable;
 *  - `thread/tokenUsage/updated` must reach the sink in the official
 *    vocabulary, where cache counts are disjoint from `inputTokens`.
 */
import type { TokenUsage, UserMessage } from '@deepseek-ai/dsh-llm'
import type { NativeContent, NativeSink } from '../src/host/backends/types'
import { fileURLToPath } from 'node:url'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { createCodexSession } from '../src/host/backends/codex'

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-codex-modes.mjs', import.meta.url))

function recorder(): { sink: NativeSink, usage: TokenUsage[] } {
  const usage: TokenUsage[] = []
  const sink: NativeSink = {
    text: () => {},
    thinking: () => {},
    assistant: (_id: string, _content: readonly NativeContent[]) => {},
    usage: reported => usage.push(reported),
    toolStart: () => {},
    toolEnd: () => {},
    approval: async () => false,
    questions: async () => ({}),
  }
  return { sink, usage }
}

function prompt(): UserMessage[] {
  return [{ id: MessageId('user-1'), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'go' }] }]
}

/** One stub child per mode; the mode is the argument the fixture reads. */
function command(mode: string): { file: string, args: string[] } {
  return { file: process.execPath, args: [FIXTURE, mode] }
}

describe('codex protocol', () => {
  it('ends the turn on a native error that no completion follows', async () => {
    const { sink } = recorder()
    const session = await createCodexSession(command('error'), process.cwd(), null, sink, AbortSignal.timeout(10_000))
    try {
      await expect(session.submit(prompt(), AbortSignal.timeout(10_000))).rejects.toThrow('provider exploded')
    }
    finally {
      await session.dispose()
    }
  })

  it('reports token usage with cache counts kept apart from input', { timeout: 20_000 }, async () => {
    const { sink, usage } = recorder()
    const session = await createCodexSession(command('usage'), process.cwd(), null, sink, AbortSignal.timeout(10_000))
    try {
      await session.submit(prompt(), AbortSignal.timeout(10_000))
      // inputTokens 20 folds 8 cached + 2 cache-written prompt tokens in; the
      // official vocabulary keeps them disjoint.
      expect(usage).toEqual([{ inputTokens: 10, outputTokens: 10, cacheReadTokens: 8, cacheWriteTokens: 2 }])
    }
    finally {
      await session.dispose()
    }
  })
})
