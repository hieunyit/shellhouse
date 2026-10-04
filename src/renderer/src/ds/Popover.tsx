import type { ReactNode } from 'react'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import { usePortalContainer } from './provider'
import { cx } from './utils'

/** Lớp nổi chung của DS: nền popover, viền + bóng mềm, bo 8px, xuất hiện ≤ 100ms. */
export const floatingSurface =
  'z-(--ds-z-dropdown) rounded-ds-lg bg-ds-popover text-ds-base text-ds-fg shadow-ds-popover animate-ds-pop outline-none'

/**
 * Popover: Esc / bấm ra ngoài để đóng, focus trả về nút mở (Radix). Nội dung tự quyết định focus
 * đầu tiên (mặc định phần tử bấm được đầu tiên).
 */
export function Popover({
  trigger,
  children,
  open,
  onOpenChange,
  side = 'bottom',
  align = 'start',
  label,
  className
}: {
  /** Phần tử mở popover (phải nhận ref). */
  trigger: React.ReactElement
  children: ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
  /** Tên hộp thoại cho trình đọc màn hình. */
  label: string
  className?: string
}): React.JSX.Element {
  const container = usePortalContainer()
  return (
    <PopoverPrimitive.Root
      {...(open !== undefined ? { open } : {})}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal container={container}>
        <PopoverPrimitive.Content
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          aria-label={label}
          className={cx(floatingSurface, 'w-72 p-3', className)}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}
