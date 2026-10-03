import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import { Button, Input, Modal, Notice } from '../../../renderer/src/components/ui'
import { t } from '../../registry/renderer-kit'

/**
 * Hộp xác nhận dạng Modal (window.prompt không chạy trong Electron, window.confirm chặn cả app).
 * Context production (màu đỏ) → phải gõ đúng tên đối tượng mới bấm được.
 */
export interface ConfirmRequest {
  title: string
  message?: React.ReactNode
  confirmLabel: string
  /** Nút đỏ (thao tác phá huỷ / khó hoàn tác). */
  danger?: boolean
  /** Bắt gõ đúng chuỗi này (thường là tên đối tượng) mới bấm được. */
  typeToConfirm?: string
  /** Cảnh báo nổi bật thêm (scale về 0…). */
  warning?: React.ReactNode
}

export function ConfirmDialog({
  request,
  onAnswer
}: {
  request: ConfirmRequest
  onAnswer: (ok: boolean) => void
}): React.JSX.Element {
  const [typed, setTyped] = useState('')
  const need = request.typeToConfirm
  const ok = !need || typed === need
  // Tên đối tượng in kiểu mono giữa câu: tách câu đã dịch quanh {name}.
  const [typeBefore, typeAfter = ''] = t(
    'This is a production context. Type {name} to confirm.'
  ).split('{name}')
  const cancel = (): void => {
    onAnswer(false)
  }
  return (
    <Modal
      title={request.title}
      onClose={cancel}
      width="max-w-md"
      testId="k8s-confirm"
      footer={
        <>
          <Button variant="ghost" onClick={cancel}>
            {t('Cancel')}
          </Button>
          <Button
            autoFocus={!need}
            variant={request.danger ? 'danger' : 'primary'}
            disabled={!ok}
            data-testid="k8s-confirm-ok"
            onClick={() => {
              onAnswer(true)
            }}
          >
            {request.confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2 text-[13px]">
        {request.message && <div className="text-muted">{request.message}</div>}
        {request.warning && <Notice tone="warning">{request.warning}</Notice>}
        {need && (
          <>
            <Notice tone="warning">
              {typeBefore}
              <span className="font-mono">{need}</span>
              {typeAfter}
            </Notice>
            <Input
              autoFocus
              mono
              data-testid="k8s-confirm-typed"
              placeholder={need}
              value={typed}
              onChange={(e) => {
                setTyped(e.target.value)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && ok) onAnswer(true)
              }}
            />
          </>
        )}
      </div>
    </Modal>
  )
}

/** Hỏi bằng Promise: `if (!(await confirm({...}))) return`. Đặt `element` vào cây giao diện. */
export function useConfirmDialog(): {
  confirm: (r: ConfirmRequest) => Promise<boolean>
  element: React.ReactNode
} {
  const [pending, setPending] = useState<{
    id: number
    request: ConfirmRequest
    resolve: (ok: boolean) => void
  } | null>(null)
  const seq = useRef(0)
  const current = useRef<((ok: boolean) => void) | null>(null)
  const confirm = useCallback(
    (request: ConfirmRequest) =>
      new Promise<boolean>((resolve) => {
        // Đang hỏi việc khác → coi như huỷ việc cũ (không treo Promise).
        current.current?.(false)
        current.current = resolve
        seq.current += 1
        setPending({ id: seq.current, request, resolve })
      }),
    []
  )
  const element = pending ? (
    <ConfirmDialog
      key={pending.id}
      request={pending.request}
      onAnswer={(ok) => {
        if (current.current === pending.resolve) current.current = null
        pending.resolve(ok)
        setPending((p) => (p?.id === pending.id ? null : p))
      }}
    />
  ) : null
  return { confirm, element }
}

/** Hỏi trước thao tác thay đổi trên cluster: production → gõ tên; không thì hỏi thường. */
export interface GuardRequest extends Omit<ConfirmRequest, 'typeToConfirm'> {
  /** Tên đối tượng (phải gõ lại khi context production). */
  name: string
  /** Chỉ hỏi khi context production (thao tác nhẹ, dễ hoàn tác). */
  onlyProduction?: boolean
}

export type Guard = (r: GuardRequest) => Promise<boolean>

export function guardRequest(r: GuardRequest, production: boolean): ConfirmRequest | null {
  if (r.onlyProduction && !production) return null
  const rest: ConfirmRequest = {
    title: r.title,
    confirmLabel: r.confirmLabel,
    ...(r.message !== undefined ? { message: r.message } : {}),
    ...(r.danger ? { danger: true } : {}),
    ...(r.warning !== undefined ? { warning: r.warning } : {})
  }
  return production ? { ...rest, typeToConfirm: r.name } : rest
}

interface ClusterGuard {
  production: boolean
  guard: Guard
}

const GuardContext = createContext<ClusterGuard>({
  production: false,
  // Ngoài tab cluster (không có provider): không hỏi được → không làm (an toàn).
  guard: () => Promise.resolve(false)
})

export function useClusterGuard(): ClusterGuard {
  return useContext(GuardContext)
}

/** Tạo guard cho tab cluster + phần tử hộp thoại để đặt vào cây. */
export function useGuardProvider(production: boolean): {
  value: ClusterGuard
  element: React.ReactNode
} {
  const { confirm, element } = useConfirmDialog()
  const value = useMemo<ClusterGuard>(
    () => ({
      production,
      guard: (r) => {
        const req = guardRequest(r, production)
        return req ? confirm(req) : Promise.resolve(true)
      }
    }),
    [production, confirm]
  )
  return { value, element }
}

export const GuardProvider = GuardContext.Provider
