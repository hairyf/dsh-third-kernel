/**
 * The sidebar swap.
 *
 * Occupies the official `sidebar` slot (single, `collapsed`/`width` handed in by
 * the frame) only while a third-party kernel is selected, so the official
 * navigation column is shadowed rather than destroyed. It receives the frame's
 * live column state and honours the collapsed rail exactly as the official shell
 * does, because the frame still owns geometry.
 */
import type { ReactElement } from 'react'
import type { ThirdPartyKernelId } from '../../shared/protocol'
import { KERNEL_META } from '../constants'
import { useKernelState } from '../lib/use-store'
import { KernelRail } from './kernel-nav'

/** Owner props the frame hands its sidebar occupant. */
export interface SidebarOwnerProps {
  collapsed: boolean
  width: number
}

/**
 * Render the active kernel's navigation column.
 */
export function KernelSidebar({ collapsed, width }: SidebarOwnerProps): ReactElement {
  const app = useKernelState()
  const kernel = (app.selected === 'dsh' ? 'codex' : app.selected) as ThirdPartyKernelId
  const meta = KERNEL_META[kernel]

  if (collapsed) {
    return (
      <nav
        aria-label={`${meta.label} 导航`}
        className="flex h-full w-full flex-col items-center gap-[6px] py-[8px]"
        style={{ background: kernel === 'claude' ? 'var(--color-tk-claude-rail)' : 'var(--color-tk-codex-rail)' }}
      >
        <span style={{ color: meta.accent }} title={meta.label}>
          {kernel === 'claude' ? <span className="rotate-0">✳</span> : <span>◍</span>}
        </span>
      </nav>
    )
  }

  return (
    <div style={{ width }} className="h-full" data-dsh-third-kernel={kernel}>
      <KernelRail kernel={kernel} directory={app.cwd} />
    </div>
  )
}
