/**
 * Cây nhóm host (nhóm lồng nhóm). Hàm thuần, dùng chung cho main (kiểm tra khi lưu) và renderer
 * (vẽ cây, ô chọn nhóm cha, kéo thả).
 */

/** Tối đa 6 cấp: đủ cho "Công ty / Môi trường / Khu vực / Dịch vụ / ...", vẫn đọc được trên sidebar. */
export const MAX_GROUP_DEPTH = 6

export interface GroupNode {
  id: string
  parentId: string | null
  name: string
  sort: number
}

export interface GroupTree<G extends GroupNode = GroupNode> {
  byId: ReadonlyMap<string, G>
  /** Nhóm con trực tiếp (null = cấp cao nhất), đã sắp theo sort rồi tên. */
  children(parentId: string | null): readonly G[]
  /** Tên các nhóm từ gốc tới nhóm này (gồm chính nó). Nhóm không tồn tại → []. */
  path(id: string): string[]
  /** Cấp của nhóm: nhóm cấp cao nhất = 1. */
  depth(id: string): number
  /** Mọi nhóm con cháu (không gồm chính nó). */
  descendants(id: string): Set<string>
  /** Số cấp của cây con tính từ nhóm này (nhóm lá = 1). */
  height(id: string): number
  /** Duyệt theo chiều sâu, đúng thứ tự hiển thị — cho ô chọn nhóm dạng cây. */
  flatten(): { group: G; depth: number }[]
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export function buildGroupTree<G extends GroupNode>(groups: readonly G[]): GroupTree<G> {
  const byId = new Map(groups.map((g) => [g.id, g]))
  const kids = new Map<string | null, G[]>()
  for (const g of groups) {
    // Cha không tồn tại (dữ liệu hỏng) → coi như cấp cao nhất, không làm mất nhóm.
    const parent = g.parentId !== null && byId.has(g.parentId) ? g.parentId : null
    const list = kids.get(parent) ?? []
    list.push(g)
    kids.set(parent, list)
  }
  for (const list of kids.values())
    list.sort((a, b) => a.sort - b.sort || collator.compare(a.name, b.name))

  const children = (parentId: string | null): readonly G[] => kids.get(parentId) ?? []

  const ancestry = (id: string): G[] => {
    const chain: G[] = []
    const seen = new Set<string>()
    let current = byId.get(id)
    // `seen` chặn vòng lặp nếu dữ liệu lỡ bị hỏng.
    while (current && !seen.has(current.id)) {
      seen.add(current.id)
      chain.unshift(current)
      current = current.parentId === null ? undefined : byId.get(current.parentId)
    }
    return chain
  }

  const descendants = (id: string): Set<string> => {
    const out = new Set<string>()
    const stack = [...children(id)]
    while (stack.length) {
      const g = stack.pop()
      if (!g || out.has(g.id)) continue
      out.add(g.id)
      stack.push(...children(g.id))
    }
    return out
  }

  const height = (id: string, seen = new Set<string>()): number => {
    if (seen.has(id)) return 0
    seen.add(id)
    let max = 0
    for (const c of children(id)) max = Math.max(max, height(c.id, seen))
    return max + 1
  }

  const flatten = (): { group: G; depth: number }[] => {
    const out: { group: G; depth: number }[] = []
    const seen = new Set<string>()
    const walk = (parentId: string | null, depth: number): void => {
      for (const g of children(parentId)) {
        if (seen.has(g.id)) continue
        seen.add(g.id)
        out.push({ group: g, depth })
        walk(g.id, depth + 1)
      }
    }
    walk(null, 1)
    return out
  }

  return {
    byId,
    children,
    path: (id) => ancestry(id).map((g) => g.name),
    depth: (id) => ancestry(id).length,
    descendants,
    height: (id) => height(id),
    flatten
  }
}

/**
 * Có được đặt nhóm `id` (null = nhóm mới) vào trong `parentId` không. Trả về lý do nếu không.
 * Chặn: vào chính nó hoặc nhóm con cháu (tạo vòng), vượt quá MAX_GROUP_DEPTH.
 */
export function groupMoveProblem(
  tree: GroupTree,
  id: string | null,
  parentId: string | null
): string | null {
  if (parentId === null) {
    if (id && tree.height(id) > MAX_GROUP_DEPTH) return 'That would make the tree too deep'
    return null
  }
  if (!tree.byId.has(parentId)) return 'The parent group no longer exists'
  if (id !== null && (parentId === id || tree.descendants(id).has(parentId)))
    return 'A group cannot be moved into itself or one of its subgroups'
  const subtree = id === null ? 1 : tree.height(id)
  if (tree.depth(parentId) + subtree > MAX_GROUP_DEPTH)
    return `Groups can be nested at most ${MAX_GROUP_DEPTH} levels deep`
  return null
}

/** Số host trong mỗi nhóm, tính cả nhóm con cháu. */
export function countHostsRecursive(
  tree: GroupTree,
  hosts: readonly { groupId: string | null }[]
): Map<string, number> {
  const direct = new Map<string, number>()
  for (const h of hosts)
    if (h.groupId !== null) direct.set(h.groupId, (direct.get(h.groupId) ?? 0) + 1)
  const total = new Map<string, number>()
  const visit = (id: string, seen: Set<string>): number => {
    const cached = total.get(id)
    if (cached !== undefined) return cached
    if (seen.has(id)) return 0
    seen.add(id)
    let n = direct.get(id) ?? 0
    for (const c of tree.children(id)) n += visit(c.id, seen)
    total.set(id, n)
    return n
  }
  for (const id of tree.byId.keys()) visit(id, new Set())
  return total
}
