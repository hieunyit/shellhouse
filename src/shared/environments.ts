import { z } from 'zod'
import type { HostColor } from './hosts'

/**
 * Môi trường (thiết kế v0.6 — Settings › Workspace › Environments): đặt theo nhóm host, cluster,
 * Docker endpoint, tài khoản S3. Mỗi môi trường quyết định:
 * - nhãn ngắn (≤ 4 ký tự) hiện ở hàng nhóm / header, kiểu Highlighted (màu riêng — magenta) hay
 *   Neutral (xám);
 * - vạch 2px ở đỉnh vùng nội dung khi đang làm việc trên đó;
 * - mức xác nhận khi phá huỷ: gõ tên (type) · hộp xác nhận (confirm) · làm ngay + Undo (undo);
 * - chỉ đọc mặc định (module ẩn thao tác thay đổi).
 * Production là môi trường dựng sẵn, không xoá được (đổi tên / thuộc tính thì được).
 */
export const ConfirmLevel = z.enum(['type', 'confirm', 'undo'])
export type ConfirmLevel = z.infer<typeof ConfirmLevel>

export const EnvironmentDef = z.object({
  id: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9-]+$/),
  name: z.string().trim().min(1).max(40),
  /** Nhãn ngắn trên chip (Prod, Stg, Dev…). */
  short: z.string().trim().min(1).max(4),
  description: z.string().max(200).catch(''),
  highlight: z.boolean().catch(false),
  topLine: z.boolean().catch(false),
  confirm: ConfirmLevel.catch('confirm'),
  readOnly: z.boolean().catch(false)
})
export type EnvironmentDef = z.infer<typeof EnvironmentDef>

/** Id của môi trường dựng sẵn không xoá được. */
export const PRODUCTION_ID = 'prod'

export const DEFAULT_ENVIRONMENTS: readonly EnvironmentDef[] = [
  {
    id: PRODUCTION_ID,
    name: 'Production',
    short: 'Prod',
    description: 'Live systems your users depend on.',
    highlight: true,
    topLine: true,
    confirm: 'type',
    readOnly: false
  },
  {
    id: 'staging',
    name: 'Staging',
    short: 'Stg',
    description: 'Pre-release copy of production.',
    highlight: false,
    topLine: false,
    confirm: 'confirm',
    readOnly: false
  },
  {
    id: 'dev',
    name: 'Development',
    short: 'Dev',
    description: 'Shared development machines and clusters.',
    highlight: false,
    topLine: false,
    confirm: 'confirm',
    readOnly: false
  },
  {
    id: 'test',
    name: 'Test',
    short: 'Test',
    description: 'Throw-away and CI environments.',
    highlight: false,
    topLine: false,
    confirm: 'undo',
    readOnly: false
  }
]

/**
 * Danh sách môi trường hợp lệ: id không trùng, luôn có Production (thêm lại nếu bị mất), tối đa 20.
 */
export const Environments = z
  .array(z.unknown())
  .catch([])
  .transform((list): EnvironmentDef[] => {
    const seen = new Set<string>()
    const out: EnvironmentDef[] = []
    for (const raw of list) {
      const parsed = EnvironmentDef.safeParse(raw)
      if (!parsed.success || seen.has(parsed.data.id)) continue
      seen.add(parsed.data.id)
      out.push(parsed.data)
    }
    if (out.length === 0) return DEFAULT_ENVIRONMENTS.map((e) => ({ ...e }))
    if (!seen.has(PRODUCTION_ID)) out.unshift({ ...(DEFAULT_ENVIRONMENTS[0] as EnvironmentDef) })
    return out.slice(0, 20)
  })

/**
 * Môi trường suy từ màu cũ của nhóm / host (trước khi có môi trường): đỏ = Production, cam / vàng =
 * Staging, xanh dương = Development, tím = Test.
 */
export function environmentFromColor(color: HostColor | null | undefined): string | undefined {
  switch (color) {
    case 'red':
      return PRODUCTION_ID
    case 'orange':
    case 'yellow':
      return 'staging'
    case 'blue':
      return 'dev'
    case 'purple':
      return 'test'
    default:
      return undefined
  }
}

/** Tìm môi trường theo id (không có / đã xoá → undefined). */
export function findEnvironment(
  list: readonly EnvironmentDef[],
  id: string | null | undefined
): EnvironmentDef | undefined {
  return id ? list.find((e) => e.id === id) : undefined
}

/** Id mới không trùng từ tên ("QA Lab" → "qa-lab", "qa-lab-2"…). */
export function environmentId(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/đ/g, 'd')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 28) || 'env'
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) if (!taken.has(`${base}-${String(i)}`)) return `${base}-${String(i)}`
}

/** Nhãn ngắn gợi ý từ tên: "Production" → "Prod", "QA lab" → "QA". */
export function suggestShort(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length > 1)
    return words
      .map((w) => w.charAt(0).toUpperCase())
      .join('')
      .slice(0, 4)
  const w = words[0] ?? ''
  return (w.charAt(0).toUpperCase() + w.slice(1, 4).toLowerCase()).slice(0, 4)
}
