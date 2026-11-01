import type { ComponentProps, ReactElement, ReactNode } from 'react'
import { forwardRef } from 'react'

export type ChipVariant = 'seat' | 'composerTrigger' | 'selector'
export interface ChipProps extends Omit<ComponentProps<'button'>, 'children' | 'ref'> {
  variant: ChipVariant
  icon?: ReactNode
  badge?: ReactNode
  chevron?: ReactNode
  open?: boolean
  children?: ReactNode
}

const variants: Record<ChipVariant, { base: string, icon: string, label: string, chevron: string }> = {
  seat: { base: 'gap-[4px] min-w-0 max-w-[min(100%,240px)] min-h-[28px] px-[8px] text-[13px] leading-[20px] text-primary whitespace-nowrap hover:not-disabled:bg-hover aria-expanded:bg-hover disabled:text-[var(--dsw-alias-label-quaternary)]', icon: 'text-primary', label: 'min-w-0 truncate', chevron: '' },
  composerTrigger: { base: 'gap-[4px] min-w-0 max-w-[220px] h-[28px] pl-[8px] pr-[4px] text-[13px] leading-[20px] text-secondary outline-none hover:not-disabled:bg-hover focus-visible:shadow-focus-ring disabled:text-dimmed', icon: '[&_svg]:w-[14px] [&_svg]:h-[14px]', label: '@max-[460px]:hidden min-w-0 truncate', chevron: 'transition-transform duration-[120ms] ease-[ease] data-[open=true]:rotate-180' },
  selector: { base: 'gap-[12px] h-[36px] px-[14px] rounded-md bg-module-platform [font-family:inherit] text-[14px] leading-[22px] text-primary hover:not-disabled:bg-hover', icon: '', label: '', chevron: 'transition-transform duration-[120ms] ease-[ease] data-[open=true]:rotate-180' },
}

export const Chip = forwardRef<HTMLButtonElement, ChipProps>(({ variant, icon, badge, chevron, open, className, children, ...rest }, ref): ReactElement => {
  const style = variants[variant]
  const wraps = variant !== 'selector'
  const base = ['inline-flex items-center border-none rounded-sm bg-transparent font-medium cursor-pointer disabled:cursor-default', style.base].join(' ')
  const chevronClass = ['inline-flex shrink-0 text-[var(--dsw-alias-label-caption)] [&_svg]:w-[11px] [&_svg]:h-[11px]', style.chevron].join(' ')
  return (
    <button type="button" className={className === undefined ? base : [base, className].join(' ')} {...rest} ref={ref}>
      {wraps && icon != null ? <span className={['inline-flex shrink-0', style.icon].join(' ')} aria-hidden>{icon}</span> : icon}
      {wraps && children != null ? <span className={style.label}>{children}</span> : children}
      {wraps && badge != null ? <span className="shrink-0" aria-hidden>{badge}</span> : badge}
      {chevron === undefined ? null : <span className={chevronClass} aria-hidden data-open={open === true ? 'true' : undefined}>{chevron}</span>}
    </button>
  )
})
