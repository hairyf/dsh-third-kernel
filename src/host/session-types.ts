/**
 * A kernel session is one chat thread: it owns the child process, turns
 * submissions into protocol frames, and translates native notifications into the
 * flattened events the browser UI renders.
 */
import type { KernelQuestion, TurnEvent } from '../shared/protocol'
import type { JsonLinesProcess } from './transport'

/** What the UI must answer to let a blocked native turn continue. */
export interface PendingApproval {
  id: string
  kind: 'command' | 'file' | 'tool'
  title: string
  details: string
}

/** One submitted user turn. */
export interface TurnInput {
  text: string
}

/**
 * Session surface the HTTP layer drives. Both kernels implement it so the
 * browser half is kernel-agnostic.
 */
export interface KernelSession {
  readonly id: string
  /** Complete the native handshake before the session accepts a turn. */
  open: (signal: AbortSignal) => Promise<void>
  /** Model ids the kernel advertises, for the composer's model row. */
  models: (signal?: AbortSignal) => Promise<string[]>
  /**
   * Run one turn and stream its events. The generator ends after a terminal
   * `done` or `error`; aborting the signal interrupts the native turn.
   */
  run: (input: TurnInput, signal: AbortSignal) => AsyncGenerator<TurnEvent>
  /** Settle an approval or question the stream is waiting on. */
  answer: (id: string, value: ApprovalAnswer) => void
  /** Ask the native kernel to stop the running turn. */
  interrupt: () => Promise<void>
  /** Terminate the child and release every waiter. */
  dispose: () => Promise<void>
}

export type ApprovalAnswer
  = | { kind: 'approval', allowed: boolean }
    | { kind: 'question', answers: Record<string, string | string[]> }

/** Internal shape every answer waiter resolves with. */
export type Waiter
  = | { kind: 'approval', resolve: (allowed: boolean) => void }
    | { kind: 'question', resolve: (answers: Record<string, string | string[]>) => void }

/** Bookkeeping for one in-flight turn shared by a kernel implementation. */
export interface TurnState {
  text: (event: TurnEvent) => void
  error: (message: string) => void
  done: () => void
}

/** Collect a question frame's questions into the shared shape. */
export function questionsOf(value: unknown): KernelQuestion[] {
  if (!Array.isArray(value) || value.length === 0)
    return []
  return value.map((raw, index) => {
    const question = raw as Record<string, unknown>
    const id = typeof question.id === 'string' && question.id !== '' ? question.id : `q${index}`
    const text = typeof question.question === 'string' && question.question !== '' ? question.question : id
    const options = Array.isArray(question.options)
      ? question.options.flatMap((entry) => {
          const option = entry as Record<string, unknown>
          const label = typeof option.label === 'string' ? option.label : ''
          if (label === '')
            return []
          return [{ label, ...typeof option.description === 'string' ? { description: option.description } : {} }]
        })
      : undefined
    return {
      id,
      question: text,
      ...options === undefined ? {} : { options },
      ...typeof question.multiSelect === 'boolean' ? { multiSelect: question.multiSelect } : {},
    }
  })
}

/**
 * Human-readable approval text: the native reason plus only the fields that
 * identify what is being approved. Protocol plumbing (ids, timestamps, decision
 * menus) is unreadable in a permission prompt.
 */
export function approvalDetails(fallback: string, params: Record<string, unknown>, fields: readonly string[]): string {
  const lines = [typeof params.reason === 'string' && params.reason.trim() !== '' ? params.reason.trim() : fallback]
  for (const field of fields) {
    const value = params[field]
    if (value === undefined || value === null || value === '')
      continue
    lines.push(`${field}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
  }
  return lines.join('\n')
}

/** Terminal-state guard shared by both kernels' failure paths. */
export function failTransport(transport: JsonLinesProcess, error: Error): void {
  transport.fail(error)
}
