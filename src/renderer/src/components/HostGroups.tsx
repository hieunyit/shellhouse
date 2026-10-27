import { Fragment, type ReactNode } from 'react'
import { Folder } from 'lucide-react'
import { useHosts } from '../stores/hosts'

/** Nhóm nguồn Docker/SFTP theo cây SSH gốc; cập nhật ngay khi host đổi nhóm. */
export function HostGroups<T>({
  items,
  hostId,
  itemKey,
  children
}: {
  items: readonly T[]
  hostId: (item: T) => string | null
  itemKey: (item: T) => string
  children: (item: T) => ReactNode
}): React.JSX.Element {
  const hosts = useHosts((s) => s.tree.hosts)
  const tree = useHosts((s) => s.groupTree)
  const groups = new Map(hosts.map((h) => [h.id, h.groupId]))
  const byGroup = new Map<string | null, T[]>()
  const visible = new Set<string>()
  for (const item of items) {
    const id = hostId(item)
    const group = id ? groups.get(id) : null
    const key = group && tree.byId.has(group) ? group : null
    const bucket = byGroup.get(key) ?? []
    bucket.push(item)
    byGroup.set(key, bucket)
    for (let current = key; current && !visible.has(current);) {
      visible.add(current)
      current = tree.byId.get(current)?.parentId ?? null
    }
  }
  const rows = (id: string | null): ReactNode =>
    byGroup.get(id)?.map((item) => <Fragment key={itemKey(item)}>{children(item)}</Fragment>)
  const branches = (parent: string | null): ReactNode =>
    tree
      .children(parent)
      .filter((g) => visible.has(g.id))
      .map((g) => (
        <details key={g.id} open data-host-group={g.id} className="min-w-0">
          <summary
            className="cursor-pointer truncate rounded-ds-md px-2 py-1 text-xs font-medium text-muted hover:bg-ds-hover"
            title={tree.path(g.id).join(' / ')}
          >
            <Folder size={13} className="mx-1 inline-block align-text-bottom" />
            {g.name}
          </summary>
          <div className="ml-3 border-l border-ds-border-subtle pl-1">
            {branches(g.id)}
            {rows(g.id)}
          </div>
        </details>
      ))
  return (
    <>
      {rows(null)}
      {branches(null)}
    </>
  )
}
