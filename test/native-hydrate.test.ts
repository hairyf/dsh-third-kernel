/**
 * `identity.hydrate` restores a committed native route onto a live Agent.
 *
 * DSH 0.2.2's session controller publishes `agent.options` through getter-only
 * accessors (`ApiSessionAgentController.agentOptions()`), so the pre-0.2.1
 * implementation — assigning `provider` and `model` — threw
 * `TypeError: Cannot set property provider of #<Object> which has only a getter`
 * from the global `agent/created` listener. That took down every resumed native
 * session and, because the listener is global and awaited, ordinary session
 * creation too (issues #7 and #8).
 *
 * These tests drive `hydrate` against both an Agent-shaped object with
 * getter-only options and the durable selection API it must use instead.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { KernelBinding } from '../src/shared/types'
import { afterEach, expect, it, vi } from 'vitest'
import { BRIDGE_PROVIDER } from '../src/host/config/constants'
import { identity } from '../src/host/service/identity'

const CLAUDE: KernelBinding = { backend: 'claude', nativeSessionId: 'native-claude', sessionId: 'session-1' }

interface Selection {
  provider: string
  model: string
}

/** An Agent whose route options answer like the host controller's live getters. */
function agentOf(options: { provider?: string, model?: string }, current: () => Selection | undefined) {
  const select = vi.fn()
  const value = {
    options: Object.defineProperties({}, {
      provider: { get: () => options.provider, enumerable: true },
      model: { get: () => options.model, enumerable: true },
      reasoningEffort: { get: () => undefined, enumerable: true },
    }),
    model: { current, select },
  }
  return { agent: value as unknown as Agent, select }
}

function resolveAs(binding: KernelBinding): void {
  vi.spyOn(identity, 'resolve').mockReturnValue(binding)
}

afterEach(() => vi.restoreAllMocks())

it('records the native route through the selection API instead of writing getter-only options', () => {
  resolveAs(CLAUDE)
  const { agent, select } = agentOf({ provider: 'dsh', model: 'deepseek-v4' }, () => ({ provider: 'dsh', model: 'deepseek-v4' }))

  // The reported failure: strict-mode assignment to the controller's accessor.
  expect(() => {
    agent.options.provider = BRIDGE_PROVIDER
  }).toThrow(TypeError)

  identity.hydrate(agent)
  expect(select).toHaveBeenCalledOnce()
  expect(select).toHaveBeenCalledWith({ provider: BRIDGE_PROVIDER, model: 'claude' })
})

it('leaves the session alone when the native route is already recorded', () => {
  resolveAs(CLAUDE)
  const { agent, select } = agentOf({ provider: 'dsh', model: 'deepseek-v4' }, () => ({ provider: BRIDGE_PROVIDER, model: 'claude' }))

  identity.hydrate(agent)
  expect(select).not.toHaveBeenCalled()
})

it('never replaces a different explicit model choice', () => {
  resolveAs(CLAUDE)
  const { agent, select } = agentOf({ provider: 'dsh', model: 'deepseek-v4' }, () => ({ provider: 'openai', model: 'gpt-5' }))

  identity.hydrate(agent)
  expect(select).not.toHaveBeenCalled()
})

it('records the route when the Agent has no route at all', () => {
  resolveAs({ ...CLAUDE, backend: 'codex' })
  const { agent, select } = agentOf({}, () => undefined)

  identity.hydrate(agent)
  expect(select).toHaveBeenCalledWith({ provider: BRIDGE_PROVIDER, model: 'codex' })
})

it('does not mutate a writable options object either', () => {
  resolveAs(CLAUDE)
  const options = { provider: 'dsh', model: 'deepseek-v4' }
  const select = vi.fn()
  const agent = { options, model: { current: () => ({ provider: 'dsh', model: 'deepseek-v4' }), select } } as unknown as Agent

  identity.hydrate(agent)
  expect(select).toHaveBeenCalledWith({ provider: BRIDGE_PROVIDER, model: 'claude' })
  expect(options).toEqual({ provider: 'dsh', model: 'deepseek-v4' })
})
