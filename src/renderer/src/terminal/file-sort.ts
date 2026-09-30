import type { SortOption } from '../components/SortMenu'

/** Sắp xếp danh sách file (SFTP remote và local): cột và thứ tự tên tự nhiên (file2 < file10). */
export type FileSort = 'name' | 'size' | 'mtime'

export const FILE_SORT_OPTIONS = [
  { key: 'name', label: 'Name', kind: 'text' },
  { key: 'size', label: 'Size', kind: 'number' },
  { key: 'mtime', label: 'Modified', kind: 'date' }
] as const satisfies readonly SortOption<FileSort>[]

export const FILE_SORT_KEYS: readonly FileSort[] = FILE_SORT_OPTIONS.map((o) => o.key)

export const nameOrder = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
