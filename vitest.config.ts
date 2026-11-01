import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // source/ holds the read-only reference checkouts (git submodules that ship
    // their own suites and their own environment dependencies); only tests that
    // belong to this package are ours to run.
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
  },
})
