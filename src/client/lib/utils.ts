import type { NativeTurnOptions } from '../../shared/native-model'
import type { KernelBinding } from '../../shared/types'

export function noop(): void {}

export function sameTurnOptions(a: NativeTurnOptions, b: NativeTurnOptions): boolean {
  return a.model === b.model && a.reasoningEffort === b.reasoningEffort
}

export function sameKernelBinding(a: unknown, b: KernelBinding): boolean {
  if (a === null || typeof a !== 'object')
    return false
  const value = a as Partial<KernelBinding>
  return value.backend === b.backend && value.sessionId === b.sessionId && value.nativeSessionId === b.nativeSessionId
}
