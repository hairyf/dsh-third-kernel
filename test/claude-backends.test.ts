import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { NativeContent, NativeSink } from '../src/host/backends/types'
import { fileURLToPath } from 'node:url'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { createClaudeSession } from '../src/host/backends/claude'

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-active-claude.mjs', import.meta.url))

describe('active Claude backend', () => {
  it('does not project child-lane transcript or tool results into the root sink', async () => {
    const events: string[] = []
    const sink: NativeSink = {
      text: (id, delta) => events.push(`text:${id}:${delta}`),
      thinking: (id, delta) => events.push(`thinking:${id}:${delta}`),
      assistant: (id, content: readonly NativeContent[]) => events.push(`assistant:${id}:${content.map(value => value.type).join(',')}`),
      toolStart: (id, name) => events.push(`toolStart:${id}:${name}`),
      toolEnd: (id, output, error) => events.push(`toolEnd:${id}:${output}:${error === true}`),
      usage: usage => events.push(`usage:${usage.inputTokens}/${usage.outputTokens}/${usage.cacheReadTokens ?? 0}/${usage.cacheWriteTokens ?? 0}`),
      approval: async () => false,
      questions: async () => ({}),
    }
    const session = await createClaudeSession({ file: process.execPath, args: [FAKE_CLAUDE] }, process.cwd(), null, sink, AbortSignal.timeout(10_000))
    try {
      const message: UserMessage = { id: MessageId('user-1'), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'go' }] }
      await session.submit([message], AbortSignal.timeout(10_000))
      expect(events).toContain('text:root-msg:block:0:root')
      expect(events.some(event => event.includes('child-msg'))).toBe(false)
      expect(events.some(event => event.startsWith('toolEnd:'))).toBe(false)
      // The turn ends even though the task report carried an unmapped status,
      // and the authoritative result usage is forwarded once.
      expect(events.filter(event => event.startsWith('usage:'))).toEqual(['usage:10/5/2/1'])
    }
    finally {
      await session.dispose()
    }
  })
})
