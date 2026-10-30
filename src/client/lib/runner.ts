/**
 * Turn orchestration: the only place that talks to the kernel API.
 *
 * Components call `startTurn` / `answerPrompt`, and this module owns the
 * lifecycle — lazily opening a native session, mapping stream events onto store
 * items, and releasing the session when the thread is closed.
 */
import type { ThirdPartyKernelId, TurnEvent } from '../../shared/protocol'
import type { Thread, ThreadItem } from './store'
import { answer, closeSession, interrupt, openSession, runTurn } from './api'
import { itemKey, store } from './store'

/** Controller kept outside React state: one per thread key. */
const controllers = new Map<string, AbortController>()

/**
 * Append a delta to a growing text/thinking item, creating it on first use.
 * Merging by key keeps one item per native stream id.
 */
function appendText(items: readonly ThreadItem[], key: string, role: 'assistant' | 'thinking', delta: string): ThreadItem[] {
  const index = items.findIndex(item => item.key === key)
  if (index < 0)
    return [...items, { key, role, text: delta }]
  const existing = items[index]
  if (existing.role !== role)
    return [...items, { key: `${key}:${role}`, role, text: delta }]
  const next = [...items]
  next[index] = { ...existing, text: existing.text + delta }
  return next
}

function textOf(items: readonly ThreadItem[], key: string): string {
  const item = items.find(entry => entry.key === key)
  return item !== undefined && 'text' in item ? item.text : ''
}

/**
 * Append a stream event to the thread.
 * Text and thinking deltas merge into one growing item per native id so a
 * character-by-character stream does not create thousands of rows.
 */
function apply(thread: Thread, event: TurnEvent): Thread {
  switch (event.type) {
    case 'text': {
      const key = `text:${event.id}`
      return {
        ...thread,
        items: appendText(thread.items, key, 'assistant', event.delta),
      }
    }
    case 'thinking': {
      const key = `thinking:${event.id}`
      return {
        ...thread,
        items: appendText(thread.items, key, 'thinking', event.delta),
      }
    }
    case 'tool-start':
      return {
        ...thread,
        items: [...thread.items, { key: `tool:${event.id}`, role: 'tool', name: event.name, input: event.input, output: '', error: false, done: false }],
      }
    case 'tool-output': {
      const key = `tool:${event.id}`
      return {
        ...thread,
        items: thread.items.map(item => item.key === key && item.role === 'tool' ? { ...item, output: item.output + event.delta } : item),
      }
    }
    case 'tool-end': {
      const key = `tool:${event.id}`
      return {
        ...thread,
        items: thread.items.map(item => item.key === key && item.role === 'tool'
          ? { ...item, output: item.output === '' ? event.output : item.output, error: event.error, done: true }
          : item),
      }
    }
    case 'approval':
      return { ...thread, pending: { kind: 'approval', id: event.id, title: event.title, details: event.details } }
    case 'question':
      return { ...thread, pending: { kind: 'question', id: event.id, questions: event.questions } }
    case 'error':
      return { ...thread, items: [...thread.items, { key: itemKey('error'), role: 'error', text: event.message }] }
    case 'done':
      return thread
    default:
      return thread
  }
}

/** Ensure the thread has a live native session, opening one on first use. */
async function ensureSession(kernel: ThirdPartyKernelId, thread: Thread): Promise<string> {
  if (thread.sessionId !== null)
    return thread.sessionId
  const opened = await openSession(kernel, thread.cwd || store.snapshot().cwd)
  store.patchThread(kernel, thread.key, current => ({ ...current, sessionId: opened.id, models: opened.models, cwd: opened.cwd }))
  return opened.id
}

/**
 * Submit one user turn and stream it into the thread.
 * Resolves when the native turn ends; a second call while running is refused by
 * the kernel, so the composer disables itself.
 */
export async function startTurn(kernel: ThirdPartyKernelId, key: string, text: string): Promise<void> {
  const thread = store.snapshot().threads[kernel].find(entry => entry.key === key)
  if (thread === undefined || thread.running)
    return
  const userItem: ThreadItem = { key: itemKey('user'), role: 'user', text }
  store.patchThread(kernel, key, current => ({
    ...current,
    running: true,
    pending: null,
    title: current.title === '' ? text.slice(0, 60) : current.title,
    items: [...current.items, userItem],
  }))
  const controller = new AbortController()
  controllers.set(key, controller)
  try {
    const sessionId = await ensureSession(kernel, thread)
    for await (const event of runTurn(sessionId, text, controller.signal)) {
      store.patchThread(kernel, key, current => apply(current, event))
      if (event.type === 'done')
        break
    }
  }
  catch (error) {
    if (!controller.signal.aborted) {
      const message = error instanceof Error ? error.message : String(error)
      store.patchThread(kernel, key, current => apply(current, { type: 'error', message }))
    }
  }
  finally {
    controllers.delete(key)
    store.patchThread(kernel, key, current => ({ ...current, running: false, pending: null }))
  }
}

/** Settle the thread's pending approval or question. */
export async function answerPrompt(kernel: ThirdPartyKernelId, key: string, value: { allowed: boolean } | { answers: Record<string, string | string[]> }): Promise<void> {
  const thread = store.snapshot().threads[kernel].find(entry => entry.key === key)
  if (thread?.sessionId === null || thread === undefined || thread.pending === null)
    return
  const pending = thread.pending
  store.patchThread(kernel, key, current => ({ ...current, pending: null }))
  await answer(thread.sessionId, pending.id, value).catch(() => {})
}

/** Stop the running turn, locally and natively. */
export async function stopTurn(kernel: ThirdPartyKernelId, key: string): Promise<void> {
  const thread = store.snapshot().threads[kernel].find(entry => entry.key === key)
  controllers.get(key)?.abort()
  controllers.delete(key)
  if (thread?.sessionId !== null && thread !== undefined)
    await interrupt(thread.sessionId).catch(() => {})
  store.patchThread(kernel, key, current => ({ ...current, running: false, pending: null }))
}

/** Drop one thread and release its kernel child. */
export async function closeThread(kernel: ThirdPartyKernelId, key: string): Promise<void> {
  controllers.get(key)?.abort()
  controllers.delete(key)
  const thread = store.snapshot().threads[kernel].find(entry => entry.key === key)
  store.removeThread(kernel, key)
  if (thread?.sessionId !== null && thread !== undefined)
    await closeSession(thread.sessionId)
}

/** Text already accumulated for one item, used by the renderer's copy action. */
export { textOf }
