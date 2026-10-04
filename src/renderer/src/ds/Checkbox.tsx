import { forwardRef, useId, type ReactNode } from 'react'
import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import * as SwitchPrimitive from '@radix-ui/react-switch'
import { Check, Minus } from 'lucide-react'
import { cx, focusRing, transition } from './utils'

export type CheckedState = boolean | 'indeterminate'

/** Ô chọn 14px (role=checkbox, aria-checked="mixed" khi chọn một phần). */
export const Checkbox = forwardRef<
  HTMLButtonElement,
  {
    checked: CheckedState
    onCheckedChange: (checked: boolean) => void
    label?: ReactNode
    description?: ReactNode
    disabled?: boolean
    /** Khi không có label hiển thị (ô chọn hàng trong bảng…). */
    'aria-label'?: string
    className?: string
    tabIndex?: number
    'data-testid'?: string
  }
>(function Checkbox(
  { checked, onCheckedChange, label, description, disabled, className, ...rest },
  ref
) {
  const id = useId()
  const box = (
    <CheckboxPrimitive.Root
      ref={ref}
      id={id}
      checked={checked}
      disabled={disabled}
      onCheckedChange={(v) => {
        onCheckedChange(v === true)
      }}
      className={cx(
        'flex size-3.5 shrink-0 items-center justify-center rounded-ds-xs border border-ds-border-strong bg-ds-surface-1 text-ds-accent-contrast',
        'hover:border-ds-fg-3 data-[state=checked]:border-ds-accent data-[state=checked]:bg-ds-accent data-[state=indeterminate]:border-ds-accent data-[state=indeterminate]:bg-ds-accent',
        'disabled:opacity-40',
        focusRing,
        transition,
        !label && className
      )}
      {...rest}
    >
      <CheckboxPrimitive.Indicator>
        {checked === 'indeterminate' ? (
          <Minus size={10} strokeWidth={2.5} aria-hidden />
        ) : (
          <Check size={10} strokeWidth={2.5} aria-hidden />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
  if (!label) return box
  return (
    <div className={cx('flex items-start gap-2', className)}>
      <span className="flex h-5 items-center">{box}</span>
      <label
        htmlFor={id}
        className={cx('min-w-0 text-ds-base', disabled ? 'text-ds-fg-disabled' : 'text-ds-fg')}
      >
        {label}
        {description && <span className="block text-ds-sm text-ds-fg-2">{description}</span>}
      </label>
    </div>
  )
})

/** Công tắc bật / tắt (role=switch). */
export function Switch({
  checked,
  onCheckedChange,
  label,
  description,
  disabled,
  className,
  ...rest
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  label?: ReactNode
  description?: ReactNode
  disabled?: boolean
  'aria-label'?: string
  className?: string
  'data-testid'?: string
}): React.JSX.Element {
  const id = useId()
  const control = (
    <SwitchPrimitive.Root
      id={id}
      checked={checked}
      disabled={disabled}
      onCheckedChange={onCheckedChange}
      className={cx(
        'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border border-ds-border-strong bg-ds-surface-3',
        'data-[state=checked]:border-ds-accent data-[state=checked]:bg-ds-accent disabled:opacity-40',
        focusRing,
        transition
      )}
      {...rest}
    >
      <SwitchPrimitive.Thumb
        className={cx(
          'block size-3 translate-x-px rounded-full bg-ds-fg-2 data-[state=checked]:translate-x-[13px] data-[state=checked]:bg-ds-accent-contrast',
          transition
        )}
      />
    </SwitchPrimitive.Root>
  )
  if (!label) return <span className={className}>{control}</span>
  return (
    <div className={cx('flex items-start justify-between gap-4', className)}>
      <label htmlFor={id} className="min-w-0 text-ds-base text-ds-fg">
        {label}
        {description && <span className="block text-ds-sm text-ds-fg-2">{description}</span>}
      </label>
      <span className="flex h-5 items-center">{control}</span>
    </div>
  )
}
