import type { MenuItem } from '@deepseek-ai/dsh-client-ui-primitives'
/**
 * The kernel switcher: the official menu primitives, one hover state per instance.
 *
 * Two surfaces render this — the official brand row and a kernel's own rail — and
 * they must never open together, so every hover flag lives inside the component
 * instance rather than in a module-level singleton.
 *
 * The list is portaled because the brand row clips overflow. That makes the list a
 * child of `document.body`, outside the trigger's subtree, so the Menu's own
 * `closeOnPointerLeave` cannot work here: it would close on the very move that
 * enters the list. Hover is tracked by this component instead, over the trigger
 * and over the list element it owns, with a grace delay for the gap between them.
 */
import type { ReactElement } from 'react'
import type { KernelId } from '../../shared/protocol'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useRef, useState } from 'react'
import { KERNEL_META } from '../constants'
import { store } from '../lib/store'
import { useKernelState } from '../lib/use-store'
import { KernelMark } from './kernel-icons'

/** Allowance for travelling between trigger and list, and for a brief overshoot. */
const CLOSE_GRACE_MS = 260

/** Marks the trigger element this instance watches. */
export const TRIGGER_ATTR = 'data-tk-trigger'

/** Rows, in menu order. An absent kernel is still listed: choosing it installs. */
function kernelItems(): MenuItem[] {
  return (['dsh', 'codex', 'claude'] as KernelId[]).map(kernel => ({
    id: kernel,
    label: KERNEL_META[kernel].label,
    icon: <KernelMark kernel={kernel} size={16} />,
  }))
}

interface Props {
  /** Content of the clickable/hoverable trigger. */
  children: ReactElement
  /** Extra class on the trigger wrapper. */
  className?: string
  /** Which way the list opens. */
  side?: 'bottom' | 'top'
  /** Minimum card width; the list never inherits a 20px anchor's width. */
  listClassName?: string
}

export function KernelSwitcher({ children, className, side = 'bottom', listClassName = 'min-w-[248px]!' }: Props): ReactElement {
  const app = useKernelState()
  const [open, setOpen] = useState(false)
  // Unique tag for the card this instance portals, so the document-level tracker
  // can tell its own list from the other switcher's.
  const owner = useRef(`tk-${Math.random().toString(36).slice(2, 8)}`).current
  const trigger = useRef<HTMLSpanElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const cancelClose = useCallback(() => {
    if (closeTimer.current !== undefined) {
      clearTimeout(closeTimer.current)
      closeTimer.current = undefined
    }
  }, [])

  const armClose = useCallback(() => {
    cancelClose()
    closeTimer.current = setTimeout(() => {
      closeTimer.current = undefined
      setOpen(false)
    }, CLOSE_GRACE_MS)
  }, [cancelClose])

  useEffect(() => () => {
    if (closeTimer.current !== undefined)
      clearTimeout(closeTimer.current)
  }, [])

  // Track the pointer on the document: the portaled list is not inside the
  // trigger, and only elements belonging to THIS instance count, so the two
  // switchers can never both be open.
  useEffect(() => {
    if (!open)
      return
    const onMove = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Element)) {
        armClose()
        return
      }
      const own = trigger.current
      const insideTrigger = own !== null && own.contains(target)
      // The list is portaled, so find the nearest menu ancestor and treat it as
      // ours only when it was opened from this trigger.
      const list = target.closest('[role="menu"]')
      const insideList = list !== null && list.getAttribute('data-tk-owner') === owner
      if (insideTrigger || insideList)
        cancelClose()
      else
        armClose()
    }
    document.addEventListener('pointermove', onMove, { passive: true })
    return () => {
      document.removeEventListener('pointermove', onMove)
    }
  }, [open, armClose, cancelClose])

  // Tag the portaled card so the tracker can recognise it as this instance's.
  useEffect(() => {
    if (!open)
      return
    const timer = setTimeout(() => {
      for (const list of document.querySelectorAll('[role="menu"]')) {
        if (!list.hasAttribute('data-tk-owner'))
          list.setAttribute('data-tk-owner', owner)
      }
    }, 0)
    return () => {
      clearTimeout(timer)
    }
  }, [open, owner])

  const choose = (id: string): void => {
    store.select(id as KernelId)
    setOpen(false)
  }

  return (
    <Menu
      open={open}
      onClose={() => setOpen(false)}
      onSelect={choose}
      items={kernelItems()}
      selectedId={app.selected}
      portal
      side={side}
      align="start"
      listClassName={listClassName}
      className={className}
      anchor={(
        <span
          ref={trigger}
          className="inline-flex cursor-pointer items-center"
          {...{ [TRIGGER_ATTR]: '' }}
          onPointerEnter={() => {
            cancelClose()
            setOpen(true)
          }}
          onPointerLeave={armClose}
        >
          {children}
        </span>
      )}
    />
  )
}
