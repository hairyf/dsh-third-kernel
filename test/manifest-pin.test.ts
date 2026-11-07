/**
 * The published manifest is the version pin DSH enforces before any Cordis
 * plugin loads: an own `engines.dsh` range decides alone, otherwise every
 * `@deepseek-ai/dsh*` peer must match the running core. This asserts the
 * shipped `package.json` declares that line and no longer claims older cores.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { KERNEL_CORE_BASELINE } from '../src/shared/version'

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
  engines?: Record<string, string>
  peerDependencies?: Record<string, string>
}

describe('published manifest', () => {
  it('pins the supported core line through peerDependencies', () => {
    const peers = manifest.peerDependencies ?? {}
    expect(peers['@deepseek-ai/cordis']).toBe('^4.1.0')
    const core = Object.entries(peers).filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
    expect(core.length).toBeGreaterThan(0)
    for (const [name, range] of core)
      expect(range, name).toBe(`^${KERNEL_CORE_BASELINE}`)
  })

  it('declares no engines.dsh range that would silently win over the peers', () => {
    expect(manifest.engines?.dsh).toBeUndefined()
  })
})
