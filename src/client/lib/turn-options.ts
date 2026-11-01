/**
 * One self-consistent set of composer knobs.
 *
 * Model, reasoning level and permission are chosen on three separate controls
 * but travel as one object, so any of them can survive a change that made it
 * illegal: switching to a model without `low` leaves `effort: 'low'` pointing at
 * a level the new model never advertised, and the chip then names a level the
 * turn cannot run in. Both functions here are pure — they take the catalogue the
 * caller already has — so the store, the React binding and the tests all repair
 * the same object the same way.
 */
import type { KernelModel, TurnOptions } from '../../shared/protocol'
import { PERMISSION_MODES } from '../../shared/protocol'

/**
 * The effort to actually send for `model`.
 *
 * Undefined means "let the kernel apply its own default": that is the honest
 * answer when the model is unknown or advertises no levels, not an invented id.
 * A stale level falls back to the model's first entry, which is the default the
 * catalogue lists first in both adapters.
 */
export function pickEffort(
  models: readonly KernelModel[],
  model: string | undefined,
  effort: string | undefined,
): string | undefined {
  const found = models.find(entry => entry.id === model)
  if (found === undefined || found.efforts.length === 0)
    return undefined
  if (effort !== undefined && found.efforts.some(entry => entry.id === effort))
    return effort
  return found.efforts[0].id
}

/**
 * Repair `options` against `models`.
 *
 * An empty catalogue knows nothing, so the caller's model is kept — clearing it
 * there would silently drop a kernel's own configured default. With a catalogue
 * in hand a model it does not list is dropped rather than guessed: no default is
 * pinned here, that is `setModelCatalog`'s job.
 */
export function normalizeOptions(
  models: readonly KernelModel[],
  options: TurnOptions,
): TurnOptions {
  const permission = PERMISSION_MODES.includes(options.permission) ? options.permission : 'auto'
  if (models.length === 0)
    return { ...options, permission }
  const model = models.find(entry => entry.id === options.model)
  // Effort without a model is meaningless, so it goes with it.
  if (model === undefined)
    return { permission }
  return { model: model.id, effort: pickEffort(models, model.id, options.effort), permission }
}
