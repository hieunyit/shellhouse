import type { ReactNode } from 'react'
import { create } from 'zustand'
import { t } from '@shared/i18n'

/**
 * Hộp thoại hỏi xác nhận dạng gọi hàm (thay window.confirm — hộp thoại hệ thống chặn cả renderer,
 * không theo theme, không có nút tuỳ chọn). Giao diện vẽ bởi <ConfirmHost /> (gắn một lần trong App).
 *
 *   if (await confirmAction({ title: 'Delete “x”?', confirmLabel: 'Delete', danger: true })) …
 *   const c = await choose({ title, choices: [{ value: 'replace', label: 'Replace' }, …] })
 */

export interface Choice<T extends string> {
  value: T
  label: string
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
  /** Nút nhận focus khi mở (mặc định: nút cuối). */
  autoFocus?: boolean
  testId?: string
}

export interface ChooseOptions<T extends string> {
  title: string
  message?: ReactNode
  /** Nội dung phụ dưới message (xem trước văn bản dán…). */
  details?: ReactNode
  choices: readonly Choice<T>[]
  testId?: string
  width?: string
}

interface Pending {
  id: number
  options: ChooseOptions<string>
  resolve: (value: string | null) => void
}

interface ConfirmState {
  /** Hàng đợi — hiện từng hộp thoại một, theo thứ tự gọi. */
  queue: Pending[]
}

export const useConfirm = create<ConfirmState>(() => ({ queue: [] }))

let nextId = 1

/** Hỏi người dùng chọn một trong các nút. null = đóng hộp thoại (Esc / ×). */
export function choose<T extends string>(options: ChooseOptions<T>): Promise<T | null> {
  return new Promise((resolve) => {
    const id = nextId++
    useConfirm.setState((s) => ({
      queue: [
        ...s.queue,
        {
          id,
          options,
          resolve: resolve as (value: string | null) => void
        }
      ]
    }))
  })
}

/** Trả lời hộp thoại `id` (gọi bởi ConfirmHost). */
export function settleConfirm(id: number, value: string | null): void {
  const item = useConfirm.getState().queue.find((p) => p.id === id)
  if (!item) return
  useConfirm.setState((s) => ({ queue: s.queue.filter((p) => p.id !== id) }))
  item.resolve(value)
}

export interface ConfirmOptions {
  title: string
  message?: ReactNode
  details?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  testId?: string
}

/** Hỏi Có / Không. true = người dùng xác nhận. */
export async function confirmAction(options: ConfirmOptions): Promise<boolean> {
  const value = await choose({
    title: options.title,
    message: options.message,
    details: options.details,
    testId: options.testId ?? 'confirm-dialog',
    choices: [
      // Thao tác nguy hiểm: focus sẵn ở Cancel — lỡ nhấn Enter không xoá gì.
      {
        value: 'cancel',
        label: options.cancelLabel ?? t('Cancel'),
        autoFocus: options.danger === true,
        testId: 'confirm-cancel'
      },
      {
        value: 'ok',
        label: options.confirmLabel ?? t('OK'),
        variant: options.danger ? 'danger' : 'primary',
        autoFocus: options.danger !== true,
        testId: 'confirm-ok'
      }
    ]
  })
  return value === 'ok'
}
