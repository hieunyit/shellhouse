import { z } from 'zod'

/**
 * Workspace = bộ tab + cách chia màn hình đặt tên được ("Prod DB + web"), mở lại một lần là đủ.
 * Chỉ lưu đích kết nối (id host đã lưu, user@host, loại shell) — không có bí mật.
 */

export const WorkspaceTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local'), shellId: z.string().max(80).optional() }),
  z.object({
    kind: z.literal('ssh'),
    host: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65535),
    username: z.string().min(1).max(128)
  }),
  z.object({ kind: z.literal('host'), hostId: z.string().min(1).max(64) })
])
export type WorkspaceTarget = z.infer<typeof WorkspaceTarget>

export const WorkspaceItem = z.object({
  target: WorkspaceTarget,
  title: z.string().max(200),
  /** Mở cạnh mục thứ `after` (chỉ số trong danh sách); null = tab mới bình thường. */
  after: z.number().int().min(0).nullable(),
  direction: z.enum(['right', 'below', 'within'])
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
  describe: (panelId: string) => { target: WorkspaceTarget; title: string } | null
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
