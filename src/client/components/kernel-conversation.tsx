/**
 * The conversation swap.
 *
 * Occupies the official `main.conversation` slot (a `single` seat inside the
 * `conversation` main-panel key) only while a third-party kernel is selected.
 * The frame, header, right column, and composer chain stay official; only the
 * message area becomes the kernel's own.
 */
import type { ReactElement } from 'react'
import type { ThirdPartyKernelId } from '../../shared/protocol'
import { useEffect } from 'react'
import { newThread, store } from '../lib/store'
import { useKernelState } from '../lib/use-store'
import { ClaudeThread } from './claude-thread'
import { CodexThread } from './codex-thread'

export function KernelConversation(): ReactElement {
  const app = useKernelState()
  const kernel = (app.selected === 'dsh' ? 'codex' : app.selected) as ThirdPartyKernelId
  const threads = app.threads[kernel]
  const activeKey = app.active[kernel]
  const thread = threads.find(entry => entry.key === activeKey) ?? null

  // A kernel surface always has something to type into: create the first thread
  // lazily rather than rendering an empty shell.
  useEffect(() => {
    if (threads.length === 0)
      store.addThread(kernel, newThread(app.cwd))
  }, [app.cwd, kernel, threads.length])

  if (thread === null) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] opacity-50">
        正在准备
        {kernel === 'codex' ? 'Codex' : 'Claude'}
        {' '}
        会话…
      </div>
    )
  }

  // The marker scopes the control-colour reset to a kernel surface only.
  return (
    <div className="h-full w-full" data-dsh-third-kernel={kernel}>
      {kernel === 'codex' ? <CodexThread thread={thread} /> : <ClaudeThread thread={thread} />}
    </div>
  )
}
