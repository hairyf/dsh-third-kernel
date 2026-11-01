/**
 * A reload must not lose the user's projects, and must not leak one kernel's
 * threads into another's list.
 *
 * The store is a module singleton, so a reload is simulated the only honest way:
 * throw away the module registry and import it again against the same storage.
 * Nothing here stubs `localStorage` — a real Map-backed object stands in for it,
 * so the read/write path in `lib/threadPersistence` is the code under test.
 */
import type { ThirdPartyKernelId } from '../src/shared/protocol'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { storageKey } from '../src/client/lib/threadPersistence'

/** The smallest thing a page needs: per-origin key/value strings. */
class MemoryStorage {
  private readonly rows = new Map<string, string>()
  getItem(key: string): string | null {
    return this.rows.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.rows.set(key, value)
  }

  clear(): void {
    this.rows.clear()
  }

  keys(): string[] {
    return [...this.rows.keys()].sort()
  }
}

const storage = new MemoryStorage()

/** A fresh copy of the store, as if the page had just been loaded. */
async function loadStore(): Promise<typeof import('../src/client/store/store')> {
  vi.resetModules()
  return await import('../src/client/store/store')
}

beforeEach(() => {
  storage.clear()
  vi.stubGlobal('localStorage', storage)
})

describe('kernel threads survive a reload', () => {
  it('restores each kernel list from its own key, with no cross-talk', async () => {
    const first = await loadStore()
    const codex = first.newThread('/work/codex-project')
    first.store.addThread('codex', { ...codex, title: 'Codex 里的任务' })
    const claude = first.newThread('/work/claude-project')
    first.store.addThread('claude', { ...claude, title: 'Claude 里的任务' })

    // One key per kernel, and nothing written under the other's name.
    expect(storage.keys()).toEqual([storageKey('claude'), storageKey('codex')])

    const second = await loadStore()
    const state = second.store.snapshot()
    expect(state.threads.codex.map(thread => thread.title)).toEqual(['Codex 里的任务'])
    expect(state.threads.claude.map(thread => thread.title)).toEqual(['Claude 里的任务'])
    expect(state.threads.codex[0].cwd).toBe('/work/codex-project')
    // Restored rows are history: no native session is claimed.
    expect(state.threads.codex[0].history).toBe(true)
    expect(state.threads.codex[0].sessionId).toBeNull()
    expect(state.active.codex).toBe(codex.key)
  })

  it('drops a kernel that has nothing stored instead of inventing a row', async () => {
    const first = await loadStore()
    first.store.addThread('codex', first.newThread('/work/only-codex'))

    const second = await loadStore()
    expect(second.store.snapshot().threads.claude).toEqual([])
    expect(second.store.snapshot().active.claude).toBeNull()
  })

  it('records the known working directories newest-first', async () => {
    const first = await loadStore()
    const older = first.newThread('/work/a', { permission: 'auto' })
    first.store.addThread('codex', { ...older, title: 'a', updatedAt: 1 })
    const newer = first.newThread('/work/b', { permission: 'auto' })
    first.store.addThread('codex', { ...newer, title: 'b', updatedAt: 2 })

    const stored = JSON.parse(storage.getItem(storageKey('codex')) ?? '{}') as { cwds: string[] }
    expect(stored.cwds).toEqual(['/work/b', '/work/a'])
  })

  it('forgets a deleted thread on the next load', async () => {
    const first = await loadStore()
    const thread = first.newThread('/work/gone')
    first.store.addThread('codex', { ...thread, title: '要删掉' })
    first.store.removeThread('codex', thread.key)

    const second = await loadStore()
    expect(second.store.snapshot().threads.codex).toEqual([])
    expect(second.store.snapshot().active.codex).toBeNull()
  })

  it('ignores a corrupted or foreign payload', async () => {
    storage.setItem(storageKey('codex'), '{"version":1,"threads":[{"key":""}]}')
    storage.setItem(storageKey('claude'), 'not json at all')
    const loaded = await loadStore()
    const state = loaded.store.snapshot()
    expect(state.threads.codex).toEqual([])
    expect(state.threads.claude).toEqual([])
  })

  it('survives storage that refuses writes', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    })
    const loaded = await loadStore()
    expect(() => loaded.store.addThread('codex', loaded.newThread('/work/x'))).not.toThrow()
    expect(loaded.store.snapshot().threads.codex).toHaveLength(1)
  })

  it('keeps the kernels apart after both have written', async () => {
    const first = await loadStore()
    for (const kernel of ['codex', 'claude'] as ThirdPartyKernelId[]) {
      const thread = first.newThread(`/work/${kernel}`)
      first.store.addThread(kernel, { ...thread, title: `${kernel} only` })
    }
    const second = await loadStore()
    for (const kernel of ['codex', 'claude'] as ThirdPartyKernelId[])
      expect(second.store.snapshot().threads[kernel].every(thread => thread.title === `${kernel} only`)).toBe(true)
  })
})
