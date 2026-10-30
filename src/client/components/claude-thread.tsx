/**
 * The Claude conversation area.
 *
 * Deliberately a different design from Codex: warm paper, a serif display line,
 * and a card composer. Sharing one layout would make both read as a DSH reskin;
 * the two kernels are meant to feel like their own products.
 */
import type { ReactElement } from 'react'
import type { Thread } from '../lib/store'
import { useRef } from 'react'
import { HERO_COPY, KERNEL_META } from '../constants'
import { baseName, Composer, PromptBar, ThreadItems, useScrollToEnd } from './chat-shared'
import { ClaudeIcon } from './kernel-icons'

export function ClaudeThread({ thread }: { thread: Thread }): ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null)
  useScrollToEnd(scrollRef, thread.items.length)
  const dirName = baseName(thread.cwd) || 'workspace'

  return (
    <div className="flex h-full min-h-0 w-full flex-col" style={{ background: 'var(--color-tk-claude-paper)', color: '#2b2622' }}>
      <div ref={scrollRef} className="tk-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[680px] flex-col gap-[18px] px-[24px] pb-[20px] pt-[10px]">
          {thread.items.length === 0
            ? (
                <div className="flex flex-col items-center pt-[120px] text-center">
                  <p className="flex items-center gap-[10px] font-[family-name:var(--font-tk-serif)] text-[34px] leading-none" style={{ color: '#211d1a' }}>
                    <span style={{ color: KERNEL_META.claude.accent }}><ClaudeIcon width={30} height={30} /></span>
                    {HERO_COPY.claude.title}
                  </p>
                </div>
              )
            : (
                <ThreadItems
                  items={thread.items}
                  render={{
                    user: item => (
                      <div key={item.key} className="self-end rounded-[14px] bg-[#efe7dc] px-[14px] py-[9px] text-[14px] leading-[1.65] whitespace-pre-wrap break-words">
                        {item.text}
                      </div>
                    ),
                    assistant: item => (
                      <div key={item.key} className="text-[14.5px] leading-[1.75] whitespace-pre-wrap break-words">{item.text}</div>
                    ),
                    thinking: item => (
                      <div key={item.key} className="border-l-2 pl-[10px] text-[13px] leading-[1.7] whitespace-pre-wrap break-words italic opacity-60" style={{ borderColor: 'var(--color-tk-claude-line)' }}>
                        {item.text}
                      </div>
                    ),
                    tool: item => (
                      <div key={item.key} className="rounded-[10px] border px-[12px] py-[8px]" style={{ borderColor: 'var(--color-tk-claude-line)' }}>
                        <div className="flex items-center gap-[6px] text-[12px]">
                          <span className="inline-block size-[5px] rounded-full" style={{ background: item.error ? '#c0392b' : item.done ? '#4c8c4a' : '#d8cec2' }} />
                          <span className="font-[family-name:var(--font-tk-mono)]">{item.name}</span>
                          <span className="truncate opacity-45">{item.input}</span>
                        </div>
                        {item.output !== '' && (
                          <pre className="tk-scroll mt-[6px] max-h-[200px] overflow-auto rounded-[6px] bg-black/[0.03] p-[8px] font-[family-name:var(--font-tk-mono)] text-[11px] leading-[1.5] whitespace-pre-wrap break-words">{item.output}</pre>
                        )}
                      </div>
                    ),
                    error: item => (
                      <div key={item.key} className="rounded-[10px] border border-[#e3bdb2] bg-[#fdf2ee] px-[12px] py-[8px] text-[12.5px] text-[#a83a20] whitespace-pre-wrap break-words">{item.text}</div>
                    ),
                  }}
                />
              )}
        </div>
      </div>
      <div className="shrink-0 px-[24px] pb-[14px]">
        <div className="mx-auto w-full max-w-[680px]">
          {thread.pending !== null && <PromptBar kernel="claude" thread={thread} pending={thread.pending} className="mb-[8px]" />}
          <div className="rounded-[14px] border bg-white p-[12px] shadow-[0_2px_14px_rgba(60,45,30,0.06)]" style={{ borderColor: 'var(--color-tk-claude-line)' }}>
            <Composer
              kernel="claude"
              thread={thread}
              placeholder={HERO_COPY.claude.input}
              leading={(
                <button type="button" aria-label="添加附件" className="flex size-[24px] shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-[#2b2622] hover:bg-black/[0.05]">
                  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                </button>
              )}
              trailing={<span className="shrink-0 px-[4px] text-[11px] opacity-55">{thread.models[0]?.split(' · ')[0] ?? 'Opus'}</span>}
              buttonClassName="bg-[#2b2622] text-white"
            />
          </div>
          <div className="mt-[8px] flex items-center gap-[6px] px-[4px] text-[11.5px] opacity-55">
            <span>
              📁
              {dirName}
            </span>
            <span className="ml-auto truncate font-[family-name:var(--font-tk-mono)]">{thread.cwd}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
