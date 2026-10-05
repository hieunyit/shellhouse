import { memo, useState } from 'react'
import {
  Box,
  Boxes,
  ChevronRight,
  Clock,
  Copy,
  Database,
  HardDrive,
  Hash,
  KeyRound,
  Layers,
  LayoutDashboard,
  ListChecks,
  LogIn,
  Map as MapIcon,
  Network,
  Package,
  Server,
  SlidersHorizontal,
  type LucideIcon
} from 'lucide-react'
import { cx } from '../../../renderer/src/components/ui'
import { COUNT_CAPPED, type DiscoveredKind, type HealthResult } from '../shared/ops'
import { BUILTIN_KINDS, CRD_SECTIONS, type ResourceSection } from '../shared/resources'
import { formatNumber, t, type NavPlacement } from '../../registry/renderer-kit'
import { HELM, MAP, OVERVIEW } from './nav'

/** Thứ tự nhóm như Rancher; CRD có nhóm riêng (Gateway API, Argo CD) đứng sau. */
const SECTIONS: readonly ResourceSection[] = [
  'Workloads',
  'Service Discovery',
  'Storage',
  'Policy',
  'Access Control',
  'Cluster'
]
/**
 * Loại hay dùng hiện ngay dưới namespace đang chọn (thiết kế v0.5: Explorer › cluster › namespace ›
 * Pods, Deployments…). Loại còn lại nằm ở "More resources".
 */
const QUICK = [
  'pods',
  'deployments.apps',
  'statefulsets.apps',
  'daemonsets.apps',
  'jobs.batch',
  'cronjobs.batch',
  'services',
  'ingresses.networking.k8s.io',
  'configmaps',
  'secrets',
  'persistentvolumeclaims'
]
/** Icon nét đơn sắc cho loại hay dùng (Explorer của thiết kế v0.5). */
const QUICK_ICON: Record<string, LucideIcon> = {
  pods: Box,
  'deployments.apps': Layers,
  'statefulsets.apps': Database,
  'daemonsets.apps': Copy,
  'jobs.batch': ListChecks,
  'cronjobs.batch': Clock,
  services: Network,
  'ingresses.networking.k8s.io': LogIn,
  configmaps: SlidersHorizontal,
  secrets: KeyRound,
  persistentvolumeclaims: HardDrive
}
/** Mục cấp cluster (trên danh sách namespace). */
const CLUSTER_LEVEL = new Set([OVERVIEW, MAP, HELM, 'nodes'])
/** Id nhóm (cũng là test id) — tiêu đề hiện dịch lúc vẽ. */
const MORE = 'more'
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
 * Điều hướng của một cluster (thiết kế v0.5): Overview · Map · Helm releases · Nodes; rồi danh sách
 * namespace — namespace đang xem mở ra các loại hay dùng (Pods, Deployments, Services…) kèm số
 * đối tượng; "More resources" giữ đủ mọi loại theo nhóm kiểu Rancher (RBAC, Storage, CRD…).
 * Lựa chọn mở / đóng nhóm được nhớ.
 */
export const ResourceNav = memo(function ResourceNav({
  kinds,
  view,
  drilled,
  counts,
  allNamespaces,
  namespaces,
  health = null,
  onNamespaces,
  onGo,
  placement = 'inline'
}: {
  kinds: DiscoveredKind[] | null
  view: string
  /** Đang đi sâu (breadcrumb) — không tô mục nào là "đang xem". */
  drilled: boolean
  /** Số đối tượng theo loại (namespace đang chọn); thiếu / null = chưa biết. */
  counts: Readonly<Record<string, number | null>>
  /** Mọi namespace của cluster (đọc được). */
  allNamespaces: readonly string[]
  /** Namespace đang xem: [] = mọi namespace; null = chưa biết. */
  namespaces: readonly string[] | null
  /** Pod / deployment lỗi theo namespace — "N failing" cạnh namespace, Pods, Deployments. */
  health?: HealthResult | null
  onNamespaces: (v: string[]) => void
  onGo: (id: string) => void
  /** Trong Explorer của khung app (không khung riêng) hay cột bên trái của view. */
  placement?: NavPlacement
}): React.JSX.Element {
  const [choices, setChoices] = useState<Record<string, boolean>>(loadChoices)
  const visible = (kinds ?? BUILTIN_KINDS.map((x) => ({ ...x, forbidden: false }))).filter(
    (x) => !x.forbidden
  )
  const builtin = new Map(BUILTIN_KINDS.map((b) => [b.id, b]))
  const visibleIds = new Set(visible.map((x) => x.id))
  const quick: Item[] = QUICK.filter((id) => visibleIds.has(id)).map((id) => ({
    id,
    title: builtin.get(id)?.title ?? id
  }))
  const groups: { id: string; title: string; items: Item[] }[] = []
  for (const section of SECTIONS) {
    const items = visible
      .filter(
        (x) =>
          builtin.get(x.id)?.section === section &&
          !QUICK.includes(x.id) &&
          !CLUSTER_LEVEL.has(x.id)
      )
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
      items: items.sort((a, b) => a.title.localeCompare(b.title))
    }))

  const has = (items: Item[]): boolean => !drilled && items.some((i) => i.id === view)
  const isOpen = (id: string, items: Item[], fallback: boolean): boolean =>
    choices[id] ?? (has(items) || fallback)
  const toggle = (id: string, open: boolean): void => {
    const next = { ...choices, [id]: !open }
    setChoices(next)
    saveChoices(next)
  }

  const row = (
    id: string,
    label: string,
    icon: React.ReactNode,
    level: number,
    current: boolean,
    onClick: () => void,
    meta?: React.ReactNode
  ): React.JSX.Element => (
    <button
      key={id}
      type="button"
      data-testid={`k8s-nav-${id}`}
      aria-current={current}
      title={label}
      className={cx(
        'flex h-7 w-full shrink-0 items-center gap-2 rounded-ds-md pr-2 text-left text-ds-base outline-none focus-visible:shadow-ds-focus',
        current
          ? 'bg-ds-active font-medium text-ds-fg'
          : 'text-ds-fg-2 hover:bg-ds-hover hover:text-ds-fg'
      )}
      style={{ paddingLeft: `${String(8 + level * 14)}px` }}
      onClick={onClick}
    >
      {icon && <span className="flex shrink-0 text-ds-fg-3">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {meta}
    </button>
  )

  const count = (id: string): React.ReactNode => {
    const n = counts[id]
    if (typeof n !== 'number') return null
    // Loại quá nhiều đối tượng để đếm hết: số là mức tối thiểu.
    const capped = counts[`${COUNT_CAPPED}${id}`] === 1
    return (
      <span
        className={cx(
          'shrink-0 text-ds-xs tabular-nums',
          n === 0 ? 'text-ds-fg-4' : 'text-ds-fg-3'
        )}
        data-testid="k8s-nav-count"
        title={capped ? t('At least {n}', { n: formatNumber(n) }) : undefined}
      >
        {formatNumber(n)}
        {capped ? '+' : ''}
      </span>
    )
  }

  // Số lỗi trong một phạm vi namespace (null = mọi namespace).
  const failingIn = (kind: 'pods' | 'deployments', scope: readonly string[] | null): number => {
    if (!health) return 0
    const map = health[kind]
    return scope === null
      ? Object.values(map).reduce((a, b) => a + b, 0)
      : scope.reduce((a, n) => a + (map[n] ?? 0), 0)
  }
  const failingBadge = (n: number, testId: string): React.ReactNode =>
    n > 0 ? (
      <span className="shrink-0 text-ds-xs text-ds-danger tabular-nums" data-testid={testId}>
        {t('{n} failing', { n: formatNumber(n) })}
      </span>
    ) : null
  // Phạm vi đang xem: [] = mọi namespace.
  const scope = namespaces && namespaces.length > 0 ? namespaces : null
  const kindFailing = (id: string): React.ReactNode =>
    id === 'pods'
      ? failingBadge(failingIn('pods', scope), 'k8s-nav-failing')
      : id === 'deployments.apps'
        ? failingBadge(failingIn('deployments', scope), 'k8s-nav-failing')
        : null

  const item = (x: Item, level: number): React.JSX.Element => {
    const Icon = QUICK_ICON[x.id]
    return row(
      x.id,
      x.title,
      Icon ? <Icon size={14} /> : null,
      level,
      view === x.id && !drilled,
      () => {
        onGo(x.id)
      },
      <>
        {kindFailing(x.id)}
        {count(x.id)}
      </>
    )
  }

  const header = (
    id: string,
    title: string,
    open: boolean,
    active: boolean,
    level: number
  ): React.JSX.Element => (
    <button
      key={id}
      type="button"
      data-testid={`k8s-nav-group-${id}`}
      aria-expanded={open}
      className={cx(
        'flex h-7 w-full items-center gap-1.5 rounded-ds-md pr-2 text-left text-ds-base outline-none hover:bg-ds-hover focus-visible:shadow-ds-focus',
        active && !open ? 'text-ds-accent-text' : 'text-ds-fg-2'
      )}
      style={{ paddingLeft: `${String(4 + level * 14)}px` }}
      onClick={() => {
        toggle(id, open)
      }}
    >
      <ChevronRight
        size={12}
        className={cx('shrink-0 text-ds-fg-3 transition-transform', open && 'rotate-90')}
      />
      <span className="min-w-0 flex-1 truncate" title={title}>
        {title}
      </span>
    </button>
  )

  // Namespace đang mở: một namespace đang xem; [] = "All namespaces"; nhiều namespace = nhóm chọn.
  const single = namespaces && namespaces.length === 1 ? namespaces[0] : null
  const all = namespaces !== null && namespaces.length === 0
  const many = namespaces && namespaces.length > 1 ? namespaces : null
  const nsRow = (ns: string): React.JSX.Element => {
    const open = single === ns
    return (
      <div key={`ns:${ns}`}>
        {row(
          `ns-${ns}`,
          ns,
          <Hash size={14} />,
          0,
          false,
          () => {
            onNamespaces(open ? [] : [ns])
            // Đang xem mục cấp cluster (Nodes): chọn namespace → Pods của namespace đó.
            if (!open && view === 'nodes') onGo('pods')
          },
          <>
            {failingBadge(
              failingIn('pods', [ns]) + failingIn('deployments', [ns]),
              'k8s-nav-ns-failing'
            )}
            <ChevronRight
              size={12}
              aria-hidden
              className={cx('shrink-0 text-ds-fg-3 transition-transform', open && 'rotate-90')}
            />
          </>
        )}
        {open && quick.map((x) => item(x, 1))}
      </div>
    )
  }

  const moreItems = [...groups.flatMap((g) => g.items), ...crdGroups.flatMap((g) => g.items)]
  const moreOpen = isOpen(MORE, moreItems, false)
  return (
    <nav
      className={cx(
        'flex flex-col gap-px',
        placement === 'inline' &&
          'w-60 shrink-0 overflow-auto border-r border-ds-border-subtle bg-ds-bg p-2'
      )}
      data-testid="k8s-nav"
    >
      {row(
        OVERVIEW,
        t('Overview'),
        <LayoutDashboard size={14} />,
        0,
        view === OVERVIEW && !drilled,
        () => {
          onGo(OVERVIEW)
        }
      )}
      {row(MAP, t('Map'), <MapIcon size={14} />, 0, view === MAP && !drilled, () => {
        onGo(MAP)
      })}
      {row(HELM, t('Helm releases'), <Package size={14} />, 0, view === HELM && !drilled, () => {
        onGo(HELM)
      })}
      {visibleIds.has('nodes') &&
        row(
          'nodes',
          t('Nodes'),
          <Server size={14} />,
          0,
          view === 'nodes' && !drilled,
          () => {
            onGo('nodes')
          },
          count('nodes')
        )}

      <div className="mt-3 mb-1 flex h-6 items-center px-2 text-ds-sm font-medium text-ds-fg-3">
        {t('Namespaces')}
      </div>
      <div>
        {row(
          'ns-all',
          t('All namespaces'),
          <Boxes size={14} />,
          0,
          false,
          () => {
            onNamespaces([])
          },
          <ChevronRight
            size={12}
            aria-hidden
            className={cx('shrink-0 text-ds-fg-3 transition-transform', all && 'rotate-90')}
          />
        )}
        {all && quick.map((x) => item(x, 1))}
      </div>
      {many && (
        <div>
          {row(
            'ns-selected',
            t('{n} namespaces', { n: formatNumber(many.length) }),
            <Boxes size={14} />,
            0,
            false,
            () => undefined,
            <ChevronRight size={12} aria-hidden className="shrink-0 rotate-90 text-ds-fg-3" />
          )}
          {quick.map((x) => item(x, 1))}
        </div>
      )}
      {allNamespaces.map(nsRow)}

      {moreItems.length > 0 && (
        <div className="mt-3">
          {header(MORE, t('More resources'), moreOpen, has(moreItems), 0)}
          {moreOpen &&
            [...groups, ...crdGroups].map((g) => {
              const open = isOpen(g.id, g.items, false)
              return (
                <div key={g.id}>
                  {header(g.id, g.title, open, has(g.items), 1)}
                  {open && g.items.map((x) => item(x, 2))}
                </div>
              )
            })}
        </div>
      )}
    </nav>
  )
})
