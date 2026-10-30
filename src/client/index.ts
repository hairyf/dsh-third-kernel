/**
 * Browser half: swap the sidebar and the conversation area, and nothing else.
 *
 * Both target slots are `single`, so occupying one permanently would bury the
 * official occupant. Instead the occupancy is bound to the selection: the
 * entries are registered while a third-party kernel is active and disposed the
 * moment `dsh` is selected, which hands the two seats back to ui-sidebar and
 * ui-conversation untouched. That is what makes switching a real swap rather
 * than a one-way takeover.
 *
 * The switcher itself lives in the official brand row (`sidebar.brand.mark` /
 * `sidebar.brand.name`), which is always mounted — so the way back exists in
 * every mode, including inside a kernel surface.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only imports: each merges its slot keys into SlotMap and declares the
// services used here. Nothing is required at runtime beyond what DSH provides.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { ThirdPartyKernelId } from '../shared/protocol'
import { PLUGIN_ID, SELECTION_KEY } from '../shared/protocol'
import { BrandMark, BrandName } from './components/brand'
import { KernelConversation } from './components/kernel-conversation'
import { KernelSidebar } from './components/kernel-sidebar'
import { fetchState } from './lib/api'
import { store } from './lib/store'

export const name = PLUGIN_ID
/** The slot registry is the only service this plugin requires. */
export const inject = ['slots']

/** Restore the persisted selection so a reload lands where the user left off. */
function restoreSelection(): void {
  try {
    const stored = window.localStorage.getItem(SELECTION_KEY)
    if (stored === 'dsh' || stored === 'codex' || stored === 'claude')
      store.select(stored)
  }
  catch {
    // Private-mode or disabled storage: fall back to the official kernel.
  }
}

function persistSelection(): () => void {
  let previous = store.snapshot().selected
  return store.subscribe(() => {
    const current = store.snapshot().selected
    if (current === previous)
      return
    previous = current
    try {
      window.localStorage.setItem(SELECTION_KEY, current)
    }
    catch {
      // Persistence is a convenience; a failed write must not break switching.
    }
  })
}

/**
 * Register the two occupying entries only while a kernel is selected.
 *
 * The disposers returned by the inner effect own the registrations, so dropping
 * them on selection change restores the official occupants immediately — the
 * declarers were never removed, only shadowed.
 */
function bindSurfaces(slots: NonNullable<Context['slots']>): () => void {
  let dispose: (() => void) | undefined

  const sync = (): void => {
    const selected = store.snapshot().selected
    const active = selected !== 'dsh' ? (selected as ThirdPartyKernelId) : null
    if (active === null) {
      dispose?.()
      dispose = undefined
      return
    }
    if (dispose !== undefined)
      return
    // The declaration of `main.conversation` belongs to the conversation entry,
    // so `inject` waits for it rather than assuming load order.
    const offSidebar = slots.inject('sidebar', () => slots.register(
      { name: 'sidebar', registrant: PLUGIN_ID, priority: -1 },
      KernelSidebar,
    ))
    // `main` is keyed: shadowing the `conversation` cell replaces only what the
    // centre renders for that panel key, leaving the frame and every other panel
    // untouched.
    const offConversation = slots.inject('main', () => slots.register(
      { name: 'main', key: 'conversation', registrant: PLUGIN_ID, priority: -1 },
      KernelConversation,
    ))
    dispose = () => {
      offConversation()
      offSidebar()
    }
  }

  sync()
  const unsubscribe = store.subscribe(sync)
  return () => {
    unsubscribe()
    dispose?.()
    dispose = undefined
  }
}

export function apply(ctx: Context): void {
  const { slots } = ctx
  if (slots === undefined) {
    ctx.logger?.warn(`${PLUGIN_ID}: slots 服务不可用，内核切换已禁用`)
    return
  }

  restoreSelection()
  ctx.effect(persistSelection, `${PLUGIN_ID}: persist selection`)

  // Detect the local kernels once per activation. The result feeds both the menu
  // (which kernel is usable) and every surface's working directory, so it must run
  // regardless of which surface is currently mounted.
  ctx.effect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const next = await fetchState(controller.signal)
        store.setDetection({ kernels: next.kernels, cwd: next.cwd, detection: 'ready', detectionError: null })
        // Threads created before detection finished need the directory too.
        store.adoptCwd(next.cwd)
      }
      catch (error) {
        if (!controller.signal.aborted)
          store.setDetection({ detection: 'error', detectionError: error instanceof Error ? error.message : String(error) })
      }
    })()
    return () => {
      controller.abort()
    }
  }, `${PLUGIN_ID}: detect kernels`)

  // The switcher: the official brand row's two holes. `single` slots already held
  // by ui-brand-official at priority 0, so priority -1 wins the cell while the
  // official entries stay registered beneath for an unload.
  ctx.effect(() => slots.inject('sidebar.brand.mark', () => slots.inject('sidebar.brand.name', function* () {
    yield slots.register({ name: 'sidebar.brand.mark', registrant: PLUGIN_ID, priority: -1 }, BrandMark)
    yield slots.register({ name: 'sidebar.brand.name', registrant: PLUGIN_ID, priority: -1 }, BrandName)
  })), `${PLUGIN_ID}: brand row`)

  // The swap: only the sidebar and the conversation area, only while a kernel is
  // selected.
  ctx.effect(() => bindSurfaces(slots), `${PLUGIN_ID}: kernel surfaces`)
}
