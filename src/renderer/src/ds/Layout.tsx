import { Fragment, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, X } from 'lucide-react'
import { t } from '@shared/i18n'
import { IconButton } from './Button'
import { EnvLabel, type EnvLike } from './Status'
import { cx, focusRing } from './utils'

// ---------- Inspector ----------

export const INSPECTOR_WIDTH = { min: 320, default: 380, max: 640 } as const

export function clampInspectorWidth(width: number): number {
  return Math.round(Math.min(INSPECTOR_WIDTH.max, Math.max(INSPECTOR_WIDTH.min, width)))
}

/**
 * Khung Inspector (panel chi tiết bên phải): header (tiêu đề, dòng phụ, hành động, nút đóng), tay
 * nắm đổi độ rộng ở mép trái (kéo chuột; ←/→ khi focus, Shift = bước lớn; nhấp đúp / Enter = mặc
 * định), Esc trong panel để đóng. Nơi dùng giữ độ rộng (để lưu theo máy).
 */
export function Inspector({
  title,
  subtitle,
  icon,
  badges,
  actions,
  children,
  onClose,
  width,
  onWidthChange,
  className,
  'data-testid': testId
}: {
  title: string
  subtitle?: ReactNode
  icon?: ReactNode
  /** Hàng chip dưới tiêu đề (StatusChip trạng thái + meta ngắn). */
  badges?: ReactNode
  actions?: ReactNode
  children: ReactNode
  onClose: () => void
  width: number
  onWidthChange: (width: number) => void
  className?: string
  'data-testid'?: string
}): React.JSX.Element {
  const [resizing, setResizing] = useState(false)
  const start = useRef<{ x: number; width: number } | null>(null)
  return (
    <aside
      aria-label={title}
      data-testid={testId}
      className={cx(
        'relative flex h-full shrink-0 flex-col border-l border-ds-border bg-ds-surface-0 text-ds-base text-ds-fg',
        className
      )}
      style={{ width: clampInspectorWidth(width) }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) {
          e.preventDefault()
          onClose()
        }
      }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('Resize panel')}
        aria-valuemin={INSPECTOR_WIDTH.min}
        aria-valuemax={INSPECTOR_WIDTH.max}
        aria-valuenow={clampInspectorWidth(width)}
        tabIndex={0}
        className={cx(
          'absolute inset-y-0 -left-1 z-(--ds-z-resizer) w-2 cursor-col-resize',
          'after:absolute after:inset-y-0 after:left-[3px] after:w-0.5 after:transition-colors',
          resizing ? 'after:bg-ds-accent' : 'hover:after:bg-ds-border-strong',
          focusRing,
          'focus-visible:after:bg-ds-accent'
        )}
        onPointerDown={(e) => {
          e.preventDefault()
          e.currentTarget.setPointerCapture(e.pointerId)
          start.current = { x: e.clientX, width }
          setResizing(true)
        }}
        onPointerMove={(e) => {
          if (!start.current) return
          onWidthChange(clampInspectorWidth(start.current.width + start.current.x - e.clientX))
        }}
        onPointerUp={() => {
          start.current = null
          setResizing(false)
        }}
        onPointerCancel={() => {
          start.current = null
          setResizing(false)
        }}
        onDoubleClick={() => {
          onWidthChange(INSPECTOR_WIDTH.default)
        }}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 64 : 16
          const next =
            e.key === 'ArrowLeft'
              ? width + step
              : e.key === 'ArrowRight'
                ? width - step
                : e.key === 'Home'
                  ? INSPECTOR_WIDTH.max
                  : e.key === 'End'
                    ? INSPECTOR_WIDTH.min
                    : e.key === 'Enter'
                      ? INSPECTOR_WIDTH.default
                      : null
          if (next === null) return
          e.preventDefault()
          e.stopPropagation()
          onWidthChange(clampInspectorWidth(next))
        }}
      />
      <header className="flex shrink-0 items-start gap-3 px-4 pt-3.5 pb-3">
        {icon && (
          <span className="flex size-8 shrink-0 items-center justify-center rounded-ds-lg border border-ds-border text-ds-fg-2">
            {icon}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-ds-md font-semibold">{title}</h2>
          {subtitle && <div className="truncate text-ds-sm text-ds-fg-3">{subtitle}</div>}
          {badges && <div className="mt-2 flex flex-wrap items-center gap-2">{badges}</div>}
        </div>
        <IconButton label={t('Close')} shortcut="Esc" size="sm" onClick={onClose}>
          <X size={14} strokeWidth={1.5} aria-hidden />
        </IconButton>
      </header>
      {actions && <div className="flex shrink-0 items-center gap-1.5 px-4 pb-3">{actions}</div>}
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </aside>
  )
}

// ---------- Breadcrumb ----------

export interface Crumb {
  id: string
  label: string
  icon?: ReactNode
  onSelect?: () => void
}

/**
 * Đường dẫn trong header: mục cuối đậm (aria-current="page"), mục trước bấm được. Môi trường: một
 * nhãn màu (PROD / STG / DEV / TEST) sau crumb cuối — chỉ một chỗ, không tô màu cả header.
 */
export function Breadcrumb({
  items,
  env,
  className
}: {
  items: readonly Crumb[]
  env?: 'prod' | 'staging' | 'dev' | 'test' | EnvLike
  className?: string
}): React.JSX.Element {
  return (
    <nav aria-label={t('Breadcrumb')} className={cx('min-w-0', className)}>
      <ol className="m-0 flex min-w-0 list-none items-center gap-1 p-0 text-ds-base">
        {items.map((c, i) => {
          const last = i === items.length - 1
          return (
            <Fragment key={c.id}>
              {i > 0 && (
                <li aria-hidden className="flex shrink-0 text-ds-fg-3">
                  <ChevronRight size={14} strokeWidth={1.5} />
                </li>
              )}
              <li className={cx('flex min-w-0 items-center', last ? 'shrink-0' : 'shrink')}>
                {last || !c.onSelect ? (
                  <span
                    aria-current={last ? 'page' : undefined}
                    className={cx(
                      'flex min-w-0 items-center gap-1.5 truncate px-1',
                      last ? 'font-semibold text-ds-fg' : 'text-ds-fg-2'
                    )}
                  >
                    {c.icon}
                    {c.label}
                  </span>
                ) : (
                  <button
                    type="button"
                    className={cx(
                      'flex min-w-0 items-center gap-1.5 truncate rounded-ds-sm px-1 text-ds-fg-2 hover:bg-ds-hover hover:text-ds-fg',
                      focusRing
                    )}
                    onClick={c.onSelect}
                  >
                    {c.icon}
                    {c.label}
                  </button>
                )}
              </li>
            </Fragment>
          )
        })}
        {env && (
          <li className="ml-1.5 flex shrink-0">
            <EnvLabel env={env} size="md" />
          </li>
        )}
      </ol>
    </nav>
  )
}
