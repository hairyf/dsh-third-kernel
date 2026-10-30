/**
 * Slot prop shapes this plugin consumes.
 *
 * The official slot map composes owner props, framework shares, and the
 * registrant's injected face at the component. Declaring the slices here keeps
 * components typed without re-deriving the whole composed prop type, and keeps
 * every slot key in one place.
 */
import type { ReactElement } from 'react'

/** Owner props the sidebar hands its brand occupants. */
export interface BrandMarkProps {
  /** Requested square edge in pixels. */
  size?: number
}

/** Owner props of the brand-name hole: the occupant owns its own content. */
export type BrandNameProps = Record<never, never>

/** Props of a component registered into the built-in `root` slot. */
export type RootProps = Record<never, never>

/** Slot key → the props this plugin's occupant expects. */
export interface SlotPropsMap {
  'sidebar.brand.mark': BrandMarkProps
  'sidebar.brand.name': BrandNameProps
  'root': RootProps
}

/** Component signature for one slot occupant. */
export type SlotComponent<K extends keyof SlotPropsMap> = (props: SlotPropsMap[K]) => ReactElement | null
