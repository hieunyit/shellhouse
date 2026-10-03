import { useState } from 'react'
import { ArrowDownUp, Check } from 'lucide-react'
import { t } from '@shared/i18n'
import { useContextMenu, type MenuEntry } from './ContextMenu'
import { IconButton } from './ui'

export type SortDir = 'asc' | 'desc'
export interface SortState<K extends string> {
  key: K
  dir: SortDir
}
/** `kind` quyết định chữ của chiều sắp xếp: A → Z, nhỏ → lớn, cũ → mới. */
export interface SortOption<K extends string> {
  key: K
  label: string
  kind: 'text' | 'number' | 'date'
}

function dirLabel(kind: SortOption<string>['kind'], dir: SortDir): string {
  switch (kind) {
    case 'text':
      return dir === 'asc' ? 'A → Z' : 'Z → A'
    case 'number':
      return dir === 'asc' ? t('Smallest first') : t('Largest first')
    case 'date':
      return dir === 'asc' ? t('Oldest first') : t('Newest first')
  }
}

/** Chiều mặc định khi chọn một cột: tên A → Z; dung lượng / ngày thì lớn / mới trước. */
export function defaultDir(kind: SortOption<string>['kind']): SortDir {
  return kind === 'text' ? 'asc' : 'desc'
}

const storageKey = (scope: string): string => `shellhouse.sort.${scope}`

/**
 * Kiểu sắp xếp nhớ qua các lần mở (localStorage của cửa sổ — chỉ là tiện ích hiển thị; đọc/ghi lỗi
 * thì dùng mặc định).
 */
export function usePersistentSort<K extends string>(
  scope: string,
  allowed: readonly K[],
  initial: SortState<K>
): [SortState<K>, (next: SortState<K>) => void] {
  const [sort, setSort] = useState<SortState<K>>(() => {
    try {
      const raw = localStorage.getItem(storageKey(scope))
      const saved = raw ? (JSON.parse(raw) as Partial<SortState<string>>) : null
      if (
        saved &&
        allowed.includes(saved.key as K) &&
        (saved.dir === 'asc' || saved.dir === 'desc')
      )
        return { key: saved.key as K, dir: saved.dir }
    } catch {
      // Bỏ qua: dùng mặc định.
    }
    return initial
  })
  const update = (next: SortState<K>): void => {
    setSort(next)
    try {
      localStorage.setItem(storageKey(scope), JSON.stringify(next))
    } catch {
      // Không lưu được thì chỉ mất phần "nhớ", sắp xếp vẫn chạy.
    }
  }
  return [sort, update]
}

/** Nút "Sort": chọn cột và chiều sắp xếp (cho người không biết bấm tiêu đề cột). */
export function SortMenu<K extends string>({
  options,
  sort,
  onChange,
  testId
}: {
  options: readonly SortOption<K>[]
  sort: SortState<K>
  onChange: (next: SortState<K>) => void
  testId?: string
}): React.JSX.Element {
  const { menu, open } = useContextMenu()
  const current = options.find((o) => o.key === sort.key) ?? options[0]
  const kind = current?.kind ?? 'text'
  const mark = (on: boolean): React.JSX.Element =>
    on ? <Check size={14} className="text-accent" /> : <span className="inline-block size-3.5" />

  const items = (): MenuEntry[] => [
    ...options.map((o): MenuEntry => ({
      id: `sort-${o.key}`,
      label: o.label,
      icon: mark(o.key === sort.key),
      onSelect: () => {
        onChange({ key: o.key, dir: o.key === sort.key ? sort.dir : defaultDir(o.kind) })
      }
    })),
    'separator',
    ...(['asc', 'desc'] as const).map((dir): MenuEntry => ({
      id: `sort-${dir}`,
      label: dirLabel(kind, dir),
      icon: mark(sort.dir === dir),
      onSelect: () => {
        onChange({ key: sort.key, dir })
      }
    }))
  ]

  return (
    <>
      <IconButton
        label={t('Sort: {column}, {direction}', {
          column: current?.label ?? '',
          direction: dirLabel(kind, sort.dir)
        })}
        size="sm"
        className="size-7"
        data-testid={testId}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          open({ clientX: r.left, clientY: r.bottom + 4, preventDefault: () => undefined }, items())
        }}
      >
        <ArrowDownUp size={14} />
      </IconButton>
      {menu}
    </>
  )
}
