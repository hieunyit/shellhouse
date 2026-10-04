import type { GroupTree } from './group-tree'
import type { GroupDefaults, HostColor } from './hosts'
import { environmentFromColor } from './environments'

/**
 * Kế thừa giá trị mặc định theo cây nhóm (ADR-010). Dùng chung cho main (khi kết nối) và renderer
 * (hiện "từ nhóm nào" trong form, màu môi trường trên tab).
 */

export interface GroupWithDefaults {
  id: string
  parentId: string | null
  name: string
  sort: number
  defaults: GroupDefaults
}

export interface Inherited<T> {
  value: T
  /** Nhóm đặt giá trị này (nhóm gần nhất tính từ host đi lên). */
  groupId: string
  groupName: string
}

/** Mỗi trường: giá trị kế thừa, hoặc undefined nếu không nhóm nào đặt. (Không dùng `-?`: nó xoá luôn `undefined`.) */
export type InheritedDefaults = {
  [K in keyof Required<GroupDefaults>]: Inherited<NonNullable<GroupDefaults[K]>> | undefined
}

const FIELDS = ['username', 'port', 'keyId', 'jumpHostIds', 'color', 'environment'] as const

/** Giá trị mỗi trường lấy từ nhóm gần nhất (tính từ `groupId` đi lên gốc) có đặt trường đó. */
export function inheritedDefaults(
  tree: GroupTree<GroupWithDefaults>,
  groupId: string | null
): InheritedDefaults {
  const out: Record<string, Inherited<unknown> | undefined> = {}
  for (const f of FIELDS) out[f] = undefined
  const seen = new Set<string>()
  let current = groupId === null ? undefined : tree.byId.get(groupId)
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    for (const f of FIELDS) {
      const value = current.defaults[f]
      if (out[f] === undefined && value !== undefined)
        out[f] = { value, groupId: current.id, groupName: current.name }
    }
    current = current.parentId === null ? undefined : tree.byId.get(current.parentId)
  }
  return out as InheritedDefaults
}

export interface HostOwnValues {
  /** '' = kế thừa */
  username: string
  /** null = kế thừa */
  port: number | null
  jumpHostIds: readonly string[]
  proxyJump: string | null
  direct: boolean
  color: HostColor | null
}

export interface EffectiveHost {
  username: string | null
  port: number
  /** Jump host đã lưu (id) sẽ dùng; rỗng = kết nối thẳng hoặc dùng proxyJump của host. */
  jumpHostIds: readonly string[]
  color: HostColor | null
  /**
   * Id môi trường (Settings › Environments) của nhóm gần nhất có đặt; không nhóm nào đặt → suy từ màu
   * cũ (đỏ = Production…); null = không có môi trường.
   */
  environment: string | null
  /** Trường nào đang lấy từ nhóm (để hiển thị). */
  from: {
    username?: string
    port?: string
    jumpHostIds?: string
    color?: string
    environment?: string
  }
}

/** Giá trị thực tế của host sau khi áp kế thừa. */
export function effectiveHost(own: HostOwnValues, inherited: InheritedDefaults): EffectiveHost {
  const from: EffectiveHost['from'] = {}
  let username: string | null = own.username || null
  if (!username && inherited.username) {
    username = inherited.username.value
    from.username = inherited.username.groupName
  }
  let port = own.port
  if (port === null) {
    port = inherited.port?.value ?? 22
    if (inherited.port) from.port = inherited.port.groupName
  }
  let jumpHostIds = own.jumpHostIds
  // Host tự có jump / ProxyJump, hoặc chọn kết nối thẳng → không kế thừa.
  if (jumpHostIds.length === 0 && !own.proxyJump && !own.direct && inherited.jumpHostIds) {
    jumpHostIds = inherited.jumpHostIds.value
    from.jumpHostIds = inherited.jumpHostIds.groupName
  }
  let color = own.color
  if (color === null && inherited.color) {
    color = inherited.color.value
    from.color = inherited.color.groupName
  }
  let environment: string | null
  if (inherited.environment) {
    environment = inherited.environment.value
    from.environment = inherited.environment.groupName
  } else environment = environmentFromColor(color) ?? null
  return { username, port, jumpHostIds, color, environment, from }
}
