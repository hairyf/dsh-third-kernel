import type { ReactElement } from 'react'
import type { BackendId } from '../../shared/types'
import type { KernelHeroBrandProps, KernelLineageProps } from './slot-contract'
import { useEffect } from 'react'
import { CLAUDE_ICON_COLOR, KERNEL_META, KERNEL_SLOGAN, kernelHeroHeadline } from '../constants'
import { backendFromIdentity } from '../service/kernel-identity'
import { kernelStore } from '../store/modules/kernel-store'
import { useStore } from '../store/reactive'
import { ClaudeIcon, CodexHeroMark, FishLogo, GptIcon } from './index'

export function KernelHeroBrand({ size, className, Original }: KernelHeroBrandProps): ReactElement {
  const { selected, workspace } = useStore(kernelStore)
  if (selected !== 'codex' && selected !== 'claude')
    return Original ? <Original size={size} className={className} /> : <FishLogo size={size} className={className} />
  // The mark replaces the whale *and* the official title group (探索未至之境 /
  // 预览版), which main.css hides while a kernel is selected: the hero then
  // carries the kernel's own mark and headline, in the official type scale.
  // The glyph takes the fish's 25px height so the 32px headline row never grows.
  // No wrap: the headline ellipses instead of pushing the row taller. The
  // official `fish` class (hover swim animation) rides the icon alone, not the
  // whole mark: animating the headline text was the reported bug.
  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'center', gap: 10, minWidth: 0 }}
      aria-label={KERNEL_META[selected].label}
    >
      <span className={className} style={{ display: 'inline-flex', flex: 'none' }}>
        {/* The hero uses the user-supplied Codex asset; every other surface keeps
            the standard `GptIcon` (via `KernelIcon`). Claude's hero mark is
            tinted with its accent. */}
        {selected === 'codex'
          ? <CodexHeroMark width={Math.round(size * 0.74)} height={Math.round(size * 0.74)} />
          : <ClaudeIcon width={Math.round(size * 0.74)} height={Math.round(size * 0.74)} color={CLAUDE_ICON_COLOR} />}
      </span>
      <span style={{ fontSize: 26, lineHeight: '32px', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {kernelHeroHeadline(selected, workspace)}
      </span>
    </span>
  )
}

/**
 * Publish the kernel identity the two shell consumers read: the brand mark
 * (kernelStore) and the CSS hooks (data-dsh-third-kernel-shell).
 *
 * Both the hero picker and the session header own a copy of the identity, and
 * only one of them is mounted at a time — the hero hides the header — so the
 * hook runs in both.
 */
export function useKernelShell(backend: BackendId | undefined, workspace?: string): void {
  useEffect(() => {
    kernelStore.patch({ selected: backend, ...workspace === undefined ? {} : { workspace } })
    const root = document.documentElement
    if (backend !== 'codex' && backend !== 'claude') {
      root.removeAttribute('data-dsh-third-kernel-shell')
      return
    }
    root.setAttribute('data-dsh-third-kernel-shell', backend)
    return () => {
      if (root.getAttribute('data-dsh-third-kernel-shell') === backend)
        root.removeAttribute('data-dsh-third-kernel-shell')
      if (kernelStore.getSnapshot().selected === backend)
        kernelStore.patch({ selected: undefined })
    }
  }, [backend, workspace])
}

export function KernelLineage(props: KernelLineageProps): ReactElement | null {
  const backend = backendFromIdentity(props.useProjection('bridgeKernel'))
  useKernelShell(backend)
  if ((backend !== 'codex' && backend !== 'claude') || props.sessionId !== props.lineageSessionId)
    return null
  return (
    <span className="ml-1.5 inline-flex items-center gap-1.5 text-[11px] text-[var(--color-foreground-subtlest)]" aria-label={KERNEL_META[backend].label}>
      {backend === 'codex' ? <GptIcon width={14} height={14} /> : <ClaudeIcon width={14} height={14} />}
      <span>{KERNEL_SLOGAN[backend]}</span>
    </span>
  )
}
