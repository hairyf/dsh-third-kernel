import type { BackendDetection } from '../../../shared/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

const state = createSnapshotStore({
  backends: [] as BackendDetection[],
  selected: undefined as 'dsh' | 'codex' | 'claude' | undefined,
  /** Workspace label the hero headline names ("你想让我们在 X 中构建什么"). */
  workspace: '' as string,
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
