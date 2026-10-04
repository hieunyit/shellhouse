import { cx } from '../ui'

/** Mức rộng của khung mà từ đó nút hiện cả chữ (hẹp hơn: chỉ icon + tooltip). */
const labelAt = {
  md: 'hidden @md:inline',
  xl: 'hidden @xl:inline',
  '2xl': 'hidden @2xl:inline',
  '3xl': 'hidden @3xl:inline',
  '4xl': 'hidden @4xl:inline',
  '5xl': 'hidden @5xl:inline'
} as const

export function ToolButton({
  icon,
  label,
  labelAt: at,
  testId,
  danger,
  primary,
  tone,
  title,
  pressed,
  trailing,
  disabled,
  onClick
}: {
  icon: React.ReactNode
  label: string
  labelAt: keyof typeof labelAt
  testId?: string
  danger?: boolean
  /** Hành động chính của trang (nút đặc màu nhấn — một nút mỗi thanh). */
  primary?: boolean
  /** Trạng thái đang bật cần gây chú ý (ví dụ MultiExec). */
  tone?: 'warning' | undefined
  /** Tooltip dài hơn nhãn. */
  title?: string
  /** Nút bật/tắt: đang bật. */
  pressed?: boolean
  /** Phần sau nhãn (mũi tên menu…). */
  trailing?: React.ReactNode
  disabled?: boolean
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={title ?? label}
      aria-label={label}
      aria-pressed={pressed}
      data-testid={testId}
      disabled={disabled}
      className={cx(
        'inline-flex h-ds-ctl min-w-7 shrink-0 items-center justify-center gap-1.5 rounded-ds-md px-1.5 text-xs font-medium whitespace-nowrap transition-colors duration-(--ds-dur-fast) outline-none focus-visible:shadow-ds-focus disabled:pointer-events-none disabled:opacity-40',
        primary
          ? 'bg-accent-solid px-2.5 text-accent-fg hover:bg-accent-solid-hover'
          : danger
            ? 'text-danger hover:bg-danger-soft'
            : tone === 'warning'
              ? 'bg-warning-soft text-warning'
              : pressed
                ? 'bg-ds-active text-fg'
                : 'text-muted hover:bg-ds-hover hover:text-fg'
      )}
      onClick={onClick}
    >
      {icon}
      <span className={cx(labelAt[at], 'pr-0.5')}>{label}</span>
      {trailing}
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
      <span className="flex size-10 items-center justify-center rounded-ds-lg border border-ds-border text-faint">
        {icon}
      </span>
      <p className="mt-1 text-ds-md font-semibold text-fg">{title}</p>
      <p className="max-w-80 text-[13px] text-muted">{text}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}
