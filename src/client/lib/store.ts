/**
 * Browser state for the kernel switcher.
 *
 * One tiny external store: components subscribe through
 * `useSyncExternalStore`, and every mutation replaces the snapshot so React can
 * compare by identity. Threads live here rather than in the official Session
 * store on purpose — a native kernel conversation is not an official session.
 */
import type { KernelId, KernelState, ThirdPartyKernelId } from '../../shared/protocol'

/** One rendered conversation item. */
export type ThreadItem
  = | { key: string, role: 'user', text: string }
    | { key: string, role: 'assistant', text: string }
    | { key: string, role: 'thinking', text: string }
    | { key: string, role: 'tool', name: string, input: string, output: string, error: boolean, done: boolean }
    | { key: string, role: 'error', text: string }

/** One kernel conversation kept in the page. */
export interface Thread {
  /** Local key; survives a kernel restart. */
  key: string
  /** Native session id, absent until the kernel child is up. */
  sessionId: string | null
  title: string
  items: ThreadItem[]
  /** Working directory this thread runs in. */
  cwd: string
  /** Model ids the kernel advertised. */
  models: string[]
  /** Whether a turn is currently streaming. */
  running: boolean
  /** Pending approval or question that blocks the native turn. */
  pending: PendingPrompt | null
}

export type PendingPrompt
  = | { kind: 'approval', id: string, title: string, details: string }
    | { kind: 'question', id: string, questions: { id: string, question: string, options?: { label: string, description?: string }[], multiSelect?: boolean }[] }

export interface KernelAppState {
  selected: KernelId
  /** Detection rows from the host, empty until the first probe returns. */
  kernels: KernelState[]
  detection: 'loading' | 'ready' | 'error'
  detectionError: string | null
  /** Working directory the host reports for new sessions. */
  cwd: string
  /** Threads per third-party kernel. */
  threads: Record<ThirdPartyKernelId, Thread[]>
  /** Active thread key per kernel. */
  active: Record<ThirdPartyKernelId, string | null>
}

let state: KernelAppState = {
  selected: 'dsh',
  kernels: [],
  detection: 'loading',
  detectionError: null,
  cwd: '',
  threads: { codex: [], claude: [] },
  active: { codex: null, claude: null },
}

const listeners = new Set<() => void>()

function publish(next: KernelAppState): void {
  state = next
  for (const listener of listeners)
    listener()
}

export const store = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  snapshot(): KernelAppState {
    return state
  },
  select(selected: KernelId): void {
    publish({ ...state, selected })
  },
  setDetection(patch: Partial<Pick<KernelAppState, 'kernels' | 'detection' | 'detectionError' | 'cwd'>>): void {
    publish({ ...state, ...patch })
  },
  patchThread(kernel: ThirdPartyKernelId, key: string, patch: (thread: Thread) => Thread): void {
    publish({
      ...state,
      threads: {
        ...state.threads,
        [kernel]: state.threads[kernel].map(thread => thread.key === key ? patch(thread) : thread),
      },
    })
  },
  addThread(kernel: ThirdPartyKernelId, thread: Thread): void {
    publish({
      ...state,
      threads: { ...state.threads, [kernel]: [thread, ...state.threads[kernel]] },
      active: { ...state.active, [kernel]: thread.key },
    })
  },
  /** Backfill the working directory on threads created before detection answered. */
  adoptCwd(cwd: string): void {
    const threads = { ...state.threads }
    let changed = false
    for (const kernel of ['codex', 'claude'] as ThirdPartyKernelId[]) {
      const next = threads[kernel].map((thread) => {
        if (thread.cwd !== '')
          return thread
        changed = true
        return { ...thread, cwd }
      })
      threads[kernel] = next
    }
    if (changed)
      publish({ ...state, threads })
  },
  setActive(kernel: ThirdPartyKernelId, key: string | null): void {
    publish({ ...state, active: { ...state.active, [kernel]: key } })
  },
  removeThread(kernel: ThirdPartyKernelId, key: string): void {
    const remaining = state.threads[kernel].filter(thread => thread.key !== key)
    publish({
      ...state,
      threads: { ...state.threads, [kernel]: remaining },
      active: { ...state.active, [kernel]: state.active[kernel] === key ? remaining[0]?.key ?? null : state.active[kernel] },
    })
  },
}

/** Build a fresh thread rooted at . */
export function newThread(cwd: string): Thread {
  return { key: threadKey(), sessionId: null, title: '', items: [], cwd, models: [], running: false, pending: null }
}

/** Monotonic key for a local thread. */
export function threadKey(): string {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** Monotonic key for a streamed item. */
export function itemKey(prefix: string): string {
  return `${prefix}:${Math.random().toString(36).slice(2, 10)}`
}
