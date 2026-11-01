import type { ReactElement } from 'react'
import type { BackendId } from '../../shared/types'
import type { KernelHeroBrandProps, KernelLineageProps } from './slot-contract'
import { useEffect } from 'react'
import { KERNEL_META, KERNEL_SLOGAN } from '../constants'
import { backendFromIdentity } from '../service/kernel-identity'
import { kernelStore } from '../store/modules/kernel-store'
import { useStore } from '../store/reactive'
import { ClaudeIcon, FishLogo, GptIcon } from './index'
import { KernelIcon } from './kernel-icon'

export function KernelHeroBrand({ size, className, Original }: KernelHeroBrandProps): ReactElement {
  const { selected } = useStore(kernelStore)
  if (selected !== 'codex' && selected !== 'claude')
    return Original ? <Original size={size} className={className} /> : <FishLogo size={size} className={className} />
  // The mark replaces the whale *and* the official title group (探索未至之境 /
  // 预览版), which main.css hides while a kernel is selected: the hero then
  // carries only the kernel's own mark and slogan, in the official type scale.
  // The glyph takes the fish's 25px height so the 32px headline row never grows.
  return (
    <span
      className={className}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}
      aria-label={KERNEL_META[selected].label}
    >
      <KernelIcon backend={selected} size={Math.round(size * 0.74)} />
      <span style={{ fontSize: 26, lineHeight: '32px', fontWeight: 500, whiteSpace: 'nowrap' }}>
        {KERNEL_SLOGAN[selected]}
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
export function useKernelShell(backend: BackendId | undefined): void {
  useEffect(() => {
    kernelStore.patch({ selected: backend })
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
  }, [backend])
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
