import { memo, type RefObject } from 'react'
import { File, Folder, Pin } from 'lucide-react'
import type { S3Entry } from '../shared/ops'
import { cx } from '../../../renderer/src/components/ui'
import { formatDateTime, formatRelative, t } from '../../registry/renderer-kit'
import { formatSize } from './format'
import { columns, storageClassLabel } from './parts'

type Mods = { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }

/** Xử lý sự kiện của dòng — để trong ref (ổn định), dòng không vẽ lại khi hàm đổi. */
export interface RowHandlers {
  select(entry: S3Entry, e: Mods): void
  open(entry: S3Entry): void
  menu(entry: S3Entry, e: React.MouseEvent): void
}

/**
 * Một dòng object / thư mục. memo: thư mục 5 000+ mục không vẽ lại mọi dòng mỗi lần tiến độ tải lên
 * cập nhật (~4 lần / giây) hay khi chọn một mục — chỉ dòng đổi trạng thái chọn / ghim.
 */
export const ObjectRow = memo(function ObjectRow({
  entry,
  selected,
  pinned,
  handlers
}: {
  entry: S3Entry
  selected: boolean
  pinned: boolean
  handlers: RefObject<RowHandlers>
}): React.JSX.Element {
  return (
    <div
      role="row"
      aria-selected={selected}
      data-testid="s3-entry"
      data-name={entry.name}
      data-key={entry.key}
      className={cx(
        'grid h-8 cursor-default items-center gap-3 px-3 text-[13px] select-none',
        columns,
        selected ? 'bg-accent-soft' : 'hover:bg-hover'
      )}
      onClick={(e) => {
        handlers.current.select(entry, e)
      }}
      onDoubleClick={() => {
        handlers.current.open(entry)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        handlers.current.menu(entry, e)
      }}
    >
      <span role="gridcell" className="flex min-w-0 items-center gap-2">
        {entry.isFolder ? (
          <Folder size={15} className="shrink-0 text-accent" />
        ) : (
          <File size={15} className="shrink-0 text-muted" />
        )}
        <span className="truncate" title={entry.name}>
          {entry.name}
        </span>
        {pinned && <Pin size={11} className="shrink-0 text-accent" aria-label={t('Pinned')} />}
      </span>
      <span role="gridcell" className="text-right text-xs text-muted tabular-nums">
        {entry.isFolder ? '' : formatSize(entry.size)}
      </span>
      <span
        role="gridcell"
        className="hidden truncate text-xs text-muted tabular-nums @xl:block"
        title={entry.modified ? formatRelative(entry.modified) : undefined}
      >
        {entry.modified ? formatDateTime(entry.modified) : ''}
      </span>
      <span role="gridcell" className="hidden truncate text-xs text-faint @3xl:block">
        {entry.isFolder ? '' : storageClassLabel(entry.storageClass)}
      </span>
    </div>
  )
})
