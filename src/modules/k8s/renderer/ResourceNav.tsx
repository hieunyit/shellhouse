import { useState } from 'react'
import { ChevronRight, LayoutDashboard } from 'lucide-react'
import { cx } from '../../../renderer/src/components/ui'
import type { DiscoveredKind } from '../shared/ops'
import { BUILTIN_KINDS } from '../shared/resources'
import { OVERVIEW } from './nav'

const SECTIONS = ['Workloads', 'Network', 'Config', 'Storage', 'Cluster'] as const
const CUSTOM = 'Custom resources'
const STORE_KEY = 'shellhouse.k8s.nav'

/** Nhóm người dùng đã tự mở / đóng (nhớ giữa các lần mở app — chỉ là tiện lợi, lỗi thì bỏ qua). */
function loadChoices(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(STORE_KEY)
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}
function saveChoices(v: Record<string, boolean>): void {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(v))
  } catch {
    // Bỏ qua: chế độ riêng tư / bị chặn lưu trữ.
  }
}

interface Item {
  id: string
  title: string
}

/**
 * Thanh điều hướng kiểu Lens: các nhóm thu gọn được. Mặc định chỉ mở nhóm đang xem (và
 * Workloads); lựa chọn mở / đóng của người dùng được nhớ. CRD gom theo API group, đóng sẵn.
 */
export function ResourceNav({
  kinds,
  view,
  drilled,
  onGo
}: {
  kinds: DiscoveredKind[] | null
  view: string
  /** Đang đi sâu (breadcrumb) — không tô mục nào là "đang xem". */
  drilled: boolean
  onGo: (id: string) => void
}): React.JSX.Element {
  const [choices, setChoices] = useState<Record<string, boolean>>(loadChoices)
  const visible = (kinds ?? BUILTIN_KINDS.map((x) => ({ ...x, forbidden: false }))).filter(
    (x) => !x.forbidden
  )
  const builtin = new Map(BUILTIN_KINDS.map((b) => [b.id, b]))
  const groups: { id: string; title: string; items: Item[]; sub?: boolean }[] = []
  for (const section of SECTIONS) {
    const items = visible
      .filter((x) => builtin.get(x.id)?.section === section)
      .map((x) => ({ id: x.id, title: builtin.get(x.id)?.title ?? x.kind }))
    if (items.length) groups.push({ id: section, title: section, items })
  }
  const custom = visible.filter((x) => !builtin.has(x.id))
  const byGroup = new Map<string, Item[]>()
  for (const x of custom)
    byGroup.set(x.group || 'core', [
      ...(byGroup.get(x.group || 'core') ?? []),
      { id: x.id, title: x.kind }
    ])
  const crdGroups = [...byGroup.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([g, items]) => ({
      id: `crd:${g}`,
      title: g,
      items: items.sort((a, b) => a.title.localeCompare(b.title)),
      sub: true
    }))

  const has = (items: Item[]): boolean => !drilled && items.some((i) => i.id === view)
  const isOpen = (id: string, items: Item[], fallback: boolean): boolean =>
    choices[id] ?? (has(items) || fallback)
  const toggle = (id: string, open: boolean): void => {
    const next = { ...choices, [id]: !open }
    setChoices(next)
    saveChoices(next)
  }

  const item = (x: Item, indent: boolean): React.JSX.Element => {
    const current = view === x.id && !drilled
    return (
      <button
        key={x.id}
        type="button"
        data-testid={`k8s-nav-${x.id}`}
        aria-current={current}
        title={x.id}
        className={cx(
          'block w-full truncate rounded-md py-1 pr-2 text-left text-[13px]',
          indent ? 'pl-9' : 'pl-7',
          current
            ? 'bg-surface font-medium text-fg shadow-sm'
            : 'text-muted hover:bg-hover hover:text-fg'
        )}
        onClick={() => {
          onGo(x.id)
        }}
      >
        {x.title}
      </button>
    )
  }

  const header = (
    id: string,
    title: string,
    open: boolean,
    active: boolean,
    count: number,
    sub = false
  ): React.JSX.Element => (
    <button
      type="button"
      data-testid={`k8s-nav-group-${id}`}
      aria-expanded={open}
      className={cx(
        'flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left hover:bg-hover',
        sub ? 'pl-4 text-xs' : 'pl-1.5 text-[13px] font-medium',
        active && !open ? 'text-accent' : sub ? 'text-muted' : 'text-fg'
      )}
      onClick={() => {
        toggle(id, open)
      }}
    >
      <ChevronRight
        size={13}
        className={cx('shrink-0 text-faint transition-transform', open && 'rotate-90')}
      />
      <span className="min-w-0 flex-1 truncate" title={title}>
        {title}
      </span>
      {!open && <span className="text-[11px] font-normal text-faint tabular-nums">{count}</span>}
    </button>
  )

  const onOverview = view === OVERVIEW && !drilled
  const customItems = crdGroups.flatMap((g) => g.items)
  const customOpen = isOpen(CUSTOM, customItems, false)
  return (
    <nav
      className="flex w-48 shrink-0 flex-col gap-0.5 overflow-auto border-r border-line bg-subtle p-2"
      data-testid="k8s-nav"
    >
      <button
        type="button"
        data-testid={`k8s-nav-${OVERVIEW}`}
        aria-current={onOverview}
        className={cx(
          'mb-1 flex items-center gap-2 rounded-md px-2 py-1 text-left text-[13px]',
          onOverview
            ? 'bg-surface font-medium text-fg shadow-sm'
            : 'text-muted hover:bg-hover hover:text-fg'
        )}
        onClick={() => {
          onGo(OVERVIEW)
        }}
      >
        <LayoutDashboard size={13} /> Overview
      </button>
      {groups.map((g) => {
        const open = isOpen(g.id, g.items, g.id === 'Workloads')
        return (
          <div key={g.id}>
            {header(g.id, g.title, open, has(g.items), g.items.length)}
            {open && g.items.map((x) => item(x, false))}
          </div>
        )
      })}
      {crdGroups.length > 0 && (
        <div>
          {header(CUSTOM, CUSTOM, customOpen, has(customItems), customItems.length)}
          {customOpen &&
            crdGroups.map((g) => {
              const open = isOpen(g.id, g.items, false)
              return (
                <div key={g.id}>
                  {header(g.id, g.title, open, has(g.items), g.items.length, true)}
                  {open && g.items.map((x) => item(x, true))}
                </div>
              )
            })}
        </div>
      )}
    </nav>
  )
}
