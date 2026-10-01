import type { DragEvent, MouseEvent } from 'react'
import { FolderOpen, Pencil, Play, Star } from 'lucide-react'
import type { HostSummary } from '@shared/hosts'
import { hostAddress, useHosts } from '../../stores/hosts'
import { useTabStatus } from '../../stores/tab-status'
import { useTabs } from '../../stores/tabs'
import { HostAvatar } from '../HostAvatar'
import { cx, IconButton, type ConnectionState } from '../ui'
import { connect } from './actions'

const RANK: Record<ConnectionState, number> = {
  connected: 5,
  reconnecting: 4,
  connecting: 3,
  disconnected: 2,
  idle: 1,
  exited: 0
}

/** Trạng thái "tốt nhất" trong các tab đang mở tới host này (null = không có tab nào). */
function useHostSession(hostId: string): ConnectionState | null {
  return useTabStatus((status) => {
    let best: ConnectionState | null = null
    for (const tab of useTabs.getState().tabs) {
      if (tab.target.kind !== 'host' || tab.target.hostId !== hostId) continue
      const state = status.byTab[tab.id] ?? 'connecting'
      if (!best || RANK[state] > RANK[best]) best = state
    }
    return best === 'exited' ? null : best
  })
}

export type DropPos = 'before' | 'after' | 'into'

/** Vạch chỉ chỗ thả khi kéo để sắp xếp. */
export function DropLine({ pos }: { pos: DropPos | null }): React.JSX.Element | null {
  if (pos !== 'before' && pos !== 'after') return null
  return (
    <span
      aria-hidden
      className={cx(
        'pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-accent',
        pos === 'before' ? '-top-px' : '-bottom-px'
      )}
    />
  )
}

export function HostRow({
  host,
  testId = 'host-row',
  groupPath,
  selected,
  active,
  dropPos,
  onSelect,
  onOpen,
  onEdit,
  onContextMenu,
  dnd
}: {
  host: HostSummary
  /** host-row (cây) / favorite-row / recent-row — tránh trùng khi một host xuất hiện nhiều nơi. */
  testId?: string
  /** Hiện đường dẫn nhóm (kết quả tìm kiếm, Favorites, Recent). */
  groupPath?: string
  selected?: boolean
  /** Con trỏ bàn phím trong kết quả tìm kiếm. */
  active?: boolean
  dropPos?: DropPos | null
  onSelect: (e: MouseEvent) => void
  onOpen: () => void
  onEdit: () => void
  onContextMenu: (e: MouseEvent) => void
  dnd?: {
    onDragStart: (e: DragEvent) => void
    onDragEnd: () => void
    onDragOver?: (e: DragEvent) => void
    onDragLeave?: () => void
    onDrop?: (e: DragEvent) => void
  }
}): React.JSX.Element {
  const session = useHostSession(host.id)
  const effective = useHosts((s) => s.effective.get(host.id))
  const address = hostAddress(host, effective)
  return (
    <div
      role="treeitem"
      aria-selected={selected ?? false}
      tabIndex={0}
      draggable={!!dnd}
      data-testid={testId}
      data-host-label={host.label}
      data-selected={selected ? 'true' : undefined}
      title={`${address}${host.lastUsedAt ? `\nLast used: ${new Date(host.lastUsedAt).toLocaleString()}` : ''}`}
      className={cx(
        'group relative flex cursor-default items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors duration-100 outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        selected ? 'bg-accent-soft' : active ? 'bg-hover' : 'hover:bg-hover'
      )}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onContextMenu={onContextMenu}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen()
      }}
      {...(dnd ?? {})}
    >
      <DropLine pos={dropPos ?? null} />
      <HostAvatar host={host} session={session} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1">
          <span className="truncate text-[13px] text-fg">{host.label}</span>
          {host.favorite && testId === 'host-row' && (
            <Star size={11} className="shrink-0 fill-warning text-warning" aria-label="Favorite" />
          )}
        </span>
        <span className="block truncate font-mono text-xs text-faint">
          {groupPath && <span className="font-sans">{groupPath} · </span>}
          {address}
        </span>
      </span>
      {/* Thao tác nhanh khi rê chuột: mở file (SFTP), sửa, kết nối. */}
      <span className="hidden shrink-0 items-center group-focus-within:flex group-hover:flex">
        {host.protocol === 'ssh' && (
          <IconButton
            label={`Open files on ${host.label}`}
            size="sm"
            data-testid="host-sftp"
            onClick={(e) => {
              e.stopPropagation()
              connect(host, { view: 'files' })
            }}
          >
            <FolderOpen size={13} />
          </IconButton>
        )}
        <IconButton
          label={`Edit ${host.label}`}
          size="sm"
          data-testid="host-edit"
          onClick={(e) => {
            e.stopPropagation()
            onEdit()
          }}
        >
          <Pencil size={13} />
        </IconButton>
        <IconButton
          label={`Connect to ${host.label}`}
          size="sm"
          data-testid="host-connect"
          className="text-accent hover:text-accent"
          onClick={(e) => {
            e.stopPropagation()
            onOpen()
          }}
        >
          <Play size={13} />
        </IconButton>
      </span>
    </div>
  )
}
