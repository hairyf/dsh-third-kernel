/**
 * Browser state for the kernel switcher.
 *
 * One tiny external store: components subscribe through
 * `useSyncExternalStore`, and every mutation replaces the snapshot so React can
 * compare by identity. Threads live here rather than in the official Session
 * store on purpose — a native kernel conversation is not an official session.
 */
import type { KernelId, KernelModel, KernelState, ThirdPartyKernelId, TurnOptions } from '../../shared/protocol'
import type { PersistedThread } from '../lib/threadPersistence'
import { readKernelSnapshot, writeKernelSnapshot } from '../lib/threadPersistence'
import { normalizeOptions } from '../lib/turn-options'

/** The kernels this store keeps threads for. */
const KERNELS: ThirdPartyKernelId[] = ['codex', 'claude']

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
  /** Models the kernel advertised, with the reasoning levels each accepts. */
  models: KernelModel[]
  /** Composer knobs this thread sends with every turn. */
  options: TurnOptions
  /** Whether a turn is currently streaming. */
  running: boolean
  /** Pending approval or question that blocks the native turn. */
  pending: PendingPrompt | null
  /**
   * Restored from localStorage after a reload.
   *
   * The native session died with the previous page, so such a thread has no
   * `sessionId` and the first send opens a fresh one. The surface must say
   * "history" instead of pretending the old conversation is still live.
   */
  history: boolean
  /** Epoch ms, stamped by the store. */
  createdAt: number
  /** Epoch ms of the last turn boundary; orders the restored list. */
  updatedAt: number
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
  /** Composer knobs new threads start from. */
  options: TurnOptions
  /**
   * Each kernel's model catalogue, fetched once from a probe session.
   *
   * A thread only learns its models when its own native session opens, so the
   * composer would show an empty picker until the first send. This is the
   * page-level copy the chip falls back to.
   */
  modelCatalog: Record<ThirdPartyKernelId, KernelModel[]>
  /**
   * Why a kernel's catalogue could not be read, per kernel.
   *
   * The composer must not pretend: an unreadable catalogue keeps 「选择模型」 and
   * shows this text instead of an empty menu.
   */
  modelErrors: Record<ThirdPartyKernelId, string | null>
  /** Threads per third-party kernel. */
  threads: Record<ThirdPartyKernelId, Thread[]>
  /** Active thread key per kernel. */
  active: Record<ThirdPartyKernelId, string | null>
}

const DEFAULT_OPTIONS: TurnOptions = { permission: 'auto' }

/**
 * A restored thread carries its summary only.
 *
 * No log, no session, no model catalogue: the previous page's native child is
 * gone, so anything more would be invented state.
 */
function restoredThread(row: PersistedThread, options: TurnOptions): Thread {
  return {
    key: row.key,
    sessionId: null,
    title: row.title,
    items: [],
    cwd: row.cwd,
    models: [],
    options: { ...options },
    running: false,
    pending: null,
    history: true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** Rebuild every kernel's list from its own storage key, so kernels stay isolated. */
function restoreThreads(options: TurnOptions): Pick<KernelAppState, 'threads' | 'active'> {
  const threads: Record<ThirdPartyKernelId, Thread[]> = { codex: [], claude: [] }
  const active: Record<ThirdPartyKernelId, string | null> = { codex: null, claude: null }
  for (const kernel of KERNELS) {
    const stored = readKernelSnapshot(kernel)
    if (stored === null)
      continue
    threads[kernel] = stored.threads.map(row => restoredThread(row, options))
    const rows = threads[kernel]
    // A stale active key (thread deleted before the reload) falls back to the
    // newest row rather than leaving the surface on a thread that does not exist.
    active[kernel] = stored.active !== null && rows.some(thread => thread.key === stored.active)
      ? stored.active
      : rows[0]?.key ?? null
  }
  return { threads, active }
}

const restored = restoreThreads(DEFAULT_OPTIONS)

let state: KernelAppState = {
  selected: 'dsh',
  kernels: [],
  detection: 'loading',
  detectionError: null,
  cwd: '',
  options: DEFAULT_OPTIONS,
  modelCatalog: { codex: [], claude: [] },
  modelErrors: { codex: null, claude: null },
  threads: restored.threads,
  active: restored.active,
}

const listeners = new Set<() => void>()

/**
 * Activity is a turn boundary, not a streamed token.
 *
 * `patchThread` runs once per delta; stamping every call would rewrite the
 * whole persisted slice thousands of times per turn. A run starting or ending,
 * or the title being set from the first message, is the honest boundary.
 */
function stampActivity(before: Thread, after: Thread): Thread {
  if (after === before)
    return after
  if (after.running !== before.running || after.title !== before.title)
    return { ...after, updatedAt: Date.now() }
  return after
}

/** Cheap fingerprint of everything a reload restores. */
function persistenceSignature(next: KernelAppState): string {
  return JSON.stringify(KERNELS.map(kernel => [
    kernel,
    next.active[kernel],
    next.threads[kernel].map(thread => [thread.key, thread.cwd, thread.title, thread.createdAt, thread.updatedAt]),
  ]))
}

/** Last slice written, so a streaming publish that changed nothing skips storage. */
let persisted = persistenceSignature(state)

/**
 * Write each kernel's summary under its own key.
 *
 * Known working directories are derived, not stored separately: they are the
 * distinct directories of that kernel's threads, newest activity first.
 */
function persist(next: KernelAppState): void {
  const signature = persistenceSignature(next)
  if (signature === persisted)
    return
  persisted = signature
  for (const kernel of KERNELS) {
    const threads = [...next.threads[kernel]].sort((a, b) => b.updatedAt - a.updatedAt)
    writeKernelSnapshot(kernel, {
      cwds: [...new Set(threads.map(thread => thread.cwd).filter(cwd => cwd !== ''))],
      active: next.active[kernel],
      threads: threads.map(thread => ({
        key: thread.key,
        title: thread.title,
        cwd: thread.cwd,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
      })),
    })
  }
}

function publish(next: KernelAppState): void {
  state = next
  persist(next)
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
        // Only a turn boundary counts as activity. Stamping every publish would
        // rewrite storage once per streamed token.
        [kernel]: state.threads[kernel].map(thread => thread.key === key ? stampActivity(thread, patch(thread)) : thread),
      },
    })
  },
  /**
   * Merge one thread's model/effort/permission choice.
   *
   * The merge is repaired against the same catalogue `useThreadOptions` reads,
   * so switching model cannot leave an effort the new model never advertised.
   */
  setThreadOptions(kernel: ThirdPartyKernelId, key: string, patch: Partial<TurnOptions>): void {
    store.patchThread(kernel, key, (thread) => {
      // A thread learns its models when its own session opens, which is later
      // than the page-level probe; until then the fallback is what the composer
      // already shows, so the merge repairs against the same list it displays.
      const models = thread.models.length > 0 ? thread.models : state.modelCatalog[kernel]
      return { ...thread, options: normalizeOptions(models, { ...thread.options, ...patch }) }
    })
  },
  /** Merge the defaults every new thread inherits. */
  setGlobalOptions(patch: Partial<TurnOptions>): void {
    publish({ ...state, options: { ...state.options, ...patch } })
  },
  /**
   * Record one kernel's model catalogue.
   *
   * Two things land at once: the page-level copy, and the same list on every
   * thread of that kernel — including its default model, so a thread created
   * before the catalogue arrived still shows a model name instead of an empty
   * picker.
   *
   * ponytail: the default model is the head of `model/list`. Neither host
   * adapter reports the kernel's configured default (Codex keeps it in
   * `config/read`, which our adapter does not expose), so pinning the first
   * entry is the smallest thing that keeps the chip label and the model the turn
   * actually runs in agreement. Upgrade path: return a `defaultModel` from
   * `/session` and pin that instead.
   */
  setModelCatalog(kernel: ThirdPartyKernelId, models: KernelModel[]): void {
    // An empty list means "not read yet", never "this kernel has none": a stale
    // probe must not blank a catalogue a real session already filled in.
    if (models.length === 0 && state.modelCatalog[kernel].length > 0)
      return
    // No model pinned when the kernel advertised none: the kernel then keeps
    // applying its own default at turn start.
    const fallback = models[0]?.id
    const pin = (options: TurnOptions): TurnOptions =>
      normalizeOptions(models, options.model === undefined && fallback !== undefined ? { ...options, model: fallback } : options)
    publish({
      ...state,
      modelCatalog: { ...state.modelCatalog, [kernel]: models },
      modelErrors: { ...state.modelErrors, [kernel]: null },
      options: pin(state.options),
      threads: {
        ...state.threads,
        [kernel]: state.threads[kernel].map(thread => ({ ...thread, models, options: pin(thread.options) })),
      },
    })
  },
  /**
   * Record why one kernel's catalogue is unreadable.
   *
   * Kept separate from the catalogue so the composer can stay on 「选择模型」 and
   * name the host's reason instead of showing a silent empty picker.
   */
  setModelError(kernel: ThirdPartyKernelId, reason: string | null): void {
    publish({ ...state, modelErrors: { ...state.modelErrors, [kernel]: reason } })
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
    for (const kernel of KERNELS) {
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

/** Build a fresh thread rooted at `cwd`, inheriting the global composer options. */
export function newThread(cwd: string, options: TurnOptions = state.options): Thread {
  const now = Date.now()
  return {
    key: threadKey(),
    sessionId: null,
    title: '',
    items: [],
    cwd,
    models: [],
    options: { ...options },
    running: false,
    pending: null,
    history: false,
    createdAt: now,
    updatedAt: now,
  }
}

/** Monotonic key for a local thread. */
export function threadKey(): string {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** Monotonic key for a streamed item. */
export function itemKey(prefix: string): string {
  return `${prefix}:${Math.random().toString(36).slice(2, 10)}`
}
