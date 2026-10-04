import { memo, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react'
import { FolderOpen, Pencil, Play, Star } from 'lucide-react'
import { t } from '@shared/i18n'
import { formatDateTime } from '@shared/i18n/format'
import type { HostSummary } from '@shared/hosts'
import { hostAddress, useHosts } from '../../stores/hosts'
import { useTabStatus } from '../../stores/tab-status'
import { useTabs } from '../../stores/tabs'
import { sessionsByHost } from './sessions'
import { HostAvatar } from '../HostAvatar'
import { cx, IconButton, StatusDot, type ConnectionState } from '../ui'
import { connect } from './actions'

/** Trạng thái "tốt nhất" trong các tab đang mở tới host này (null = không có tab nào). */
function useHostSession(hostId: string): ConnectionState | null {
  return useTabStatus((status) => {
    const best = sessionsByHost(useTabs.getState().tabs, status.byTab).get(hostId) ?? null
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

/**
 * Thao tác trên hàng host — một object ỔN ĐỊNH dùng chung cho mọi hàng (nhận host làm tham số), để
 * HostRow (memo) không vẽ lại mỗi khi thanh bên vẽ lại (chọn, kéo thả, gõ tìm…).
 */
export interface HostRowHandlers {
  select: (host: HostSummary, e: MouseEvent | KeyboardEvent) => void
  open: (host: HostSummary) => void
  edit: (host: HostSummary) => void
  contextMenu: (host: HostSummary, e: MouseEvent) => void
  dragStart: (host: HostSummary, e: DragEvent) => void
  dragEnd: () => void
  /** Thả lên host trong cây: sắp xếp. */
  dragOver: (host: HostSummary, e: DragEvent) => void
  dragLeave: (e: DragEvent) => void
  drop: (host: HostSummary, e: DragEvent) => void
}

export const HostRow = memo(function HostRow({
  host,
  testId = 'host-row',
  groupPath,
  selected,
  active,
  dropPos,
  handlers,
  dnd,
  compact
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
  handlers: HostRowHandlers
  /** 'sort' = kéo đi và nhận thả (cây); 'drag' = chỉ kéo đi (Favorites / Recent). */
  dnd?: 'sort' | 'drag'
  /** Một dòng, thấp hơn (Favorites / Recent): địa chỉ và nhóm chuyển vào tooltip. */
  compact?: boolean
}): React.JSX.Element {
  const session = useHostSession(host.id)
  const effective = useHosts((s) => s.effective.get(host.id))
  const address = hostAddress(host, effective)
  const h = handlers
  return (
    <div
      role="treeitem"
      aria-selected={selected ?? false}
      draggable={!!dnd}
      data-tree-item=""
      data-tree-key={`${testId}:${host.id}`}
      data-testid={testId}
      data-host-label={host.label}
      data-selected={selected ? 'true' : undefined}
      title={[
        compact && groupPath ? `${host.label} · ${groupPath}` : null,
        address,
        host.lastUsedAt ? t('Last used: {time}', { time: formatDateTime(host.lastUsedAt) }) : null
      ]
        .filter(Boolean)
        .join('\n')}
      // Một dòng (thiết kế v0.5): icon hệ điều hành đơn sắc · tên · chấm trạng thái phiên bên phải;
      // địa chỉ / nhóm nằm trong tooltip.
      className={cx(
        'group relative flex h-(--ds-tree-row-h) cursor-default items-center gap-2 rounded-ds-md px-2 transition-colors duration-100 outline-none focus-visible:shadow-ds-focus',
        selected ? 'bg-ds-active font-medium' : active ? 'bg-ds-hover' : 'hover:bg-ds-hover'
      )}
      onClick={(e) => {
        h.select(host, e)
      }}
      onDoubleClick={() => {
        h.open(host)
      }}
      onContextMenu={(e) => {
        h.contextMenu(host, e)
      }}
      onKeyDown={(e) => {
        // Chỉ khi chính hàng đang focus — Enter trên nút con (Edit, SFTP…) không mở thêm phiên.
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter') h.open(host)
        else if (e.key === ' ') {
          e.preventDefault()
          h.select(host, e)
        }
      }}
      {...(dnd
        ? {
            onDragStart: (e: DragEvent) => {
              h.dragStart(host, e)
            },
            onDragEnd: h.dragEnd
          }
        : {})}
      {...(dnd === 'sort'
        ? {
            onDragOver: (e: DragEvent) => {
              h.dragOver(host, e)
            },
            onDragLeave: h.dragLeave,
            onDrop: (e: DragEvent) => {
              h.drop(host, e)
            }
          }
        : {})}
    >
      <DropLine pos={dropPos ?? null} />
      <HostAvatar host={host} />
      <span className="min-w-0 flex-1 truncate text-[13px] text-fg">
        {host.label}
        {groupPath && !compact && (
          <span className="ml-1.5 text-xs font-normal text-faint">{groupPath}</span>
        )}
      </span>
      {host.favorite && testId === 'host-row' && (
        <Star
          size={11}
          className="shrink-0 fill-ds-fg-3 text-faint group-hover:hidden"
          aria-label={t('Favorite')}
        />
      )}
      {session && (
        <span className="flex shrink-0 group-focus-within:hidden group-hover:hidden">
          <StatusDot state={session} />
        </span>
      )}
      {/* Thao tác nhanh khi rê chuột: mở file (SFTP), sửa, kết nối. */}
      <span className="hidden shrink-0 items-center group-focus-within:flex group-hover:flex">
        {host.protocol === 'ssh' && (
          <IconButton
            label={t('Open files on {name}', { name: host.label })}
            size="sm"
            tabIndex={-1}
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
          label={t('Edit {name}', { name: host.label })}
          size="sm"
          tabIndex={-1}
          data-testid="host-edit"
          onClick={(e) => {
            e.stopPropagation()
            h.edit(host)
          }}
        >
          <Pencil size={13} />
        </IconButton>
        <IconButton
          label={t('Connect to {name}', { name: host.label })}
          size="sm"
          tabIndex={-1}
          data-testid="host-connect"
          className="text-ds-accent-text hover:text-ds-accent-text"
          onClick={(e) => {
            e.stopPropagation()
            h.open(host)
          }}
        >
          <Play size={13} />
        </IconButton>
      </span>
    </div>
  )
})
