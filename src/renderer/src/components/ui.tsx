import {
  forwardRef,
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type RefObject,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes
} from 'react'
import { X } from 'lucide-react'

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

// ---------- Button ----------

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost'
type Size = 'sm' | 'md'

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover',
  secondary: 'border border-line bg-surface text-fg hover:bg-hover',
  ghost: 'text-muted hover:bg-hover hover:text-fg',
  danger: 'bg-danger text-white hover:opacity-90',
  'danger-ghost': 'text-danger hover:bg-danger-soft'
}
const sizes: Record<Size, string> = {
  sm: 'h-7 gap-1.5 px-2.5 text-xs',
  md: 'h-8 gap-2 px-3 text-[13px]'
}

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; icon?: ReactNode }
>(function Button(
  { variant = 'secondary', size = 'md', icon, className, children, type, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-md font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-45',
        variants[variant],
        sizes[size],
        className
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  )
})

export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; size?: 'sm' | 'md' }
>(function IconButton({ label, active, size = 'md', className, children, type, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40',
        size === 'sm' ? 'size-6' : 'size-8',
        active && 'bg-hover text-fg',
        className
      )}
      {...rest}
    >
      {children}
    </button>
  )
})

// ---------- Inputs ----------

const control =
  'w-full rounded-md border border-line bg-surface px-2.5 text-[13px] text-fg placeholder:text-faint outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:opacity-50'

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }
>(function Input({ className, mono, ...rest }, ref) {
  return (
    <input
      ref={ref}
      className={cx(control, 'h-8', mono && 'font-mono text-xs', className)}
      {...rest}
    />
  )
})

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <select ref={ref} className={cx(control, 'h-8 pr-7', className)} {...rest}>
        {children}
      </select>
    )
  }
)

export const TextArea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function TextArea({ className, ...rest }, ref) {
  return (
    <textarea ref={ref} className={cx(control, 'py-2 font-mono text-xs', className)} {...rest} />
  )
})

export function Checkbox({
  label,
  description,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & {
  label: ReactNode
  description?: ReactNode
}): React.JSX.Element {
  return (
    <label
      className={cx(
        'flex cursor-pointer items-start gap-2.5 text-[13px]',
        rest.disabled && 'cursor-not-allowed opacity-60',
        className
      )}
    >
      <input
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 accent-[var(--sh-accent)]"
        {...rest}
      />
      <span className="min-w-0">
        <span className="text-fg">{label}</span>
        {description && <span className="mt-0.5 block text-xs text-muted">{description}</span>}
      </span>
    </label>
  )
}

export function Field({
  label,
  hint,
  children,
  className
}: {
  label: string
  hint?: ReactNode
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <label className={cx('flex flex-col gap-1.5', className)}>
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="text-xs text-faint">{hint}</span>}
    </label>
  )
}

/** Nhóm nút chọn một (segmented control). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  testIdPrefix
}: {
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
  testIdPrefix?: string
}): React.JSX.Element {
  return (
    <div role="radiogroup" className="inline-flex rounded-md border border-line bg-subtle p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          data-testid={testIdPrefix ? `${testIdPrefix}-${o.value}` : undefined}
          className={cx(
            'h-7 rounded px-3 text-xs font-medium transition-colors',
            value === o.value ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg'
          )}
          onClick={() => {
            onChange(o.value)
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// ---------- Feedback ----------

export function Notice({
  tone = 'info',
  children,
  testId
}: {
  tone?: 'info' | 'success' | 'warning' | 'danger'
  children: ReactNode
  testId?: string
}): React.JSX.Element {
  const tones = {
    info: 'border-line bg-subtle text-muted',
    success: 'border-success/30 bg-success-soft text-success',
    warning: 'border-warning/30 bg-warning-soft text-warning',
    danger: 'border-danger/30 bg-danger-soft text-danger'
  }
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      data-testid={testId}
      className={cx('rounded-md border px-3 py-2 text-xs', tones[tone])}
    >
      {children}
    </div>
  )
}

export function Kbd({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <kbd className="rounded border border-line bg-subtle px-1.5 py-0.5 font-mono text-[11px] text-muted">
      {children}
    </kbd>
  )
}

export function SectionTitle({
  children,
  description
}: {
  children: ReactNode
  description?: ReactNode
}): React.JSX.Element {
  return (
    <div className="mb-3">
      <h3 className="text-sm font-semibold text-fg">{children}</h3>
      {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
    </div>
  )
}

// ---------- Modal ----------

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.offsetParent !== null || el === document.activeElement
  )
}

/**
 * Giữ focus trong hộp thoại: Tab / Shift+Tab xoay vòng bên trong; khi mở, focus vào phần tử
 * `autoFocus` (hoặc phần tử đầu tiên); khi đóng, trả focus về chỗ cũ (ví dụ terminal).
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = ref.current
    if (!root) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // autoFocus của React chạy trước effect này; chỉ tự chọn khi focus còn ở ngoài.
    if (!root.contains(document.activeElement)) (focusables(root)[0] ?? root).focus()

    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return
      const items = focusables(root)
      const first = items[0]
      const last = items.at(-1)
      if (!first || !last) {
        event.preventDefault()
        return
      }
      const active = document.activeElement
      if (event.shiftKey && (active === first || !root.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !root.contains(active))) {
        event.preventDefault()
        first.focus()
      }
    }
    root.addEventListener('keydown', onKey)
    return () => {
      root.removeEventListener('keydown', onKey)
      // Chỉ trả focus nếu focus đang ở trong hộp thoại vừa đóng (hoặc đã rơi về body).
      const active = document.activeElement
      const lost = !active || active === document.body || root.contains(active)
      if (lost && previous?.isConnected) previous.focus()
    }
  }, [ref])
}

/** Ngăn xếp hộp thoại đang mở: Esc chỉ đóng hộp thoại trên cùng. */
const stack: symbol[] = []

export function useEscapeToClose(onClose: () => void): void {
  const latest = useRef(onClose)
  useEffect(() => {
    latest.current = onClose
  })
  useEffect(() => {
    const id = Symbol('modal')
    stack.push(id)
    const onKey = (event: KeyboardEvent): void => {
      // Không phụ thuộc focus: nút bị disable hay focus rơi ra ngoài vẫn đóng được.
      if (event.key !== 'Escape' || stack.at(-1) !== id) return
      // Phần tử đang tự bắt phím (ví dụ ô ghi phím tắt) được xử lý Esc trước.
      const target = event.target as HTMLElement | null
      if (target?.closest('[data-capture-keys="true"]')) return
      event.preventDefault()
      event.stopPropagation()
      latest.current()
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true })
      stack.splice(stack.indexOf(id), 1)
    }
  }, [])
}

export function Modal({
  title,
  description,
  onClose,
  children,
  footer,
  width = 'max-w-lg',
  testId,
  bodyClassName
}: {
  title: string
  description?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: string
  testId?: string
  bodyClassName?: string
}): React.JSX.Element {
  useEscapeToClose(onClose)
  const dialogRef = useRef<HTMLDivElement>(null)
  useFocusTrap(dialogRef)
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4 backdrop-blur-[1px] dark:bg-black/60"
      onMouseDown={(e) => {
        // Bấm ra nền không làm mất focus khỏi hộp thoại.
        if (e.target === e.currentTarget) e.preventDefault()
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={testId}
        className={cx(
          'shadow-elevated flex max-h-full w-full flex-col rounded-xl border border-line bg-elevated outline-none',
          width
        )}
      >
        <header className="flex items-start gap-3 px-5 pt-4 pb-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold text-fg">{title}</h2>
            {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
          </div>
          <IconButton label="Close" size="sm" onClick={onClose}>
            <X size={15} />
          </IconButton>
        </header>
        <div className={cx('overflow-auto px-5 pb-5', bodyClassName)}>{children}</div>
        {footer && (
          <footer className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>
  )
}
