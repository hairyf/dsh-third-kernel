/**
 * Brand-row occupants.
 *
 * `sidebar.brand.mark` and `sidebar.brand.name` are the official sidebar's two
 * holes inside `.hHd-Xa_logoRow`. The mark and wordmark rendered here ARE the
 * official `FishLogo` and `BrandWordmark` primitives that ui-brand-official uses,
 * so the row looks exactly like the stock build — the switcher only hangs a menu
 * off that untouched artwork.
 *
 * The sidebar this row lives in is itself replaced while a kernel is active, so
 * the rail carries its own switcher; both use `KernelSwitcher`, whose hover state
 * is per instance, so only the one under the pointer opens.
 */
import type { ReactElement } from 'react'
import { BrandWordmark, FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import { KernelSwitcher } from './kernel-switcher'

/** The official sidebar mark, with the kernel menu anchored to it. */
export function BrandMark({ size }: { size?: number }): ReactElement {
  const edge = typeof size === 'number' && size > 0 ? size : 20
  return (
    <KernelSwitcher>
      <FishLogo size={edge} />
    </KernelSwitcher>
  )
}

/** The official wordmark, opening the same menu. */
export function BrandName(): ReactElement {
  return (
    <KernelSwitcher className="min-w-0">
      <span className="inline-flex min-w-0 items-center">
        <BrandWordmark includeMark={false} />
      </span>
    </KernelSwitcher>
  )
}
