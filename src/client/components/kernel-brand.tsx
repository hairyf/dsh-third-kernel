import type { ReactElement } from 'react'
import type { BackendId } from '../../shared/types'
import type { KernelLineageProps } from './slot-contract'
import { useEffect } from 'react'
import { KERNEL_META, KERNEL_SLOGAN } from '../constants'
import { backendFromIdentity } from '../service/kernel-identity'
import { ClaudeIcon, GptIcon } from './index'

/**
 * Publish the kernel identity as the `data-dsh-third-kernel-shell` CSS hook.
 *
 * The hero picker and the session header each own a copy of the identity and
 * only one of them is mounted at a time — the hero hides the header — so the
 * hook runs in both. Keeping the attribute in sync is all this does now: the
 * hero brand mark and its headline are left to the official renderer.
 */
export function useKernelShell(backend: BackendId | undefined): void {
  useEffect(() => {
    const root = document.documentElement
    if (backend !== 'codex' && backend !== 'claude') {
      root.removeAttribute('data-dsh-third-kernel-shell')
      return
    }
    root.setAttribute('data-dsh-third-kernel-shell', backend)
    return () => {
      if (root.getAttribute('data-dsh-third-kernel-shell') === backend)
        root.removeAttribute('data-dsh-third-kernel-shell')
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
