import type { BackendDetection } from '../../shared/types'
import { kernelVersionAtLeast } from '../../shared/version'

export { KERNEL_CORE_BASELINE, kernelVersionAtLeast } from '../../shared/version'

/**
 * Whether bridge content may render. A known core version decides; without one
 * (the projection has not reported yet) the answer follows a usable kernel.
 */
export function kernelContentAvailable(backends: readonly BackendDetection[]): boolean {
  const verdict = kernelVersionAtLeast(backends.find(backend => backend.id === 'dsh')?.version)
  if (verdict !== undefined)
    return verdict
  return backends.some(backend => backend.id !== 'dsh' && backend.bridgeReady !== false)
}
