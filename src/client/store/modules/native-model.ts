import type { NativeModelEntry } from '../../types/kernel-model'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

const state = createSnapshotStore({ generation: 0, entries: {} as Record<string, NativeModelEntry | undefined> })

export const nativeModel = {
  getSnapshot: () => state.getSnapshot(),
  subscribe: (listener: () => void) => state.subscribe(listener),
  nextScope(): number {
    state.update((draft) => {
      draft.generation += 1
    })
    return state.getSnapshot().generation
  },
  open(entry: NativeModelEntry): void {
    state.update((draft) => {
      draft.entries[entry.sessionId] = entry
    })
  },
  update(sessionId: string, scope: number, patch: Partial<NativeModelEntry>): void {
    state.update((draft) => {
      const entry = draft.entries[sessionId]
      if (entry?.scope === scope)
        draft.entries[sessionId] = { ...entry, ...patch }
    })
  },
  close(sessionId: string, scope: number): void {
    state.update((draft) => {
      if (draft.entries[sessionId]?.scope === scope)
        delete draft.entries[sessionId]
    })
  },
}
