import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { ResolvedToolSet } from '@deepseek-ai/dsh-tools'
import type { HostContext } from '../src/host/types'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { ToolsService } from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runtime } from '../src/host/config/runtime'
import { activateHost } from '../src/host/context'
import { sink } from '../src/host/service/sink'

const modelSelection: ModelSelection = { provider: 'native', model: 'opus' }

describe('native tool replay through the official pipeline', () => {
  let ctx: HostContext
  let agent: Agent
  let signal: AbortSignal
  let toolSet: ResolvedToolSet
  let official: Awaited<ReturnType<typeof sink.create>>
  let deactivate: () => void
  let disposers: (() => void)[]

  beforeEach(async () => {
    ctx = new Context() as HostContext
    // Only unrelated host services are minimal fixtures; registry and execution are real.
    ctx.provide('systemPrompt', { tools: () => () => {} } as unknown as Context['systemPrompt'])
    new ToolsService(ctx)
    ctx.provide('loader', { import: (id: string) => import(id), unwrapExports: (value: unknown) => value })
    agent = { id: 'native-agent', ctx, session: {} } as Agent
    ctx.provide('agents', { get: () => agent } as unknown as Context['agents'])
    ctx.provide('sessions', { get: () => agent.session } as unknown as Context['sessions'])
    deactivate = activateHost(ctx, {})
    signal = new AbortController().signal
    // The official loop resolves admission before the native assistant registers its tools.
    toolSet = await ctx.tools.resolve({ agent, modelSelection, signal })
    official = await sink.create({ agent, turn: 1, step: 1, messages: [], signal, dispatched: true, binding: { backend: 'claude', nativeSessionId: 'native-session', sessionId: agent.id } })
    disposers = [
      ctx.on('tools/pre-execute', sink.admitTool),
      ctx.on('tools/execute', sink.executeTool),
      ctx.on('tools/post-execute', sink.finishTool),
      ctx.on('tools/result', sink.acceptTool),
    ]
  })

  afterEach(async () => {
    await official.dispose()
    toolSet.dispose()
    for (const dispose of disposers)
      dispose()
    deactivate()
    runtime.executors = new WeakSet()
  })

  it.each([
    { name: 'Bash', arguments: '{"command":"date"}', output: '17:00:00' },
    { name: 'Grep', arguments: '{"pattern":"native","path":"src"}', output: 'src/host/service/sink.ts: native' },
  ])('preserves a successful $name result absent from the step snapshot', async ({ name, arguments: arguments_, output }) => {
    const id = ToolCallId(`native-${name}`)
    const call = { type: 'tool-call' as const, id, name, arguments: arguments_ }
    expect(ctx.tools.executable(name, agent, toolSet)).toBeUndefined()
    official.state.native.assistant('assistant-1', [call])
    official.state.native.toolStart(id, name, arguments_)
    official.state.native.toolEnd(id, output)

    const batch = await ctx.tools.execute({ agent, signal, toolSet, calls: [call] })

    expect(batch.results).toEqual([{ callId: id, result: { isError: false, value: output, content: [{ type: 'text', text: output }] } }])
    expect(official.state.failure).toBeUndefined()
    expect(official.state.tools.get(id)?.accepted).toBe(true)
  })

  it('preserves native error content and BRIDGE_NATIVE_TOOL_ERROR', async () => {
    const id = ToolCallId('native-error')
    const call = { type: 'tool-call' as const, id, name: 'Bash', arguments: '{"command":"missing-command"}' }
    official.state.native.assistant('assistant-error', [call])
    official.state.native.toolStart(id, call.name, call.arguments)
    official.state.native.toolEnd(id, 'command not found', true)

    const batch = await ctx.tools.execute({ agent, signal, toolSet, calls: [call] })

    expect(batch.results[0]?.result).toEqual({
      isError: true,
      error: { message: 'command not found', info: { name: 'NativeToolError', code: 'BRIDGE_NATIVE_TOOL_ERROR' } },
      content: [{ type: 'text', text: 'command not found' }],
    })
    expect(official.state.failure).toBeUndefined()
    expect(official.state.tools.get(id)?.accepted).toBe(true)
  })

  it('accepts new native names in consecutive steps and removes placeholders on disposal', async () => {
    const bash = { type: 'tool-call' as const, id: ToolCallId('step-1'), name: 'Bash', arguments: '{"command":"date"}' }
    official.state.native.assistant('assistant-1', [bash])
    official.state.native.toolStart(bash.id, bash.name, bash.arguments)
    official.state.native.toolEnd(bash.id, '17:00:00')
    const first = await ctx.tools.execute({ agent, signal, toolSet, calls: [bash] })
    expect(first.results[0]?.result).toMatchObject({ isError: false, value: '17:00:00' })
    toolSet.dispose()

    toolSet = await ctx.tools.resolve({ agent, modelSelection, signal })
    expect(ctx.tools.executable('Grep', agent, toolSet)).toBeUndefined()
    const grep = { type: 'tool-call' as const, id: ToolCallId('step-2'), name: 'Grep', arguments: '{"pattern":"native"}' }
    official.state.native.assistant('assistant-2', [grep])
    official.state.native.toolStart(grep.id, grep.name, grep.arguments)
    official.state.native.toolEnd(grep.id, 'found native')
    const second = await ctx.tools.execute({ agent, signal, toolSet, calls: [grep] })
    expect(second.results[0]?.result).toMatchObject({ isError: false, value: 'found native' })
    expect([...official.state.tools.values()].every(tool => tool.accepted)).toBe(true)

    await official.dispose()
    await official.dispose()
    expect(runtime.exchanges.has(agent.id)).toBe(false)
    expect(ctx.tools.get('Bash', agent)).toBeUndefined()
    expect(ctx.tools.get('Grep', agent)).toBeUndefined()
    toolSet.dispose()

    toolSet = await ctx.tools.resolve({ agent, modelSelection, signal })
    official = await sink.create({ agent, turn: 2, step: 1, messages: [], signal, dispatched: true, binding: { backend: 'claude', nativeSessionId: 'native-session', sessionId: agent.id } })
    const next = { ...bash, id: ToolCallId('turn-2') }
    official.state.native.assistant('assistant-next-turn', [next])
    official.state.native.toolStart(next.id, next.name, next.arguments)
    official.state.native.toolEnd(next.id, '18:00:00')
    const batch = await ctx.tools.execute({ agent, signal, toolSet, calls: [next] })
    expect(batch.results[0]?.result).toMatchObject({ isError: false, value: '18:00:00' })
    expect(official.state.failure).toBeUndefined()
  })

  it.each(['unpresented-id', 'changed-arguments'])('rejects a registered native name with %s', async (mismatch) => {
    const call = { type: 'tool-call' as const, id: ToolCallId('presented'), name: 'Bash', arguments: '{"command":"date"}' }
    official.state.native.assistant('assistant-1', [call])
    official.state.native.toolStart(call.id, call.name, call.arguments)
    official.state.native.toolEnd(call.id, '17:00:00')
    const unsupported = mismatch === 'unpresented-id'
      ? { ...call, id: ToolCallId('not-presented') }
      : { ...call, arguments: '{"command":"different-command"}' }

    const batch = await ctx.tools.execute({ agent, signal, toolSet, calls: [unsupported] })

    expect(batch.results[0]?.result.isError).toBe(true)
    expect(official.state.signal.aborted).toBe(true)
    expect(official.state.signal.reason).toEqual(expect.objectContaining({ message: expect.stringContaining('BRIDGE_TOOL_NOT_PRESENTED') }))
    expect(official.state.tools.get(call.id)?.dispatched).toBe(false)
    expect(official.state.tools.get(call.id)?.accepted).toBe(false)
  })

  it('rejects altered official results before accepting native replay', async () => {
    disposers.push(ctx.on('tools/post-execute', async () => ({ kind: 'accept', content: [{ type: 'text', text: 'altered output' }] }), true))
    const call = { type: 'tool-call' as const, id: ToolCallId('altered'), name: 'Bash', arguments: '{"command":"date"}' }
    official.state.native.assistant('assistant-1', [call])
    official.state.native.toolStart(call.id, call.name, call.arguments)
    official.state.native.toolEnd(call.id, '17:00:00')

    const batch = await ctx.tools.execute({ agent, signal, toolSet, calls: [call] })

    expect(batch.results[0]?.result.content).toEqual([{ type: 'text', text: 'altered output' }])
    expect(official.state.failure).toEqual(expect.objectContaining({ message: expect.stringContaining('BRIDGE_TOOL_RESULT_REJECTED') }))
    expect(official.state.signal.aborted).toBe(true)
    expect(official.state.tools.get(call.id)?.accepted).toBe(false)
  })

  it('keeps ordinary tool snapshot admission after the native turn is disposed', async () => {
    await official.dispose()
    let executions = 0
    disposers.push(ctx.tools.register({
      name: 'ordinary',
      description: 'An ordinary conditional tool',
      parameters: { type: 'object' },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute() {
        executions++
        return 'ordinary result'
      },
    }, { when: () => true }))
    const call = { type: 'tool-call' as const, id: ToolCallId('ordinary-missing'), name: 'ordinary', arguments: '{}' }

    const excluded = await ctx.tools.execute({ agent, signal, toolSet, calls: [call] })
    expect(excluded.results[0]?.result).toMatchObject({ isError: true, error: { info: { code: 'UNKNOWN_TOOL' } } })
    expect(executions).toBe(0)
    toolSet.dispose()

    toolSet = await ctx.tools.resolve({ agent, modelSelection, signal })
    const admitted = await ctx.tools.execute({ agent, signal, toolSet, calls: [{ ...call, id: ToolCallId('ordinary-admitted') }] })
    expect(admitted.results[0]?.result).toMatchObject({ isError: false, value: 'ordinary result' })
    expect(executions).toBe(1)
    toolSet.dispose()

    const closed = await ctx.tools.execute({ agent, signal, toolSet, calls: [{ ...call, id: ToolCallId('ordinary-closed') }] })
    expect(closed.results[0]?.result).toMatchObject({ isError: true, error: { info: { code: 'UNKNOWN_TOOL' } } })
    expect(executions).toBe(1)
  })
})
