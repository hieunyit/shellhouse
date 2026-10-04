import type { ReactNode } from 'react'
import * as RadioGroup from '@radix-ui/react-radio-group'
import { cx, focusRing, transition } from './utils'

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  icon?: ReactNode
  /** Chỉ hiện icon (label thành aria-label). */
  iconOnly?: boolean
  disabled?: boolean
}

/**
 * Nhóm chọn một (role=radiogroup): ←/→ đổi lựa chọn, Tab dừng một lần ở mục đang chọn (Radix).
 * Mục đang chọn nổi lên bằng nền + viền, không dùng màu accent.
 */
export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  label,
  size = 'md',
  className,
  testIdPrefix
}: {
  value: T
  onValueChange: (value: T) => void
  options: readonly SegmentedOption<T>[]
  /** Tên nhóm cho trình đọc màn hình. */
  label: string
  size?: 'sm' | 'md'
  className?: string
  testIdPrefix?: string
}): React.JSX.Element {
  return (
    <RadioGroup.Root
      value={value}
      onValueChange={(v) => {
        const option = options.find((o) => o.value === v)
        if (option) onValueChange(option.value)
      }}
      orientation="horizontal"
      loop
      aria-label={label}
      className={cx(
        'inline-flex items-center gap-0.5 rounded-ds-md border border-ds-border bg-ds-surface-1 p-0.5',
        size === 'sm' ? 'h-ds-ctl-sm' : 'h-ds-ctl',
        className
      )}
    >
      {options.map((o) => (
        <RadioGroup.Item
          key={o.value}
          value={o.value}
          disabled={o.disabled}
          aria-label={o.iconOnly ? o.label : undefined}
          title={o.iconOnly ? o.label : undefined}
          data-testid={testIdPrefix ? `${testIdPrefix}-${o.value}` : undefined}
          className={cx(
            'inline-flex h-full items-center justify-center gap-1.5 rounded-ds-sm text-ds-sm font-medium text-ds-fg-2',
            'hover:text-ds-fg data-[state=checked]:bg-ds-surface-3 data-[state=checked]:text-ds-fg data-[state=checked]:shadow-[0_0_0_1px_var(--ds-border)]',
            'disabled:text-ds-fg-disabled [&_svg]:shrink-0',
            o.iconOnly ? 'aspect-square' : 'px-2.5',
            focusRing,
            transition
          )}
        >
          {o.icon}
          {!o.iconOnly && o.label}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  )
}
