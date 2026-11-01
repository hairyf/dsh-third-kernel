/**
 * Claude kernel over `claude --print --input-format stream-json`.
 *
 * The CLI speaks newline-delimited JSON: the client writes `{type:'user'}`
 * frames and `control_request`s, and reads `stream_event`, `assistant`,
 * `user`, and `result` frames. Permission prompts and questions arrive as
 * control requests that must be answered to unblock the turn.
 *
 * Two rules keep the transcript honest (the CLI delivers both a token stream
 * and the same content again as whole messages):
 *
 * - `stream_event` frames are the typewriter: deltas only.
 * - `assistant` frames are authoritative: they carry complete blocks and the
 *   tool calls with their parsed input, and they repeat what the deltas
 *   already showed.
 *
 * Both belong to one API message id (`message.id`), so one attempt tracks
 * which blocks were streamed and the id is remembered once settled — a late
 * block of a finished message is dropped instead of reopening it.
 */
import type { KernelModel, PermissionMode, TurnEvent } from '../shared/protocol'
import type { KernelCommand } from './detect'
import type { ApprovalAnswer, KernelSession, TurnInput, Waiter } from './session-types'
import type { JsonLinesProcess } from './transport'
import { randomUUID } from 'node:crypto'
import { nativeEnvironment } from './detect'
import { approvalDetails, questionsOf } from './session-types'
import { BridgeError, errorFrom, INTERRUPT_TIMEOUT_MS, optionalString, PendingRequests, JsonLinesProcess as Process, record, stringField } from './transport'

/**
 * Permission mode → Claude's native permission mode name.
 *
 * Claude has no read-only mode: `plan` is the one that refuses every write, so
 * it is the honest translation. `auto` accepts edits and asks for the rest;
 * `bypassPermissions` only exists because the child is launched with
 * `--allow-dangerously-skip-permissions` below.
 */
export const PERMISSION_MODE: Record<PermissionMode, string> = {
  'read-only': 'plan',
  'auto': 'acceptEdits',
  'full-access': 'bypassPermissions',
}

/** Settled message ids remembered; a late block only trails its own response. */
const MAX_SETTLED_ATTEMPTS = 256
/** Abort diagnostics the CLI appends to `result.errors` (never shown). */
const EDE_DIAGNOSTIC = '[ede_diagnostic]'
/** Terminal reasons that mean "the user stopped this", not "it failed". */
const ABORTED = ['aborted_streaming', 'aborted_tools']
/** Result subtypes that mean "this turn hit a wall", not "the kernel broke". */
const BLOCKED = ['error_max_turns', 'error_max_budget_usd']

/** One API response, assembled from its streamed deltas and its messages. */
interface Attempt {
  id: string
  /** Text already shown as deltas: the whole-message frame must not repeat it. */
  streamedText: boolean
  streamedThinking: boolean
}

interface TurnState {
  yieldEvent: (event: TurnEvent) => void
  finish: (error?: Error) => void
  tools: Map<string, { output: string, ended: boolean }>
  /** Message ids already closed, so a late block cannot reopen one. */
  settled: Set<string>
  attempt?: Attempt
  resultReceived: boolean
}

export class ClaudeSession implements KernelSession {
  private readonly transport: JsonLinesProcess
  private readonly requests: PendingRequests
  private readonly waiters = new Map<string, Waiter>()
  private readonly approvals = new Map<string, AbortController>()
  private readonly nativeId = randomUUID()
  /** The CLI's current session id; a `conversation_reset` moves it. */
  private sessionId: string = this.nativeId
  /** A reset was seen: the next frame naming another id adopts it. */
  private resetPending = false
  /** The `initialize` response, which is also the model catalogue. */
  private initialization?: Record<string, unknown>
  /** Per-turn choices the CLI already runs, so a repeat turn costs no round trip. */
  private mode?: string
  private model?: string
  private effort?: string
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
      // Pre-authorises the dangerous mode so a turn may switch into it later;
      // it does not enable it by itself.
      '--allow-dangerously-skip-permissions',
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
    this.initialization = response
    const reported = optionalString(response.session_id)
    if (reported !== undefined && reported !== this.nativeId)
      throw new BridgeError('BRIDGE_RESUME_MISMATCH', 'Claude 返回了不同的会话标识')
  }

  async models(signal?: AbortSignal): Promise<KernelModel[]> {
    // There is no `supported_models` control request: the CLI advertises its
    // catalogue on every `initialize` response (the SDK's supportedModels()
    // reads the same field), so the handshake's copy serves this call.
    const response = this.initialization ?? record(await this.control({ subtype: 'initialize' }, signal))
    if (!Array.isArray(response.models))
      return []
    return response.models.flatMap((value): KernelModel[] => {
      const model = record(value)
      const id = optionalString(model.value)
      if (id === undefined)
        return []
      // A model that takes no reasoning level still lists the ladder; offering
      // it would promise a setting the model ignores.
      const levels = model.supportsEffort === false ? [] : model.supportedEffortLevels
      const efforts = Array.isArray(levels)
        ? levels.flatMap((level) => {
            if (typeof level !== 'string' || level === '')
              return []
            return [{ id: level, label: level }]
          })
        : []
      return [{ id, label: optionalString(model.displayName) ?? id, efforts }]
    })
  }

  async* run(input: TurnInput, signal: AbortSignal): AsyncGenerator<TurnEvent> {
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
      settled: new Set(),
      resultReceived: false,
    }
    this.active = state
    const aborted = (): void => {
      if (!state.resultReceived)
        void this.control({ subtype: 'interrupt' }, undefined, INTERRUPT_TIMEOUT_MS).catch(() => {})
    }
    signal.addEventListener('abort', aborted, { once: true })
    try {
      await this.applyOptions(input)
      this.transport.write({
        type: 'user',
        session_id: this.sessionId,
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

  /** Push the composer's per-turn choices into the session before the turn runs. */
  private async applyOptions(input: TurnInput): Promise<void> {
    const options = input.options
    if (options === undefined)
      return
    // Claude takes each knob as its own control request mid-session; repeating
    // a value it already runs only costs a round trip before every turn.
    const mode = PERMISSION_MODE[options.permission]
    if (mode !== this.mode && await this.send({ subtype: 'set_permission_mode', mode }))
      this.mode = mode
    if (options.model !== undefined && options.model !== this.model && await this.send({ subtype: 'set_model', model: options.model }))
      this.model = options.model
    if (options.effort !== undefined && options.effort !== this.effort && await this.send({ subtype: 'apply_flag_settings', settings: { effortLevel: options.effort } }))
      this.effort = options.effort
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

  /** Send a control request, reporting whether the CLI accepted it. */
  private async send(request: Record<string, unknown>): Promise<boolean> {
    try {
      await this.control(request)
      return true
    }
    catch {
      return false
    }
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
    if (type === 'conversation_reset') {
      // A plan-mode exit clears the CLI's context and it continues under a new
      // session id — named by the frames that follow, not by this frame's
      // `new_conversation_id`. Whatever the old conversation had open is
      // aborted (it will never get a `result`), and the knobs the CLI may have
      // reset are pushed again on the next turn.
      this.resetPending = true
      this.mode = undefined
      this.model = undefined
      this.effort = undefined
      this.active?.finish(new BridgeError('BRIDGE_ABORTED', 'Claude 重置了会话'))
      return
    }
    this.adopt(message)
    const turn = this.active
    if (type === 'result') {
      this.settleResult(turn, message)
      return
    }
    if (turn === undefined)
      return
    // A subagent's frames carry the parent call id: its text and tool calls
    // belong to that tool card, not to the main message being assembled here.
    if (optionalString(message.parent_tool_use_id) !== undefined)
      return
    if (type === 'stream_event')
      this.stream(turn, record(message.event ?? {}))
    else if (type === 'assistant')
      this.assistant(turn, record(message.message ?? {}))
    else if (type === 'user')
      this.toolResults(turn, record(message.message ?? {}))
  }

  /** Continue under the id a reset moved the CLI to. */
  private adopt(message: Record<string, unknown>): void {
    if (!this.resetPending)
      return
    const next = optionalString(message.session_id)
    if (next === undefined || next === this.sessionId)
      return
    this.resetPending = false
    this.sessionId = next
  }

  /**
   * `result` is the turn's only authoritative end: tool results end tools and
   * `message_stop` ends one attempt, but neither ends the turn.
   */
  private settleResult(turn: TurnState | undefined, message: Record<string, unknown>): void {
    const terminal = optionalString(message.terminal_reason)
    const subtype = optionalString(message.subtype)
    const aborted = terminal !== undefined && ABORTED.includes(terminal)
    // A user-interrupted turn is `subtype:'success'` with `aborted_*`: the
    // terminal reason decides first, then "hit a wall", then failure.
    const error = aborted
      ? new BridgeError('BRIDGE_ABORTED', '回合已取消')
      : subtype !== undefined && BLOCKED.includes(subtype)
        ? new BridgeError('BRIDGE_NATIVE_TURN', `Claude 无法继续：${subtype}`)
        : message.is_error === true || subtype !== 'success'
          ? new BridgeError('BRIDGE_NATIVE_TURN', this.resultText(message, subtype))
          : undefined
    if (turn === undefined) {
      if (error !== undefined)
        this.transport.fail(error)
      return
    }
    turn.resultReceived = true
    // Whatever the stream left open closes before the turn does: a message
    // whose `message_stop` was dropped must not outlive its turn.
    this.settleAttempt(turn)
    turn.finish(error)
  }

  /** The most specific thing a failed `result` said. */
  private resultText(message: Record<string, unknown>, subtype: string | undefined): string {
    const errors = Array.isArray(message.errors)
      ? message.errors.filter((line): line is string => typeof line === 'string' && !line.startsWith(EDE_DIAGNOSTIC))
      : []
    return optionalString(message.result) ?? (errors.length > 0 ? errors.join('\n') : subtype ?? 'Claude 回合失败')
  }

  /** Translate one streamed content-block event; this is the typewriter only. */
  private stream(turn: TurnState, event: Record<string, unknown>): void {
    const type = optionalString(event.type)
    if (type === 'message_start') {
      const id = optionalString(record(event.message ?? {}).id)
      if (id !== undefined)
        this.openAttempt(turn, id)
      return
    }
    if (type === 'message_stop') {
      this.settleAttempt(turn)
      return
    }
    if (type !== 'content_block_delta')
      return
    const attempt = turn.attempt
    if (attempt === undefined)
      return
    const delta = record(event.delta ?? {})
    if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text !== '') {
      attempt.streamedText = true
      turn.yieldEvent({ type: 'text', id: attempt.id, delta: delta.text })
    }
    else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking !== '') {
      attempt.streamedThinking = true
      turn.yieldEvent({ type: 'thinking', id: attempt.id, delta: delta.thinking })
    }
    // `input_json_delta` stays unused on purpose: tool arguments are only
    // authoritative once parsed, on the `assistant` frame below.
  }

  /** A whole message: the authoritative content and the tool calls it makes. */
  private assistant(turn: TurnState, message: Record<string, unknown>): void {
    const id = optionalString(message.id)
    if (id === undefined)
      return
    const attempt = this.openAttempt(turn, id)
    if (attempt === undefined) {
      // A late block of a message that already settled: it must not reopen it.
      return
    }
    for (const value of Array.isArray(message.content) ? message.content : []) {
      const block = record(value)
      if (block.type === 'thinking') {
        const text = optionalString(block.thinking)
        if (text !== undefined && !attempt.streamedThinking) {
          attempt.streamedThinking = true
          turn.yieldEvent({ type: 'thinking', id, delta: text })
        }
      }
      else if (block.type === 'text') {
        const text = optionalString(block.text)
        if (text !== undefined && !attempt.streamedText) {
          attempt.streamedText = true
          turn.yieldEvent({ type: 'text', id, delta: text })
        }
      }
      else if (block.type === 'tool_use') {
        const callId = optionalString(block.id)
        const name = optionalString(block.name)
        if (callId === undefined || name === undefined || turn.tools.has(callId))
          continue
        turn.tools.set(callId, { output: '', ended: false })
        turn.yieldEvent({ type: 'tool-start', id: callId, name, input: JSON.stringify(block.input ?? {}) })
      }
    }
    // An aborted response never gets its `message_stop`: it settles here.
    if (message.aborted === true)
      this.settleAttempt(turn)
  }

  /**
   * Close the tools whose results arrived.
   *
   * This does not settle the attempt: the CLI drains finished tool results
   * while the same API message still streams (parallel calls), so a later
   * block of that message — another tool call, more text — still belongs to
   * it. Attempts settle on `message_stop`, a new message id, an abort, or
   * `result`.
   *
   * No `tool-output` event is emitted here or anywhere: the CLI streams no
   * incremental tool output (only `tool_progress` heartbeats carrying elapsed
   * time), so there is nothing honest to put in one.
   */
  private toolResults(turn: TurnState, message: Record<string, unknown>): void {
    if (!Array.isArray(message.content))
      return
    for (const value of message.content) {
      const block = record(value)
      if (block.type !== 'tool_result')
        continue
      const id = optionalString(block.tool_use_id)
      if (id === undefined)
        continue
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

  /** Open an attempt for a message id, settling the one it replaces. */
  private openAttempt(turn: TurnState, id: string): Attempt | undefined {
    if (turn.attempt?.id === id)
      return turn.attempt
    if (turn.settled.has(id))
      return undefined
    this.settleAttempt(turn)
    turn.attempt = { id, streamedText: false, streamedThinking: false }
    return turn.attempt
  }

  private settleAttempt(turn: TurnState): void {
    const attempt = turn.attempt
    if (attempt === undefined)
      return
    turn.attempt = undefined
    turn.settled.add(attempt.id)
    if (turn.settled.size > MAX_SETTLED_ATTEMPTS)
      turn.settled.delete(turn.settled.values().next().value!)
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
