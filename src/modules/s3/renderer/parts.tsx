import type { SortOption } from '../../../renderer/src/components/SortMenu'
import { t } from '../../registry/renderer-kit'

export type SortKey = 'name' | 'size' | 'modified'

/** Tuỳ chọn menu Sort của danh sách object (dịch lúc vẽ). */
export function objectSortOptions(): SortOption<SortKey>[] {
  return [
    { key: 'name', label: t('Name'), kind: 'text' },
    { key: 'size', label: t('Size'), kind: 'number' },
    { key: 'modified', label: t('Modified'), kind: 'date' }
  ]
}
export const OBJECT_SORT_KEYS: readonly SortKey[] = ['name', 'size', 'modified']

export { nameOrder as collator } from '../../../renderer/src/lib/format'
export { Empty, ToolButton } from '../../../renderer/src/components/files/parts'
/** Cột danh sách: Modified / Class chỉ hiện khi khung đủ rộng (container query). */
export const columns =
  'grid-cols-[minmax(0,1fr)_5rem] @xl:grid-cols-[minmax(0,1fr)_5rem_8.5rem] @3xl:grid-cols-[minmax(0,1fr)_5rem_8.5rem_6.5rem]'

/** Tên lớp lưu trữ dễ đọc: STANDARD_IA → "Standard IA" (tên riêng của AWS, không dịch). */
export function storageClassLabel(cls: string | null): string {
  if (!cls) return 'Standard'
  return cls
    .toLowerCase()
    .split('_')
    .map((w) => (w === 'ia' ? 'IA' : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
}
