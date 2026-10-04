import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Kbd } from './Kbd'
import { Tooltip } from './Tooltip'
import { cx, focusRing, transition } from './utils'

/**
 * Nút. Quy tắc: tối đa MỘT nút primary mỗi màn hình; danger chỉ cho nút xác nhận hành động phá huỷ
 * (trong hộp thoại) — hành động xoá trên thanh công cụ / menu dùng ghost + chữ đỏ khi rê chuột.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

const variantClass: Record<ButtonVariant, string> = {
  primary:
    'bg-ds-accent text-ds-accent-contrast hover:bg-ds-accent-hover active:bg-ds-accent-press disabled:bg-ds-surface-1 disabled:ring-1 disabled:ring-ds-border-subtle disabled:ring-inset',
  secondary:
    'border border-ds-border bg-ds-surface-1 text-ds-fg hover:border-ds-border-strong hover:bg-ds-surface-2 active:bg-ds-surface-3 [&_svg]:text-ds-fg-2',
  ghost:
    'text-ds-fg-2 hover:bg-ds-hover hover:text-ds-fg active:bg-ds-active aria-expanded:bg-ds-active aria-pressed:bg-ds-active aria-pressed:text-ds-fg',
  danger:
    'bg-ds-danger-solid text-ds-danger-contrast hover:bg-ds-danger-solid-hover active:bg-ds-danger-solid disabled:bg-ds-surface-1 disabled:ring-1 disabled:ring-ds-border-subtle disabled:ring-inset'
}

const sizeClass: Record<ButtonSize, string> = {
  sm: 'h-ds-ctl-sm gap-1 rounded-ds-sm px-2 text-ds-sm',
  md: 'h-ds-ctl gap-1.5 rounded-ds-md px-3 text-ds-base',
  lg: 'h-ds-ctl-lg gap-2 rounded-ds-md px-4 text-ds-base'
}

const iconSizeClass: Record<ButtonSize, string> = {
  sm: 'size-ds-ctl-sm rounded-ds-sm',
  md: 'size-ds-ctl rounded-ds-md',
  lg: 'size-ds-ctl-lg rounded-ds-md'
}

const base = cx(
  'inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap select-none',
  'disabled:pointer-events-none disabled:border-ds-border-subtle disabled:text-ds-fg-disabled',
  focusRing,
  transition
)

function Spinner(): React.JSX.Element {
  return (
    <span
      aria-hidden
      className="size-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-current/25 border-t-current motion-reduce:animate-none"
    />
  )
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Icon đứng trước chữ (lucide 16px, stroke 1.5). */
  icon?: ReactNode
  /** Phím tắt hiển thị trong nút. */
  shortcut?: string
  /** Đang chạy: hiện spinner thay icon, khoá nút, aria-busy. */
  loading?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    icon,
    shortcut,
    loading,
    className,
    children,
    type,
    disabled,
    ...rest
  },
  ref
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      disabled={disabled === true || loading === true}
      aria-busy={loading || undefined}
      className={cx(base, variantClass[variant], sizeClass[size], className)}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      {children}
      {shortcut && <Kbd keys={shortcut} subtle={variant === 'primary' || variant === 'danger'} />}
    </button>
  )
})

export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'icon' | 'shortcut'> {
  /** Bắt buộc: tên đọc màn hình + tooltip. */
  label: string
  /** Phím tắt hiện trong tooltip. */
  shortcut?: string
  children: ReactNode
  /** Tắt tooltip (ví dụ khi nút đã nằm trong một trigger có tooltip riêng). */
  noTooltip?: boolean
  tooltipSide?: 'top' | 'bottom' | 'left' | 'right'
}

/** Nút chỉ có icon: luôn có aria-label và tooltip (kèm phím tắt nếu có). */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    label,
    shortcut,
    variant = 'ghost',
    size = 'md',
    className,
    children,
    noTooltip,
    tooltipSide,
    type,
    loading,
    disabled,
    ...rest
  },
  ref
) {
  const button = (
    <button
      ref={ref}
      type={type ?? 'button'}
      aria-label={label}
      disabled={disabled === true || loading === true}
      aria-busy={loading || undefined}
      className={cx(base, variantClass[variant], iconSizeClass[size], className)}
      {...rest}
    >
      {loading ? <Spinner /> : children}
    </button>
  )
  if (noTooltip) return button
  return (
    <Tooltip content={label} {...(shortcut ? { shortcut } : {})} side={tooltipSide ?? 'top'}>
      {button}
    </Tooltip>
  )
})
