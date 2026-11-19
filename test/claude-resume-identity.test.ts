/**
 * A resumed Claude session must open without waiting for a callback the real CLI
 * never sends.
 *
 * Claude Code 2.1.x answers the `initialize` control request with the model
 * catalogue and `hooks_applied: true`, but without a `session_id`, and it never
 * invokes the registered `SessionStart` hook callback before user input. The
 * backend therefore confirmed identity only after the first `session_id` frame,
 * which happens after the first message — i.e. after `open()` already failed
 * with `BRIDGE_NATIVE_BIND_UNCONFIRMED` 60s later (issue #7).
 *
 * The fixture below reproduces exactly that CLI behaviour: it echoes `--resume`
 * in later frames, sends no hook callback, and never mentions the session id in
 * the initialize response.
 */
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { NativeContent, NativeSink } from '../src/host/backends/types'
import { fileURLToPath } from 'node:url'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { createClaudeSession } from '../src/host/backends/claude'

const FAKE_RESUME_CLAUDE = fileURLToPath(new URL('./fixtures/fake-resume-claude.mjs', import.meta.url))

function sinkOf(events: string[]): NativeSink {
  return {
    text: (id, delta) => events.push(`text:${id}:${delta}`),
    thinking: (id, delta) => events.push(`thinking:${id}:${delta}`),
    assistant: (id, content: readonly NativeContent[]) => events.push(`assistant:${id}:${content.map(value => value.type).join(',')}`),
    toolStart: (id, name) => events.push(`toolStart:${id}:${name}`),
    toolEnd: (id, output, error) => events.push(`toolEnd:${id}:${output}:${error === true}`),
    usage: usage => events.push(`usage:${usage.inputTokens}/${usage.outputTokens}`),
    approval: async () => false,
    questions: async () => ({}),
  }
}

describe('resumed Claude session identity', () => {
  it('opens and reads the catalogue from the accepted handshake', async () => {
    const events: string[] = []
    const session = await createClaudeSession({ file: process.execPath, args: [FAKE_RESUME_CLAUDE] }, process.cwd(), 'resume-me', sinkOf(events), AbortSignal.timeout(20_000))
    try {
      expect(session.id).toBe('resume-me')
      if (typeof session.models !== 'function')
        throw new Error('the Claude backend must expose its model catalogue')
      const catalog = await session.models(AbortSignal.timeout(5_000))
      expect(catalog.models.map(model => model.id)).toContain('fake-model')
    }
    finally {
      await session.dispose()
    }
  }, 30_000)

  it('still runs a turn whose frames report the resumed id', async () => {
    const events: string[] = []
    const session = await createClaudeSession({ file: process.execPath, args: [FAKE_RESUME_CLAUDE] }, process.cwd(), 'resume-me', sinkOf(events), AbortSignal.timeout(20_000))
    try {
      const message: UserMessage = { id: MessageId('user-1'), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'go' }] }
      await session.submit([message], AbortSignal.timeout(10_000))
      expect(events).toContain('text:resumed-msg:block:0:resumed')
      expect(events).toContain('usage:3/2')
    }
    finally {
      await session.dispose()
    }
  }, 30_000)
})
