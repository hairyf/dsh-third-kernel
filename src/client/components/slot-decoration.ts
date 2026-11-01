import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsRuntime, SlotMap, SlotScope, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { ComponentType, ReactElement } from 'react'
import { createElement, Fragment } from 'react'

export interface SlotDecorationOriginalProps {
  Original?: ComponentType<Record<string, unknown>>
}

export type SlotDecorationOptions<K extends keyof SlotMap & string, I extends object> = {
  slot: K
  scope: SlotScope
  registrant: string
  accept?: (entry: StoredEntry) => boolean
  empty?: true
  inject: () => I
  warn: (reason: string) => void
} & ({
  mode?: 'append'
  component: ComponentType<PropsRuntime<K> & I>
} | {
  mode: 'wrap'
  component: ComponentType<PropsRuntime<K> & I & SlotDecorationOriginalProps>
})

export function registerSlotDecoration<K extends keyof SlotMap & string, I extends object>(
  slots: SlotRegistry | undefined,
  options: SlotDecorationOptions<K, I>,
): () => void {
  if (typeof slots?.inject !== 'function' || typeof slots.spec !== 'function'
    || typeof slots.entries !== 'function' || typeof slots.entriesOfSlot !== 'function'
    || typeof slots.subscribe !== 'function' || typeof slots.register !== 'function'
    || typeof slots.onEntryError !== 'function') {
    options.warn('slot decoration unavailable; official registration APIs are missing')
    return () => {}
  }
  return slots.inject(options.slot, function* () {
    const spec = slots.spec(options.slot)
    if (spec?.kind !== 'single' || spec.scope !== options.scope) {
      options.warn('slot decoration unavailable; the official slot contract differs')
      return
    }
    let original: StoredEntry | undefined
    let wrapper: unknown
    let provider: unknown
    let unregister: (() => void) | undefined
    let unregisterProvider: (() => void) | undefined
    let disposed = false
    let syncing = false
    let initialized = false
    const retired = new Set<StoredEntry>()

    function registerProvider(): void {
      if (!options.empty)
        return
      const used = new Set(slots!.entries(options.slot)
        .map(entry => entry.options.priority)
        .filter((priority): priority is number => Number.isFinite(priority)))
      let priority = -1
      while (used.has(priority))
        priority -= 1
      const Addition = options.component as ComponentType<Record<string, unknown>>
      const register = slots!.register as unknown as (
        registration: { name: K, priority: number, registrant: string, inject: (...args: unknown[]) => object },
        renderer: ComponentType<Record<string, unknown>>,
      ) => () => void
      provider = Addition
      unregisterProvider = register.call(slots, {
        name: options.slot,
        priority,
        registrant: options.registrant,
        inject: () => options.inject(),
      }, Addition)
    }

    function sync(): void {
      if (disposed || syncing)
        return
      const winner = slots!.entriesOfSlot(options.slot)[0]
      if (winner?.component === wrapper) {
        if (original !== undefined && slots!.entries(options.slot).includes(original) && !retired.has(original))
          return
        unregister?.()
        unregister = undefined
        wrapper = undefined
      }
      else if (winner?.component === provider) {
        const hasOther = slots!.entries(options.slot).some(entry => entry !== winner && !retired.has(entry))
        if (!hasOther)
          return
        unregisterProvider?.()
        unregisterProvider = undefined
        provider = undefined
      }
      const next = slots!.entriesOfSlot(options.slot)[0]
      if (initialized && next === original)
        return
      syncing = true
      try {
        unregister?.()
        unregister = undefined
        unregisterProvider?.()
        unregisterProvider = undefined
        wrapper = undefined
        provider = undefined
        original = next
        initialized = true
        if (next === undefined) {
          registerProvider()
          return
        }
        const priority = (next.options.priority ?? 0) - 1
        const component = next.component
        const composable = Number.isFinite(priority) && priority < (next.options.priority ?? 0)
          && (typeof component === 'function' || (typeof component === 'object' && component !== null && '$$typeof' in component))
        if (!composable) {
          registerProvider()
          if (provider === undefined)
            options.warn('slot decoration unavailable; the official renderer cannot be safely composed')
          return
        }
        if (options.accept !== undefined && !options.accept(next)) {
          options.warn('slot decoration unavailable; the official renderer capability is unverified')
          return
        }
        const source = next
        const Original = component as ComponentType<Record<string, unknown>>
        const Addition = options.component as ComponentType<Record<string, unknown>>
        // ponytail: the shadowing entry cannot re-declare the official children
        // (SlotCore rejects the duplicate declaration while the official entry lives),
        // so it gets no renderSlot kit. Hand the wrapped renderer a no-contribution
        // binding: every child collapses to its own fallback, which is what an
        // empty decoration slot renders anyway.
        const passthroughRenderSlot = (
          _key: string,
          _owner?: unknown,
          opts?: { fallback?: unknown },
        ): unknown => opts?.fallback ?? null
        function Decorated(props: Record<string, unknown>): ReactElement | null {
          if (!slots!.entries(options.slot).includes(source))
            return null
          return options.mode === 'wrap'
            ? createElement(Addition, {
                ...props,
                renderSlot: props.renderSlot ?? passthroughRenderSlot,
                Original,
              })
            : createElement(Fragment, null, createElement(Original, props), createElement(Addition, props))
        }
        wrapper = Decorated
        const originalInject = next.inject as ((...args: unknown[]) => Record<string, unknown>) | undefined
        const register = slots!.register as unknown as (
          registration: Pick<StoredEntry, 'locale' | 'store'> & {
            name: K
            priority: number
            registrant: string
            inject: (...args: unknown[]) => object
          },
          renderer: ComponentType<Record<string, unknown>>,
        ) => () => void
        unregister = register.call(slots, {
          name: options.slot,
          priority,
          registrant: options.registrant,
          locale: next.locale,
          store: next.store,
          inject: (...args) => slots!.entries(options.slot).includes(source)
            ? { ...originalInject?.(...args), ...options.inject() }
            : {},
        }, Decorated)
      }
      finally {
        syncing = false
      }
    }

    yield () => {
      disposed = true
      unregister?.()
      unregisterProvider?.()
    }
    yield slots.subscribe(options.slot, sync)
    yield slots.onEntryError((key, entry, _error, info) => {
      if (!disposed && key === options.slot && info.abdicated
        && (entry === original || entry.component === wrapper || entry.component === provider)) {
        const originalRetired = entry === original
        if (originalRetired)
          retired.add(entry)
        unregister?.()
        unregister = undefined
        unregisterProvider?.()
        unregisterProvider = undefined
        wrapper = undefined
        provider = undefined
        options.warn('slot decoration disabled after renderer retirement; the official fallback is preserved')
        if (originalRetired) {
          initialized = false
          sync()
        }
      }
    })
    sync()
  })
}
