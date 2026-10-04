import type { ReactNode } from 'react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { Kbd } from './Kbd'
import { useDs, usePortalContainer } from './provider'

/**
 * Tooltip: hiện sau 450 ms khi rê chuột, ngay lập tức khi focus bằng bàn phím (Radix), Esc để ẩn.
 * Gắn aria-describedby vào phần tử kích hoạt. Có thể kèm phím tắt.
 */
export function Tooltip({
  content,
  shortcut,
  side = 'top',
  children,
  open,
  onOpenChange
}: {
  content: ReactNode
  shortcut?: string
  side?: 'top' | 'bottom' | 'left' | 'right'
  /** Phần tử kích hoạt — phải nhận ref (button, a…). */
  children: React.ReactElement
  open?: boolean
  onOpenChange?: (open: boolean) => void
}): React.JSX.Element {
  const { hasTooltipProvider } = useDs()
  const container = usePortalContainer()
  const tip = (
    <TooltipPrimitive.Root
      {...(open !== undefined ? { open } : {})}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal container={container}>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className="z-(--ds-z-tooltip) inline-flex max-w-72 animate-ds-fade items-center gap-2 rounded-ds-md bg-ds-popover px-2 py-1 text-ds-sm text-ds-fg shadow-ds-popover"
        >
          <span className="min-w-0">{content}</span>
          {shortcut && <Kbd keys={shortcut} />}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
  if (hasTooltipProvider) return tip
  return (
    <TooltipPrimitive.Provider delayDuration={450} skipDelayDuration={300}>
      {tip}
    </TooltipPrimitive.Provider>
  )
}
