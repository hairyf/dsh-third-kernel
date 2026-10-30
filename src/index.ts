/**
 * Host half: detect the local CLIs, install them on request, and drive one
 * kernel conversation per browser session.
 */
import type { Context } from '@deepseek-ai/cordis'
import { disposeSessions } from './host/registry'
import { mountRoutes } from './host/routes'
import { PLUGIN_ID } from './shared/protocol'

export const name = PLUGIN_ID
export const inject = ['connection']

/**
 * Mount the kernel API. The effect's disposer closes every live kernel child, so
 * unloading the plugin never leaves an orphaned app-server behind.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const dispose = mountRoutes(ctx)
    return () => {
      dispose()
      void disposeSessions()
    }
  }, `${PLUGIN_ID}: kernel API`)
}
