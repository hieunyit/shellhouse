import type { SortOption } from '../components/SortMenu'

export type SortKey = 'name' | 'size' | 'modified'

export const OBJECT_SORT_OPTIONS = [
  { key: 'name', label: 'Name', kind: 'text' },
  { key: 'size', label: 'Size', kind: 'number' },
  { key: 'modified', label: 'Modified', kind: 'date' }
] as const satisfies readonly SortOption<SortKey>[]
export const OBJECT_SORT_KEYS: readonly SortKey[] = OBJECT_SORT_OPTIONS.map((o) => o.key)

export { nameOrder as collator, dateFormat } from '../lib/format'
export { Empty, ToolButton } from '../components/files/parts'
/** Cột danh sách: Modified / Class chỉ hiện khi khung đủ rộng (container query). */
export const columns =
  'grid-cols-[minmax(0,1fr)_5rem] @xl:grid-cols-[minmax(0,1fr)_5rem_8.5rem] @3xl:grid-cols-[minmax(0,1fr)_5rem_8.5rem_6.5rem]'

export function storageClassLabel(cls: string | null): string {
  if (!cls) return 'Standard'
  return cls
    .toLowerCase()
    .split('_')
    .map((w) => (w === 'ia' ? 'IA' : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
}
