import { cx } from './utils'

/**
 * Phím tắt: "Ctrl K" / ["Ctrl", "K"] → từng phím một ô. Đọc màn hình: cả nhóm là một chuỗi
 * ("Ctrl+K"), không đọc từng ô.
 */
export function Kbd({
  keys,
  className,
  subtle
}: {
  keys: string | readonly string[]
  className?: string
  /** Trong nút primary / tooltip: viền mờ hơn, nền trong suốt. */
  subtle?: boolean
}): React.JSX.Element {
  const list = typeof keys === 'string' ? keys.split(' ').filter(Boolean) : keys
  return (
    <span className={cx('inline-flex shrink-0 items-center gap-0.5', className)}>
      <span className="sr-only">{list.join('+')}</span>
      {list.map((k, i) => (
        <kbd
          key={`${k}-${String(i)}`}
          aria-hidden
          className={cx(
            'inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-ds-xs border px-1 font-sans text-ds-xs font-medium tracking-normal tabular-nums',
            subtle
              ? 'border-current/20 bg-transparent text-current/75'
              : 'border-ds-border bg-ds-surface-3 text-ds-fg-2'
          )}
        >
          {k}
        </kbd>
      ))}
    </span>
  )
}
