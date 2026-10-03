import { useMemo, useRef, useState } from 'react'
import {
  ArrowRight,
  FileInput,
  FolderOpen,
  Pencil,
  Play,
  Puzzle,
  Server,
  SquareTerminal,
  Star,
  Zap
} from 'lucide-react'
import { t, tn } from '@shared/i18n'
import { formatRelative } from '@shared/i18n/format'
import type { HostSummary } from '@shared/hosts'
import { keybindingFor } from '@shared/commands'
import { parseQuickConnect } from '@shared/quick-connect'
import { displayKeybinding, isMac } from '../lib/keybindings'
import { hostAddress, useHosts } from '../stores/hosts'
import { browseModules } from '../stores/module-ui'
import { useSettings } from '../stores/settings'
import { useTabs } from '../stores/tabs'
import { openSidebarDialog } from '../stores/ui-requests'
import { HostAvatar } from './HostAvatar'
import { Logo } from './Logo'
import { cx, Kbd } from './ui'

/** Lưới thẻ host: 1 cột (hẹp) → 2 → 3 cột theo độ rộng vùng Home. */
const HOST_GRID = 'grid grid-cols-1 gap-2 @3xl/home:grid-cols-2 @5xl/home:grid-cols-3'

/** Một lựa chọn bắt đầu. */
function StartCard({
  icon,
  title,
  text,
  hint,
  testId,
  className,
  onClick
}: {
  icon: React.ReactNode
  title: string
  text: string
  hint?: string
  testId: string
  className?: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      className={cx(
        className,
        'group flex items-start gap-3 rounded-xl border border-line bg-surface p-3.5 text-left shadow-xs transition-[border-color,box-shadow] duration-150 hover:border-accent/50 hover:shadow-md focus-visible:border-accent'
      )}
      onClick={onClick}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-[13px] font-semibold text-fg">
          {title}
          {hint && <Kbd>{hint}</Kbd>}
        </span>
        <span className="mt-0.5 block text-xs text-muted">{text}</span>
      </span>
    </button>
  )
}

/** Thẻ host trên trang chủ: kết nối / mở file / sửa. */
function HostCard({ host }: { host: HostSummary }): React.JSX.Element {
  const effective = useHosts((s) => s.effective.get(host.id))
  const address = hostAddress(host, effective)
  const open = (view?: 'files'): void => {
    useTabs.getState().addHost({ id: host.id, label: host.label }, view ? { view } : undefined)
  }
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="home-host-card"
      data-name={host.label}
      className="group flex min-w-0 cursor-pointer items-center gap-3 rounded-xl border border-line bg-surface p-3 shadow-xs transition-[border-color,box-shadow] duration-150 hover:border-accent/50 hover:shadow-md"
      onClick={() => {
        open()
      }}
      onKeyDown={(e) => {
        // Chỉ khi chính thẻ đang focus — Enter trên nút con (Edit, SFTP) không mở thêm phiên.
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          open()
        }
      }}
    >
      <HostAvatar host={host} size={36} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <span className="truncate text-[13px] font-semibold text-fg">{host.label}</span>
          {host.favorite && (
            <Star
              size={11}
              className="shrink-0 fill-warning text-warning"
              aria-label={t('Favorite')}
            />
          )}
        </div>
        <div className="truncate font-mono text-[11px] text-faint">{address}</div>
        {host.lastUsedAt !== null && (
          <div className="text-[11px] text-faint">
            {t('Connected {time}', { time: formatRelative(host.lastUsedAt) })}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
        {host.protocol === 'ssh' && (
          <button
            type="button"
            title={t('Open files (SFTP)')}
            aria-label={t('Open files on {name}', { name: host.label })}
            data-testid="home-sftp"
            className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-fg"
            onClick={(e) => {
              e.stopPropagation()
              open('files')
            }}
          >
            <FolderOpen size={14} />
          </button>
        )}
        <button
          type="button"
          title={t('Edit')}
          aria-label={t('Edit {name}', { name: host.label })}
          className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-fg"
          onClick={(e) => {
            e.stopPropagation()
            void openSidebarDialog('edit-host', host.id)
          }}
        >
          <Pencil size={14} />
        </button>
        <button
          type="button"
          title={t('Connect')}
          aria-label={t('Connect to {name}', { name: host.label })}
          data-testid="home-connect"
          className="flex items-center gap-1 rounded-md bg-accent-solid px-2 py-1 text-xs font-medium text-accent-fg hover:bg-accent-solid-hover"
          onClick={(e) => {
            e.stopPropagation()
            open()
          }}
        >
          <Play size={12} /> {t('Connect')}
        </button>
      </div>
    </div>
  )
}

function greeting(now = new Date()): string {
  const h = now.getHours()
  return h < 5
    ? t('Good evening')
    : h < 12
      ? t('Good morning')
      : h < 18
        ? t('Good afternoon')
        : t('Good evening')
}

/** "12 saved hosts in 3 groups — pick up where you left off." */
function summary(hosts: number, groups: number): string {
  return groups
    ? tn(
        hosts,
        '{n} saved host in {groups} — pick up where you left off.',
        '{n} saved hosts in {groups} — pick up where you left off.',
        { groups: tn(groups, '{n} group', '{n} groups') }
      )
    : tn(
        hosts,
        '{n} saved host — pick up where you left off.',
        '{n} saved hosts — pick up where you left off.'
      )
}

/**
 * Trang chủ (tab Home / khi không còn tab nào): kết nối nhanh, kết nối gần đây, yêu thích, thao tác
 * bắt đầu và phím tắt — như màn khởi động của các trình SSH thương mại.
 */
export function HomeView(): React.JSX.Element {
  const overrides = useSettings((s) => s.settings.keybindings)
  const hosts = useHosts((s) => s.tree.hosts)
  const groups = useHosts((s) => s.tree.groups.length)
  const key = (id: string): string => displayKeybinding(keybindingFor(id, overrides, isMac))
  const [value, setValue] = useState('')
  const quickRef = useRef<HTMLInputElement>(null)
  const [invalid, setInvalid] = useState(false)
  const recent = useMemo(
    () =>
      hosts
        .filter((h) => h.lastUsedAt !== null)
        .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
        .slice(0, 6),
    [hosts]
  )
  const favorites = useMemo(
    () => hosts.filter((h) => h.favorite && !recent.includes(h)).slice(0, 6),
    [hosts, recent]
  )
  // Chưa kết nối lần nào: gợi ý vài host đã lưu.
  const saved = useMemo(
    () => (recent.length || favorites.length ? [] : hosts.slice(0, 6)),
    [hosts, recent, favorites]
  )
  const hasHosts = hosts.length > 0

  return (
    // @container: lưới co giãn theo độ rộng THẬT của vùng Home (panel dockview, có thể bị chia đôi /
    // thanh bên rộng hẹp), không theo cửa sổ (breakpoint md/lg) — phóng to cửa sổ là lưới giãn theo.
    <div
      className="animate-fade-in @container/home h-full overflow-auto bg-canvas"
      data-testid="welcome"
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-7 px-5 py-8 @3xl/home:px-8 @3xl/home:py-10">
        <header className="flex items-center gap-4">
          <Logo size={48} className="drop-shadow-md" />
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight text-fg">
              {hasHosts ? greeting() : t('Welcome to Shellhouse')}
            </h1>
            <p className="text-[13px] text-muted">
              {hasHosts
                ? summary(hosts.length, groups)
                : t(
                    'SSH, SFTP, Telnet, serial and more in one place. How would you like to start?'
                  )}
            </p>
          </div>
        </header>

        <form
          className={cx(
            'flex h-12 items-center gap-3 rounded-xl border bg-surface px-4 shadow-sm transition-[border-color,box-shadow]',
            invalid
              ? 'border-danger ring-4 ring-danger/15'
              : 'border-line focus-within:border-accent focus-within:ring-4 focus-within:ring-accent/15'
          )}
          onSubmit={(e) => {
            e.preventDefault()
            const target = parseQuickConnect(value)
            if (!target) {
              setInvalid(true)
              return
            }
            useTabs.getState().addSsh(target)
            setValue('')
            setInvalid(false)
          }}
        >
          <Zap size={16} className="shrink-0 text-accent" />
          <input
            className="min-w-0 flex-1 bg-transparent font-mono text-[14px] text-fg outline-none placeholder:font-sans placeholder:text-faint"
            placeholder={t('Quick connect — user@host:port')}
            ref={quickRef}
            aria-label={t('Quick connect')}
            data-testid="home-quick-connect"
            value={value}
            onChange={(e) => {
              setValue(e.target.value)
              setInvalid(false)
            }}
          />
          {invalid ? (
            <span role="alert" className="shrink-0 text-xs text-danger">
              {t('Use user@host or user@host:port')}
            </span>
          ) : (
            <span className="flex shrink-0 items-center gap-1 text-xs text-faint">
              <Kbd>Enter</Kbd> <ArrowRight size={12} />
            </span>
          )}
        </form>

        {(recent.length > 0 || favorites.length > 0 || saved.length > 0) && (
          <div className="flex flex-col gap-5">
            {recent.length > 0 && (
              <section data-testid="home-recent">
                <h2 className="mb-2 text-[11px] font-semibold tracking-wider text-faint uppercase">
                  {t('Recent')}
                </h2>
                <div className={HOST_GRID}>
                  {recent.map((h) => (
                    <HostCard key={h.id} host={h} />
                  ))}
                </div>
              </section>
            )}
            {favorites.length > 0 && (
              <section data-testid="home-favorites">
                <h2 className="mb-2 text-[11px] font-semibold tracking-wider text-faint uppercase">
                  {t('Favorites')}
                </h2>
                <div className={HOST_GRID}>
                  {favorites.map((h) => (
                    <HostCard key={h.id} host={h} />
                  ))}
                </div>
              </section>
            )}
            {saved.length > 0 && (
              <section data-testid="home-saved">
                <h2 className="mb-2 text-[11px] font-semibold tracking-wider text-faint uppercase">
                  {t('Your hosts')}
                </h2>
                <div className={HOST_GRID}>
                  {saved.map((h) => (
                    <HostCard key={h.id} host={h} />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}

        <section>
          <h2 className="mb-2 text-[11px] font-semibold tracking-wider text-faint uppercase">
            {hasHosts ? t('Start something new') : t('Get started')}
          </h2>
          <div className="grid grid-cols-1 gap-2.5 @xl/home:grid-cols-2 @4xl/home:grid-cols-3">
            <StartCard
              icon={<Server size={18} />}
              title={t('Add a host')}
              text={t('Save a server with its login — connect later in one click.')}
              testId="welcome-add-host"
              onClick={() => void openSidebarDialog('new-host')}
            />
            <StartCard
              icon={<FileInput size={18} />}
              title={t('Import hosts')}
              text={t('From ~/.ssh/config, MobaXterm, Termius or a CSV file.')}
              testId="welcome-import"
              onClick={() => void openSidebarDialog('import-hosts')}
            />
            <StartCard
              icon={<SquareTerminal size={18} />}
              title={t('Local terminal')}
              text={t('Open a shell on this computer.')}
              hint={key('tab.new')}
              testId="welcome-new-terminal"
              onClick={() => useTabs.getState().addLocal()}
            />
            <StartCard
              icon={<Zap size={18} />}
              title={t('Quick connect')}
              text={t('Type user@host:port — nothing is saved.')}
              testId="welcome-quick-connect"
              onClick={() => {
                quickRef.current?.focus()
              }}
            />
            <StartCard
              icon={<Puzzle size={18} />}
              title={t('Add tools')}
              text={t('S3 storage, Docker and Kubernetes — turn on what you need.')}
              testId="welcome-add-tools"
              className="@xl/home:col-span-2"
              onClick={() => {
                browseModules()
              }}
            />
          </div>
        </section>

        <footer className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line pt-4 text-xs text-faint">
          <span>
            {t('Search hosts')} <Kbd>{key('hosts.search')}</Kbd>
          </span>
          <span>
            {t('Command palette')} <Kbd>{key('palette.open')}</Kbd>
          </span>
          <span>
            {t('New terminal')} <Kbd>{key('tab.new')}</Kbd>
          </span>
          <span>
            {t('Settings')} <Kbd>{key('settings.open')}</Kbd>
          </span>
        </footer>
      </div>
    </div>
  )
}
