import { create } from 'zustand'

/**
 * Thông báo nổi (toast) dùng chung cho cả app: kết quả thao tác, lỗi, việc đang chạy. Không chặn
 * thao tác; lỗi giữ lâu hơn và có nút sao chép chi tiết.
 */

export type ToastTone = 'success' | 'error' | 'info' | 'warning' | 'loading'

export interface ToastAction {
  label: string
  run: () => void
}

export interface Toast {
  id: number
  tone: ToastTone
  title: string
  description?: string | undefined
  /** Chi tiết dài (lỗi gốc) — hiện khi mở rộng, có nút sao chép. */
  details?: string | undefined
  action?: ToastAction | undefined
  /** Nhóm (vd. "k8s:scale:shop/web") — toast mới cùng nhóm thay toast cũ. */
  group?: string | undefined
  createdAt: number
}

export interface ToastInput {
  description?: string | undefined
  details?: string | undefined
  action?: ToastAction | undefined
  group?: string | undefined
  /** ms; 0 = không tự đóng. Mặc định: 4.5 s (thành công / thông tin), 10 s (lỗi). */
  duration?: number | undefined
}

interface ToastState {
  toasts: Toast[]
}

export const useToasts = create<ToastState>(() => ({ toasts: [] }))

const MAX = 5
let nextId = 1
const timers = new Map<number, ReturnType<typeof setTimeout>>()

const defaultDuration = (tone: ToastTone): number =>
  tone === 'loading' ? 0 : tone === 'error' ? 10_000 : tone === 'warning' ? 7_000 : 4_500

function schedule(id: number, ms: number): void {
  const old = timers.get(id)
  if (old) clearTimeout(old)
  timers.delete(id)
  if (ms > 0)
    timers.set(
      id,
      setTimeout(() => {
        dismiss(id)
      }, ms)
    )
}

function show(tone: ToastTone, title: string, input: ToastInput = {}): number {
  const id = nextId++
  const toast: Toast = {
    id,
    tone,
    title,
    description: input.description,
    details: input.details,
    action: input.action,
    group: input.group,
    createdAt: Date.now()
  }
  useToasts.setState((s) => {
    const kept = input.group ? s.toasts.filter((t) => t.group !== input.group) : s.toasts
    return { toasts: [...kept, toast].slice(-MAX) }
  })
  schedule(id, input.duration ?? defaultDuration(tone))
  return id
}

export function dismiss(id: number): void {
  const t = timers.get(id)
  if (t) clearTimeout(t)
  timers.delete(id)
  useToasts.setState((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }))
}

/** Đổi nội dung toast (vd. đang chạy → xong). */
export function update(id: number, tone: ToastTone, title: string, input: ToastInput = {}): void {
  const found = useToasts.getState().toasts.some((t) => t.id === id)
  useToasts.setState((s) => ({
    toasts: s.toasts.map((t) => {
      if (t.id !== id) return t
      return {
        ...t,
        tone,
        title,
        description: input.description,
        details: input.details,
        action: input.action
      }
    })
  }))
  if (found) schedule(id, input.duration ?? defaultDuration(tone))
  else show(tone, title, input)
}

/** Tạm dừng / chạy lại hẹn giờ đóng (rê chuột lên toast). */
export function hold(id: number, on: boolean): void {
  if (on) {
    const t = timers.get(id)
    if (t) clearTimeout(t)
    timers.delete(id)
    return
  }
  const toast = useToasts.getState().toasts.find((x) => x.id === id)
  if (toast && toast.tone !== 'loading') schedule(id, 3_000)
}

export const toast = {
  success: (title: string, input?: ToastInput) => show('success', title, input),
  error: (title: string, input?: ToastInput) => show('error', title, input),
  info: (title: string, input?: ToastInput) => show('info', title, input),
  warning: (title: string, input?: ToastInput) => show('warning', title, input),
  loading: (title: string, input?: ToastInput) => show('loading', title, input),
  dismiss,
  update,
  /** Toast "đang chạy" đổi thành thành công / lỗi khi xong. */
  promise<T>(
    work: Promise<T>,
    messages: {
      loading: string
      success: string | ((value: T) => string)
      error: string | ((error: unknown) => string)
      description?: (value: T) => string | undefined
      action?: (value: T) => ToastAction | undefined
      details?: (error: unknown) => string | undefined
      group?: string
    }
  ): Promise<T> {
    const id = show('loading', messages.loading, { group: messages.group })
    work.then(
      (value) => {
        update(
          id,
          'success',
          typeof messages.success === 'function' ? messages.success(value) : messages.success,
          { description: messages.description?.(value), action: messages.action?.(value) }
        )
      },
      (error: unknown) => {
        update(
          id,
          'error',
          typeof messages.error === 'function' ? messages.error(error) : messages.error,
          {
            description: error instanceof Error ? error.message : String(error),
            details: messages.details?.(error)
          }
        )
      }
    )
    return work
  }
}
