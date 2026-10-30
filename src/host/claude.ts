/**
 * Claude kernel over `claude --print --input-format stream-json`.
 *
 * The CLI speaks newline-delimited JSON: the client writes `{type:'user'}`
 * frames and `control_request`s, and reads `stream_event`, `assistant`,
 * `result`, and `control_request` frames. Permission prompts and questions
 * arrive as control requests that must be answered to unblock the turn.
 */
import type { TurnEvent } from '../shared/protocol'
import type { KernelCommand } from './detect'
import type { ApprovalAnswer, KernelSession, Waiter } from './session-types'
import type { JsonLinesProcess } from './transport'
import { randomUUID } from 'node:crypto'
import { nativeEnvironment } from './detect'
import { approvalDetails, questionsOf } from './session-types'
import { BridgeError, errorFrom, INTERRUPT_TIMEOUT_MS, optionalString, PendingRequests, JsonLinesProcess as Process, record, stringField } from './transport'

interface TurnState {
  yieldEvent: (event: TurnEvent) => void
  finish: (error?: Error) => void
  tools: Map<string, { output: string, ended: boolean }>
  /** Content-block indexes already streamed, so a whole-message frame never doubles text. */
  streamed: Set<number>
  resultReceived: boolean
}

export class ClaudeSession implements KernelSession {
  private readonly transport: JsonLinesProcess
  private readonly requests: PendingRequests
  private readonly waiters = new Map<string, Waiter>()
  private readonly approvals = new Map<string, AbortController>()
  private readonly nativeId = randomUUID()
  private active?: TurnState
  private failure?: Error
  private disposed = false
  private disposePromise?: Promise<void>

  constructor(executable: KernelCommand, cwd: string) {
    this.transport = new Process(executable, [
      '--print',
      '--verbose',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--permission-prompt-tool',
      'stdio',
      `--session-id=${this.nativeId}`,
    ], cwd, {
      ...nativeEnvironment(),
      // Claude drops its SDK session state when this is unset, which also drops
      // the assistant/tool frames this adapter translates.
      CLAUDE_CODE_SDK_READS_SESSION_STATE: '1',
    })
    this.requests = new PendingRequests(value => this.transport.write(value))
    this.transport.onFailure((error) => {
      this.failure = error
      this.requests.failAll(error)
      this.waiters.clear()
      this.approvals.clear()
      this.active?.finish(error)
    })
    this.transport.onMessage(message => this.receive(message))
  }

  get id(): string {
    return this.nativeId
  }

  async open(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const response = record(await this.control({
      subtype: 'initialize',
      hooks: { SessionStart: [{ hookCallbackIds: ['dsh-third-kernel'] }] },
    }, signal))
    const reported = optionalString(response.session_id)
    if (reported !== undefined && reported !== this.nativeId)
      throw new BridgeError('BRIDGE_RESUME_MISMATCH', 'Claude 返回了不同的会话标识')
  }

  async models(signal?: AbortSignal): Promise<string[]> {
    // Claude advertises its models on every initialize response, so re-sending it
    // keeps this call stateless.
    const response = record(await this.control({ subtype: 'initialize' }, signal))
    if (!Array.isArray(response.models))
      return []
    return response.models.flatMap((value) => {
      const model = record(value)
      const name = optionalString(model.displayName) ?? optionalString(model.value)
      if (name === undefined)
        return []
      const levels = Array.isArray(model.supportedEffortLevels)
        ? model.supportedEffortLevels.filter((level): level is string => typeof level === 'string')
        : []
      return [levels.length === 0 ? name : `${name} · ${levels.join('/')}`]
    })
  }

  async* run(input: { text: string }, signal: AbortSignal): AsyncGenerator<TurnEvent> {
    if (this.disposed || this.failure)
      throw this.failure ?? new BridgeError('BRIDGE_PROCESS_CLOSED', 'Claude 会话已关闭')
    if (this.active !== undefined)
      throw new BridgeError('BRIDGE_BUSY', 'Claude 会话已有正在进行的回合')
    const events: TurnEvent[] = []
    let wake: (() => void) | undefined
    let finished = false
    let terminalError: Error | undefined
    const state: TurnState = {
      yieldEvent: (event) => {
        events.push(event)
        wake?.()
        wake = undefined
      },
      finish: (error) => {
        terminalError = error
        finished = true
        wake?.()
        wake = undefined
      },
      tools: new Map(),
      streamed: new Set(),
      resultReceived: false,
    }
    this.active = state
    const aborted = (): void => {
      if (!state.resultReceived)
        void this.control({ subtype: 'interrupt' }, undefined, INTERRUPT_TIMEOUT_MS).catch(() => {})
    }
    signal.addEventListener('abort', aborted, { once: true })
    try {
      this.transport.write({
        type: 'user',
        session_id: this.nativeId,
        uuid: randomUUID(),
        parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'text', text: input.text }] },
      })
      while (true) {
        if (events.length > 0) {
          const event = events.shift()!
          yield event
          if (event.type === 'done')
            return
          continue
        }
        if (finished) {
          if (terminalError !== undefined) {
            yield { type: 'error', message: terminalError.message }
            return
          }
          yield { type: 'done' }
          return
        }

        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
    }
    catch (error) {
      const reason = errorFrom(error)
      if (this.failure === undefined && !signal.aborted)
        this.transport.fail(reason)
      yield { type: 'error', message: reason.message }
    }
    finally {
      signal.removeEventListener('abort', aborted)
      this.approvals.clear()
      if (this.active === state)
        this.active = undefined
    }
  }

  answer(id: string, value: ApprovalAnswer): void {
    const waiter = this.waiters.get(id)
    if (waiter === undefined)
      return
    this.waiters.delete(id)
    if (waiter.kind === 'approval' && value.kind === 'approval')
      waiter.resolve(value.allowed)
    else if (waiter.kind === 'question' && value.kind === 'question')
      waiter.resolve(value.answers)
  }

  async interrupt(): Promise<void> {
    if (this.active !== undefined)
      await this.control({ subtype: 'interrupt' }, undefined, INTERRUPT_TIMEOUT_MS).catch(() => {})
  }

  dispose(): Promise<void> {
    this.disposePromise ??= this.close()
    return this.disposePromise
  }

  private async close(): Promise<void> {
    this.disposed = true
    const error = new BridgeError('BRIDGE_PROCESS_CLOSED', 'Claude 会话已关闭')
    this.requests.failAll(error)
    this.waiters.clear()
    this.approvals.clear()
    this.active?.finish(error)
    try {
      await this.transport.close(this.active === undefined)
    }
    catch {
      // Best effort: a wedged child must not fail teardown.
    }
  }

  private control(request: Record<string, unknown>, signal?: AbortSignal, timeoutMs?: number): Promise<unknown> {
    const id = randomUUID()
    return this.requests.request(id, { type: 'control_request', request_id: id, request }, signal, timeoutMs)
  }

  private receive(message: Record<string, unknown>): void {
    const type = stringField(message, 'type')
    if (type === 'control_response') {
      const response = record(message.response)
      const id = stringField(response, 'request_id')
      if (response.subtype === 'success')
        this.requests.settle(id, response.response ?? {})
      else
        this.requests.settle(id, undefined, new BridgeError('BRIDGE_NATIVE_REQUEST', optionalString(response.error) ?? '内核拒绝了控制请求'))
      return
    }
    if (type === 'control_request') {
      const id = stringField(message, 'request_id')
      void this.handleRequest(id, record(message.request)).catch((error: unknown) => {
        this.transport.write({ type: 'control_response', response: { subtype: 'error', request_id: id, error: errorFrom(error).message } })
      })
      return
    }
    if (type === 'control_cancel_request') {
      const id = stringField(message, 'request_id')
      this.approvals.get(id)?.abort(new BridgeError('BRIDGE_REQUEST_CLOSED', 'Claude 撤回了该请求'))
      this.approvals.delete(id)
      return
    }
    if (type === 'conversation_reset')
      throw new BridgeError('BRIDGE_NATIVE_RESET', 'Claude 重置了会话，已绑定会话不能被静默替换')
    const turn = this.active
    if (type === 'result') {
      const aborted = message.terminal_reason === 'aborted_streaming' || message.terminal_reason === 'aborted_tools'
      const error = aborted
        ? new BridgeError('BRIDGE_ABORTED', '回合已取消')
        : message.is_error === true || message.subtype !== 'success'
          ? new BridgeError('BRIDGE_NATIVE_TURN', optionalString(message.result) ?? JSON.stringify(message.errors ?? message.subtype))
          : undefined
      if (turn === undefined) {
        if (error !== undefined)
          this.transport.fail(error)
        return
      }
      turn.resultReceived = true
      turn.finish(error)
      return
    }
    if (turn === undefined)
      return
    if (type === 'stream_event')
      this.stream(turn, record(message.event ?? {}))
    else if (type === 'assistant')
      this.assistantText(turn, record(message.message ?? {}))
    else
      this.toolResults(turn, record(message.message ?? {}))
  }

  /** Translate one streamed content-block delta; mirrors the Anthropic stream events. */
  private stream(turn: TurnState, event: Record<string, unknown>): void {
    const type = optionalString(event.type)
    const index = typeof event.index === 'number' ? event.index : 0
    if (type === 'content_block_start') {
      const block = record(event.content_block ?? {})
      if (block.type === 'tool_use') {
        const id = stringField(block, 'id')
        turn.tools.set(id, { output: '', ended: false })
        turn.yieldEvent({ type: 'tool-start', id, name: stringField(block, 'name'), input: JSON.stringify(block.input ?? {}) })
      }
      return
    }
    if (type !== 'content_block_delta')
      return
    const delta = record(event.delta ?? {})
    if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text !== '') {
      turn.streamed.add(index)
      turn.yieldEvent({ type: 'text', id: `t${index}`, delta: delta.text })
    }
    else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking !== '') {
      turn.yieldEvent({ type: 'thinking', id: `r${index}`, delta: delta.thinking })
    }
  }

  /** Text-only fallback for blocks that carried no streamed partials. */
  private assistantText(turn: TurnState, message: Record<string, unknown>): void {
    if (!Array.isArray(message.content))
      return
    message.content.forEach((value, index) => {
      const block = record(value)
      if (block.type !== 'text' || typeof block.text !== 'string' || block.text === '')
        return
      if (turn.streamed.has(index))
        return
      turn.streamed.add(index)
      turn.yieldEvent({ type: 'text', id: `t${index}`, delta: block.text })
    })
  }

  /** Complete tools announced by an earlier frame once their results arrive. */
  private toolResults(turn: TurnState, message: Record<string, unknown>): void {
    if (!Array.isArray(message.content))
      return
    for (const value of message.content) {
      const block = record(value)
      if (block.type !== 'tool_result')
        continue
      const id = stringField(block, 'tool_use_id')
      const tool = turn.tools.get(id)
      if (tool === undefined || tool.ended)
        continue
      tool.ended = true
      const output = Array.isArray(block.content)
        ? block.content.map((part) => {
            const inner = record(part)
            return inner.type === 'text' && typeof inner.text === 'string' ? inner.text : JSON.stringify(inner)
          }).join('\n')
        : optionalString(block.content) ?? JSON.stringify(block.content ?? '')
      turn.yieldEvent({ type: 'tool-end', id, output, error: block.is_error === true })
    }
  }

  /** Answer a server-to-client control request: permissions and questions. */
  private async handleRequest(id: string, request: Record<string, unknown>): Promise<void> {
    const turn = this.active
    const subtype = optionalString(request.subtype) ?? ''
    const respond = (result: Record<string, unknown>): void => {
      this.transport.write({ type: 'control_response', response: { subtype: 'success', request_id: id, response: result } })
    }
    if (subtype === 'can_use_tool') {
      if (turn === undefined) {
        respond({ behavior: 'deny', message: '没有进行中的回合' })
        return
      }
      const tool = optionalString(request.tool_name) ?? 'tool'
      turn.yieldEvent({
        type: 'approval',
        id,
        kind: 'tool',
        title: `${tool} 需要许可`,
        details: approvalDetails(`Claude 请求运行 ${tool}`, record(request.input ?? {}), ['command', 'file_path', 'path', 'url', 'pattern']),
      })
      const allowed = await new Promise<boolean>((resolve) => {
        this.waiters.set(id, { kind: 'approval', resolve })
      })
      respond(allowed
        ? { behavior: 'allow', updatedInput: record(request.input ?? {}) }
        : { behavior: 'deny', message: '用户拒绝了该操作' })
      return
    }
    if (subtype === 'ask_user_question' || subtype === 'user_question') {
      if (turn === undefined) {
        respond({ answers: {} })
        return
      }
      const questions = questionsOf(request.questions)
      turn.yieldEvent({ type: 'question', id, questions })
      const answers = await new Promise<Record<string, string | string[]>>((resolve) => {
        this.waiters.set(id, { kind: 'question', resolve })
      })
      respond({ answers })
      return
    }
    respond({})
  }
}
