/**
 * Public API snapshot for the host entry.
 *
 * `pnpm run test` builds before running vitest, so a stale `dist` cannot reach
 * this test. The template's `guardStaleBuild` pre-check is deliberately not used:
 * on the pinned tsdown 0.22 its recorder never writes the hash file it then
 * requires, so it fails every run regardless of build freshness — reproduced on
 * the untouched starter — and it would only re-check the build this test script
 * has already performed.
 */
import { fileURLToPath } from 'node:url'
import { snapshotApiPerEntry } from 'tsnapi/vitest'
import { describe } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

describe('api snapshot', () => {
  snapshotApiPerEntry(root)
})
