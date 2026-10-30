/**
 * Full-screen install surface.
 *
 * Shown when a selected kernel is missing (or the user asks to reinstall). It
 * starts the install by itself — the point of the flow is that picking a missing
 * kernel is enough — and every number on screen comes from the host's stream:
 * phase messages carry their own percent, ticks carry the current one, and 100%
 * only arrives after the installer has proved the binary runs.
 */
import type { ReactElement } from 'react'
import type { InstallEvent, ThirdPartyKernelId } from '../../shared/protocol'
import { useEffect, useRef, useState } from 'react'
import { INSTALL_COPY, KERNEL_META } from '../constants'
import { fetchState, install } from '../lib/api'
import { store } from '../lib/store'
import { KernelMark } from './kernel-icons'

interface Props {
  kernel: ThirdPartyKernelId
  /** Called once the install is verified, so the parent can open the kernel. */
  onInstalled: () => void
  /** Leave the surface and go back to the official kernel. */
  onCancel: () => void
}

export function InstallScreen({ kernel, onInstalled, onCancel }: Props): ReactElement {
  const meta = KERNEL_META[kernel]
  const copy = INSTALL_COPY[kernel]
  const [percent, setPercent] = useState(0)
  const [message, setMessage] = useState('正在准备安装…')
  const [error, setError] = useState<string | null>(null)
  const started = useRef(false)
  const onInstalledRef = useRef(onInstalled)
  onInstalledRef.current = onInstalled

  useEffect(() => {
    if (started.current)
      return
    started.current = true
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of install(kernel, controller.signal)) {
          apply(event)
          if (event.type === 'done')
            break
        }
      }
      catch (reason) {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : String(reason))
      }
    })()
    function apply(event: InstallEvent): void {
      if (event.type === 'step') {
        setPercent(event.percent)
        setMessage(event.message)
        return
      }
      if (event.type === 'tick') {
        setPercent(value => Math.max(value, event.percent))
        return
      }
      if (event.type === 'error') {
        setError(event.message)
        return
      }
      setPercent(100)
      setMessage(event.version === null ? '安装完成' : `安装完成 · ${event.version}`)
      // Refresh detection before handing the page over: the switcher must show
      // the kernel as installed, and the kernel UI needs its executable name.
      void refreshDetection().finally(() => onInstalledRef.current())
    }
    return () => {
      controller.abort()
    }
  }, [kernel])

  const failed = error !== null

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center"
      style={{ background: kernel === 'claude' ? 'var(--color-tk-claude-paper)' : 'var(--color-tk-codex-paper)' }}
      role="dialog"
      aria-modal="true"
      aria-label={copy.initializing}
    >
      <div className="flex flex-col items-center">
        <span
          className="flex size-[72px] items-center justify-center"
          style={{ color: kernel === 'claude' ? meta.accent : '#111' }}
        >
          <KernelMark kernel={kernel} size={56} />
        </span>
        <p
          className="mt-[18px] text-[15px]"
          style={{ color: kernel === 'claude' ? 'var(--color-tk-claude-muted)' : 'var(--color-tk-codex-muted)' }}
        >
          {failed ? `${meta.label} 安装失败` : message}
        </p>
        <div
          className="mt-[26px] h-[3px] w-[520px] max-w-[70vw] overflow-hidden rounded-full"
          style={{ background: kernel === 'claude' ? 'var(--color-tk-claude-line)' : 'var(--color-tk-codex-line)' }}
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="安装进度"
        >
          <div
            className="h-full rounded-full transition-[width] duration-300 ease-out"
            style={{
              width: `${percent}%`,
              background: failed ? '#c0392b' : kernel === 'claude' ? meta.accent : '#111',
            }}
          />
        </div>
        {failed
          ? (
              <div className="mt-[22px] flex max-w-[560px] flex-col items-center gap-[10px] px-6">
                <p className="text-center text-[13px] leading-[1.6]" style={{ color: '#b4341f' }}>{error}</p>
                <p className="text-center text-[12px] leading-[1.6]" style={{ color: 'var(--color-tk-codex-muted)' }}>{copy.hint}</p>
                <div className="mt-[6px] flex gap-[10px]">
                  <button
                    type="button"
                    className="cursor-pointer rounded-[8px] border-0 bg-[#111] px-[16px] py-[8px] text-[13px] text-white"
                    onClick={() => window.location.reload()}
                  >
                    重新尝试
                  </button>
                  <button
                    type="button"
                    className="cursor-pointer rounded-[8px] border border-black/12 bg-transparent px-[16px] py-[8px] text-[13px]"
                    onClick={onCancel}
                  >
                    返回 DSH
                  </button>
                </div>
              </div>
            )
          : (
              <div className="mt-[22px] flex flex-col items-center gap-[6px]">
                <p className="text-[12px]" style={{ color: 'var(--color-tk-codex-muted)' }}>{copy.hint}</p>
                <button
                  type="button"
                  className="cursor-pointer border-0 bg-transparent p-0 text-[12px] underline underline-offset-2 opacity-60"
                  onClick={onCancel}
                >
                  取消并返回 DSH
                </button>
              </div>
            )}
      </div>
    </div>
  )
}

/** Re-probe the host so the store reflects the freshly installed kernel. */
async function refreshDetection(): Promise<void> {
  try {
    const next = await fetchState()
    store.setDetection({ kernels: next.kernels, cwd: next.cwd, detection: 'ready', detectionError: null })
  }
  catch {
    // The install already succeeded; detection refreshes on the next mount.
  }
}
