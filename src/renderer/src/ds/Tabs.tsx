import type { ReactNode } from 'react'
import * as TabsPrimitive from '@radix-ui/react-tabs'
import { Badge } from './Status'
import { cx, focusRing, transition } from './utils'

export interface TabItem<T extends string> {
  value: T
  label: string
  /** Số đếm: xám trung tính; `countTone` tô theo nghĩa (danger = lỗi, warning = cảnh báo). */
  count?: number
  countTone?: 'neutral' | 'warning' | 'danger'
  disabled?: boolean
}

/**
 * Tab gạch chân (mục con trong Inspector / trang). ←/→ di chuyển, Home/End, roving tabindex (Radix).
 * Chỉ báo tab đang chọn: vạch 2px màu chữ chính (accent dành cho nav chính).
 */
export function Tabs<T extends string>({
  value,
  onValueChange,
  items,
  label,
  children,
  className,
  listClassName
}: {
  value: T
  onValueChange: (value: T) => void
  items: readonly TabItem<T>[]
  /** Tên danh sách tab cho trình đọc màn hình. */
  label: string
  /** Nội dung: dùng <TabPanel value=…> cho từng tab. */
  children?: ReactNode
  className?: string
  listClassName?: string
}): React.JSX.Element {
  return (
    <TabsPrimitive.Root
      value={value}
      onValueChange={(v) => {
        const item = items.find((i) => i.value === v)
        if (item) onValueChange(item.value)
      }}
      activationMode="automatic"
      className={className}
    >
      <TabsPrimitive.List
        aria-label={label}
        className={cx(
          'flex h-ds-tab shrink-0 items-stretch gap-4 overflow-x-auto border-b border-ds-border-subtle px-4 [scrollbar-width:none]',
          listClassName
        )}
      >
        {items.map((item) => (
          <TabsPrimitive.Trigger
            key={item.value}
            value={item.value}
            disabled={item.disabled}
            className={cx(
              'relative -mb-px inline-flex items-center gap-1.5 border-b-2 border-transparent text-ds-base font-medium whitespace-nowrap text-ds-fg-2',
              'hover:text-ds-fg data-[state=active]:border-ds-fg data-[state=active]:text-ds-fg disabled:text-ds-fg-disabled',
              focusRing,
              transition
            )}
          >
            {item.label}
            {item.count !== undefined && (
              <Badge tone={item.countTone ?? 'neutral'} size="sm">
                {item.count}
              </Badge>
            )}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
      {children}
    </TabsPrimitive.Root>
  )
}

export function TabPanel({
  value,
  children,
  className
}: {
  value: string
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <TabsPrimitive.Content value={value} className={cx(focusRing, className)}>
      {children}
    </TabsPrimitive.Content>
  )
}
