import type { ReactNode } from 'react'

/**
 * Header của vùng chính (thiết kế v0.5 — "Main header" 44px): icon của khu vực + breadcrumb (mục
 * cuối đậm), thao tác bên phải. Dùng cho các trang không có header riêng (Home, Transfers, Files).
 */
export function AreaHeader({
  icon,
  title,
  children,
  actions,
  testId
}: {
  icon: ReactNode
  title: string
  /** Phần breadcrumb sau tiêu đề (vd. "· Failed"). */
  children?: ReactNode
  actions?: ReactNode
  testId?: string
}): React.JSX.Element {
  return (
    <div
      className="flex h-ds-header shrink-0 items-center gap-2 border-b border-ds-border-subtle px-4"
      data-testid={testId}
    >
      <span className="flex shrink-0 text-ds-fg-3" aria-hidden>
        {icon}
      </span>
      <h1 className="truncate text-ds-base font-semibold text-ds-fg">{title}</h1>
      {children}
      <div className="flex-1" />
      {actions}
    </div>
  )
}
