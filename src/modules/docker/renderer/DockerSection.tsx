import { useEffect, useState } from 'react'
import {
  ChevronRight,
  Container,
  Eye,
  Laptop,
  Plus,
  RefreshCw,
  Server,
  SquareTerminal,
  Trash2
} from 'lucide-react'
import { cx, IconButton } from '../../../renderer/src/components/ui'
import { useContextMenu, type MenuEntry } from '../../../renderer/src/components/ContextMenu'
import { t, useSavedHosts } from '../../registry/renderer-kit'
import { wslDistroOf, wslSource } from '../shared/ipc'
import { dockerApi, openDocker, sourceLabel } from './api'
import { useDocker } from './store'

/**
 * Mục "Docker" ở thanh bên (ADR-014 mục 6.4): "This computer" + các host SSH đã thêm Docker.
 * Bấm đúp để mở tab Docker.
 */
export function DockerSection(): React.JSX.Element {
  const endpoints = useDocker((s) => s.endpoints)
  const wsl = useDocker((s) => s.wsl)
  const hosts = useSavedHosts()
  const [open, setOpen] = useState(true)
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
  const rows = [
    { hostId: null, readOnly: local?.readOnly ?? false },
    ...wslRows,
    ...remote.map((e) => ({ hostId: e.hostId, readOnly: e.readOnly }))
  ]
  const addableWsl = wsl.filter((d) => !wslRows.some((r) => r.hostId === wslSource(d.name)))
  const addable = hosts.filter(
    (h) => h.protocol === 'ssh' && !remote.some((e) => e.hostId === h.id)
  )

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
    ...(hostId
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
        <IconButton
          label={t('Add a server')}
          size="sm"
          data-testid="docker-add-server"
          onClick={(e) => {
            const entries: MenuEntry[] = [
              ...addableWsl.map((d) => ({
                id: `docker-add-wsl-${d.name}`,
                label: `${d.name} (WSL)`,
                hint: d.running ? t('running') : t('stopped'),
                icon: <SquareTerminal size={14} />,
                onSelect: () => {
                  void dockerApi.add(wslSource(d.name))
                }
              })),
              ...(addableWsl.length ? ['separator' as const] : []),
              ...(addable.length === 0
                ? [
                    {
                      id: 'none',
                      label: t('Save an SSH host first'),
                      disabled: true,
                      onSelect: () => undefined
                    }
                  ]
                : addable.map((h) => ({
                    id: `docker-add-${h.id}`,
                    label: h.label,
                    hint: h.address,
                    icon: <Server size={14} />,
                    onSelect: () => {
                      void dockerApi.add(h.id)
                    }
                  })))
            ]
            openMenu(e, entries)
          }}
        >
          <Plus size={13} />
        </IconButton>
      </div>
      {open &&
        rows.map((r) => (
          <div
            key={r.hostId ?? 'local'}
            role="button"
            tabIndex={0}
            data-testid="docker-endpoint"
            data-name={sourceLabel(r.hostId)}
            className="group flex h-8 cursor-default items-center gap-2.5 rounded-md px-2 hover:bg-hover"
            title={t('Double-click to open')}
            onDoubleClick={() => openDocker(r.hostId)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') openDocker(r.hostId)
            }}
            onContextMenu={(e) => {
              openMenu(e, rowMenu(r.hostId, r.readOnly))
            }}
          >
            {wslDistroOf(r.hostId) ? (
              <SquareTerminal size={14} className="shrink-0 text-muted" />
            ) : r.hostId ? (
              <Server size={14} className="shrink-0 text-muted" />
            ) : (
              <Laptop size={14} className="shrink-0 text-muted" />
            )}
            <span className="min-w-0 flex-1 truncate text-[13px] text-fg">
              {sourceLabel(r.hostId)}
            </span>
            {r.readOnly && (
              <span className="rounded bg-subtle px-1 text-[11px] font-medium text-muted">
                {t('read-only')}
              </span>
            )}
          </div>
        ))}
      {menu}
    </div>
  )
}
