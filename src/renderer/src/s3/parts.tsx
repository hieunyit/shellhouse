import { cx } from '../components/ui'

export type SortKey = 'name' | 'size' | 'modified'

export const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
/** Ngày giờ dạng số theo thói quen máy người dùng (không có chữ → giao diện vẫn thuần tiếng Anh). */
export const dateFormat = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit'
})
/** Cột danh sách: Modified / Class chỉ hiện khi khung đủ rộng (container query). */
export const columns =
  'grid-cols-[minmax(0,1fr)_5rem] @xl:grid-cols-[minmax(0,1fr)_5rem_8.5rem] @3xl:grid-cols-[minmax(0,1fr)_5rem_8.5rem_6.5rem]'

export function storageClassLabel(cls: string | null): string {
  if (!cls) return 'Standard'
  return cls
    .toLowerCase()
    .split('_')
    .map((w) => (w === 'ia' ? 'IA' : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
}

/** Mức rộng của khung mà từ đó nút hiện cả chữ (hẹp hơn: chỉ icon + tooltip). */
const labelAt = {
  md: 'hidden @md:inline',
  xl: 'hidden @xl:inline',
  '3xl': 'hidden @3xl:inline',
  '5xl': 'hidden @5xl:inline'
} as const

export function ToolButton({
  icon,
  label,
  labelAt: at,
  testId,
  danger,
  disabled,
  onClick
}: {
  icon: React.ReactNode
  label: string
  labelAt: keyof typeof labelAt
  testId?: string
  danger?: boolean
  disabled?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-testid={testId}
      disabled={disabled}
      className={cx(
        'inline-flex h-7 min-w-7 shrink-0 items-center justify-center gap-1.5 rounded-md px-1.5 text-xs font-medium whitespace-nowrap transition-colors duration-150 disabled:pointer-events-none disabled:opacity-40',
        danger ? 'text-danger hover:bg-danger-soft' : 'text-muted hover:bg-hover hover:text-fg'
      )}
      onClick={onClick}
    >
      {icon}
      <span className={cx(labelAt[at], 'pr-0.5')}>{label}</span>
    </button>
  )
}

export function Empty({
  icon,
  title,
  text,
  action
}: {
  icon: React.ReactNode
  title: string
  text: string
  action: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <span className="flex size-10 items-center justify-center rounded-xl border border-line bg-subtle text-muted">
        {icon}
      </span>
      <p className="mt-1 text-[13px] font-medium text-fg">{title}</p>
      <p className="max-w-xs text-xs text-muted">{text}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}
