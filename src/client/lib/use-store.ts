import type { KernelId, KernelState, ThirdPartyKernelId } from '../../shared/protocol'
/**
 * React binding for the kernel store.
 *
 * `useSyncExternalStore` needs a stable snapshot; the store replaces its object
 * on every mutation, so identity comparison is enough and components only
 * re-render for the data they actually read.
 */
import type { KernelAppState, Thread } from './store'
import { useSyncExternalStore } from 'react'
import { store } from './store'

export function useKernelState(): KernelAppState {
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
}

/** Detection row for one kernel, or undefined before the first probe lands. */
export function useKernelStateRow(id: KernelId): KernelState | undefined {
  const state = useKernelState()
  return state.kernels.find(row => row.id === id)
}

/** Threads and active key for one third-party kernel. */
export function useKernelThreads(kernel: ThirdPartyKernelId): { threads: readonly Thread[], activeKey: string | null, thread: Thread | null } {
  const state = useKernelState()
  return {
    threads: state.threads[kernel],
    activeKey: state.active[kernel],
    thread: state.threads[kernel].find(thread => thread.key === state.active[kernel]) ?? null,
  }
}
