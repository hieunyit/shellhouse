import { memo, useState } from 'react'
import { ChevronRight, LayoutDashboard, Map as MapIcon } from 'lucide-react'
import { cx } from '../../../renderer/src/components/ui'
import { COUNT_CAPPED, type DiscoveredKind } from '../shared/ops'
import { BUILTIN_KINDS, CRD_SECTIONS, type ResourceSection } from '../shared/resources'
import { formatNumber, t, type NavPlacement } from '../../registry/renderer-kit'
import { HELM, MAP, OVERVIEW } from './nav'

/** Thứ tự nhóm như Rancher; CRD có nhóm riêng (Gateway API, Argo CD) đứng sau, rồi Apps. */
const SECTIONS: readonly ResourceSection[] = [
  'Workloads',
  'Service Discovery',
  'Storage',
  'Policy',
  'Access Control',
  'Cluster'
]
/** Id nhóm (cũng là test id) — tiêu đề hiện dịch lúc vẽ. */
const CUSTOM = 'Custom resources'
const APPS = 'Apps'
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

/** "applicationsets" → "ApplicationSets" (tên CRD hiện ở số nhiều như Rancher / Lens). */
function plural(kind: string): string {
  return /(s|x|ch|sh)$/.test(kind)
    ? `${kind}es`
    : /[^aeiou]y$/.test(kind)
      ? `${kind.slice(0, -1)}ies`
      : `${kind}s`
}

/**
 * Thanh điều hướng kiểu Rancher / Lens: nhóm thu gọn được (Workloads, Service Discovery, Storage,
 * Policy, Access Control, Cluster; Gateway API / Argo CD khi cluster có), mỗi loại có số đối
 * tượng. Mặc định mở Workloads và nhóm đang xem; lựa chọn mở / đóng được nhớ.
 */
export const ResourceNav = memo(function ResourceNav({
  kinds,
  view,
  drilled,
  counts,
  onGo,
  placement = 'inline'
}: {
  kinds: DiscoveredKind[] | null
  view: string
  /** Đang đi sâu (breadcrumb) — không tô mục nào là "đang xem". */
  drilled: boolean
  /** Số đối tượng theo loại (namespace đang chọn); thiếu / null = chưa biết. */
  counts: Readonly<Record<string, number | null>>
  onGo: (id: string) => void
  /** Trong Explorer của khung app (không khung riêng) hay cột bên trái của view. */
  placement?: NavPlacement
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
    // Tên nhóm là hằng tiếng Anh (cũng là id / test id) → dịch lúc vẽ.
    if (items.length) groups.push({ id: section, title: t(section), items })
  }
  const custom = visible.filter((x) => !builtin.has(x.id))
  for (const [group, title] of Object.entries(CRD_SECTIONS)) {
    const items = custom
      .filter((x) => x.group === group)
      .map((x) => ({ id: x.id, title: plural(x.kind) }))
      .sort((a, b) => a.title.localeCompare(b.title))
    if (items.length) groups.push({ id: title, title, items })
  }
  groups.push({ id: APPS, title: t('Apps'), items: [{ id: HELM, title: t('Helm releases') }] })
  const byGroup = new Map<string, Item[]>()
  for (const x of custom) {
    if (CRD_SECTIONS[x.group]) continue
    const g = x.group || 'core'
    byGroup.set(g, [...(byGroup.get(g) ?? []), { id: x.id, title: plural(x.kind) }])
  }
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
    const n = counts[x.id]
    // Loại quá nhiều đối tượng để đếm hết: số là mức tối thiểu.
    const capped = counts[`${COUNT_CAPPED}${x.id}`] === 1
    return (
      <button
        key={x.id}
        type="button"
        data-testid={`k8s-nav-${x.id}`}
        aria-current={current}
        title={x.id}
        className={cx(
          'flex w-full items-center gap-2 rounded-md py-1 pr-2 text-left text-[13px]',
          indent ? 'pl-9' : 'pl-7',
          current
            ? 'bg-ds-active font-medium text-fg'
            : 'text-muted hover:bg-ds-hover hover:text-fg'
        )}
        onClick={() => {
          onGo(x.id)
        }}
      >
        <span className="min-w-0 flex-1 truncate">{x.title}</span>
        {typeof n === 'number' && (
          <span
            className={cx(
              'shrink-0 text-[11px] tabular-nums',
              n === 0 ? 'text-faint/70' : 'text-faint'
            )}
            data-testid="k8s-nav-count"
            title={capped ? t('At least {n}', { n: formatNumber(n) }) : undefined}
          >
            {formatNumber(n)}
            {capped ? '+' : ''}
          </span>
        )}
      </button>
    )
  }

  const header = (
    id: string,
    title: string,
    open: boolean,
    active: boolean,
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
    </button>
  )

  const onOverview = view === OVERVIEW && !drilled
  const customItems = crdGroups.flatMap((g) => g.items)
  const customOpen = isOpen(CUSTOM, customItems, false)
  return (
    <nav
      className={cx(
        'flex flex-col gap-0.5',
        placement === 'inline' &&
          'w-60 shrink-0 overflow-auto border-r border-ds-border-subtle bg-ds-bg p-2'
      )}
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
        <LayoutDashboard size={13} /> {t('Overview')}
      </button>
      <button
        type="button"
        data-testid={`k8s-nav-${MAP}`}
        aria-current={view === MAP && !drilled}
        className={cx(
          'mb-1 flex items-center gap-2 rounded-md px-2 py-1 text-left text-[13px]',
          view === MAP && !drilled
            ? 'bg-surface font-medium text-fg shadow-sm'
            : 'text-muted hover:bg-hover hover:text-fg'
        )}
        onClick={() => {
          onGo(MAP)
        }}
      >
        <MapIcon size={13} /> {t('Map')}
      </button>
      {groups.map((g) => {
        const open = isOpen(g.id, g.items, g.id === 'Workloads')
        return (
          <div key={g.id}>
            {header(g.id, g.title, open, has(g.items))}
            {open && g.items.map((x) => item(x, false))}
          </div>
        )
      })}
      {crdGroups.length > 0 && (
        <div>
          {header(CUSTOM, t('Custom resources'), customOpen, has(customItems))}
          {customOpen &&
            crdGroups.map((g) => {
              const open = isOpen(g.id, g.items, false)
              return (
                <div key={g.id}>
                  {header(g.id, g.title, open, has(g.items), true)}
                  {open && g.items.map((x) => item(x, true))}
                </div>
              )
            })}
        </div>
      )}
    </nav>
  )
})
