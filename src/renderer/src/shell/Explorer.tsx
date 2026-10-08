import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowDownToLine,
  CircleAlert,
  CircleCheck,
  Clock,
  FolderOpen,
  Laptop,
  List,
  Loader,
  PanelLeftClose,
  Plus,
  Search
} from 'lucide-react'
import { t } from '@shared/i18n'
import type { HostSummary } from '@shared/hosts'
import { bestScore } from '@shared/fuzzy'
import { IconButton } from '../ds'
import { cx, ICON_SM } from '../ds/utils'
import { Sidebar } from '../components/Sidebar'
import { HostAvatar } from '../components/HostAvatar'
import { SETTINGS_NAV, settingsDescription } from '../components/settings/settings-sections'
import { connect } from '../components/sidebar/actions'
import {
  rendererModule,
  useModuleEnabled,
  useModules
} from '../../../modules/registry/renderer-kit'
import { hostAddress, useHosts } from '../stores/hosts'
import { useSettings } from '../stores/settings'
import { useTabs } from '../stores/tabs'
import { openSidebarDialog } from '../stores/ui-requests'
import { useTransfers } from '../stores/transfers'
import { EXPLORER_WIDTH, useShell, type Area } from './store'
import { useTransfersFilter, TRANSFER_FILTERS, transferCounts, rowKey } from './transfers-filter'

/** Hàng của Explorer (cao 28px, icon 16px màu chữ phụ, mục chọn: nền active + chữ chính). */
export function ExplorerItem({
  icon,
  label,
  meta,
  current,
  testId,
  title,
  onClick,
  onDoubleClick
}: {
  icon?: ReactNode
  label: ReactNode
  meta?: ReactNode
  current?: boolean
  testId?: string
  title?: string
  onClick?: () => void
  onDoubleClick?: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      title={title}
      aria-current={current ? 'true' : undefined}
      className={cx(
        'flex h-(--ds-tree-row-h) w-full min-w-0 items-center gap-2 rounded-ds-md px-2 text-left text-ds-base outline-none',
        'focus-visible:shadow-ds-focus',
        current
          ? 'bg-ds-active font-medium text-ds-fg'
          : 'text-ds-fg-2 hover:bg-ds-hover hover:text-ds-fg'
      )}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      {icon && <span className="flex shrink-0 text-ds-fg-3">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {meta !== undefined && (
        <span className="shrink-0 text-ds-sm text-ds-fg-3 tabular-nums">{meta}</span>
      )}
    </button>
  )
}

export function ExplorerGroup({
  title,
  action,
  children
}: {
  title: string
  action?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="mb-3">
      <div className="flex h-7 items-center gap-1 px-2 text-ds-sm font-medium text-ds-fg-3">
        <span className="flex-1 truncate">{title}</span>
        {action}
      </div>
      {children}
    </div>
  )
}

function ExplorerSearch({
  value,
  onChange,
  placeholder,
  testId
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  testId: string
}): React.JSX.Element {
  return (
    <div className="flex h-ds-ctl items-center gap-1.5 rounded-ds-md border border-ds-border-control bg-ds-surface-1 px-2 focus-within:border-ds-accent focus-within:ring-3 focus-within:ring-ds-accent-soft hover:border-ds-fg-3">
      <Search {...ICON_SM} className="shrink-0 text-ds-fg-3" />
      <input
        type="search"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        data-testid={testId}
        className="min-w-0 flex-1 bg-transparent text-ds-base text-ds-fg outline-none placeholder:text-ds-fg-3"
        onChange={(e) => {
          onChange(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.stopPropagation()
            onChange('')
          }
        }}
      />
    </div>
  )
}

function useHostSearch(query: string): HostSummary[] | null {
  const hosts = useHosts((s) => s.tree.hosts)
  return useMemo(() => {
    if (!query.trim()) return null
    return hosts
      .map((h) => ({ h, s: bestScore(query, [h.label, h.hostname, ...h.tags]) }))
      .filter((r): r is { h: HostSummary; s: number } => r.s !== null)
      .sort((a, b) => b.s - a.s)
      .map((r) => r.h)
  }, [hosts, query])
}

function HostItem({
  host,
  testId,
  files
}: {
  host: HostSummary
  testId: string
  /** Mở thành trình quản lý file hai cột. */
  files?: boolean
}): React.JSX.Element {
  const effective = useHosts((s) => s.effective.get(host.id))
  return (
    <ExplorerItem
      testId={testId}
      icon={<HostAvatar host={host} size={16} className="rounded-ds-xs" />}
      label={host.label}
      title={hostAddress(host, effective)}
      onClick={() => {
        connect(host, files ? { view: 'files' } : undefined)
      }}
    />
  )
}

/** Home: tìm nhanh, host ghim (Favorites) và gần đây. */
function HomeExplorer(): React.JSX.Element {
  const hosts = useHosts((s) => s.tree.hosts)
  const [query, setQuery] = useState('')
  const results = useHostSearch(query)
  const favorites = useMemo(() => hosts.filter((h) => h.favorite), [hosts])
  const recent = useMemo(
    () =>
      hosts
        .filter((h) => h.lastUsedAt !== null)
        .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
        .slice(0, 8),
    [hosts]
  )
  return (
    <>
      <div className="px-2.5 pb-2">
        <ExplorerSearch
          value={query}
          onChange={setQuery}
          placeholder={t('Search…')}
          testId="explorer-home-search"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
        {results ? (
          results.length === 0 ? (
            <p className="px-2 py-2 text-ds-sm text-ds-fg-3">{t('No matching hosts.')}</p>
          ) : (
            results.map((h) => <HostItem key={h.id} host={h} testId="explorer-host" />)
          )
        ) : (
          <>
            {favorites.length > 0 && (
              <ExplorerGroup title={t('Pinned')}>
                {favorites.map((h) => (
                  <HostItem key={h.id} host={h} testId="explorer-pinned" />
                ))}
              </ExplorerGroup>
            )}
            {recent.length > 0 && (
              <ExplorerGroup title={t('Recent')}>
                {recent.map((h) => (
                  <HostItem key={h.id} host={h} testId="explorer-recent" />
                ))}
              </ExplorerGroup>
            )}
            {favorites.length === 0 && recent.length === 0 && (
              <p className="px-2 py-2 text-ds-sm text-ds-fg-3">
                {t('Hosts you pin or connect to show up here.')}
              </p>
            )}
          </>
        )}
      </div>
    </>
  )
}

/** Files: trình quản lý file đang mở + host SSH để mở thêm. */
function FilesExplorer(): React.JSX.Element {
  const hosts = useHosts((s) => s.tree.hosts)
  const tabs = useTabs((s) => s.tabs)
  const activeId = useTabs((s) => s.activeId)
  const [query, setQuery] = useState('')
  const results = useHostSearch(query)
  const filesLocal = useShell((s) => s.filesLocal)
  const ssh = useMemo(() => hosts.filter((h) => h.protocol === 'ssh'), [hosts])
  const open = tabs.filter((x) => x.view === 'files')
  return (
    <>
      <div className="px-2.5 pb-2">
        <ExplorerSearch
          value={query}
          onChange={setQuery}
          placeholder={t('Search hosts')}
          testId="explorer-files-search"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
        {!results && (
          <ExplorerGroup title={t('Local')}>
            <ExplorerItem
              testId="explorer-files-local"
              icon={<Laptop {...ICON_SM} />}
              label={t('This computer')}
              current={filesLocal}
              onClick={() => {
                useShell.getState().openLocalFiles()
              }}
            />
          </ExplorerGroup>
        )}
        {open.length > 0 && !results && (
          <ExplorerGroup title={t('Open')}>
            {open.map((x) => (
              <ExplorerItem
                key={x.id}
                testId="explorer-files-tab"
                icon={<FolderOpen {...ICON_SM} />}
                label={x.title.replace(/ \(SFTP\)$/, '')}
                current={!filesLocal && x.id === activeId}
                onClick={() => {
                  useTabs.getState().activate(x.id)
                }}
              />
            ))}
          </ExplorerGroup>
        )}
        <ExplorerGroup title={t('Remote (SFTP)')}>
          {(results ?? ssh).filter((h) => h.protocol === 'ssh').length === 0 ? (
            <p className="px-2 py-1 text-ds-sm text-ds-fg-3">
              {results ? t('No matching hosts.') : t('Saved SSH hosts show up here.')}
            </p>
          ) : (
            (results ?? ssh)
              .filter((h) => h.protocol === 'ssh')
              .map((h) => <HostItem key={h.id} host={h} testId="explorer-files-host" files />)
          )}
        </ExplorerGroup>
      </div>
    </>
  )
}

function TransfersExplorer(): React.JSX.Element {
  const filter = useTransfersFilter((s) => s.filter)
  const setFilter = useTransfersFilter((s) => s.setFilter)
  const sources = useTransfers((s) => s.sources)
  const counts = transferCounts(sources)
  const icons: Record<(typeof TRANSFER_FILTERS)[number]['id'], ReactNode> = {
    all: <List {...ICON_SM} />,
    active: <Loader {...ICON_SM} />,
    queued: <Clock {...ICON_SM} />,
    failed: <CircleAlert {...ICON_SM} />,
    done: <CircleCheck {...ICON_SM} />
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
      <ExplorerGroup title={t('Status')}>
        {TRANSFER_FILTERS.map((f) => (
          <ExplorerItem
            key={f.id}
            testId={`transfers-filter-${f.id}`}
            icon={icons[f.id]}
            label={f.title()}
            meta={counts[f.id] || undefined}
            current={filter === f.id}
            onClick={() => {
              setFilter(f.id)
            }}
          />
        ))}
      </ExplorerGroup>
      {Object.values(sources).length > 0 && (
        <ExplorerGroup title={t('By source')}>
          {Object.values(sources).map((src) => (
            <ExplorerItem
              key={src.id}
              icon={<ArrowDownToLine {...ICON_SM} />}
              label={src.label}
              meta={new Set(src.transfers.map(rowKey)).size}
              onClick={() => src.reveal?.()}
            />
          ))}
        </ExplorerGroup>
      )}
    </div>
  )
}

function SettingsExplorer(): React.JSX.Element {
  const section = useShell((s) => s.settingsSection)
  const current = section === 'accounts' || section === 'keys' ? 'keychain' : section
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const groups = SETTINGS_NAV.map((g) => ({
    ...g,
    items: g.items.filter(
      (i) =>
        !q ||
        i.title().toLowerCase().includes(q) ||
        settingsDescription(i.id).toLowerCase().includes(q)
    )
  })).filter((g) => g.items.length > 0)
  return (
    <>
      <div className="px-2.5 pb-2">
        <ExplorerSearch
          value={query}
          onChange={setQuery}
          placeholder={t('Search settings')}
          testId="explorer-settings-search"
        />
      </div>
      <nav aria-label={t('Settings')} className="min-h-0 flex-1 overflow-auto px-2 pb-2">
        {groups.map((g) => (
          <ExplorerGroup key={g.group()} title={g.group()}>
            {g.items.map((s) => (
              <ExplorerItem
                key={s.id}
                testId={`settings-nav-${s.id}`}
                icon={<s.icon {...ICON_SM} />}
                label={s.title()}
                current={current === s.id}
                onClick={() => {
                  useShell.getState().openSettings(s.id)
                }}
              />
            ))}
          </ExplorerGroup>
        ))}
      </nav>
    </>
  )
}

/** Mục thanh bên của module (danh sách cluster / endpoint / account). */
function ModuleExplorer({ id }: { id: string }): React.JSX.Element | null {
  const enabled = useModuleEnabled(id)
  const loaded = useModules((s) => s.loaded)
  // Module vừa bị tắt (Settings → Modules) → khu vực của nó không còn: về Hosts.
  useEffect(() => {
    if (loaded && !enabled && useShell.getState().area === `m:${id}`)
      useShell.getState().go('hosts')
  }, [loaded, enabled, id])
  const Section = rendererModule(id)?.SidebarSection
  if (!Section || !enabled) return null
  return (
    <div
      className="min-h-0 flex-1 overflow-auto px-2 pb-2"
      data-module-section={id}
      data-testid={`explorer-module-${id}`}
    >
      <Section />
    </div>
  )
}

function areaTitle(area: Area): string {
  switch (area) {
    case 'home':
      return t('Home')
    case 'hosts':
      return t('Hosts')
    case 'files':
      return t('Files')
    case 'transfers':
      return t('Transfers')
    case 'settings':
      return t('Settings')
    default:
      return rendererModule(area.slice(2))?.manifest.name ?? area.slice(2)
  }
}

/**
 * Explorer theo ngữ cảnh (260px, kéo giãn 200–420, thu gọn bằng Ctrl+Shift+B): tiêu đề khu vực +
 * nút tạo mới + thu gọn; nội dung tuỳ khu vực. Cây host luôn được giữ (ẩn khi ở khu vực khác) để
 * không mất trạng thái mở / cuộn.
 */
export const Explorer = memo(function Explorer({
  searchRef
}: {
  searchRef: React.Ref<HTMLInputElement>
}): React.JSX.Element | null {
  const area = useShell((s) => s.area)
  const width = useShell((s) => s.explorerWidth)
  const hidden = useSettings((s) => s.settings.appearance.sidebarHidden)
  const [resizing, setResizing] = useState(false)
  const stop = useRef<(() => void) | null>(null)
  if (hidden) return null
  const startResize = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = width
    setResizing(true)
    const move = (ev: PointerEvent): void => {
      useShell.getState().setExplorerWidth(startWidth + ev.clientX - startX)
    }
    const up = (): void => {
      stop.current = null
      setResizing(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
    stop.current?.()
    stop.current = up
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }
  const newAction =
    area === 'hosts' || area === 'home' ? (
      <IconButton
        label={t('New host')}
        size="sm"
        data-testid="add-host"
        tooltipSide="bottom"
        onClick={() => void openSidebarDialog('new-host')}
      >
        <Plus {...ICON_SM} />
      </IconButton>
    ) : null
  return (
    <aside
      className="relative flex shrink-0 flex-col bg-ds-bg"
      style={{ width }}
      aria-label={areaTitle(area)}
      data-testid="explorer"
      data-area={area}
    >
      <div className="flex h-(--ds-header-h) shrink-0 items-center gap-1 pr-1.5 pl-3">
        <h2 className="min-w-0 flex-1 truncate text-ds-base font-semibold text-ds-fg">
          {areaTitle(area)}
        </h2>
        {newAction}
        <IconButton
          label={t('Hide sidebar')}
          size="sm"
          data-testid="sidebar-collapse"
          tooltipSide="bottom"
          onClick={() => {
            useShell.getState().toggleExplorer(true)
          }}
        >
          <PanelLeftClose {...ICON_SM} />
        </IconButton>
      </div>
      {/* Cây host luôn sống (giữ trạng thái), chỉ hiện ở khu vực Hosts. */}
      <div className={cx('min-h-0 flex-1 flex-col', area === 'hosts' ? 'flex' : 'hidden')}>
        <Sidebar ref={searchRef} />
      </div>
      {area === 'home' && <HomeExplorer />}
      {area === 'files' && <FilesExplorer />}
      {area === 'transfers' && <TransfersExplorer />}
      {area === 'settings' && <SettingsExplorer />}
      {area.startsWith('m:') && <ModuleExplorer id={area.slice(2)} />}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('Resize sidebar')}
        aria-valuemin={EXPLORER_WIDTH.min}
        aria-valuemax={EXPLORER_WIDTH.max}
        aria-valuenow={width}
        tabIndex={0}
        data-testid="sidebar-resize"
        className={cx(
          'absolute inset-y-0 -right-1 z-(--ds-z-resizer) w-2 cursor-col-resize outline-none',
          resizing ? 'bg-ds-accent/40' : 'hover:bg-ds-accent/25 focus-visible:bg-ds-accent/40'
        )}
        onPointerDown={startResize}
        onDoubleClick={() => {
          useShell.getState().setExplorerWidth(EXPLORER_WIDTH.default)
        }}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 64 : 16
          const next =
            e.key === 'ArrowLeft'
              ? width - step
              : e.key === 'ArrowRight'
                ? width + step
                : e.key === 'Enter'
                  ? EXPLORER_WIDTH.default
                  : null
          if (next === null) return
          e.preventDefault()
          useShell.getState().setExplorerWidth(next)
        }}
      />
    </aside>
  )
})
