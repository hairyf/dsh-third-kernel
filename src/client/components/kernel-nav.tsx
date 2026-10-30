/**
 * The project/conversation rail inside a third-party kernel's sidebar.
 *
 * Rendered by the `sidebar` occupant while a kernel is selected, so it is the
 * whole navigation column: kernel identity, new conversation, the working
 * directory, and the thread list. The kernel switch lives in the official brand
 * row above it, which stays mounted in every mode.
 */
import type { ReactElement } from 'react'
import type { ThirdPartyKernelId } from '../../shared/protocol'
import { KERNEL_META } from '../constants'
import { closeThread } from '../lib/runner'
import { newThread, store } from '../lib/store'
import { useKernelThreads } from '../lib/use-store'
import { baseName } from './chat-shared'
import { KernelMark } from './kernel-icons'
import { KernelSwitcher } from './kernel-switcher'

interface Props {
  kernel: ThirdPartyKernelId
  directory: string
}

export function KernelRail({ kernel, directory }: Props): ReactElement {
  const meta = KERNEL_META[kernel]
  const { threads, activeKey } = useKernelThreads(kernel)
  const railColor = kernel === 'claude' ? 'var(--color-tk-claude-rail)' : 'var(--color-tk-codex-rail)'
  const lineColor = kernel === 'claude' ? 'var(--color-tk-claude-line)' : 'var(--color-tk-codex-line)'
  const textColor = kernel === 'claude' ? '#2b2622' : '#151515'

  return (
    <aside
      className="flex h-full w-full flex-col border-r"
      style={{ background: railColor, borderColor: lineColor, color: textColor }}
    >
      <div className="flex h-[46px] shrink-0 items-center px-[16px]">
        {/* The kernel switch must exist inside the kernel too, otherwise a
            selected kernel is a one-way door: its own rail replaces the official
            brand row that normally hosts the switcher. */}
        <KernelSwitcher>
          <span className="flex min-w-0 items-center gap-[8px]">
            <span className="flex size-[18px] shrink-0 items-center justify-center" style={{ color: meta.accent }}>
              <KernelMark kernel={kernel} size={16} />
            </span>
            <span className="truncate text-[13px] font-medium">{meta.label}</span>
          </span>
        </KernelSwitcher>
      </div>
      <div className="px-[10px] pb-[8px]">
        <button
          type="button"
          className="flex w-full cursor-pointer items-center gap-[8px] rounded-[6px] border-0 bg-transparent px-[8px] py-[7px] text-left text-[13px] hover:bg-black/[0.05]"
          onClick={() => store.addThread(kernel, newThread(directory))}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          新对话
        </button>
      </div>
      <div className="px-[16px] pb-[4px] text-[11px] uppercase tracking-wide opacity-40">项目</div>
      <div className="tk-scroll min-h-0 flex-1 overflow-y-auto px-[10px] pb-[10px]">
        <div className="flex items-center gap-[6px] rounded-[6px] bg-black/[0.05] px-[8px] py-[6px] text-[12px]">
          <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2 5.5h4l1.2 1.5H14v6H2z" fill="none" stroke="currentColor" strokeWidth="1.2" />
          </svg>
          <span className="truncate">{baseName(directory)}</span>
        </div>
        <div className="mt-[8px] flex flex-col gap-[1px]">
          {threads.length === 0 && <span className="px-[8px] py-[6px] text-[12px] opacity-40">还没有对话</span>}
          {threads.map(thread => (
            <div
              key={thread.key}
              className={`group flex items-center gap-[4px] rounded-[6px] px-[8px] py-[6px] text-[12px] ${thread.key === activeKey ? 'bg-black/[0.07]' : 'hover:bg-black/[0.04]'}`}
            >
              <button
                type="button"
                className="min-w-0 flex-1 cursor-pointer truncate border-0 bg-transparent text-left text-inherit"
                onClick={() => store.setActive(kernel, thread.key)}
                title={thread.title || '新对话'}
              >
                {thread.title === '' ? '新对话' : thread.title}
              </button>
              <button
                type="button"
                aria-label="关闭对话"
                className="hidden size-[16px] shrink-0 cursor-pointer items-center justify-center rounded-[3px] border-0 bg-transparent text-[11px] opacity-50 hover:opacity-100 group-hover:flex"
                onClick={() => void closeThread(kernel, thread.key)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </div>
    </aside>
  )
}
