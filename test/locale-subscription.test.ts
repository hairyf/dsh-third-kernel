import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { expect, it, vi } from 'vitest'

const useSyncExternalStore = vi.hoisted(() => vi.fn())
vi.mock('react', () => ({ useSyncExternalStore }))

const { locale } = await import('../src/client/locales')

it('preserves the locale receiver when React subscribes and unsubscribes', () => {
  class Runtime {
    listeners = new Set<() => void>()
    getLocale() {
      return { active: 'zh' }
    }

    subscribe(listener: () => void) {
      this.listeners.add(listener)
      return () => {
        this.listeners.delete(listener)
      }
    }

    bind() {
      return (key: string) => key
    }

    register() {
      return () => {}
    }
  }

  const runtime = new Runtime()
  const dispose = locale.registerLocale({ locale: runtime as unknown as LocaleRuntime })
  const listener = vi.fn()
  let unsubscribe: (() => void) | undefined
  useSyncExternalStore.mockImplementation((subscribe: (fn: () => void) => () => void, getSnapshot: () => string) => {
    unsubscribe = subscribe(listener)
    return getSnapshot()
  })
  try {
    expect(locale.useLocale()).toBe('zh')
    expect(runtime.listeners.size).toBe(1)
    for (const notify of runtime.listeners)
      notify()
    expect(listener).toHaveBeenCalledOnce()
    unsubscribe?.()
    expect(runtime.listeners.size).toBe(0)
  }
  finally {
    unsubscribe?.()
    dispose()
    useSyncExternalStore.mockReset()
  }
})
