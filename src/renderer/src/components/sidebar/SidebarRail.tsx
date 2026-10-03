import type { ReactNode } from 'react'
import { House, PanelLeftOpen, Plus, Search, Settings, Star } from 'lucide-react'
import { t } from '@shared/i18n'
import type { HostSummary } from '@shared/hosts'
import { ModuleIcon, useEnabledModules } from '../../../../modules/registry/renderer-kit'
import { useTabs } from '../../stores/tabs'
import { HostAvatar } from '../HostAvatar'
import { Logo } from '../Logo'
import { cx } from '../ui'
import { connect } from './actions'

/** Số host yêu thích hiện thẳng trên thanh icon (nhiều hơn → mở thanh bên để xem hết). */
const MAX_RAIL_FAVORITES = 6

function RailButton({
  label,
  active,
  testId,
  onClick,
  children
}: {
  label: string
  active?: boolean
  testId?: string
  onClick: () => void
  children: ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-current={active ? 'page' : undefined}
      data-testid={testId}
      className={cx(
        'relative flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors duration-100 outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        active ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-hover hover:text-fg'
      )}
      onClick={onClick}
    >
      {active && (
        <span
          aria-hidden
          className="absolute top-1/2 -left-1.5 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent"
        />
      )}
      {children}
    </button>
  )
}

/**
 * Thanh bên dạng gọn (~48 px, khi đang ở tab module): Home, tìm host, thêm host, host yêu thích,
 * module đang bật, Cài đặt. Rê chuột vào → thanh bên đầy đủ trượt ra đè lên nội dung (không đổi bố
 * cục → bảng của module / terminal không phải co giãn lại).
 */
export function SidebarRail({
  favorites,
  onPeek,
  onOpenPanel,
  onSearch,
  onNewHost,
  onModule,
  onExpand,
  onOpenSettings
}: {
  favorites: readonly HostSummary[]
  onPeek: (open: boolean) => void
  /** Mở hẳn thanh bên (bấm nút — khác rê chuột). */
  onOpenPanel: () => void
  onSearch: () => void
  onNewHost: () => void
  onModule: (id: string) => void
  onExpand: () => void
  onOpenSettings?: (() => void) | undefined
}): React.JSX.Element {
  const modules = useEnabledModules().filter((m) => m.SidebarSection)
  const active = useTabs((s) => s.tabs.find((tab) => tab.id === s.activeId)?.target)
  const activeModule = active?.kind === 'module' ? active.module : null
  const shown = favorites.slice(0, MAX_RAIL_FAVORITES)
  return (
    <div
      className="flex h-full w-12 shrink-0 flex-col items-center"
      data-testid="sidebar-rail"
      onMouseEnter={() => {
        onPeek(true)
      }}
      onMouseLeave={() => {
        onPeek(false)
      }}
    >
      <div className="flex h-11 w-full shrink-0 items-center justify-center border-b border-line">
        <Logo size={22} />
      </div>
      <nav
        aria-label={t('Sidebar')}
        className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-x-hidden overflow-y-auto py-2"
      >
        <RailButton
          label={t('Home')}
          active={active?.kind === 'home'}
          testId="rail-home"
          onClick={() => {
            useTabs.getState().openHome()
          }}
        >
          <House size={17} />
        </RailButton>
        <RailButton label={t('Search hosts…')} testId="rail-search" onClick={onSearch}>
          <Search size={17} />
        </RailButton>
        <RailButton label={t('New host')} testId="rail-add-host" onClick={onNewHost}>
          <Plus size={17} />
        </RailButton>
        {shown.length > 0 && (
          <>
            <span aria-hidden className="my-1 h-px w-6 shrink-0 bg-line" />
            <span className="sr-only">{t('Favorites')}</span>
            {shown.map((h) => (
              <button
                key={h.id}
                type="button"
                title={t('Connect to {name}', { name: h.label })}
                aria-label={t('Connect to {name}', { name: h.label })}
                data-testid="rail-favorite"
                data-host-label={h.label}
                className="flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none"
                onClick={() => {
                  connect(h)
                }}
              >
                <HostAvatar host={h} size={24} />
              </button>
            ))}
            {favorites.length > shown.length && (
              <RailButton label={t('All favorites')} onClick={onOpenPanel}>
                <Star size={15} />
              </RailButton>
            )}
          </>
        )}
        {modules.length > 0 && (
          <>
            <span aria-hidden className="my-1 h-px w-6 shrink-0 bg-line" />
            {modules.map((m) => (
              <RailButton
                key={m.manifest.id}
                label={m.manifest.name}
                active={activeModule === m.manifest.id}
                testId={`rail-module-${m.manifest.id}`}
                onClick={() => {
                  onModule(m.manifest.id)
                }}
              >
                <ModuleIcon name={m.manifest.icon} size={17} />
              </RailButton>
            ))}
          </>
        )}
      </nav>
      <div className="flex w-full shrink-0 flex-col items-center gap-1 border-t border-line py-2">
        {onOpenSettings && (
          <RailButton label={t('Settings')} testId="rail-settings" onClick={onOpenSettings}>
            <Settings size={17} />
          </RailButton>
        )}
        <RailButton label={t('Expand sidebar')} testId="sidebar-expand" onClick={onExpand}>
          <PanelLeftOpen size={17} />
        </RailButton>
      </div>
    </div>
  )
}
