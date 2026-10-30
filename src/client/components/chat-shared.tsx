/**
 * Pieces both kernel surfaces share.
 *
 * The two pages are deliberately separate designs — a Codex page is monochrome
 * and dense, a Claude page is warm and serif — but the behaviour under them is
 * identical: stream items, approve tool calls, answer questions, interrupt. That
 * behaviour lives here once.
 */
import type { ReactElement, ReactNode } from 'react'
import type { ThirdPartyKernelId } from '../../shared/protocol'
import type { PendingPrompt, Thread, ThreadItem } from '../lib/store'
import { Fragment, useEffect, useRef, useState } from 'react'
import { answerPrompt, startTurn, stopTurn } from '../lib/runner'

/** Folder name of a path, for compact headers. */
export function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}

/** One streamed item, rendered by the caller's own visual language. */
export interface ItemRenderers {
  user: (item: Extract<ThreadItem, { role: 'user' }>) => ReactNode
  assistant: (item: Extract<ThreadItem, { role: 'assistant' }>) => ReactNode
  thinking: (item: Extract<ThreadItem, { role: 'thinking' }>) => ReactNode
  tool: (item: Extract<ThreadItem, { role: 'tool' }>) => ReactNode
  error: (item: Extract<ThreadItem, { role: 'error' }>) => ReactNode
}

/** Render every item through the caller's renderer for its role. */
export function ThreadItems({ items, render }: { items: readonly ThreadItem[], render: ItemRenderers }): ReactElement {
  return (
    <>
      {items.map(item => (
        <Fragment key={item.key}>
          {item.role === 'user'
            ? render.user(item)
            : item.role === 'assistant'
              ? render.assistant(item)
              : item.role === 'thinking'
                ? render.thinking(item)
                : item.role === 'tool'
                  ? render.tool(item)
                  : render.error(item)}
        </Fragment>
      ))}
    </>
  )
}

/**
 * Composer behaviour shared by both surfaces: a textarea that grows, submits on
 * Enter, keeps Shift+Enter for newlines, and swaps its action button into a stop
 * button while the kernel is working.
 */
export interface ComposerProps {
  kernel: ThirdPartyKernelId
  thread: Thread
  placeholder: string
  /** Leading accessory controls rendered inside the composer frame. */
  leading?: ReactNode
  /** Trailing controls before the submit button. */
  trailing?: ReactNode
  className?: string
  inputClassName?: string
  buttonClassName?: string
}

export function Composer({ kernel, thread, placeholder, leading, trailing, className, inputClassName, buttonClassName }: ComposerProps): ReactElement {
  const [value, setValue] = useState('')
  const area = useRef<HTMLTextAreaElement>(null)
  const disabled = thread.sessionId === null && thread.running

  useEffect(() => {
    if (area.current !== null) {
      area.current.style.height = 'auto'
      area.current.style.height = `${Math.min(area.current.scrollHeight, 220)}px`
    }
  }, [value])

  const submit = (): void => {
    const text = value.trim()
    if (text === '' || thread.running)
      return
    setValue('')
    void startTurn(kernel, thread.key, text)
  }

  return (
    <div className={`flex items-end gap-[8px] ${className ?? ''}`}>
      {leading}
      <textarea
        ref={area}
        rows={1}
        value={value}
        placeholder={placeholder}
        onChange={event => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            submit()
          }
        }}
        className={`tk-scroll max-h-[220px] min-h-[24px] flex-1 resize-none border-0 bg-transparent text-[14px] leading-[1.6] outline-none placeholder:opacity-45 ${inputClassName ?? ''}`}
      />
      {trailing}
      {thread.running
        ? (
            <button
              type="button"
              aria-label="停止生成"
              className="flex size-[28px] shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-current/85 text-white"
              onClick={() => void stopTurn(kernel, thread.key)}
            >
              <span className="block size-[9px] rounded-[2px] bg-current" style={{ color: 'var(--color-tk-codex-paper)' }} />
            </button>
          )
        : (
            <button
              type="button"
              aria-label="发送"
              disabled={value.trim() === '' || disabled}
              className={`flex size-[28px] shrink-0 origin-center cursor-pointer items-center justify-center rounded-full border-0 transition-opacity disabled:cursor-not-allowed disabled:opacity-35 ${buttonClassName ?? ''}`}
              onClick={submit}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M8 12.5V3.5M8 3.5 4 7.5M8 3.5l4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
    </div>
  )
}

/**
 * The blocking prompt for tool approval or a kernel question. It renders inline
 * above the composer so the conversation stays readable while the native turn
 * waits — the turn genuinely cannot proceed until this is answered.
 */
export interface PendingPromptProps {
  kernel: ThirdPartyKernelId
  thread: Thread
  pending: PendingPrompt
  className?: string
}

export function PromptBar({ kernel, thread, pending, className }: PendingPromptProps): ReactElement {
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({})
  if (pending.kind === 'approval') {
    return (
      <div className={`flex flex-col gap-[8px] rounded-[10px] border border-black/10 bg-white p-[12px] text-[13px] ${className ?? ''}`}>
        <div className="flex items-center gap-[6px] font-medium">
          <span className="inline-block size-[6px] rounded-full bg-amber-500" />
          内核请求许可
        </div>
        <div className="max-h-[140px] overflow-auto whitespace-pre-wrap break-words rounded-[6px] bg-black/[0.04] p-[8px] font-mono text-[12px] leading-[1.5]">{pending.details}</div>
        <div className="flex gap-[8px]">
          <button
            type="button"
            className="cursor-pointer rounded-[6px] border-0 bg-[#111] px-[12px] py-[6px] text-[12px] text-white"
            onClick={() => void answerPrompt(kernel, thread.key, { allowed: true })}
          >
            允许
          </button>
          <button
            type="button"
            className="cursor-pointer rounded-[6px] border border-black/12 bg-transparent px-[12px] py-[6px] text-[12px]"
            onClick={() => void answerPrompt(kernel, thread.key, { allowed: false })}
          >
            拒绝
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className={`flex flex-col gap-[8px] rounded-[10px] border border-black/10 bg-white p-[12px] text-[13px] ${className ?? ''}`}>
      {pending.questions.map(question => (
        <div key={question.id} className="flex flex-col gap-[6px]">
          <span className="font-medium">{question.question}</span>
          {question.options === undefined
            ? (
                <input
                  className="rounded-[6px] border border-black/12 px-[8px] py-[6px] text-[13px] outline-none"
                  value={typeof answers[question.id] === 'string' ? answers[question.id] as string : ''}
                  onChange={event => setAnswers(current => ({ ...current, [question.id]: event.target.value }))}
                />
              )
            : question.options.map(option => (
                <button
                  key={option.label}
                  type="button"
                  className={`cursor-pointer rounded-[6px] border px-[10px] py-[6px] text-left text-[12px] ${answers[question.id] === option.label ? 'border-black/40 bg-black/[0.05]' : 'border-black/12 bg-transparent'}`}
                  onClick={() => setAnswers(current => ({ ...current, [question.id]: option.label }))}
                >
                  {option.label}
                  {option.description !== undefined && <span className="ml-[6px] opacity-50">{option.description}</span>}
                </button>
              ))}
        </div>
      ))}
      <button
        type="button"
        className="self-start cursor-pointer rounded-[6px] border-0 bg-[#111] px-[12px] py-[6px] text-[12px] text-white"
        onClick={() => void answerPrompt(kernel, thread.key, { answers })}
      >
        提交回答
      </button>
    </div>
  )
}

/** Scroll the newest content into view whenever the item count changes. */
export function useScrollToEnd(ref: { current: HTMLElement | null }, count: number): void {
  useEffect(() => {
    const element = ref.current
    if (element !== null)
      element.scrollTop = element.scrollHeight
  }, [ref, count])
}
