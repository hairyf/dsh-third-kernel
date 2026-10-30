/**
 * Codex kernel over `codex app-server`.
 *
 * The protocol is JSON-RPC over stdio: `initialize` → `initialized`, then
 * `thread/*` for the conversation and `turn/*` for one exchange. Notifications
 * carry deltas and item lifecycles; approvals and user input arrive as
 * server-to-client requests. Verified against codex-cli 0.162.1.
 */
import type { TurnEvent } from '../shared/protocol'
import type { KernelCommand } from './detect'
import type { ApprovalAnswer, KernelSession, Waiter } from './session-types'
import type { PendingRequests } from './transport'
import { nativeEnvironment } from './detect'
import { approvalDetails, questionsOf } from './session-types'
import { BridgeError, errorFrom, INTERRUPT_TIMEOUT_MS, JsonLinesProcess, optionalString, record, PendingRequests as Requests, stringField } from './transport'

const INITIALIZATION = {
  clientInfo: { name: 'dsh-third-kernel', title: 'DSH third-party kernel', version: '0.1.0' },
  capabilities: { experimentalApi: true },
}

const EFFORT_NAMES = new Map([
  ['none', 'Off'],
  ['minimal', 'Minimal'],
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
  ['xhigh', 'Extra High'],
  ['max', 'Max'],
])

interface TurnState {
  yieldEvent: (event: TurnEvent) => void
  finish: (error?: Error) => void
  tools: Map<string, { output: string, ended: boolean }>
  assistants: Set<string>
  text: Map<string, string>
  thinking: Map<string, string>
  track: Map<string, string>
  interrupted: boolean
}

export class CodexSession implements KernelSession {
  private readonly transport: JsonLinesProcess
  private readonly requests: PendingRequests
  private readonly waiters = new Map<string, Waiter>()
  private readonly approvals = new Map<string | number, AbortController>()
  private readonly commandItems = new Set<string>()
  private requestId = 0
  private nativeId = ''
  private active?: TurnState
  private failure?: Error
  private disposed = false
  private disposePromise?: Promise<void>

  constructor(
    executable: KernelCommand,
    cwd: string,
    private readonly resolveCwd: () => string,
  ) {
    this.transport = new JsonLinesProcess(executable, ['app-server', '--listen', 'stdio://'], cwd, nativeEnvironment())
    this.requests = new Requests(value => this.transport.write(value))
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

  /** Complete the handshake and open the native thread this session owns. */
  async open(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const response = record(await this.request('initialize', INITIALIZATION, signal))
    if (typeof response.userAgent !== 'string')
      throw new BridgeError('BRIDGE_PROTOCOL', 'Codex 未在初始化时表明身份')
    this.transport.write({ method: 'initialized', params: {} })
    const thread = record(await this.request('thread/start', { cwd: this.resolveCwd() }, signal))
    this.nativeId = stringField(record(thread.thread), 'id')
  }

  async models(signal?: AbortSignal): Promise<string[]> {
    const response = record(await this.request('model/list', { limit: 100, includeHidden: false }, signal))
    if (!Array.isArray(response.data))
      return []
    return response.data.flatMap((value) => {
      const model = value as Record<string, unknown>
      const id = optionalString(model.model) ?? optionalString(model.id)
      if (id === undefined)
        return []
      const efforts = Array.isArray(model.supportedReasoningEfforts)
        ? model.supportedReasoningEfforts.flatMap((entry) => {
            const label = (entry as Record<string, unknown>).reasoningEffort
            if (typeof label !== 'string' || label === '')
              return []
            return [EFFORT_NAMES.get(label) ?? label]
          })
        : []
      return [efforts.length === 0 ? id : `${id} · ${efforts.join('/')}`]
    })
  }

  async* run(input: { text: string }, signal: AbortSignal): AsyncGenerator<TurnEvent> {
    if (this.disposed || this.failure)
      throw this.failure ?? new BridgeError('BRIDGE_PROCESS_CLOSED', 'Codex 会话已关闭')
    if (this.active !== undefined)
      throw new BridgeError('BRIDGE_BUSY', 'Codex 会话已有正在进行的回合')
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
      assistants: new Set(),
      text: new Map(),
      thinking: new Map(),
      track: new Map(),
      interrupted: false,
    }
    this.active = state
    const aborted = (): void => {
      state.interrupted = true
      if (this.activeTurnId !== undefined && !this.interruptSent) {
        this.interruptSent = true
        void this.request('turn/interrupt', { threadId: this.nativeId, turnId: this.activeTurnId }, undefined, INTERRUPT_TIMEOUT_MS).catch(() => {})
      }
    }
    signal.addEventListener('abort', aborted, { once: true })
    try {
      const response = record(await this.request('turn/start', {
        threadId: this.nativeId,
        input: [{ type: 'text', text: input.text, text_elements: [] }],
      }, signal))
      this.activeTurnId = stringField(record(response.turn), 'id')
      if (signal.aborted)
        aborted()
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
      this.activeTurnId = undefined
      this.interruptSent = false
      this.approvals.clear()
      if (this.active === state)
        this.active = undefined
    }
  }

  private activeTurnId?: string
  private interruptSent = false

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
    if (this.activeTurnId === undefined)
      return
    await this.request('turn/interrupt', { threadId: this.nativeId, turnId: this.activeTurnId }, undefined, INTERRUPT_TIMEOUT_MS).catch(() => {})
  }

  dispose(): Promise<void> {
    this.disposePromise ??= this.close()
    return this.disposePromise
  }

  private async close(): Promise<void> {
    this.disposed = true
    const error = new BridgeError('BRIDGE_PROCESS_CLOSED', 'Codex 会话已关闭')
    this.requests.failAll(error)
    this.waiters.clear()
    this.approvals.clear()
    this.active?.finish(error)
    try {
      await this.transport.close(this.active === undefined)
    }
    catch {
      // Termination is best effort: a stuck child must not fail teardown.
    }
  }

  private request(method: string, params: unknown, signal?: AbortSignal, timeoutMs?: number): Promise<unknown> {
    const id = ++this.requestId
    return this.requests.request(id, { id, method, params }, signal, timeoutMs)
  }

  private receive(message: Record<string, unknown>): void {
    const id = message.id
    const method = optionalString(message.method)
    if (typeof id === 'number' || typeof id === 'string') {
      if (method === undefined) {
        const error = message.error === undefined ? undefined : record(message.error)
        this.requests.settle(
          id,
          message.result,
          error === undefined ? undefined : new BridgeError('BRIDGE_NATIVE_REQUEST', optionalString(error.message) ?? JSON.stringify(error)),
        )
        return
      }
      void this.handleRequest(id, method, record(message.params ?? {})).catch((error: unknown) => {
        this.transport.write({ id, error: { code: -32603, message: errorFrom(error).message } })
      })
      return
    }
    if (method === undefined)
      return
    this.notify(method, record(message.params ?? {}))
  }

  /** Answer a server-to-client request: approvals and user-input prompts. */
  private async handleRequest(id: string | number, method: string, params: Record<string, unknown>): Promise<void> {
    const turn = this.active
    const turnId = optionalString(params.turnId)
    const belongs = turn !== undefined
      && params.threadId === this.nativeId
      && (turnId === undefined || turnId === this.activeTurnId)
      && !this.waiters.has(String(id))
    const key = String(id)
    try {
      if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
        const command = method === 'item/commandExecution/requestApproval'
        if (!belongs) {
          this.transport.write({ id, result: { decision: 'decline' } })
          return
        }
        turn.yieldEvent({
          type: 'approval',
          id: key,
          kind: command ? 'command' : 'file',
          title: command && typeof params.command === 'string' ? params.command : command ? 'Codex 命令执行' : 'Codex 文件变更',
          details: approvalDetails(command ? 'Codex 需要执行命令' : 'Codex 需要修改文件', params, command ? ['command', 'cwd'] : ['grantRoot']),
        })
        const allowed = await new Promise<boolean>((resolve) => {
          this.waiters.set(key, { kind: 'approval', resolve })
        })
        const decisions = params.availableDecisions
        const once = !Array.isArray(decisions) || decisions.includes('accept')
        this.transport.write({ id, result: { decision: once ? (allowed ? 'accept' : 'decline') : 'cancel' } })
        return
      }
      if (method === 'item/permissions/requestApproval') {
        if (!belongs) {
          this.transport.write({ id, result: { permissions: {}, scope: 'turn' } })
          return
        }
        turn.yieldEvent({
          type: 'approval',
          id: key,
          kind: 'tool',
          title: 'Codex 请求额外权限',
          details: approvalDetails('Codex 请求额外权限', params, ['permissions']),
        })
        const allowed = await new Promise<boolean>((resolve) => {
          this.waiters.set(key, { kind: 'approval', resolve })
        })
        this.transport.write({ id, result: { permissions: allowed ? record(params.permissions ?? {}) : {}, scope: 'turn' } })
        return
      }
      if (method === 'item/tool/requestUserInput') {
        if (!belongs) {
          this.transport.write({ id, error: { code: -32601, message: '没有对应的进行中回合' } })
          return
        }
        const questions = questionsOf(params.questions)
        turn.yieldEvent({ type: 'question', id: key, questions })
        const answers = await new Promise<Record<string, string | string[]>>((resolve) => {
          this.waiters.set(key, { kind: 'question', resolve })
        })
        this.transport.write({
          id,
          result: {
            answers: Object.fromEntries(questions.map(question => [question.id, { answers: Array.isArray(answers[question.id]) ? answers[question.id] : [answers[question.id] ?? ''] }])),
          },
        })
        return
      }
      // In particular `item/tool/call` is not an invitation to run DSH tools.
      this.transport.write({ id, error: { code: -32601, message: `不支持的内核请求：${method}` } })
    }
    finally {
      this.approvals.delete(id)
    }
  }

  private notify(method: string, params: Record<string, unknown>): void {
    const turn = this.active
    if (turn === undefined || params.threadId !== this.nativeId)
      return
    const nativeTurn = method === 'turn/started' || method === 'turn/completed' ? record(params.turn ?? {}) : undefined
    const turnId = nativeTurn?.id ?? params.turnId
    if (typeof turnId === 'string') {
      if (turnId !== this.activeTurnId && this.activeTurnId !== undefined)
        return
      this.activeTurnId ??= turnId
    }
    switch (method) {
      case 'turn/started':
        return
      case 'turn/completed': {
        const completed = nativeTurn ?? {}
        if (Array.isArray(completed.items)) {
          for (const value of completed.items) {
            const item = record(value)
            const tool = turn.tools.get(String(item.id))
            if (tool !== undefined && !tool.ended && (item.status === 'completed' || item.status === 'failed' || item.status === 'declined'))
              this.item(turn, item, true)
          }
        }
        const status = optionalString(completed.status) ?? 'completed'
        if (status === 'interrupted' && !turn.interrupted)
          turn.finish(new BridgeError('BRIDGE_NATIVE_INTERRUPTED', 'Codex 中断了该回合'))
        else if (status !== 'completed' && status !== 'interrupted')
          turn.finish(new BridgeError('BRIDGE_NATIVE_TURN', `Codex 回合以 ${status} 结束`))
        else
          turn.finish(turn.interrupted ? new BridgeError('BRIDGE_ABORTED', '回合已取消') : undefined)
        return
      }
      case 'error':
        if (params.willRetry !== true)
          turn.finish(new BridgeError('BRIDGE_NATIVE_TURN', optionalString(record(params.error ?? {}).message) ?? JSON.stringify(params.error ?? params)))
        return
      case 'item/agentMessage/delta':
      case 'item/plan/delta': {
        const id = stringField(params, 'itemId')
        const delta = stringField(params, 'delta')
        turn.text.set(id, (turn.text.get(id) ?? '') + delta)
        turn.yieldEvent({ type: 'text', id, delta })
        return
      }
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        const id = stringField(params, 'itemId')
        const delta = stringField(params, 'delta')
        const name = `${id}:${method === 'item/reasoning/textDelta' ? 'raw' : 'summary'}`
        turn.thinking.set(name, (turn.thinking.get(name) ?? '') + delta)
        if (!turn.track.has(id))
          turn.track.set(id, name)
        if (turn.track.get(id) === name)
          turn.yieldEvent({ type: 'thinking', id, delta })
        return
      }
      case 'item/commandExecution/outputDelta':
      case 'item/fileChange/outputDelta': {
        const tool = turn.tools.get(stringField(params, 'itemId'))
        if (tool !== undefined) {
          const delta = optionalString(params.delta) ?? ''
          tool.output += delta
          if (delta !== '')
            turn.yieldEvent({ type: 'tool-output', id: stringField(params, 'itemId'), delta })
        }
        return
      }
      case 'item/started':
      case 'item/completed':
        this.item(turn, record(params.item ?? {}), method === 'item/completed')
    }
  }

  /** Project one native item into assistant text / thinking / tool events. */
  private item(turn: TurnState, item: Record<string, unknown>, completed: boolean): void {
    const id = stringField(item, 'id')
    const type = stringField(item, 'type')
    if (type === 'commandExecution')
      this.commandItems.add(id)
    const tool = nativeTool(item)
    if (tool !== undefined) {
      if (!turn.tools.has(id)) {
        turn.tools.set(id, { output: '', ended: false })
        turn.yieldEvent({ type: 'tool-start', id, name: tool.name, input: tool.input })
      }
      const state = turn.tools.get(id)!
      if (completed && !state.ended) {
        state.ended = true
        const output = optionalString(item.aggregatedOutput)
          ?? (state.output !== '' ? state.output : JSON.stringify(item.result ?? item.contentItems ?? item.changes ?? item.error ?? item))
        const error = item.status === 'failed'
          || item.status === 'declined'
          || (item.error !== undefined && item.error !== null)
          || item.success === false
          || (typeof item.exitCode === 'number' && item.exitCode !== 0)
        turn.yieldEvent({ type: 'tool-end', id, output, error })
      }
      return
    }
    if (!completed || turn.assistants.has(id))
      return
    // Deltas for this item already reached the UI; the completed item carries the
    // same text again, so emitting it would double the answer.
    if (type === 'agentMessage' || type === 'plan') {
      turn.assistants.add(id)
      if (turn.text.has(id))
        return
      const full = optionalString(item.text) ?? ''
      if (full !== '')
        turn.yieldEvent({ type: 'text', id, delta: full })
      return
    }
    let text = ''
    if (type === 'reasoning') {
      text = arrayText(item.summary) || turn.thinking.get(`${id}:summary`) || arrayText(item.content) || turn.thinking.get(`${id}:raw`) || ''
      // Same rule for reasoning: a streamed track is authoritative.
      if (turn.thinking.has(`${id}:summary`) || turn.thinking.has(`${id}:raw`))
        text = ''
    }
    else if (type === 'enteredReviewMode' || type === 'exitedReviewMode') {
      text = optionalString(item.review) ?? ''
    }
    else if (type === 'userMessage' || type === 'hookPrompt' || type === 'contextCompaction' || type === 'subAgentActivity') {
      return
    }
    else {
      text = JSON.stringify(item)
    }
    turn.assistants.add(id)
    if (text !== '')
      turn.yieldEvent({ type: 'text', id: `${id}:final`, delta: text })
  }
}

/** Join a native array of text parts, ignoring any non-string entry. */
function arrayText(value: unknown): string {
  return Array.isArray(value) ? value.filter((part): part is string => typeof part === 'string').join('\n') : ''
}

/** Human-readable tool identity for one native item, or undefined when it is not a tool. */
function nativeTool(item: Record<string, unknown>): { name: string, input: string } | undefined {
  switch (item.type) {
    case 'commandExecution':
      return { name: 'command', input: JSON.stringify({ command: item.command, cwd: item.cwd }) }
    case 'fileChange':
      return { name: 'fileChange', input: JSON.stringify({ changes: item.changes }) }
    case 'mcpToolCall':
      return { name: `mcp::${String(item.server)}/${String(item.tool)}`, input: JSON.stringify(item.arguments ?? {}) }
    case 'dynamicToolCall':
      return { name: String(item.tool), input: JSON.stringify(item.arguments ?? {}) }
    case 'collabAgentToolCall':
      return { name: `agent::${String(item.tool)}`, input: JSON.stringify({ prompt: item.prompt, model: item.model }) }
    case 'webSearch':
    case 'imageView':
    case 'imageGeneration':
    case 'sleep': {
      const { id: _id, type, ...rest } = item
      return { name: String(type), input: JSON.stringify(rest) }
    }
    default:
      return undefined
  }
}
