import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertCircle, AlertTriangle, Check, CheckCircle2, Copy, Info, X } from 'lucide-react'
import { t } from '@shared/i18n'
import { Button } from './Button'
import { cx, focusRing } from './utils'

// ---------- Toast ----------

/**
 * Thông báo nhỏ góc dưới: nền trung tính, icon màu theo nghĩa — thành công xanh lá, thông tin xanh
 * dương, cảnh báo vàng, lỗi đỏ (neutral: icon xám). Tự đóng sau 5 s (dừng khi rê chuột / focus),
 * danger không tự đóng. role=status (đọc lịch sự) / alert (danger).
 */
export type ToastTone = 'neutral' | 'success' | 'info' | 'warning' | 'danger'

const toastIconClass: Record<ToastTone, string> = {
  neutral: 'text-ds-fg-2',
  success: 'text-ds-success',
  info: 'text-ds-info',
  warning: 'text-ds-warning',
  danger: 'text-ds-danger'
}

export function Toast({
  tone = 'neutral',
  title,
  description,
  action,
  onClose,
  duration = 5000
}: {
  tone?: ToastTone
  title: string
  description?: ReactNode
  /** Ví dụ Undo / Retry. */
  action?: { label: string; onClick: () => void }
  onClose: () => void
  /** ms; 0 = không tự đóng. */
  duration?: number
}): React.JSX.Element {
  const [paused, setPaused] = useState(false)
  const latest = useRef(onClose)
  useEffect(() => {
    latest.current = onClose
  })
  const timeout = tone === 'danger' ? 0 : duration
  useEffect(() => {
    if (!timeout || paused) return
    const timer = setTimeout(() => {
      latest.current()
    }, timeout)
    return () => {
      clearTimeout(timer)
    }
  }, [timeout, paused])

  const Icon =
    tone === 'danger'
      ? AlertCircle
      : tone === 'warning'
        ? AlertTriangle
        : tone === 'success'
          ? CheckCircle2
          : Info
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className="flex w-90 max-w-full animate-ds-pop items-start gap-2.5 rounded-ds-lg bg-ds-popover px-3 py-2.5 text-ds-base text-ds-fg shadow-ds-popover"
      onMouseEnter={() => {
        setPaused(true)
      }}
      onMouseLeave={() => {
        setPaused(false)
      }}
      onFocus={() => {
        setPaused(true)
      }}
      onBlur={() => {
        setPaused(false)
      }}
    >
      <span className={cx('mt-0.5 flex shrink-0', toastIconClass[tone])}>
        <Icon size={16} strokeWidth={1.5} aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-medium">{title}</div>
        {description && <div className="text-ds-sm text-ds-fg-2">{description}</div>}
      </div>
      {action && (
        <Button size="sm" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
      <button
        type="button"
        aria-label={t('Dismiss')}
        className={cx(
          '-mr-1 flex size-ds-ctl-sm shrink-0 items-center justify-center rounded-ds-sm text-ds-fg-3 hover:bg-ds-hover hover:text-ds-fg',
          focusRing
        )}
        onClick={onClose}
      >
        <X size={14} strokeWidth={1.5} aria-hidden />
      </button>
    </div>
  )
}

/** Vùng chứa toast (góc dưới phải, trên mọi lớp). */
export function ToastViewport({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed right-4 bottom-4 z-(--ds-z-toast) flex flex-col items-end gap-2 *:pointer-events-auto"
    >
      {children}
    </div>
  )
}

// ---------- PropertyList ----------

export interface Property {
  label: string
  value: ReactNode
  /** Chuỗi sao chép được (hiện nút sao chép khi rê chuột / focus). */
  copy?: string
  mono?: boolean
}

/** Danh sách thuộc tính (<dl>): nhãn mờ cột trái, giá trị chữ chính; sao chép khi rê chuột. */
export function PropertyList({
  items,
  labelWidth = 112,
  className
}: {
  items: readonly Property[]
  labelWidth?: number
  className?: string
}): React.JSX.Element {
  return (
    <dl
      className={cx('grid items-center text-ds-base', className)}
      style={{ gridTemplateColumns: `${String(labelWidth)}px minmax(0, 1fr)` }}
    >
      {items.map((p) => (
        <div key={p.label} className="group contents">
          <dt className="flex min-h-ds-prop-row items-center pr-3 text-ds-fg-3">{p.label}</dt>
          <dd className="m-0 flex min-h-ds-prop-row min-w-0 items-center gap-1.5">
            <span
              className={cx(
                'min-w-0 truncate select-text',
                p.mono && 'font-mono text-ds-sm tracking-normal'
              )}
            >
              {p.value}
            </span>
            {p.copy !== undefined && <CopyButton value={p.copy} label={p.label} />}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function CopyButton({ value, label }: { value: string; label: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => {
      setCopied(false)
    }, 1200)
    return () => {
      clearTimeout(timer)
    }
  }, [copied])
  return (
    <button
      type="button"
      aria-label={copied ? t('Copied') : t('Copy {name}', { name: label })}
      title={copied ? t('Copied') : t('Copy')}
      className={cx(
        'flex size-5 shrink-0 items-center justify-center rounded-ds-sm text-ds-fg-3 opacity-0 group-hover:opacity-100 hover:bg-ds-hover hover:text-ds-fg focus-visible:opacity-100',
        copied && 'opacity-100',
        focusRing
      )}
      onClick={() => {
        void window.shellhouse.writeClipboard(value).then(() => {
          setCopied(true)
        })
      }}
    >
      {copied ? (
        <Check size={12} strokeWidth={1.5} aria-hidden />
      ) : (
        <Copy size={12} strokeWidth={1.5} aria-hidden />
      )}
    </button>
  )
}

// ---------- EmptyState ----------

/**
 * Trạng thái trống / không có kết quả / lỗi: icon trung tính, một câu giải thích, hành động kế
 * tiếp. Lỗi dùng chữ của người dùng (nguyên nhân) + Thử lại; icon lỗi mới có màu.
 */
export function EmptyState({
  icon,
  title,
  description,
  actions,
  tone = 'neutral',
  className
}: {
  icon?: ReactNode
  title: string
  description?: ReactNode
  actions?: ReactNode
  tone?: 'neutral' | 'danger'
  className?: string
}): React.JSX.Element {
  return (
    <div
      role={tone === 'danger' ? 'alert' : undefined}
      className={cx('flex flex-col items-center px-4 py-8 text-center', className)}
    >
      {icon && (
        <span
          className={cx(
            'mb-3 flex size-10 items-center justify-center rounded-ds-lg border border-ds-border',
            tone === 'danger' ? 'text-ds-danger' : 'text-ds-fg-3'
          )}
        >
          {icon}
        </span>
      )}
      <div className="text-ds-md font-semibold text-ds-fg">{title}</div>
      {description && <div className="mt-1 max-w-80 text-ds-base text-ds-fg-2">{description}</div>}
      {actions && <div className="mt-4 flex gap-2">{actions}</div>}
    </div>
  )
}

// ---------- Skeleton ----------

/** Thanh giữ chỗ khi đang tải (nhấp nháy nhẹ, tắt khi giảm chuyển động). */
export function Skeleton({
  width = '100%',
  height = 10,
  className
}: {
  width?: number | string
  height?: number
  className?: string
}): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={cx(
        'block animate-[ds-shimmer_1.2s_ease-in-out_infinite_alternate] rounded-ds-xs bg-ds-surface-3 motion-reduce:animate-none',
        className
      )}
      style={{ width, height }}
    />
  )
}

/** Hàng giữ chỗ cao đúng bằng hàng bảng (không xô bố cục khi dữ liệu về). */
export function SkeletonRows({
  rows = 5,
  label
}: {
  rows?: number
  /** Đọc màn hình: "Đang tải…". */
  label?: string
}): React.JSX.Element {
  const widths = ['62%', '44%', '56%', '38%', '50%']
  return (
    <div role="status" aria-label={label ?? t('Loading…')} className="flex flex-col">
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="flex h-ds-row items-center gap-4 border-b border-ds-border-subtle px-ds-cell"
        >
          <Skeleton width={widths[i % widths.length]} />
          <Skeleton width="18%" className="ml-auto" />
        </div>
      ))}
    </div>
  )
}
