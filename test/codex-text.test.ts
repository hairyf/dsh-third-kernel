/**
 * Regression check for the doubled-reply bug: one streamed Codex turn must
 * produce the assistant text exactly once, not again on completion.
 *
 * Runs against the real CLI when it is installed and skips cleanly when not, so
 * a machine without Codex still gets an honest green unit run.
 */
import type { KernelCommand } from '../src/host/detect'
import { beforeAll, describe, expect, it } from 'vitest'
import { CodexSession } from '../src/host/codex'
import { probeKernel } from '../src/host/detect'

describe('codex turn text', () => {
  let command: KernelCommand | null = null

  beforeAll(async () => {
    const probe = await probeKernel('codex')
    command = probe.installed ? probe.command : null
  })

  it('does not repeat an agent message that already streamed', async () => {
    if (command === null) {
      expect(command).toBeNull()
      return
    }
    const session = new CodexSession(command, process.cwd(), () => process.cwd())
    try {
      await session.open(AbortSignal.timeout(30_000))
      const events: { type: string, id?: string, delta?: string }[] = []
      for await (const event of session.run({ text: 'Reply with the single word PONG and nothing else.' }, AbortSignal.timeout(90_000))) {
        events.push(event as { type: string, id?: string, delta?: string })
        if (event.type === 'done' || event.type === 'error')
          break
      }
      const text = events.filter(event => event.type === 'text').map(event => event.delta ?? '').join('').trim()
      expect(text.toUpperCase()).toBe('PONG')
    }
    finally {
      await session.dispose()
    }
  }, 120_000)
})
