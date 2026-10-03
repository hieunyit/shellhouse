import { settleConfirm, useConfirm } from '../stores/confirm'
import { Button, Modal } from './ui'

/** Vẽ hộp thoại đầu hàng đợi của `choose()` / `confirmAction()` (stores/confirm). */
export function ConfirmHost(): React.JSX.Element | null {
  const current = useConfirm((s) => s.queue[0])
  if (!current) return null
  const { id, options } = current
  const focusIndex = Math.max(
    0,
    options.choices.findIndex((c) => c.autoFocus) === -1
      ? options.choices.length - 1
      : options.choices.findIndex((c) => c.autoFocus)
  )
  return (
    <Modal
      // key: hộp thoại kế tiếp trong hàng đợi mount mới (focus đúng nút).
      key={id}
      title={options.title}
      onClose={() => {
        settleConfirm(id, null)
      }}
      width={options.width ?? 'max-w-sm'}
      testId={options.testId ?? 'confirm-dialog'}
      footer={options.choices.map((c, i) => (
        <Button
          key={c.value}
          autoFocus={i === focusIndex}
          variant={c.variant ?? 'secondary'}
          data-testid={c.testId}
          onClick={() => {
            settleConfirm(id, c.value)
          }}
        >
          {c.label}
        </Button>
      ))}
    >
      {options.message && (
        <div className="text-[13px] whitespace-pre-line text-muted">{options.message}</div>
      )}
      {options.details && <div className="mt-3">{options.details}</div>}
    </Modal>
  )
}
