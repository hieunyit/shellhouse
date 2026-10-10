import { useEffect, useState } from 'react'
import {
  ChevronRight,
  Container,
  Eye,
  Laptop,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  SquareTerminal,
  Trash2
} from 'lucide-react'
import { cx, IconButton } from '../../../renderer/src/components/ui'
import { useContextMenu, type MenuEntry } from '../../../renderer/src/components/ContextMenu'
import {
  confirmAction,
  environmentMenu,
  NavTreeRow,
  monitorMenuItem,
  useSourceMonitorMap,
  hostEnvironmentId,
  setSourceEnvironment,
  t,
  useEnvironments,
  useSavedHosts,
  useHostEnvironmentId,
  useSourceEnvironment,
  useSourceEnvironmentMap,
  hostOptions
} from '../../registry/renderer-kit'
import { EnvLabel, Popover, SearchList } from '../../../renderer/src/ds'
import { tcpIdOf, wslDistroOf, wslSource, type DockerTcpEndpoint } from '../shared/ipc'
import { dockerApi, openDocker, sourceLabel } from './api'
import { TcpEndpointDialog } from './TcpEndpointDialog'
import { useDocker } from './store'

/**
 * Mục "Docker" ở thanh bên (ADR-014 mục 6.4): "This computer" + các host SSH đã thêm Docker.
 * Bấm đúp để mở tab Docker.
 */
export function DockerSection(): React.JSX.Element {
  const endpoints = useDocker((s) => s.endpoints)
  const wsl = useDocker((s) => s.wsl)
  const tcp = useDocker((s) => s.tcp)
  const hosts = useSavedHosts()
  const [open, setOpen] = useState(true)
  /** Hộp thoại thêm / sửa engine TCP + TLS (`true` = thêm mới). */
  const [tcpDialog, setTcpDialog] = useState<DockerTcpEndpoint | true | null>(null)
  /** Popover "thêm server" đang mở. */
  const [adding, setAdding] = useState(false)
  const { menu, open: openMenu } = useContextMenu()

  useEffect(() => {
    void useDocker.getState().reload()
  }, [])

  // "This computer" luôn có; WSL: distro đang chạy + distro đã thêm; host SSH theo danh sách đã
  // thêm (bỏ host đã xoá).
  const remote = endpoints.filter((e) => e.hostId && hosts.some((h) => h.id === e.hostId))
  const local = endpoints.find((e) => e.hostId === null)
  const hidden = new Set(endpoints.filter((e) => e.hidden).map((e) => e.hostId))
  const wslRows = wsl
    .filter((d) => {
      const key = wslSource(d.name)
      if (hidden.has(key)) return false
      return d.running || endpoints.some((e) => e.hostId === key)
    })
    .map((d) => {
      const key = wslSource(d.name)
      return { hostId: key, readOnly: endpoints.find((e) => e.hostId === key)?.readOnly ?? false }
    })
  // Engine TCP + TLS: bản ghi trong danh sách nguồn + định nghĩa còn tồn tại.
  const tcpRows = endpoints
    .filter((e) => {
      const id = tcpIdOf(e.hostId)
      return id !== null && tcp.some((x) => x.id === id)
    })
    .map((e) => ({ hostId: e.hostId, readOnly: e.readOnly }))
  const rows = [
    { hostId: null, readOnly: local?.readOnly ?? false },
    ...wslRows,
    ...tcpRows,
    ...remote.map((e) => ({ hostId: e.hostId, readOnly: e.readOnly }))
  ]
  const addableWsl = wsl.filter((d) => !wslRows.some((r) => r.hostId === wslSource(d.name)))
  const addable = hosts.filter(
    (h) => h.protocol === 'ssh' && !remote.some((e) => e.hostId === h.id)
  )

  const environments = useEnvironments()
  const sourceEnvs = useSourceEnvironmentMap()
  const monitorMap = useSourceMonitorMap()
  const rowMenu = (hostId: string | null, readOnly: boolean): MenuEntry[] => [
    {
      id: 'docker-open',
      label: t('Open'),
      icon: <Container size={14} />,
      onSelect: () => openDocker(hostId)
    },
    {
      id: 'docker-read-only',
      label: readOnly ? t('Turn off read-only mode') : t('Read-only mode'),
      icon: <Eye size={14} />,
      onSelect: () => void dockerApi.setReadOnly(hostId, !readOnly)
    },
    monitorMenuItem(
      `docker:${endpointKey(hostId)}`,
      sourceEnvs[`docker:${endpointKey(hostId)}`] ?? hostEnvironmentId(hostId),
      monitorMap
    ),
    'separator',
    ...environmentMenu(
      environments,
      sourceEnvs[`docker:${endpointKey(hostId)}`] ?? hostEnvironmentId(hostId),
      (id) => void setSourceEnvironment('docker', endpointKey(hostId), id)
    ),
    ...(tcpIdOf(hostId)
      ? [
          {
            id: 'docker-tcp-edit',
            label: t('Edit connection…'),
            icon: <Pencil size={14} />,
            onSelect: () => {
              setTcpDialog(tcp.find((x) => x.id === tcpIdOf(hostId)) ?? null)
            }
          },
          'separator' as const,
          {
            id: 'docker-remove',
            label: t('Delete engine'),
            icon: <Trash2 size={14} />,
            danger: true,
            onSelect: () => {
              const id = tcpIdOf(hostId) ?? ''
              void confirmAction({
                title: t('Delete {name}?', { name: sourceLabel(hostId) }),
                message: t(
                  'The address and the certificates stored for it are deleted from the vault.'
                ),
                confirmLabel: t('Delete'),
                danger: true,
                testId: 'docker-tcp-delete-confirm'
              }).then((ok) => {
                if (ok) void dockerApi.deleteTcp(id)
              })
            }
          }
        ]
      : hostId
        ? [
            'separator' as const,
            {
              id: 'docker-remove',
              label: wslDistroOf(hostId) ? t('Hide from Docker') : t('Remove from Docker'),
              icon: <Trash2 size={14} />,
              danger: true,
              onSelect: () =>
                void (wslDistroOf(hostId) ? dockerApi.hide(hostId) : dockerApi.remove(hostId))
            }
          ]
        : [])
  ]

  return (
    <div data-testid="docker-section">
      <div className="flex h-7 items-center gap-1.5 px-1 text-xs font-medium text-faint">
        <button
          type="button"
          aria-expanded={open}
          className="flex flex-1 items-center gap-1.5 hover:text-muted"
          onClick={() => {
            setOpen(!open)
          }}
        >
          <ChevronRight
            size={13}
            className={cx('transition-transform duration-150', open && 'rotate-90')}
          />
          <span className="flex-1 text-left">{t('Endpoints')}</span>
        </button>
        <IconButton
          label={t('Refresh (find WSL distributions again)')}
          size="sm"
          data-testid="docker-refresh-sources"
          onClick={() => void useDocker.getState().reload()}
        >
          <RefreshCw size={12} />
        </IconButton>
        <Popover
          open={adding}
          onOpenChange={setAdding}
          label={t('Add a server')}
          align="end"
          className="flex max-h-[min(28rem,70vh)] w-80 flex-col p-2"
          trigger={
            <IconButton label={t('Add a server')} size="sm" data-testid="docker-add-server">
              <Plus size={13} />
            </IconButton>
          }
        >
          {/* Thao tác cố định ở trên — không bị danh sách host dài đẩy ra khỏi màn hình. */}
          <div className="mb-1.5 flex flex-col gap-0.5 border-b border-ds-border pb-1.5">
            <AddRow
              testId="docker-add-tcp"
              icon={<Network size={14} />}
              label={t('Add by address (TLS)…')}
              hint="tcp://host:2376"
              onClick={() => {
                setAdding(false)
                setTcpDialog(true)
              }}
            />
            {addableWsl.map((d) => (
              <AddRow
                key={d.name}
                testId="docker-add-wsl"
                name={`${d.name} (WSL)`}
                icon={<SquareTerminal size={14} />}
                label={`${d.name} (WSL)`}
                hint={d.running ? t('running') : t('stopped')}
                onClick={() => {
                  setAdding(false)
                  void dockerApi.add(wslSource(d.name))
                }}
              />
            ))}
          </div>
          <div className="px-1 pb-1 text-ds-xs font-medium text-ds-fg-3">
            {t('Docker on an SSH host')}
          </div>
          {addable.length === 0 ? (
            <p className="px-1 py-2 text-ds-sm text-ds-fg-3">{t('Save an SSH host first')}</p>
          ) : (
            <SearchList
              options={hostOptions(addable, ['docker'], {
                preferred: t('Tagged “docker”'),
                others: t('Other hosts')
              })}
              label={t('SSH host')}
              placeholder={t('Search hosts, addresses, tags')}
              emptyText={t('No matching hosts')}
              limit={12}
              data-testid="docker-add-search"
              optionTestId="docker-add-option"
              onEscape={() => {
                setAdding(false)
              }}
              onPick={(id) => {
                setAdding(false)
                void dockerApi.add(id)
              }}
            />
          )}
        </Popover>
      </div>
      {open &&
        rows.map((r) => (
          <NavTreeRow
            key={r.hostId ?? 'local'}
            owner={endpointKey(r.hostId)}
            row={({ active, chevron }) => (
              <div
                role="button"
                tabIndex={0}
                data-testid="docker-endpoint"
                data-name={sourceLabel(r.hostId)}
                className={cx(
                  'group flex h-(--ds-tree-row-h) cursor-default items-center gap-2 rounded-ds-md px-2 outline-none hover:bg-ds-hover focus-visible:shadow-ds-focus',
                  active && 'bg-ds-active'
                )}
                aria-current={active}
                title={t('Double-click to open')}
                onDoubleClick={() => openDocker(r.hostId)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') openDocker(r.hostId)
                }}
                onContextMenu={(e) => {
                  openMenu(e, rowMenu(r.hostId, r.readOnly))
                }}
              >
                {chevron}
                {wslDistroOf(r.hostId) ? (
                  <SquareTerminal size={14} className="shrink-0 text-muted" />
                ) : tcpIdOf(r.hostId) ? (
                  <Network size={14} className="shrink-0 text-muted" />
                ) : r.hostId ? (
                  <Server size={14} className="shrink-0 text-muted" />
                ) : (
                  <Laptop size={14} className="shrink-0 text-muted" />
                )}
                <span className="min-w-0 flex-1 truncate text-[13px] text-fg">
                  {sourceLabel(r.hostId)}
                </span>
                <EndpointEnv hostId={r.hostId} />
                {r.readOnly && (
                  <span className="rounded bg-subtle px-1 text-[11px] font-medium text-muted">
                    {t('read-only')}
                  </span>
                )}
              </div>
            )}
          />
        ))}
      {menu}
      {tcpDialog !== null && (
        <TcpEndpointDialog
          endpoint={tcpDialog === true ? undefined : tcpDialog}
          onClose={() => {
            setTcpDialog(null)
          }}
          onSaved={() => {
            setTcpDialog(null)
            void useDocker.getState().reload()
          }}
        />
      )}
    </div>
  )
}

/** Khoá môi trường của endpoint: "local" (máy này) hoặc id host / nguồn WSL. */
export function endpointKey(hostId: string | null): string {
  return hostId ?? 'local'
}

/**
 * Môi trường của endpoint Docker (Settings › Environments): chọn riêng, không thì kế thừa môi
 * trường của host SSH chạy Docker (host trong nhóm Production → endpoint là Production).
 */
export function useEndpointEnvironment(
  hostId: string | null
): ReturnType<typeof useSourceEnvironment> {
  const inherited = useHostEnvironmentId(hostId)
  return useSourceEnvironment('docker', endpointKey(hostId), inherited ?? undefined)
}

function EndpointEnv({ hostId }: { hostId: string | null }): React.JSX.Element | null {
  const env = useEndpointEnvironment(hostId)
  return env ? <EnvLabel env={env} /> : null
}

/** Một thao tác ở đầu popover "thêm server" (engine TLS, distro WSL). */
function AddRow({
  testId,
  name,
  icon,
  label,
  hint,
  onClick
}: {
  testId: string
  name?: string
  icon: React.ReactNode
  label: string
  hint?: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      data-name={name}
      className="flex h-ds-menu-item items-center gap-2 rounded-ds-md px-2 text-left text-ds-base text-ds-fg outline-none hover:bg-ds-active focus-visible:bg-ds-active [&_svg]:text-ds-fg-2"
      onClick={onClick}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="shrink-0 text-ds-sm text-ds-fg-3">{hint}</span>}
    </button>
  )
}
