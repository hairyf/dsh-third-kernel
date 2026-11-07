/**
 * The core-line gate: `package.json` pins the same line through
 * `peerDependencies`, and the client hides bridge UI below it. These cases
 * pin the comparison rules that make "0.2.2-rc.1 and later 0.2.2 builds" the
 * supported line while every 0.2.1 and earlier prerelease stays out.
 */
import { describe, expect, it } from 'vitest'
import { KERNEL_CORE_BASELINE, kernelVersionAtLeast } from '../src/shared/version'

describe('kernelVersionAtLeast', () => {
  it('targets the pinned core baseline', () => {
    expect(KERNEL_CORE_BASELINE).toBe('0.2.2-rc.1')
  })

  it('accepts the baseline, its later prereleases, and the final release', () => {
    for (const version of ['0.2.2-rc.1', '0.2.2-rc.2', '0.2.2', '0.2.3', '0.3.0'])
      expect(kernelVersionAtLeast(version), version).toBe(true)
  })

  it('rejects every older core line, including earlier 0.2.2 prereleases', () => {
    for (const version of ['0.1.7', '0.2.1-rc.4', '0.2.1-rc.5', '0.2.2-alpha.3'])
      expect(kernelVersionAtLeast(version), version).toBe(false)
  })

  it('reports an unknown verdict instead of guessing when the version is absent', () => {
    expect(kernelVersionAtLeast(undefined)).toBeUndefined()
    expect(kernelVersionAtLeast(null)).toBeUndefined()
    expect(kernelVersionAtLeast('  ')).toBeUndefined()
    expect(kernelVersionAtLeast('not-a-version')).toBeUndefined()
  })
})
