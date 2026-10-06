import { useMemo, useRef, useState } from 'react'
import {
  ArrowRight,
  CircleAlert,
  FileInput,
  FolderOpen,
  House,
  Info,
  Plus,
  TriangleAlert,
  Zap
} from 'lucide-react'
import { t, tn } from '@shared/i18n'
import { formatLongDay, formatRelative } from '@shared/i18n/format'
import type { HostSummary } from '@shared/hosts'
import { parseQuickConnect } from '@shared/quick-connect'
import { Button, EnvLabel, StatusChip } from '../ds'
import { cx, ICON_SM } from '../ds/utils'
import { useHostEnvironment } from '../stores/environments'
import { hostAddress, useHosts } from '../stores/hosts'
import { browseModules } from '../stores/module-ui'
import { useTabStatus } from '../stores/tab-status'
import { useTabs } from '../stores/tabs'
import { useSettings } from '../stores/settings'
import { attentionItems, useAttention, type AttentionSeverity } from '../stores/attention'
import { openSidebarDialog } from '../stores/ui-requests'
import { AreaHeader } from './AreaHeader'
import { HostAvatar } from './HostAvatar'

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

/** "12 saved hosts in 3 groups" */
function summary(hosts: number, groups: number): string {
  return groups
    ? tn(hosts, '{n} saved host in {groups}', '{n} saved hosts in {groups}', {
        groups: tn(groups, '{n} group', '{n} groups')
      })
    : tn(hosts, '{n} saved host', '{n} saved hosts')
}

function Section({
  title,
  count,
  action,
  testId,
  children
}: {
  title: string
  count?: number
  action?: React.ReactNode
  testId?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section data-testid={testId} className="min-w-0">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-[13px] font-semibold text-fg">{title}</h2>
        {count !== undefined && <span className="text-[13px] text-faint">{count}</span>}
        <div className="flex-1" />
        {action}
      </div>
      {children}
    </section>
  )
}

/** Đường dẫn nhóm "Production › Web". */
function useGroupPath(groupId: string | null): string {
  const tree = useHosts((s) => s.groupTree)
  return groupId ? tree.path(groupId).join(' › ') : ''
}

function openHost(host: HostSummary, view?: 'files'): void {
  useTabs.getState().addHost({ id: host.id, label: host.label }, view ? { view } : undefined)
}

/** Một host yêu thích (lưới phẳng, không thẻ): icon hệ điều hành · tên · địa chỉ · nhóm. */
function FavoriteItem({ host }: { host: HostSummary }): React.JSX.Element {
  const effective = useHosts((s) => s.effective.get(host.id))
  const env = useHostEnvironment(host.id)
  const path = useGroupPath(host.groupId)
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="home-host-card"
      data-name={host.label}
      className="group flex min-w-0 cursor-pointer items-center gap-3 rounded-ds-lg px-2 py-2 outline-none hover:bg-ds-hover focus-visible:shadow-ds-focus"
      onClick={() => {
        openHost(host)
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          openHost(host)
        }
      }}
    >
      <HostAvatar host={host} size={20} className="rounded-ds-sm" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-medium text-fg">{host.label}</span>
          {env?.highlight && <EnvLabel env={env} dot />}
        </div>
        <div className="truncate text-xs text-faint">
          {[hostAddress(host, effective), path].filter(Boolean).join(' · ')}
        </div>
      </div>
      <HostActions host={host} />
    </div>
  )
}

/** Nút nhanh khi rê chuột / focus: mở file (SFTP), kết nối. */
function HostActions({ host }: { host: HostSummary }): React.JSX.Element {
  return (
    <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
      {host.protocol === 'ssh' && (
        <button
          type="button"
          title={t('Open files (SFTP)')}
          aria-label={t('Open files on {name}', { name: host.label })}
          data-testid="home-sftp"
          className="flex size-6 items-center justify-center rounded-ds-sm text-muted outline-none hover:bg-ds-active hover:text-fg focus-visible:shadow-ds-focus"
          onClick={(e) => {
            e.stopPropagation()
            openHost(host, 'files')
          }}
        >
          <FolderOpen {...ICON_SM} />
        </button>
      )}
    </div>
  )
}

/** Một dòng trong "Recent": tên + môi trường, địa chỉ · giao thức · nhóm, thời gian, Connect. */
function RecentRow({ host }: { host: HostSummary }): React.JSX.Element {
  const effective = useHosts((s) => s.effective.get(host.id))
  const env = useHostEnvironment(host.id)
  const path = useGroupPath(host.groupId)
  return (
    <div
      data-testid="home-host-card"
      data-name={host.label}
      className="group flex min-h-11 items-center gap-3 border-b border-ds-border-subtle px-1 py-1.5 last:border-b-0"
    >
      <HostAvatar host={host} size={18} className="rounded-ds-sm" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-medium text-fg">{host.label}</span>
          {env?.highlight && <EnvLabel env={env} dot />}
        </div>
        <div className="truncate text-xs text-faint">
          {[hostAddress(host, effective), host.protocol.toUpperCase(), path]
            .filter(Boolean)
            .join(' · ')}
        </div>
      </div>
      <HostActions host={host} />
      {host.lastUsedAt !== null && (
        <span className="shrink-0 text-xs text-faint tabular-nums">
          {formatRelative(host.lastUsedAt)}
        </span>
      )}
      <button
        type="button"
        aria-label={t('Connect to {name}', { name: host.label })}
        data-testid="home-connect"
        className="shrink-0 rounded-ds-sm px-1.5 py-0.5 text-[13px] font-medium text-ds-accent-text outline-none hover:bg-ds-hover focus-visible:shadow-ds-focus"
        onClick={() => {
          openHost(host)
        }}
      >
        {t('Connect')}
      </button>
    </div>
  )
}

/** Số mục "Needs attention" (vấn đề cluster Kubernetes đang mở); 0 khi tắt trong cài đặt. */
function useAttentionCount(): number {
  const enabled = useSettings((s) => s.settings.appearance.homeAttention)
  const sources = useAttention((s) => s.sources)
  if (!enabled) return 0
  return Object.values(sources).reduce((n, list) => n + list.length, 0)
}

const SEV_ICON: Record<AttentionSeverity, React.ReactNode> = {
  danger: <CircleAlert {...ICON_SM} className="text-ds-danger" />,
  warning: <TriangleAlert {...ICON_SM} className="text-ds-warning" />,
  info: <Info {...ICON_SM} className="text-ds-info" />
}
const SEV_TONE: Record<AttentionSeverity, 'danger' | 'warning' | 'progress'> = {
  danger: 'danger',
  warning: 'warning',
  info: 'progress'
}

/**
 * Cần chú ý: vấn đề của các cluster Kubernetes đang mở (pod CrashLoop, lỗi kéo image, node
 * NotReady…) — icon mức độ, chip lý do, mô tả, nguồn; bấm để mở đúng chỗ. Chỉ đọc khi tab cluster
 * còn mở (không chạy nền); tắt được trong Settings › Appearance.
 */
function AttentionList(): React.JSX.Element | null {
  const enabled = useSettings((s) => s.settings.appearance.homeAttention)
  const sources = useAttention((s) => s.sources)
  if (!enabled) return null
  const items = attentionItems(sources)
  if (items.length === 0) return null
  return (
    <Section title={t('Needs attention')} count={items.length} testId="home-attention">
      <div className="flex flex-col">
        {items.map((it) => (
          <button
            key={`${it.source}:${it.id}`}
            type="button"
            data-testid="home-attention-item"
            data-severity={it.severity}
            className="group flex w-full items-start gap-3 border-b border-ds-border-subtle py-2.5 text-left outline-none last:border-b-0 focus-visible:shadow-ds-focus"
            onClick={() => it.open?.()}
          >
            <span className="mt-0.5 shrink-0">{SEV_ICON[it.severity]}</span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="truncate text-[13px] font-medium text-fg group-hover:underline">
                  {it.title}
                </span>
                {it.badge && <StatusChip tone={SEV_TONE[it.severity]}>{it.badge}</StatusChip>}
              </span>
              {it.description && (
                <span className="mt-0.5 block truncate text-xs text-muted">{it.description}</span>
              )}
              <span className="mt-0.5 block truncate text-xs text-faint">{it.source}</span>
            </span>
          </button>
        ))}
      </div>
    </Section>
  )
}

/** Liên kết "bắt đầu" (chữ, không thẻ): tiêu đề + một câu mô tả. */
function StartLink({
  title,
  text,
  testId,
  onClick
}: {
  title: string
  text: string
  testId: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      className="group flex min-w-0 flex-col items-start rounded-ds-md p-1 text-left outline-none focus-visible:shadow-ds-focus"
      onClick={onClick}
    >
      <span className="flex items-center gap-1 text-[13px] font-medium text-ds-accent-text group-hover:underline">
        {title}
        <ArrowRight {...ICON_SM} className="opacity-0 transition-opacity group-hover:opacity-100" />
      </span>
      <span className="mt-0.5 text-xs text-muted">{text}</span>
    </button>
  )
}

/**
 * Trang chủ (thiết kế v0.5): lời chào + tóm tắt, quick connect, Favorites (lưới phẳng), Recent
 * (danh sách phẳng) | Needs attention, Get started (liên kết chữ, không tile).
 */
export function HomeView(): React.JSX.Element {
  const hosts = useHosts((s) => s.tree.hosts)
  const groups = useHosts((s) => s.tree.groups.length)
  const sessions = useTabStatus(
    (s) => Object.values(s.byTab).filter((x) => x === 'connected').length
  )
  const attentionCount = useAttentionCount()
  const [value, setValue] = useState('')
  const quickRef = useRef<HTMLInputElement>(null)
  const [invalid, setInvalid] = useState(false)
  const recent = useMemo(
    () =>
      hosts
        .filter((h) => h.lastUsedAt !== null)
        .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
        .slice(0, 8),
    [hosts]
  )
  const favorites = useMemo(() => hosts.filter((h) => h.favorite).slice(0, 9), [hosts])
  // Chưa kết nối / ghim host nào: gợi ý vài host đã lưu.
  const saved = useMemo(
    () => (recent.length || favorites.length ? [] : hosts.slice(0, 6)),
    [hosts, recent, favorites]
  )
  const hasHosts = hosts.length > 0
  // Tính một lần lúc mở trang (Date.now() không được gọi trong lúc render).
  const [today] = useState(() => formatLongDay(Date.now()))
  const connect = (): void => {
    const target = parseQuickConnect(value)
    if (!target) {
      setInvalid(true)
      return
    }
    useTabs.getState().addSsh(target)
    setValue('')
    setInvalid(false)
  }

  return (
    // @container: bố cục co giãn theo độ rộng THẬT của vùng Home, không theo cửa sổ.
    <div
      className="animate-fade-in flex h-full min-h-0 flex-col bg-ds-surface-0"
      data-testid="welcome"
    >
      <AreaHeader icon={<House {...ICON_SM} />} title={t('Home')} />
      <div className="@container/home min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-7 px-6 py-8 @3xl/home:px-10">
          <header className="flex flex-wrap items-start gap-4">
            <div className="min-w-0 flex-1">
              <h1 className="text-ds-xl font-semibold tracking-[-0.018em] text-fg">
                {hasHosts ? greeting() : t('Welcome to Shellhouse')}
              </h1>
              <p className="mt-0.5 text-[13px] text-muted">
                {hasHosts
                  ? [
                      today,
                      summary(hosts.length, groups),
                      tn(sessions, '{n} session open', '{n} sessions open'),
                      attentionCount > 0 &&
                        tn(attentionCount, '{n} item needs attention', '{n} items need attention')
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  : t(
                      'SSH, SFTP, Telnet, serial and more in one place. How would you like to start?'
                    )}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                icon={<FileInput {...ICON_SM} />}
                data-testid="home-import"
                onClick={() => void openSidebarDialog('import-hosts')}
              >
                {t('Import')}
              </Button>
              <Button
                variant="primary"
                icon={<Plus {...ICON_SM} />}
                data-testid="home-new-host"
                onClick={() => void openSidebarDialog('new-host')}
              >
                {t('New host')}
              </Button>
            </div>
          </header>

          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              connect()
            }}
          >
            <div
              className={cx(
                'flex h-ds-ctl-lg min-w-0 flex-1 items-center gap-2.5 rounded-ds-md border bg-ds-surface-1 px-3 transition-[border-color,box-shadow]',
                invalid
                  ? 'border-ds-danger ring-3 ring-ds-danger-soft'
                  : 'border-ds-border-control focus-within:border-ds-accent focus-within:ring-3 focus-within:ring-ds-accent-soft hover:border-faint'
              )}
            >
              <Zap {...ICON_SM} className="shrink-0 text-faint" />
              <span className="shrink-0 text-xs font-medium text-faint">SSH</span>
              <input
                className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-fg outline-none placeholder:font-sans placeholder:text-faint"
                placeholder={t('user@host:port — e.g. deploy@10.10.1.11:22')}
                ref={quickRef}
                aria-label={t('Quick connect')}
                aria-invalid={invalid}
                data-testid="home-quick-connect"
                value={value}
                onChange={(e) => {
                  setValue(e.target.value)
                  setInvalid(false)
                }}
              />
              {invalid && (
                <span role="alert" className="shrink-0 text-xs text-ds-danger">
                  {t('Use user@host or user@host:port')}
                </span>
              )}
            </div>
            <Button size="lg" type="submit" data-testid="home-quick-connect-go">
              {t('Connect')}
            </Button>
          </form>

          {favorites.length > 0 && (
            <Section title={t('Favorites')} count={favorites.length} testId="home-favorites">
              <div className="grid grid-cols-1 gap-x-4 gap-y-0.5 @2xl/home:grid-cols-2 @4xl/home:grid-cols-3">
                {favorites.map((h) => (
                  <FavoriteItem key={h.id} host={h} />
                ))}
              </div>
            </Section>
          )}

          {(recent.length > 0 || saved.length > 0 || attentionCount > 0) && (
            <div className="grid grid-cols-1 gap-8 @4xl/home:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
              {recent.length === 0 && saved.length === 0 ? (
                <div />
              ) : recent.length > 0 ? (
                <Section title={t('Recent')} count={recent.length} testId="home-recent">
                  <div className="flex flex-col">
                    {recent.map((h) => (
                      <RecentRow key={h.id} host={h} />
                    ))}
                  </div>
                </Section>
              ) : (
                <Section title={t('Your hosts')} testId="home-saved">
                  <div className="flex flex-col">
                    {saved.map((h) => (
                      <RecentRow key={h.id} host={h} />
                    ))}
                  </div>
                </Section>
              )}
              <AttentionList />
            </div>
          )}

          {/* Đã có host kết nối gần đây / ghim: trang chủ là việc đang làm — gợi ý bắt đầu chỉ hiện khi
            chưa có gì (như prototype). */}
          {recent.length === 0 && favorites.length === 0 && (
            <Section title={hasHosts ? t('Start something new') : t('Get started')}>
              <div className="grid grid-cols-1 gap-4 border-t border-ds-border-subtle pt-4 @xl/home:grid-cols-2 @4xl/home:grid-cols-4">
                <StartLink
                  title={t('Add a host')}
                  text={t('Save a server with its login — connect later in one click.')}
                  testId="welcome-add-host"
                  onClick={() => void openSidebarDialog('new-host')}
                />
                <StartLink
                  title={t('Import hosts')}
                  text={t('From ~/.ssh/config, MobaXterm, Termius or a CSV file.')}
                  testId="welcome-import"
                  onClick={() => void openSidebarDialog('import-hosts')}
                />
                <StartLink
                  title={t('Local terminal')}
                  text={t('Open a shell on this computer.')}
                  testId="welcome-new-terminal"
                  onClick={() => useTabs.getState().addLocal()}
                />
                <StartLink
                  title={t('Add tools')}
                  text={t('S3 storage, Docker and Kubernetes — turn on what you need.')}
                  testId="welcome-add-tools"
                  onClick={() => {
                    browseModules()
                  }}
                />
              </div>
            </Section>
          )}
        </div>
      </div>
    </div>
  )
}
