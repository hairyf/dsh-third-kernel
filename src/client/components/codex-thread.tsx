/**
 * The Codex conversation area.
 *
 * A monochrome, dense, tool-forward transcript with a composer underneath. It
 * owns only the message pane: the sidebar comes from the `sidebar` slot occupant
 * and the frame belongs to ui-layout, so this stays a conversation and not a
 * second application shell.
 */
import type { ReactElement } from 'react'
import type { Thread } from '../lib/store'
import { useRef } from 'react'
import { HERO_COPY } from '../constants'
import { baseName, Composer, PromptBar, ThreadItems, useScrollToEnd } from './chat-shared'

export function CodexThread({ thread }: { thread: Thread }): ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null)
  useScrollToEnd(scrollRef, thread.items.length)
  const dirName = baseName(thread.cwd) || 'workspace'

  return (
    <div className="flex h-full min-h-0 w-full flex-col" style={{ background: 'var(--color-tk-codex-paper)', color: '#151515' }}>
      <div ref={scrollRef} className="tk-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-[16px] px-[20px] pb-[24px] pt-[24px]">
          {thread.items.length === 0
            ? <CodexHero dirName={dirName} />
            : (
                <ThreadItems
                  items={thread.items}
                  render={{
                    user: item => (
                      <div key={item.key} className="self-end rounded-[10px] bg-[#f2f1ee] px-[12px] py-[8px] text-[14px] leading-[1.65] whitespace-pre-wrap break-words">
                        {item.text}
                      </div>
                    ),
                    assistant: item => (
                      <div key={item.key} className="text-[14px] leading-[1.72] whitespace-pre-wrap break-words">{item.text}</div>
                    ),
                    thinking: item => (
                      <details key={item.key} className="rounded-[8px] border border-[var(--color-tk-codex-line)] px-[10px] py-[6px] text-[12px] opacity-70">
                        <summary className="cursor-pointer select-none">思考</summary>
                        <div className="mt-[6px] whitespace-pre-wrap break-words leading-[1.6]">{item.text}</div>
                      </details>
                    ),
                    tool: item => (
                      <div key={item.key} className="rounded-[8px] border border-[var(--color-tk-codex-line)]">
                        <div className="flex items-center gap-[6px] px-[10px] py-[6px] text-[12px]">
                          <span className="inline-block size-[5px] rounded-full" style={{ background: item.error ? '#c0392b' : item.done ? '#2f9e44' : '#c9c6c0' }} />
                          <span className="font-mono">{item.name}</span>
                          <span className="truncate opacity-50">{item.input}</span>
                        </div>
                        {item.output !== '' && (
                          <pre className="tk-scroll max-h-[220px] overflow-auto border-t border-[var(--color-tk-codex-line)] bg-[var(--color-tk-codex-rail)] px-[10px] py-[8px] font-mono text-[11px] leading-[1.5] whitespace-pre-wrap break-words">{item.output}</pre>
                        )}
                      </div>
                    ),
                    error: item => (
                      <div key={item.key} className="rounded-[8px] border border-[#e0b4ae] bg-[#fdf3f1] px-[10px] py-[8px] text-[12px] text-[#b4341f] whitespace-pre-wrap break-words">{item.text}</div>
                    ),
                  }}
                />
              )}
        </div>
      </div>
      <div className="shrink-0 px-[20px] pb-[14px]">
        <div className="mx-auto w-full max-w-[720px]">
          {thread.pending !== null && <PromptBar kernel="codex" thread={thread} pending={thread.pending} className="mb-[8px]" />}
          <div className="mb-[6px] flex items-center gap-[8px] rounded-t-[10px] border border-b-0 border-[var(--color-tk-codex-line)] bg-[var(--color-tk-codex-rail)] px-[12px] py-[6px] text-[11px] opacity-70">
            <span className="flex items-center gap-[4px]">
              📁
              {dirName}
            </span>
            <span className="flex items-center gap-[4px]">本地</span>
            <span className="ml-auto truncate font-mono">{thread.cwd}</span>
          </div>
          <div className="rounded-b-[10px] border border-[var(--color-tk-codex-line)] bg-white p-[10px]">
            <Composer
              kernel="codex"
              thread={thread}
              placeholder={HERO_COPY.codex.input}
              leading={(
                <button type="button" aria-label="添加附件" className="flex size-[24px] shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-[#151515] hover:bg-black/[0.05]">
                  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                </button>
              )}
              trailing={<span className="shrink-0 px-[4px] text-[11px] opacity-55">{thread.models[0]?.split(' · ')[0] ?? 'Codex'}</span>}
              buttonClassName="bg-[#111] text-white"
            />
          </div>
        </div>
      </div>
    </div>
  )
}

/** Empty-state hero for a fresh Codex thread. */
function CodexHero({ dirName }: { dirName: string }): ReactElement {
  return (
    <div className="flex flex-col items-center pt-[120px] text-center">
      <svg width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M12 3.2c2.1 0 3.9 1.2 4.8 3 1.9.5 3.3 2.2 3.3 4.3 0 1.3-.6 2.5-1.5 3.3.2.5.3 1 .3 1.6 0 2.4-1.9 4.3-4.3 4.3-.7 0-1.4-.2-2-.5-1 .9-2.3 1.5-3.7 1.5-2.4 0-4.3-1.9-4.3-4.3 0-.6.1-1.1.3-1.6A4.2 4.2 0 0 1 3.5 10.5c0-2.1 1.5-3.8 3.4-4.3.9-1.8 2.7-3 4.8-3Z"
          stroke="currentColor"
          strokeWidth="1.3"
        />
      </svg>
      <p className="mt-[14px] text-[20px] font-medium tracking-tight">
        {HERO_COPY.codex.title.replace('{dir}', dirName)}
      </p>
    </div>
  )
}
