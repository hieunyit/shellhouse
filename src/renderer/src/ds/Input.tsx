import {
  cloneElement,
  forwardRef,
  isValidElement,
  useId,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode
} from 'react'
import { AlertCircle, Search, X } from 'lucide-react'
import { t } from '@shared/i18n'
import { Kbd } from './Kbd'
import { cx, ICON_SM, transition } from './utils'

/**
 * Ô nhập: khung (viền 1px, focus = viền accent + quầng mờ) bọc <input> trần. Lỗi = viền đỏ +
 * aria-invalid; thông báo lỗi do Field hiển thị (kèm icon, không chỉ dựa màu).
 */
const frame = cx(
  'flex h-ds-ctl min-w-0 items-center gap-1.5 rounded-ds-md border border-ds-border-control bg-ds-surface-1 px-2 text-ds-base text-ds-fg',
  'hover:border-ds-fg-3 focus-within:border-ds-accent focus-within:bg-ds-surface-0 focus-within:ring-3 focus-within:ring-ds-accent-soft',
  'has-[input:disabled]:border-ds-border-subtle has-[input:disabled]:text-ds-fg-disabled',
  'has-[[aria-invalid=true]]:border-ds-danger has-[[aria-invalid=true]]:focus-within:ring-ds-danger-soft',
  transition
)

const bare =
  'h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-ds-fg-3 disabled:placeholder:text-ds-fg-disabled'

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** Icon trước chữ (14px, màu chữ mờ). */
  leading?: ReactNode
  /** Nội dung cuối ô (nút xoá, phím tắt…). */
  trailing?: ReactNode
  invalid?: boolean
  mono?: boolean
  size?: 'md' | 'lg'
  /** Class cho khung (bề rộng…). */
  className?: string
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { leading, trailing, invalid, mono, size = 'md', className, ...rest },
  ref
) {
  return (
    <div
      className={cx(frame, size === 'lg' && 'h-ds-ctl-lg rounded-ds-lg px-3 text-ds-md', className)}
    >
      {leading && <span className="flex shrink-0 text-ds-fg-3">{leading}</span>}
      <input
        ref={ref}
        aria-invalid={invalid || undefined}
        spellCheck={false}
        className={cx(bare, mono && 'font-mono text-ds-sm tracking-normal')}
        {...rest}
      />
      {trailing}
    </div>
  )
})

/**
 * Ô lọc / tìm: icon kính lúp, gợi ý phím tắt (mặc định "/") khi trống, nút xoá khi có chữ.
 * Esc xoá chữ (lần nữa thì để Esc lan ra ngoài).
 */
export const SearchInput = forwardRef<
  HTMLInputElement,
  Omit<InputProps, 'leading' | 'trailing' | 'value' | 'onChange'> & {
    value: string
    onValueChange: (value: string) => void
    /** Phím tắt focus ô (chỉ hiển thị; nơi dùng tự gắn phím). */
    shortcut?: string
  }
>(function SearchInput({ value, onValueChange, shortcut = '/', onKeyDown, ...rest }, ref) {
  return (
    <Input
      ref={ref}
      type="search"
      role="searchbox"
      leading={<Search {...ICON_SM} aria-hidden />}
      value={value}
      onChange={(e) => {
        onValueChange(e.target.value)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && value) {
          e.preventDefault()
          e.stopPropagation()
          onValueChange('')
        }
        onKeyDown?.(e)
      }}
      trailing={
        value ? (
          <button
            type="button"
            aria-label={t('Clear')}
            className="flex size-4 shrink-0 items-center justify-center rounded-ds-xs text-ds-fg-3 hover:bg-ds-active hover:text-ds-fg"
            onClick={() => {
              onValueChange('')
            }}
          >
            <X size={12} strokeWidth={1.5} aria-hidden />
          </button>
        ) : shortcut ? (
          <Kbd keys={shortcut} />
        ) : null
      }
      {...rest}
    />
  )
})

/**
 * Nhãn + control + gợi ý / lỗi, nối bằng id (htmlFor, aria-describedby). `children` là MỘT control
 * (Input, Select…) — Field gắn id / aria-describedby / invalid cho nó.
 */
export function Field({
  label,
  hint,
  error,
  children,
  className
}: {
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
  children: ReactElement<{ id?: string; 'aria-describedby'?: string; invalid?: boolean }>
  className?: string
}): React.JSX.Element {
  const id = useId()
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const describedBy = cx(error ? errorId : null, hint ? hintId : null) || undefined
  const control = isValidElement(children)
    ? cloneElement(children, {
        id,
        'aria-describedby': describedBy,
        ...(error ? { invalid: true } : {})
      })
    : children
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-ds-sm font-medium text-ds-fg-2">
        {label}
      </label>
      {control}
      {error && (
        <span id={errorId} className="flex items-center gap-1 text-ds-sm text-ds-danger">
          <AlertCircle size={12} strokeWidth={1.5} aria-hidden className="shrink-0" />
          {error}
        </span>
      )}
      {hint && (
        <span id={hintId} className="text-ds-sm text-ds-fg-3">
          {hint}
        </span>
      )}
    </div>
  )
}
