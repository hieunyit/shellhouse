import { forwardRef, useState, type InputHTMLAttributes, type KeyboardEvent } from 'react'
import { ArrowBigUpDash, Eye, EyeOff } from 'lucide-react'
import { t } from '@shared/i18n'
import { cx, Input } from './ui'

/**
 * Ô mật khẩu: nút hiện / ẩn (không lấy focus khỏi ô khi bấm) và cảnh báo Caps Lock đang bật. Dùng
 * cho hộp hỏi mật khẩu SSH, form host, vault… — module lấy qua renderer-kit.
 */
export const PasswordInput = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
    mono?: boolean
    /** false = luôn ẩn (không có nút hiện). */
    revealable?: boolean
  }
>(function PasswordInput(
  { className, revealable = true, onKeyDown, onKeyUp, onBlur, ...rest },
  ref
) {
  const [shown, setShown] = useState(false)
  const [caps, setCaps] = useState(false)
  const checkCaps = (e: KeyboardEvent<HTMLInputElement>): void => {
    // getModifierState chỉ có nghĩa khi có phím; phím CapsLock tự nó báo trạng thái MỚI.
    setCaps(e.getModifierState('CapsLock'))
  }
  return (
    <span className="flex flex-col gap-1">
      <span className="relative flex">
        <Input
          ref={ref}
          type={shown ? 'text' : 'password'}
          autoComplete="off"
          spellCheck={false}
          className={cx(revealable && 'pr-8', 'w-full', className)}
          onKeyDown={(e) => {
            checkCaps(e)
            onKeyDown?.(e)
          }}
          onKeyUp={(e) => {
            checkCaps(e)
            onKeyUp?.(e)
          }}
          onBlur={(e) => {
            setCaps(false)
            onBlur?.(e)
          }}
          {...rest}
        />
        {revealable && (
          <button
            type="button"
            tabIndex={-1}
            aria-label={shown ? t('Hide password') : t('Show password')}
            title={shown ? t('Hide password') : t('Show password')}
            aria-pressed={shown}
            data-testid="password-reveal"
            className="absolute inset-y-0 right-0 flex w-8 items-center justify-center rounded-r-md text-faint transition-colors hover:text-fg"
            // Giữ focus trong ô (con trỏ không nhảy, gõ tiếp được ngay).
            onMouseDown={(e) => {
              e.preventDefault()
            }}
            onClick={() => {
              setShown((v) => !v)
            }}
          >
            {shown ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        )}
      </span>
      {caps && (
        <span
          role="status"
          className="flex items-center gap-1 text-xs text-warning"
          data-testid="caps-lock-warning"
        >
          <ArrowBigUpDash size={13} aria-hidden /> {t('Caps Lock is on')}
        </span>
      )}
    </span>
  )
})
