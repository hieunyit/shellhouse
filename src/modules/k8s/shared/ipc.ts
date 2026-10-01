import { z } from 'zod'
import { ContextRef, type ContextInfo } from './ops'

export const ContextColor = z.enum(['red', 'orange', 'green', 'blue']).nullable()
export type ContextColor = z.infer<typeof ContextColor>

/** Tuỳ chọn người dùng đặt cho một context. */
export const ContextSettings = z.object({
  bastionHostId: z.string().min(1).max(64).nullable(),
  namespace: z.string().max(63).nullable(),
  readOnly: z.boolean(),
  /** Đỏ = production: thao tác phá huỷ phải gõ tên tài nguyên. */
  color: ContextColor,
  /** Ẩn khỏi thanh bên. */
  hidden: z.boolean()
})
export type ContextSettings = z.infer<typeof ContextSettings>

export interface ContextEntry extends ContextInfo {
  key: string
  settings: ContextSettings
}

export interface ContextList {
  contexts: ContextEntry[]
  /** File không đọc được / hỏng (hiện cho người dùng). */
  errors: string[]
  imported: { id: string; name: string; contexts: number }[]
  /** File kubeconfig đang đọc (KUBECONFIG / ~/.kube). */
  files: { path: string; label: string; contexts: number }[]
}

export interface ImportResult {
  imported: { name: string; contexts: number }[]
  errors: string[]
}

export const K8sIpc = {
  contexts: z.tuple([]),
  setContext: z.tuple([ContextRef, ContextSettings.partial()]),
  importKubeconfig: z.tuple([
    z.string().trim().min(1).max(100),
    z
      .string()
      .min(1)
      .max(1024 * 1024)
  ]),
  removeImported: z.tuple([z.string().max(64)]),
  renameImported: z.tuple([z.string().max(64), z.string().trim().min(1).max(100)]),
  /** Hộp thoại chọn file kubeconfig (một hay nhiều) → nhúng chứng chỉ → lưu vào vault. */
  importFiles: z.tuple([])
} as const
