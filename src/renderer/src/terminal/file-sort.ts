import { t } from '@shared/i18n'
import type { SortOption } from '../components/SortMenu'

/** Sắp xếp danh sách file (SFTP remote và local): cột và thứ tự tên tự nhiên (file2 < file10). */
export type FileSort = 'name' | 'size' | 'mtime'

export const FILE_SORT_OPTIONS = [
  { key: 'name', label: 'Name', kind: 'text' },
  { key: 'size', label: 'Size', kind: 'number' },
  { key: 'mtime', label: 'Modified', kind: 'date' }
] as const satisfies readonly SortOption<FileSort>[]

/** Như FILE_SORT_OPTIONS nhưng nhãn đã dịch — gọi lúc render (menu sắp xếp, tiêu đề cột). */
export function fileSortOptions(): SortOption<FileSort>[] {
  const labels: Record<FileSort, string> = {
    name: t('Name'),
    size: t('Size'),
    mtime: t('Modified')
  }
  return FILE_SORT_OPTIONS.map((o) => ({ ...o, label: labels[o.key] }))
}

export const FILE_SORT_KEYS: readonly FileSort[] = FILE_SORT_OPTIONS.map((o) => o.key)

export { nameOrder } from '../lib/format'
