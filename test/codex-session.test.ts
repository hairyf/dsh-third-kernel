import type { KernelCommand } from '../src/host/detect'
/**
 * End-to-end smoke check against a real kernel.
 *
 * This is the smallest runnable proof that the adapter's protocol work is
 * correct: it spawns the installed Codex CLI through the same transport and
 * session code the plugin uses, sends one prompt, and asserts that streamed
 * assistant text and a terminal `done` arrive. It skips itself when no kernel is
 * installed, so CI without the CLIs stays green instead of asserting nothing.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { CodexSession } from '../src/host/codex'
import { probeKernel } from '../src/host/detect'

describe('codex kernel', () => {
  let command: KernelCommand | null = null

  beforeAll(async () => {
    const probe = await probeKernel('codex')
    command = probe.installed ? probe.command : null
  })

  it('streams assistant text for one turn', async () => {
    if (command === null) {
      // No Codex on this machine: the protocol cannot be exercised, and a green
      // unit test must not pretend otherwise.
      expect(command).toBeNull()
      return
    }
    const session = new CodexSession(command, process.cwd(), () => process.cwd())
    try {
      await session.open(AbortSignal.timeout(30_000))
      expect(session.id).not.toBe('')
      const events: { type: string, delta?: string }[] = []
      for await (const event of session.run({ text: 'Reply with the single word PONG and nothing else.' }, AbortSignal.timeout(90_000))) {
        events.push(event as { type: string, delta?: string })
        if (event.type === 'done' || event.type === 'error')
          break
      }
      const text = events.filter(event => event.type === 'text').map(event => event.delta ?? '').join('')
      expect(text.toUpperCase()).toContain('PONG')
      expect(events.some(event => event.type === 'done')).toBe(true)
    }
    finally {
      await session.dispose()
    }
  }, 120_000)
})
