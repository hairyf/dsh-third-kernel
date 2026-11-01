import type { BackendDetection } from '../../../shared/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

const state = createSnapshotStore({
  backends: [] as BackendDetection[],
  selected: undefined as 'dsh' | 'codex' | 'claude' | undefined,
  phase: 'idle' as 'idle' | 'loading' | 'ready' | 'error',
  error: null as string | null,
})

export const kernelStore = {
  getSnapshot: () => state.getSnapshot(),
  subscribe: (listener: () => void) => state.subscribe(listener),
  patch(patch: Partial<ReturnType<typeof state.getSnapshot>>): void {
    state.update((draft) => {
      Object.assign(draft, patch)
    })
  },
}
