import { useId, useRef, useState, type ReactNode } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog'
import { AlertTriangle, X } from 'lucide-react'
import { t } from '@shared/i18n'
import { Button } from './Button'
import { canConfirm, typedIsPrefix, type ConfirmRisk } from './confirm-logic'
import { Input } from './Input'
import { Kbd } from './Kbd'
import { usePortalContainer } from './provider'
import { EnvLabel } from './Status'
import { cx, focusRing } from './utils'

const overlayClass = 'fixed inset-0 z-(--ds-z-overlay) animate-ds-fade bg-ds-overlay'
const contentClass = cx(
  'fixed top-1/2 left-1/2 z-(--ds-z-dialog) flex max-h-[calc(100vh-48px)] w-[calc(100vw-48px)] -translate-x-1/2 -translate-y-1/2 flex-col',
  'animate-ds-dialog rounded-ds-xl bg-ds-surface-0 text-ds-base text-ds-fg shadow-ds-dialog outline-none'
)

const widths = { sm: 'max-w-100', md: 'max-w-130', lg: 'max-w-180' } as const

/**
 * Hộp thoại: bẫy focus, Esc đóng, trả focus về chỗ cũ, aria-modal (Radix). Tiêu đề 16px, chân hộp
 * thoại: nút phụ trước, nút chính cuối (bên phải).
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = 'md',
  'data-testid': testId
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  size?: keyof typeof widths
  'data-testid'?: string
}): React.JSX.Element {
  const container = usePortalContainer()
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal container={container}>
        <DialogPrimitive.Overlay className={overlayClass} />
        <DialogPrimitive.Content
          data-testid={testId}
          className={cx(contentClass, widths[size])}
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          <header className="flex items-start gap-3 px-5 pt-4 pb-3">
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="text-ds-lg font-semibold tracking-[-0.018em]">
                {title}
              </DialogPrimitive.Title>
              {description && (
                <DialogPrimitive.Description className="mt-0.5 text-ds-base text-ds-fg-2">
                  {description}
                </DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close
              aria-label={t('Close')}
              className={cx(
                '-mr-1 flex size-ds-ctl shrink-0 items-center justify-center rounded-ds-md text-ds-fg-2 hover:bg-ds-hover hover:text-ds-fg',
                focusRing
              )}
            >
              <X size={16} strokeWidth={1.5} aria-hidden />
            </DialogPrimitive.Close>
          </header>
          {children !== undefined && (
            <div className="min-h-0 overflow-auto px-5 pb-4">{children}</div>
          )}
          {footer && (
            <footer className="flex items-center justify-end gap-2 border-t border-ds-border-subtle px-5 py-3">
              {footer}
            </footer>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

/**
 * Hộp thoại xác nhận theo mức rủi ro (confirm-logic.ts). role=alertdialog; bấm ra ngoài không đóng
 * (Radix AlertDialog); Huỷ được focus sẵn với danger, ô gõ tên được focus sẵn với production.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  risk,
  title,
  description,
  impact,
  confirmLabel,
  cancelLabel,
  confirmText,
  onConfirm,
  'data-testid': testId
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  risk: ConfirmRisk
  title: string
  description?: ReactNode
  /** Danh sách tác động (ví dụ các resource sẽ bị xoá). */
  impact?: ReactNode
  confirmLabel: string
  cancelLabel?: string
  /** production: chữ phải gõ lại (tên resource, hoặc "3 pods" khi xoá hàng loạt). */
  confirmText?: string
  onConfirm: () => void
  'data-testid'?: string
}): React.JSX.Element {
  const container = usePortalContainer()
  return (
    <AlertDialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialogPrimitive.Portal container={container}>
        <AlertDialogPrimitive.Overlay className={overlayClass} />
        {/* Nội dung tách riêng: mỗi lần mở là một lần mount → ô gõ tên luôn bắt đầu trống. */}
        {open && (
          <ConfirmContent
            risk={risk}
            title={title}
            description={description}
            impact={impact}
            confirmLabel={confirmLabel}
            cancelLabel={cancelLabel ?? t('Cancel')}
            confirmText={confirmText}
            testId={testId}
            onConfirm={() => {
              onConfirm()
              onOpenChange(false)
            }}
          />
        )}
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  )
}

function ConfirmContent({
  risk,
  title,
  description,
  impact,
  confirmLabel,
  cancelLabel,
  confirmText,
  testId,
  onConfirm
}: {
  risk: ConfirmRisk
  title: string
  description: ReactNode
  impact: ReactNode
  confirmLabel: string
  cancelLabel: string
  confirmText: string | undefined
  testId: string | undefined
  onConfirm: () => void
}): React.JSX.Element {
  const [typed, setTyped] = useState('')
  const [blocked, setBlocked] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const hintId = useId()
  const production = risk === 'production'
  const ready = canConfirm(risk, typed, confirmText)
  const wrong =
    production && confirmText !== undefined && typed !== '' && !typedIsPrefix(typed, confirmText)

  return (
    <AlertDialogPrimitive.Content
      data-testid={testId}
      data-risk={risk}
      className={cx(contentClass, widths.sm)}
      onOpenAutoFocus={(e) => {
        if (!production) return
        e.preventDefault()
        inputRef.current?.focus()
      }}
    >
      <form
        className="contents"
        onSubmit={(e) => {
          e.preventDefault()
          if (ready) onConfirm()
        }}
      >
        <header className="flex items-start gap-3 px-5 pt-5 pb-3">
          {risk !== 'normal' && (
            <span className="flex size-8 shrink-0 items-center justify-center rounded-ds-lg bg-ds-danger-soft text-ds-danger">
              <AlertTriangle size={16} strokeWidth={1.5} aria-hidden />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <AlertDialogPrimitive.Title className="text-ds-lg font-semibold tracking-[-0.018em]">
              {title}
            </AlertDialogPrimitive.Title>
            <AlertDialogPrimitive.Description className="mt-0.5 text-ds-base text-ds-fg-2">
              {description ?? (risk === 'normal' ? '' : t('This cannot be undone.'))}
            </AlertDialogPrimitive.Description>
          </div>
          {production && <EnvLabel env="prod" className="mt-1" />}
        </header>
        {(impact !== undefined || production) && (
          <div className="flex flex-col gap-3 px-5 pb-4">
            {impact}
            {production && confirmText !== undefined && (
              <div className="flex flex-col gap-1.5">
                <label htmlFor={`${hintId}-input`} className="text-ds-sm font-medium text-ds-fg-2">
                  {withSlot(
                    t('Type {name} to confirm', { name: SLOT }),
                    <code className="rounded-ds-xs bg-ds-surface-2 px-1 font-mono text-ds-sm text-ds-fg">
                      {confirmText}
                    </code>
                  )}
                </label>
                <Input
                  ref={inputRef}
                  id={`${hintId}-input`}
                  mono
                  autoComplete="off"
                  data-testid="confirm-type-input"
                  aria-describedby={hintId}
                  invalid={wrong}
                  value={typed}
                  onChange={(e) => {
                    setTyped(e.target.value)
                    setBlocked(false)
                  }}
                  // Chặn dán / kéo thả: phải gõ thật để chắc người dùng đọc tên.
                  onPaste={(e) => {
                    e.preventDefault()
                    setBlocked(true)
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    setBlocked(true)
                  }}
                />
                <span
                  id={hintId}
                  aria-live="polite"
                  className={cx('text-ds-sm', blocked || wrong ? 'text-ds-danger' : 'text-ds-fg-3')}
                >
                  {blocked
                    ? t('Pasting is disabled here — type the name.')
                    : wrong
                      ? t('Doesn’t match. Case-sensitive.')
                      : t('Case-sensitive.')}
                </span>
              </div>
            )}
          </div>
        )}
        <footer className="flex items-center gap-2 border-t border-ds-border-subtle px-5 py-3">
          <span className="mr-auto flex items-center gap-1.5 text-ds-sm text-ds-fg-3">
            <Kbd keys="Esc" /> {t('to cancel')}
          </span>
          <AlertDialogPrimitive.Cancel asChild>
            <Button data-testid="confirm-cancel">{cancelLabel}</Button>
          </AlertDialogPrimitive.Cancel>
          <Button
            type="submit"
            variant={risk === 'normal' ? 'primary' : 'danger'}
            disabled={!ready}
            data-testid="confirm-ok"
          >
            {confirmLabel}
          </Button>
        </footer>
      </form>
    </AlertDialogPrimitive.Content>
  )
}

/** Chèn một phần tử vào chỗ {name} của câu đã dịch (giữ đúng trật tự từ của từng ngôn ngữ). */
const SLOT = '\u0000'
function withSlot(text: string, node: ReactNode): ReactNode {
  const [before = '', after = ''] = text.split(SLOT)
  return (
    <>
      {before}
      {node}
      {after}
    </>
  )
}
