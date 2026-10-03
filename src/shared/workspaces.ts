import { z } from 'zod'

/**
 * Workspace = bộ tab + cách chia màn hình đặt tên được ("Prod DB + web"), mở lại một lần là đủ.
 * Chỉ lưu đích kết nối (id host đã lưu, user@host, loại shell) — không có bí mật.
 */

const ModuleId = z.string().regex(/^[a-z0-9-]{1,40}$/)

/** Tham số của tab module: JSON nhỏ do module định nghĩa (module tự kiểm khi mở lại). */
const ModuleParams = z.unknown().refine((v) => {
  try {
    return JSON.stringify(v ?? null).length <= 4096
  } catch {
    return false
  }
}, 'Tab parameters are too large')

const CurrentTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local'), shellId: z.string().max(80).optional() }),
  z.object({
    kind: z.literal('ssh'),
    host: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65535),
    username: z.string().min(1).max(128)
  }),
  z.object({ kind: z.literal('host'), hostId: z.string().min(1).max(64) }),
  /** Remote Desktop trong tab. */
  z.object({ kind: z.literal('rdp'), hostId: z.string().min(1).max(64) }),
  /** Tab của module (ADR-014). */
  z.object({
    kind: z.literal('module'),
    module: ModuleId,
    tab: z.string().regex(/^[a-z0-9-]{1,40}$/),
    params: ModuleParams
  }),
  z.object({
    kind: z.literal('module-terminal'),
    module: ModuleId,
    params: ModuleParams,
    hostId: z.string().min(1).max(64).optional()
  })
])

/** Bản ≤ 1.2: tab S3 là loại riêng → đọc thành tab của module `s3`. */
const LegacyS3Target = z
  .object({
    kind: z.literal('s3'),
    accountId: z.string().min(1).max(64),
    bucket: z.string().min(1).max(255).optional(),
    prefix: z.string().max(1024).optional()
  })
  .transform((t) => ({
    kind: 'module' as const,
    module: 's3',
    tab: 'browser',
    params: {
      accountId: t.accountId,
      ...(t.bucket ? { bucket: t.bucket } : {}),
      ...(t.prefix !== undefined ? { prefix: t.prefix } : {})
    }
  }))

export const WorkspaceTarget = z.union([CurrentTarget, LegacyS3Target])
export type WorkspaceTarget = z.output<typeof WorkspaceTarget>

export const WorkspaceItem = z.object({
  target: WorkspaceTarget,
  title: z.string().max(200),
  /** Mở cạnh mục thứ `after` (chỉ số trong danh sách); null = tab mới bình thường. */
  after: z.number().int().min(0).nullable(),
  direction: z.enum(['right', 'below', 'within']),
  /** Tab đang ở trình quản lý file hai cột. */
  view: z.literal('files').optional()
})
export type WorkspaceItem = z.infer<typeof WorkspaceItem>

export const Workspace = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(80),
  items: z.array(WorkspaceItem).min(1).max(64)
})
export type Workspace = z.infer<typeof Workspace>

/**
 * Bỏ các mục không mở được nữa (host đã xoá) và đánh lại chỉ số `after`. Mục neo vào mục bị bỏ
 * thì neo tiếp vào chỗ mục bị bỏ đã neo (giữ bố cục gần đúng); hết chỗ neo → tab thường.
 */
export function pruneItems(
  items: readonly WorkspaceItem[],
  keep: (item: WorkspaceItem) => boolean
): WorkspaceItem[] {
  const newIndex = new Map<number, number>()
  const out: WorkspaceItem[] = []
  const resolve = (after: number | null): number | undefined => {
    for (let a = after; a !== null; a = items[a]?.after ?? null) {
      const mapped = newIndex.get(a)
      if (mapped !== undefined) return mapped
    }
    return undefined
  }
  items.forEach((item, i) => {
    if (!keep(item)) return
    const anchor = resolve(item.after)
    newIndex.set(i, out.length)
    out.push(
      anchor === undefined
        ? { ...item, after: null, direction: 'within' }
        : { ...item, after: anchor }
    )
  })
  return out
}

/** Phần tối thiểu của `DockviewApi.toJSON().grid` mà ta cần. */
export interface GridNode {
  type: 'branch' | 'leaf'
  data: GridNode[] | { views: string[] }
}
export type GridOrientation = 'HORIZONTAL' | 'VERTICAL'

const flip = (o: GridOrientation): GridOrientation =>
  o === 'HORIZONTAL' ? 'VERTICAL' : 'HORIZONTAL'

/** Panel đầu tiên (trên cùng / trái nhất) của một nhánh. */
function firstView(node: GridNode): string | null {
  if (node.type === 'leaf') return (node.data as { views: string[] }).views[0] ?? null
  for (const child of node.data as GridNode[]) {
    const v = firstView(child)
    if (v) return v
  }
  return null
}

/**
 * Cây bố cục của dockview → danh sách mở lại theo thứ tự. Mỗi nhánh: đặt panel đầu của TỪNG ô con
 * trước (chia phải/dưới so với ô con trước đó), rồi mới đi sâu vào từng ô — nhờ vậy phép chia áp
 * cho cả cột/hàng chứ không chỉ một ô lẻ. Kích thước các ô không được lưu (chia đều khi mở lại).
 */
export function layoutToItems(
  root: GridNode,
  orientation: GridOrientation,
  describe: (
    panelId: string
  ) => { target: WorkspaceTarget; title: string; view?: 'files' | undefined } | null
): WorkspaceItem[] {
  const items: WorkspaceItem[] = []
  const indexOf = new Map<string, number>()
  const place = (
    panelId: string | null,
    after: string | null,
    direction: WorkspaceItem['direction']
  ): void => {
    if (!panelId || indexOf.has(panelId)) return
    const info = describe(panelId)
    if (!info) return
    const anchor = after === null ? undefined : indexOf.get(after)
    indexOf.set(panelId, items.length)
    items.push({
      target: info.target,
      title: info.title,
      ...(info.view ? { view: info.view } : {}),
      after: anchor ?? null,
      direction: anchor === undefined ? 'within' : direction
    })
  }
  const walk = (node: GridNode, o: GridOrientation): void => {
    if (node.type === 'leaf') {
      const views = (node.data as { views: string[] }).views
      for (const v of views) place(v, views[0] ?? null, 'within')
      return
    }
    const children = node.data as GridNode[]
    let previous: string | null = null
    for (const child of children) {
      const head = firstView(child)
      place(head, previous, o === 'HORIZONTAL' ? 'right' : 'below')
      if (head && indexOf.has(head)) previous = head
    }
    for (const child of children) walk(child, flip(o))
  }
  place(firstView(root), null, 'within')
  walk(root, orientation)
  return items
}
