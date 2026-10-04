import type { ReactNode } from 'react'
import { cx } from '../ui'

/** Một khối trong khung chi tiết của Keychain: tiêu đề nhỏ + nội dung. */
export function DetailSection({
  title,
  hint,
  testId,
  children
}: {
  title: string
  hint?: string
  testId?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-1.5" data-testid={testId}>
      <h4 className="text-xs font-medium text-faint">{title}</h4>
      {children}
      {hint && <p className="text-[11px] text-faint">{hint}</p>}
    </section>
  )
}

/** Dòng "nhãn — giá trị" trong khung chi tiết. */
export function DetailRow({
  label,
  children
}: {
  label: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] items-baseline gap-3 py-1 text-[13px]">
      <span className="text-xs text-muted">{label}</span>
      <span className="min-w-0 text-fg">{children}</span>
    </div>
  )
}

export interface UsageChip {
  id: string
  label: string
  icon?: ReactNode
  title?: string
  hint?: string
  onClick?: () => void
}

/** Danh sách nơi đang dùng (tài khoản / host / nhóm) dạng chip; chip có onClick là liên kết. */
export function UsageChips({
  label,
  items,
  testId
}: {
  label: string
  items: readonly UsageChip[]
  testId?: string
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1" data-testid={testId}>
      <span className="text-xs text-muted">{label}</span>
      <ul className="flex flex-wrap gap-1">
        {items.map((item) => {
          const body = (
            <>
              {item.icon && <span className="shrink-0 text-faint">{item.icon}</span>}
              <span className="truncate">{item.label}</span>
              {item.hint && <span className="shrink-0 text-faint">· {item.hint}</span>}
            </>
          )
          const chip =
            'inline-flex max-w-full items-center gap-1 rounded-full border border-line bg-subtle px-2 py-0.5 text-[11px]'
          return (
            <li key={item.id} className="min-w-0" title={item.title}>
              {item.onClick ? (
                <button
                  type="button"
                  className={cx(chip, 'text-accent hover:border-accent/50 hover:underline')}
                  data-testid="usage-link"
                  onClick={item.onClick}
                >
                  {body}
                </button>
              ) : (
                <span className={cx(chip, 'text-muted')}>{body}</span>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
