import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { useSyncExternalStore } from 'react'

export function useStore<S>(store: ObservableSnapshot<S>): S {
  return useSyncExternalStore(
    listener => store.subscribe(listener),
    () => store.getSnapshot(),
    () => store.getSnapshot(),
  )
}
