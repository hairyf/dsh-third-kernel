/**
 * Per-kernel thread summaries in localStorage.
 *
 * The kernel store lives in memory, so a refresh used to lose every project and
 * thread. This module keeps the only thing a reload can honestly restore: the
 * working directories a kernel has used, plus each thread's title, directory and
 * activity time. The key names the kernel, so Codex never sees Claude's list —
 * that separation is the isolation the switcher promises.
 *
 * The message log is deliberately not persisted. A native session dies with its
 * kernel child, so replaying old turns would be inventing history the kernel
 * cannot back; a restored row is marked `history` and opens a fresh session on
 * the first send.
 */
import type { ThirdPartyKernelId } from '../../shared/protocol'
import { readSafeLocalStorage, writeSafeLocalStorage } from './browserEnvironment'

/** Key prefix; the kernel id is appended, one key per kernel. */
export const STORAGE_PREFIX = 'dsh-third-kernel:workspaces'

/** Bumped when the payload shape changes. An unknown version is ignored, not migrated. */
const STORAGE_VERSION = 1

/** Threads kept per kernel; the rest are older than anyone scrolls back. */
const THREAD_LIMIT = 50

/** What one thread contributes to a reload. */
export interface PersistedThread {
  /** Local key, reused on restore so the active thread survives. */
  key: string
  title: string
  cwd: string
  /** Epoch ms. */
  createdAt: number
  /** Epoch ms of the last turn boundary or rename. */
  updatedAt: number
}

/** One kernel's persisted slice. */
export interface PersistedKernel {
  version: number
  /** Known working directories, most recent first. */
  cwds: string[]
  /** Thread key the user last had open. */
  active: string | null
  /** Newest first. */
  threads: PersistedThread[]
}

/** `dsh-third-kernel:workspaces:<kernel>` */
export function storageKey(kernel: ThirdPartyKernelId): string {
  return `${STORAGE_PREFIX}:${kernel}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * One stored row, or null when it cannot be trusted.
 *
 * localStorage is foreign data: a hand-edited or half-written row must be
 * dropped here rather than crash the first render.
 */
function readThread(value: unknown): PersistedThread | null {
  if (!isRecord(value))
    return null
  const { key, title, cwd, createdAt, updatedAt } = value
  if (typeof key !== 'string' || key === '')
    return null
  if (typeof title !== 'string' || typeof cwd !== 'string')
    return null
  if (typeof createdAt !== 'number' || typeof updatedAt !== 'number')
    return null
  return { key, title, cwd, createdAt, updatedAt }
}

/** Read one kernel's slice; null when nothing usable is stored. */
export function readKernelSnapshot(kernel: ThirdPartyKernelId): PersistedKernel | null {
  const raw = readSafeLocalStorage(storageKey(kernel))
  if (raw === null)
    return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    return null
  }
  if (!isRecord(parsed) || parsed.version !== STORAGE_VERSION)
    return null
  const threads = Array.isArray(parsed.threads)
    ? parsed.threads.map(readThread).filter((row): row is PersistedThread => row !== null)
    : []
  if (threads.length === 0)
    return null
  const cwds = Array.isArray(parsed.cwds)
    ? parsed.cwds.filter((cwd): cwd is string => typeof cwd === 'string' && cwd !== '')
    : []
  return {
    version: STORAGE_VERSION,
    cwds,
    active: typeof parsed.active === 'string' ? parsed.active : null,
    threads,
  }
}

/** Write one kernel's slice; a refused write (private mode, quota) is not fatal. */
export function writeKernelSnapshot(kernel: ThirdPartyKernelId, snapshot: Omit<PersistedKernel, 'version'>): void {
  writeSafeLocalStorage(storageKey(kernel), JSON.stringify({
    version: STORAGE_VERSION,
    cwds: snapshot.cwds,
    active: snapshot.active,
    threads: snapshot.threads.slice(0, THREAD_LIMIT),
  } satisfies PersistedKernel))
}
