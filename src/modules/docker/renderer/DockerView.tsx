import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Boxes,
  Container,
  Download,
  Eye,
  FileText,
  HardDrive,
  Layers,
  Network,
  Pause,
  Play,
  RefreshCw,
  RotateCw,
  Search,
  Square,
  SquareTerminal,
  Trash2
} from 'lucide-react'
import { Button, cx, Input, Modal, Notice } from '../../../renderer/src/components/ui'
import { useContextMenu, type MenuEntry } from '../../../renderer/src/components/ContextMenu'
import { FileTable, type FileColumn } from '../../../renderer/src/components/files/FileTable'
import { Empty, ToolButton } from '../../../renderer/src/components/files/parts'
import type { SortState } from '../../../renderer/src/components/SortMenu'
import { cleanError, formatSize, nameOrder } from '../../../renderer/src/lib/format'
import { ConnectionPrompt } from '../../registry/renderer-kit'
import type { ModuleTabProps } from '../../registry/renderer-types'
import type {
  DockerOp,
  ComposeAction,
  ContainerAction,
  ContainerRow,
  DockerEngineParams,
  EngineInfo,
  ImageRow,
  NetworkRow,
  PruneResult,
  PruneTarget,
  StatsSample,
  VolumeRow
} from '../shared/ops'
import { openLogs, openShell } from './api'
import { useDockerSession } from './useDockerSession'

type Section = 'containers' | 'images' | 'volumes' | 'networks' | 'compose'

const SECTIONS: { id: Section; label: string; icon: React.ReactNode }[] = [
  { id: 'containers', label: 'Containers', icon: <Container size={14} /> },
  { id: 'images', label: 'Images', icon: <Layers size={14} /> },
  { id: 'volumes', label: 'Volumes', icon: <HardDrive size={14} /> },
  { id: 'networks', label: 'Networks', icon: <Network size={14} /> },
  { id: 'compose', label: 'Compose', icon: <Boxes size={14} /> }
]

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
function ago(ms: number): string {
  if (!ms) return ''
  const s = Math.round((ms - Date.now()) / 1000)
  const abs = Math.abs(s)
  if (abs < 60) return relative.format(s, 'second')
  if (abs < 3600) return relative.format(Math.round(s / 60), 'minute')
  if (abs < 86400) return relative.format(Math.round(s / 3600), 'hour')
  return relative.format(Math.round(s / 86400), 'day')
}

function stateTone(state: string): string {
  if (state === 'running') return 'text-success'
  if (state === 'paused' || state === 'restarting') return 'text-warning'
  if (state === 'dead') return 'text-danger'
  return 'text-faint'
}

export function portsText(c: ContainerRow): string {
  return [
    ...new Set(
      c.ports.map((p) =>
        p.publicPort ? `${p.publicPort}→${p.privatePort}/${p.type}` : `${p.privatePort}/${p.type}`
      )
    )
  ].join(', ')
}

interface ComposeProject {
  name: string
  services: number
  running: number
  containers: ContainerRow[]
}

type Dialog =
  | { kind: 'prune'; what: PruneTarget; preview: PruneResult | null; error: string | null }
  | { kind: 'pull' }
  | { kind: 'rename'; container: ContainerRow }
  | { kind: 'inspect'; title: string; data: unknown }
  | null

type SectionData =
  | { section: 'containers' | 'compose'; data: ContainerRow[] }
  | { section: 'images'; data: ImageRow[] }
  | { section: 'volumes'; data: VolumeRow[] }
  | { section: 'networks'; data: NetworkRow[] }

async function fetchSection(
  request: <T>(op: DockerOp) => Promise<T>,
  section: Section
): Promise<SectionData> {
  switch (section) {
    case 'images':
      return { section, data: await request<ImageRow[]>({ op: 'images' }) }
    case 'volumes':
      return { section, data: await request<VolumeRow[]>({ op: 'volumes' }) }
    case 'networks':
      return { section, data: await request<NetworkRow[]>({ op: 'networks' }) }
    default:
      return { section, data: await request<ContainerRow[]>({ op: 'containers', all: true }) }
  }
}

/** Tab Docker của một nguồn (máy này hoặc server qua SSH). */
export function DockerTab({
  tabId,
  params
}: ModuleTabProps<DockerEngineParams>): React.JSX.Element {
  const hostId = params.hostId
  const [section, setSection] = useState<Section>('containers')
  const [info, setInfo] = useState<EngineInfo | null>(null)
  const [containers, setContainers] = useState<ContainerRow[] | null>(null)
  const [images, setImages] = useState<ImageRow[] | null>(null)
  const [volumes, setVolumes] = useState<VolumeRow[] | null>(null)
  const [networks, setNetworks] = useState<NetworkRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [sort, setSort] = useState<SortState<'name' | 'created' | 'size'>>({
    key: 'name',
    dir: 'asc'
  })
  const [dialog, setDialog] = useState<Dialog>(null)
  const [pull, setPull] = useState<{
    subscription: string
    status: string
    progress: number | null
    done: boolean
    error?: string
  } | null>(null)
  /** Mẫu CPU / RAM theo lượt theo dõi (đổi container = lượt mới). */
  const [statsState, setStats] = useState<{ sub: string; samples: StatsSample[] } | null>(null)
  const [statsActive, setStatsActive] = useState<string | null>(null)
  const statsSub = useRef<string | null>(null)
  const reloadTimer = useRef<number | null>(null)
  const { menu, open: openMenu } = useContextMenu()

  const reload = useRef<() => void>(() => undefined)
  const onEvent = useCallback((event: string, data: unknown) => {
    const d = data as { subscription?: string }
    if (event === 'engine') {
      // Container đổi trạng thái → tải lại danh sách (gộp các sự kiện dồn dập).
      if (reloadTimer.current) window.clearTimeout(reloadTimer.current)
      reloadTimer.current = window.setTimeout(() => {
        reload.current()
      }, 300)
    } else if (event === 'stats' && d.subscription === statsSub.current) {
      const sample = (data as { sample: StatsSample }).sample
      const sub = d.subscription
      setStats((s) =>
        s?.sub === sub
          ? { sub, samples: [...s.samples.slice(-59), sample] }
          : { sub, samples: [sample] }
      )
    } else if (event === 'pull') {
      setPull((p) => (p && p.subscription === d.subscription ? { ...p, ...(data as object) } : p))
    }
  }, [])
  const session = useDockerSession(tabId, hostId, onEvent)
  const { request, ready, readOnly } = session

  const apply = useCallback((result: SectionData) => {
    if (result.section === 'images') setImages(result.data)
    else if (result.section === 'volumes') setVolumes(result.data)
    else if (result.section === 'networks') setNetworks(result.data)
    else setContainers(result.data)
    setLoadError(null)
  }, [])
  const load = useCallback(
    (which: Section): Promise<void> =>
      fetchSection(request, which).then(apply, (e: unknown) => {
        setLoadError(cleanError(e))
      }),
    [request, apply]
  )
  useEffect(() => {
    reload.current = () => {
      void load(section)
    }
  }, [load, section])

  // Kết nối xong: thông tin engine + danh sách + theo dõi sự kiện (không cần poll).
  useEffect(() => {
    if (!ready) return
    let sub: string | null = null
    void request<EngineInfo>({ op: 'info' }).then(setInfo, (e: unknown) => {
      setLoadError(cleanError(e))
    })
    void request<{ subscription: string }>({ op: 'events.subscribe' }).then(
      (r) => {
        sub = r.subscription
      },
      () => undefined
    )
    return () => {
      if (sub) void request({ op: 'unsubscribe', subscription: sub }).catch(() => undefined)
    }
  }, [ready, request])

  useEffect(() => {
    if (!ready) return
    let cancelled = false
    fetchSection(request, section).then(
      (r) => {
        if (!cancelled) apply(r)
      },
      (e: unknown) => {
        if (!cancelled) setLoadError(cleanError(e))
      }
    )
    return () => {
      cancelled = true
    }
  }, [ready, section, request, apply])

  const run = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    setActionError(null)
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      setActionError(`${label}: ${cleanError(e)}`)
    } finally {
      setBusy(false)
      void load(section)
    }
  }

  const containerAction = (items: ContainerRow[], action: ContainerAction): void => {
    if (action === 'remove' || action === 'kill') {
      const names = items.map((c) => c.name).join(', ')
      if (!window.confirm(`${action === 'remove' ? 'Remove' : 'Kill'} ${names}?`)) return
    }
    void run(`${action[0]?.toUpperCase() ?? ''}${action.slice(1)} failed`, () =>
      Promise.all(
        items.map((c) =>
          request({
            op: 'action',
            id: c.id,
            action,
            ...(action === 'remove' ? { force: c.state === 'running' } : {})
          })
        )
      )
    )
  }

  // ——— Danh sách theo mục ———

  const q = filter.trim().toLowerCase()
  const match = (...parts: (string | null | undefined)[]): boolean =>
    !q || parts.some((p) => p?.toLowerCase().includes(q))
  const byName = <T,>(
    list: T[],
    name: (x: T) => string,
    created: (x: T) => number,
    size?: (x: T) => number
  ): T[] => {
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...list].sort((a, b) => {
      if (sort.key === 'created') return (created(a) - created(b)) * dir
      if (sort.key === 'size' && size) return (size(a) - size(b)) * dir
      return nameOrder.compare(name(a), name(b)) * dir
    })
  }

  const containerRows = byName(
    (containers ?? []).filter((c) => match(c.name, c.image, c.project, c.state)),
    (c) => c.name,
    (c) => c.created
  )
  const projects = ((): ComposeProject[] => {
    const map = new Map<string, ContainerRow[]>()
    for (const c of containers ?? [])
      if (c.project) map.set(c.project, [...(map.get(c.project) ?? []), c])
    return [...map.entries()]
      .map(([name, list]) => ({
        name,
        containers: list,
        services: new Set(list.map((c) => c.service ?? c.name)).size,
        running: list.filter((c) => c.state === 'running').length
      }))
      .filter((p) => !q || p.name.toLowerCase().includes(q))
      .sort((a, b) => nameOrder.compare(a.name, b.name))
  })()

  const imageName = (i: ImageRow): string => i.tags[0] ?? i.id.replace(/^sha256:/, '').slice(0, 12)

  const one = containerRows.find((c) => selected.has(c.name) && selected.size === 1)

  // Theo dõi CPU / RAM của container đang chọn (đang chạy).
  const statsTarget = section === 'containers' && one?.state === 'running' ? one.id : null
  useEffect(() => {
    if (!ready || !statsTarget) return
    let sub: string | null = null
    let cancelled = false
    void request<{ subscription: string }>({ op: 'stats.subscribe', id: statsTarget }).then(
      (r) => {
        if (cancelled) void request({ op: 'unsubscribe', subscription: r.subscription })
        else {
          sub = r.subscription
          statsSub.current = r.subscription
          setStatsActive(r.subscription)
        }
      },
      () => undefined
    )
    return () => {
      cancelled = true
      statsSub.current = null
      if (sub) void request({ op: 'unsubscribe', subscription: sub }).catch(() => undefined)
    }
  }, [ready, statsTarget, request])

  const containerMenu = (items: ContainerRow[]): MenuEntry[] => {
    const c = items.length === 1 ? items[0] : undefined
    const running = items.some((x) => x.state === 'running')
    const entries: MenuEntry[] = []
    if (c) {
      entries.push(
        {
          id: 'logs',
          label: 'Logs',
          icon: <FileText size={14} />,
          onSelect: () => openLogs(hostId, c)
        },
        {
          id: 'shell',
          label: 'Open shell',
          icon: <SquareTerminal size={14} />,
          disabled: c.state !== 'running',
          onSelect: () => openShell(hostId, c)
        },
        {
          id: 'inspect',
          label: 'Inspect',
          icon: <Search size={14} />,
          onSelect: () => {
            void request({ op: 'inspect', kind: 'container', id: c.id }).then(
              (data) => {
                setDialog({ kind: 'inspect', title: c.name, data })
              },
              (e: unknown) => {
                setActionError(cleanError(e))
              }
            )
          }
        }
      )
    }
    if (!readOnly) {
      if (entries.length) entries.push('separator')
      entries.push(
        {
          id: 'start',
          label: 'Start',
          icon: <Play size={14} />,
          disabled: items.every((x) => x.state === 'running'),
          onSelect: () => {
            containerAction(items, 'start')
          }
        },
        {
          id: 'stop',
          label: 'Stop',
          icon: <Square size={14} />,
          disabled: !running,
          onSelect: () => {
            containerAction(items, 'stop')
          }
        },
        {
          id: 'restart',
          label: 'Restart',
          icon: <RotateCw size={14} />,
          onSelect: () => {
            containerAction(items, 'restart')
          }
        },
        {
          id: 'pause',
          label: c?.state === 'paused' ? 'Resume' : 'Pause',
          icon: <Pause size={14} />,
          disabled: !c || (c.state !== 'running' && c.state !== 'paused'),
          onSelect: () => {
            if (c) containerAction([c], c.state === 'paused' ? 'unpause' : 'pause')
          }
        },
        ...(c
          ? [
              {
                id: 'rename',
                label: 'Rename…',
                onSelect: () => {
                  setDialog({ kind: 'rename', container: c })
                }
              }
            ]
          : []),
        'separator',
        {
          id: 'kill',
          label: 'Kill',
          danger: true,
          disabled: !running,
          onSelect: () => {
            containerAction(items, 'kill')
          }
        },
        {
          id: 'remove',
          label: 'Remove',
          icon: <Trash2 size={14} />,
          danger: true,
          onSelect: () => {
            containerAction(items, 'remove')
          }
        }
      )
    }
    return entries
  }

  const containerColumns: FileColumn<ContainerRow, 'name' | 'created' | 'size'>[] = [
    {
      id: 'state',
      label: 'State',
      render: (c) => (
        <span className={cx('font-medium', stateTone(c.state))} title={c.status}>
          {c.state}
        </span>
      )
    },
    {
      id: 'image',
      label: 'Image',
      className: 'hidden @lg:block',
      render: (c) => <span title={c.image}>{c.image}</span>
    },
    { id: 'ports', label: 'Ports', className: 'hidden @2xl:block', render: (c) => portsText(c) },
    {
      id: 'created',
      label: 'Created',
      sort: { key: 'created', label: 'Created', kind: 'date' },
      className: 'hidden @xl:block',
      render: (c) => ago(c.created)
    },
    {
      id: 'quick',
      label: '',
      align: 'right',
      render: (c) => (
        <span
          className="inline-flex gap-0.5"
          onClick={(e) => {
            e.stopPropagation()
          }}
          onDoubleClick={(e) => {
            e.stopPropagation()
          }}
        >
          <QuickButton
            label={`Logs of ${c.name}`}
            testId="docker-row-logs"
            onClick={() => openLogs(hostId, c)}
          >
            <FileText size={13} />
          </QuickButton>
          <QuickButton
            label={`Shell in ${c.name}`}
            testId="docker-row-shell"
            disabled={c.state !== 'running'}
            onClick={() => openShell(hostId, c)}
          >
            <SquareTerminal size={13} />
          </QuickButton>
          {!readOnly && (
            <QuickButton
              label={`Restart ${c.name}`}
              testId="docker-row-restart"
              onClick={() => {
                containerAction([c], 'restart')
              }}
            >
              <RotateCw size={13} />
            </QuickButton>
          )}
        </span>
      )
    }
  ]

  const openPrune = (what: PruneTarget): void => {
    setDialog({ kind: 'prune', what, preview: null, error: null })
    request<PruneResult>({ op: 'prune', what, dryRun: true }).then(
      (preview) => {
        setDialog((d) => (d?.kind === 'prune' && d.what === what ? { ...d, preview } : d))
      },
      (e: unknown) => {
        setDialog((d) => (d?.kind === 'prune' ? { ...d, error: cleanError(e) } : d))
      }
    )
  }

  const compose = (p: ComposeProject, action: ComposeAction): void => {
    if (
      (action === 'down' || action === 'stop') &&
      !window.confirm(`${action === 'down' ? 'Take down' : 'Stop'} the Compose project ${p.name}?`)
    )
      return
    void run(`Compose ${action} failed`, () => request({ op: 'compose', project: p.name, action }))
  }

  // ——— Vẽ ———

  if (session.error)
    return (
      <div
        className="flex h-full items-center justify-center bg-canvas p-6"
        data-testid="docker-view"
      >
        <div className="flex max-w-md flex-col items-center gap-3 text-center">
          <Container size={28} className="text-faint" />
          <p className="text-sm text-fg" data-testid="docker-error">
            {session.error}
          </p>
          <Button size="sm" icon={<RefreshCw size={13} />} onClick={session.retry}>
            Try again
          </Button>
        </div>
      </div>
    )

  const list =
    section === 'containers'
      ? containers
      : section === 'images'
        ? images
        : section === 'volumes'
          ? volumes
          : section === 'networks'
            ? networks
            : containers

  return (
    <div
      className="@container relative flex h-full bg-surface"
      data-testid="docker-view"
      data-ready={ready && list !== null}
    >
      <nav className="flex w-40 shrink-0 flex-col gap-0.5 border-r border-line bg-subtle p-2">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            data-testid={`docker-nav-${s.id}`}
            aria-current={section === s.id}
            className={cx(
              'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px]',
              section === s.id
                ? 'bg-surface font-medium text-fg shadow-sm'
                : 'text-muted hover:bg-hover hover:text-fg'
            )}
            onClick={() => {
              setSection(s.id)
              setFilter('')
              setSelected(new Set())
            }}
          >
            {s.icon}
            {s.label}
          </button>
        ))}
        <div
          className="mt-auto px-1 text-[11px] leading-snug text-faint"
          data-testid="docker-engine-info"
        >
          {info ? (
            <>
              <div className="text-muted">{info.version}</div>
              <div>{info.os}</div>
              {info.via === 'cli' && <div>via docker CLI</div>}
            </>
          ) : (
            session.status
          )}
        </div>
      </nav>
      {/* Container riêng: cột của bảng co giãn theo chỗ còn lại (khi có bảng chi tiết bên phải). */}
      <div className="@container flex min-w-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-2">
          <div className="flex h-7 w-56 items-center gap-1.5 rounded-md border border-line bg-subtle px-2">
            <Search size={13} className="text-faint" />
            <input
              type="search"
              placeholder="Filter…"
              data-testid="docker-filter"
              className="min-w-0 flex-1 bg-transparent text-xs text-fg outline-none placeholder:text-faint"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value)
              }}
            />
          </div>
          <ToolButton
            icon={<RefreshCw size={13} className={cx(busy && 'animate-spin')} />}
            label="Refresh"
            labelAt="xl"
            testId="docker-refresh"
            onClick={() => void load(section)}
          />
          {!readOnly && section === 'images' && (
            <ToolButton
              icon={<Download size={13} />}
              label="Pull"
              labelAt="md"
              testId="docker-pull"
              onClick={() => {
                setDialog({ kind: 'pull' })
              }}
            />
          )}
          {!readOnly && section !== 'compose' && (
            <ToolButton
              icon={<Trash2 size={13} />}
              label={
                section === 'containers'
                  ? 'Remove stopped'
                  : section === 'images'
                    ? 'Remove dangling'
                    : 'Remove unused'
              }
              labelAt="2xl"
              testId="docker-prune"
              onClick={() => {
                openPrune(section)
              }}
            />
          )}
          <div className="flex-1" />
          {readOnly && (
            <span
              className="flex items-center gap-1 rounded bg-warning-soft px-1.5 py-px text-xs font-medium text-warning"
              data-testid="docker-read-only"
              title="Actions that change something are hidden"
            >
              <Eye size={12} /> Read-only
            </span>
          )}
          <span className="px-1 text-xs text-faint">{params.label}</span>
        </div>
        {(loadError ?? actionError) && (
          <div className="border-b border-line p-2">
            <Notice tone="danger" testId="docker-action-error">
              {loadError ?? actionError}
            </Notice>
          </div>
        )}
        {!ready || list === null ? (
          <div className="flex flex-1 items-center justify-center text-xs text-faint">
            {session.status}
          </div>
        ) : section === 'containers' ? (
          <FileTable
            items={containerRows}
            getKey={(c) => c.name}
            icon={(c) => <Container size={14} className={stateTone(c.state)} />}
            badge={(c) =>
              c.project ? (
                <span className="shrink-0 rounded bg-subtle px-1 text-[10px] text-faint">
                  {c.project}
                </span>
              ) : null
            }
            columns={containerColumns}
            gridClass="grid-cols-[minmax(10rem,2fr)_5rem_5rem] @lg:grid-cols-[minmax(10rem,2fr)_5rem_minmax(8rem,1.5fr)_5rem] @xl:grid-cols-[minmax(10rem,2fr)_5rem_minmax(8rem,1.5fr)_7rem_5rem] @2xl:grid-cols-[minmax(10rem,2fr)_5rem_minmax(8rem,1.5fr)_minmax(6rem,1fr)_7rem_5rem]"
            nameSort={{ key: 'name', label: 'Name', kind: 'text' }}
            sort={sort}
            onSort={setSort}
            selected={selected}
            onSelect={setSelected}
            onOpen={(c) => openLogs(hostId, c)}
            onContextMenu={(e, items) => {
              openMenu(e, containerMenu(items))
            }}
            ariaLabel="Containers"
            rowTestId="docker-container"
          >
            {containerRows.length === 0 && (
              <Empty
                icon={<Container size={18} />}
                title={q ? 'Nothing matches' : 'No containers'}
                text={q ? 'Try another filter.' : 'Containers you run appear here.'}
                action={null}
              />
            )}
          </FileTable>
        ) : section === 'images' ? (
          <FileTable
            items={byName(
              (images ?? []).filter((i) => match(...i.tags, i.id)),
              imageName,
              (i) => i.created,
              (i) => i.size
            )}
            getKey={imageName}
            icon={() => <Layers size={14} className="text-muted" />}
            badge={(i) =>
              i.dangling ? (
                <span className="rounded bg-subtle px-1 text-[10px] text-faint">dangling</span>
              ) : null
            }
            columns={[
              {
                id: 'size',
                label: 'Size',
                align: 'right',
                sort: { key: 'size', label: 'Size', kind: 'number' },
                render: (i) => formatSize(i.size)
              },
              {
                id: 'created',
                label: 'Created',
                sort: { key: 'created', label: 'Created', kind: 'date' },
                className: 'hidden @xl:block',
                render: (i) => ago(i.created)
              },
              {
                id: 'used',
                label: 'Used by',
                className: 'hidden @lg:block',
                render: (i) =>
                  i.containers ? `${i.containers} container${i.containers > 1 ? 's' : ''}` : '—'
              }
            ]}
            gridClass="grid-cols-[minmax(10rem,2fr)_6rem] @lg:grid-cols-[minmax(10rem,2fr)_6rem_8rem] @xl:grid-cols-[minmax(10rem,2fr)_6rem_7rem_8rem]"
            nameSort={{ key: 'name', label: 'Name', kind: 'text' }}
            sort={sort}
            onSort={setSort}
            selected={selected}
            onSelect={setSelected}
            onOpen={(i) => {
              void request({ op: 'inspect', kind: 'image', id: i.id }).then((data) => {
                setDialog({ kind: 'inspect', title: imageName(i), data })
              })
            }}
            onContextMenu={(e, items) => {
              openMenu(
                e,
                readOnly
                  ? []
                  : [
                      {
                        id: 'rmi',
                        label: items.length > 1 ? `Remove ${items.length} images` : 'Remove image',
                        icon: <Trash2 size={14} />,
                        danger: true,
                        onSelect: () => {
                          if (window.confirm(`Remove ${items.map(imageName).join(', ')}?`))
                            void run('Remove failed', () =>
                              Promise.all(
                                items.map((i) => request({ op: 'image.remove', id: i.id }))
                              )
                            )
                        }
                      }
                    ]
              )
            }}
            ariaLabel="Images"
            rowTestId="docker-image"
          />
        ) : section === 'volumes' ? (
          <FileTable
            items={byName(
              (volumes ?? []).filter((v) => match(v.name, v.project)),
              (v) => v.name,
              (v) => v.created ?? 0
            )}
            getKey={(v) => v.name}
            icon={() => <HardDrive size={14} className="text-muted" />}
            columns={[
              { id: 'driver', label: 'Driver', render: (v) => v.driver },
              {
                id: 'project',
                label: 'Project',
                className: 'hidden @lg:block',
                render: (v) => v.project ?? '—'
              }
            ]}
            gridClass="grid-cols-[minmax(10rem,2fr)_6rem] @lg:grid-cols-[minmax(10rem,2fr)_6rem_8rem]"
            nameSort={{ key: 'name', label: 'Name', kind: 'text' }}
            sort={sort}
            onSort={setSort}
            selected={selected}
            onSelect={setSelected}
            onOpen={(v) => {
              void request({ op: 'inspect', kind: 'volume', id: v.name }).then((data) => {
                setDialog({ kind: 'inspect', title: v.name, data })
              })
            }}
            onContextMenu={(e, items) => {
              openMenu(
                e,
                readOnly
                  ? []
                  : [
                      {
                        id: 'rmv',
                        label:
                          items.length > 1 ? `Remove ${items.length} volumes` : 'Remove volume',
                        icon: <Trash2 size={14} />,
                        danger: true,
                        onSelect: () => {
                          if (
                            window.confirm(
                              `Remove ${items.map((v) => v.name).join(', ')}? The data in them is deleted.`
                            )
                          )
                            void run('Remove failed', () =>
                              Promise.all(
                                items.map((v) => request({ op: 'volume.remove', name: v.name }))
                              )
                            )
                        }
                      }
                    ]
              )
            }}
            ariaLabel="Volumes"
            rowTestId="docker-volume"
          />
        ) : section === 'networks' ? (
          <FileTable
            items={byName(
              (networks ?? []).filter((n) => match(n.name, n.driver)),
              (n) => n.name,
              () => 0
            )}
            getKey={(n) => n.name}
            icon={() => <Network size={14} className="text-muted" />}
            columns={[
              { id: 'driver', label: 'Driver', render: (n) => n.driver },
              { id: 'scope', label: 'Scope', className: 'hidden @lg:block', render: (n) => n.scope }
            ]}
            gridClass="grid-cols-[minmax(10rem,2fr)_6rem] @lg:grid-cols-[minmax(10rem,2fr)_6rem_6rem]"
            nameSort={{ key: 'name', label: 'Name', kind: 'text' }}
            sort={sort}
            onSort={setSort}
            selected={selected}
            onSelect={setSelected}
            onOpen={(n) => {
              void request({ op: 'inspect', kind: 'network', id: n.id }).then((data) => {
                setDialog({ kind: 'inspect', title: n.name, data })
              })
            }}
            onContextMenu={(e, items) => {
              const removable = items.filter((n) => !n.builtin)
              openMenu(
                e,
                readOnly || removable.length === 0
                  ? []
                  : [
                      {
                        id: 'rmn',
                        label:
                          removable.length > 1
                            ? `Remove ${removable.length} networks`
                            : 'Remove network',
                        icon: <Trash2 size={14} />,
                        danger: true,
                        onSelect: () => {
                          if (window.confirm(`Remove ${removable.map((n) => n.name).join(', ')}?`))
                            void run('Remove failed', () =>
                              Promise.all(
                                removable.map((n) => request({ op: 'network.remove', id: n.id }))
                              )
                            )
                        }
                      }
                    ]
              )
            }}
            ariaLabel="Networks"
            rowTestId="docker-network"
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-auto p-2" data-testid="docker-compose">
            {projects.length === 0 ? (
              <Empty
                icon={<Boxes size={18} />}
                title="No Compose projects"
                text="Containers started with docker compose are grouped here by project."
                action={null}
              />
            ) : (
              projects.map((p) => (
                <div
                  key={p.name}
                  className="mb-2 rounded-lg border border-line p-3"
                  data-testid="docker-project"
                  data-name={p.name}
                >
                  <div className="flex items-center gap-2">
                    <Boxes size={15} className="text-accent" />
                    <span className="flex-1 text-[13px] font-semibold text-fg">{p.name}</span>
                    <span className="text-xs text-faint">
                      {p.running}/{p.containers.length} running · {p.services} service
                      {p.services === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {p.containers.map((c) => (
                      <span
                        key={c.id}
                        className={cx('rounded bg-subtle px-1.5 py-px text-xs', stateTone(c.state))}
                      >
                        {c.service ?? c.name}
                      </span>
                    ))}
                  </div>
                  {!readOnly && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {(['start', 'stop', 'restart', 'up', 'pull', 'down'] as const).map((a) => (
                        <Button
                          key={a}
                          size="sm"
                          variant={a === 'down' ? 'danger-ghost' : 'ghost'}
                          disabled={busy}
                          data-testid={`docker-compose-${a}`}
                          onClick={() => {
                            compose(p, a)
                          }}
                        >
                          {a === 'up'
                            ? 'Up'
                            : a === 'down'
                              ? 'Down'
                              : `${a[0]?.toUpperCase() ?? ''}${a.slice(1)}`}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </div>
      {section === 'containers' && one && (
        <ContainerDetail
          container={one}
          stats={statsState && statsState.sub === statsActive ? statsState.samples : []}
        />
      )}
      {session.prompt && <ConnectionPrompt prompt={session.prompt} onAnswer={session.answer} />}
      {dialog?.kind === 'inspect' && (
        <Modal
          title={`Inspect ${dialog.title}`}
          width="max-w-3xl"
          onClose={() => {
            setDialog(null)
          }}
          testId="docker-inspect"
        >
          <pre className="max-h-[60vh] overflow-auto rounded-md bg-subtle p-3 font-mono text-xs text-fg select-text">
            {JSON.stringify(dialog.data, null, 2)}
          </pre>
        </Modal>
      )}
      {dialog?.kind === 'prune' && (
        <Modal
          title={
            dialog.what === 'containers'
              ? 'Remove stopped containers'
              : dialog.what === 'images'
                ? 'Remove dangling images'
                : `Remove unused ${dialog.what}`
          }
          onClose={() => {
            setDialog(null)
          }}
          testId="docker-prune-dialog"
          footer={
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  setDialog(null)
                }}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                data-testid="docker-prune-confirm"
                disabled={!dialog.preview || dialog.preview.items.length === 0}
                onClick={() => {
                  const what = dialog.what
                  setDialog(null)
                  void run('Clean up failed', () => request({ op: 'prune', what, dryRun: false }))
                }}
              >
                Remove {dialog.preview?.items.length ?? ''}
              </Button>
            </>
          }
        >
          {dialog.error ? (
            <Notice tone="danger">{dialog.error}</Notice>
          ) : !dialog.preview ? (
            <p className="text-xs text-faint">Checking what would be removed…</p>
          ) : dialog.preview.items.length === 0 ? (
            <p className="text-[13px] text-muted">Nothing to remove.</p>
          ) : (
            <div className="flex flex-col gap-2 text-[13px]">
              <p className="text-muted">
                These will be removed
                {dialog.preview.reclaimed ? ` (about ${formatSize(dialog.preview.reclaimed)})` : ''}
                :
              </p>
              <ul
                className="max-h-60 overflow-auto rounded-md bg-subtle p-2 font-mono text-xs text-fg"
                data-testid="docker-prune-list"
              >
                {dialog.preview.items.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            </div>
          )}
        </Modal>
      )}
      {dialog?.kind === 'pull' && (
        <PullDialog
          pull={pull}
          onClose={() => {
            setDialog(null)
            setPull(null)
            void load('images')
          }}
          onPull={(ref) => {
            request<{ subscription: string }>({ op: 'image.pull', ref }).then(
              (r) => {
                setPull({
                  subscription: r.subscription,
                  status: 'Starting…',
                  progress: null,
                  done: false
                })
              },
              (e: unknown) => {
                setPull({
                  subscription: '',
                  status: cleanError(e),
                  progress: null,
                  done: true,
                  error: cleanError(e)
                })
              }
            )
          }}
        />
      )}
      {dialog?.kind === 'rename' && (
        <RenameDialog
          container={dialog.container}
          onClose={() => {
            setDialog(null)
          }}
          onRename={(name) => {
            const id = dialog.container.id
            setDialog(null)
            void run('Rename failed', () => request({ op: 'rename', id, name }))
          }}
        />
      )}
      {menu}
    </div>
  )
}

function QuickButton({
  label,
  testId,
  disabled,
  onClick,
  children
}: {
  label: string
  testId: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-testid={testId}
      disabled={disabled}
      className="inline-flex size-6 items-center justify-center rounded text-faint hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-30"
      onClick={onClick}
    >
      {children}
    </button>
  )
}

/** Biểu đồ nhỏ (SVG) cho chuỗi giá trị 0…max. */
function Sparkline({ values, max }: { values: number[]; max: number }): React.JSX.Element {
  const w = 240
  const h = 36
  const top = Math.max(max, 1e-9)
  const points = values
    .map(
      (v, i) =>
        `${(i / Math.max(values.length - 1, 1)) * w},${h - (Math.min(v, top) / top) * (h - 2) - 1}`
    )
    .join(' ')
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="h-9 w-full text-accent"
      preserveAspectRatio="none"
      aria-hidden
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

function ContainerDetail({
  container: c,
  stats
}: {
  container: ContainerRow
  stats: StatsSample[]
}): React.JSX.Element {
  const last = stats.at(-1)
  return (
    <aside
      className="hidden w-72 shrink-0 flex-col gap-3 overflow-auto border-l border-line p-3 text-xs @3xl:flex"
      data-testid="docker-detail"
    >
      <div>
        <div className="truncate text-[13px] font-semibold text-fg">{c.name}</div>
        <div className={cx('font-medium', stateTone(c.state))}>{c.status}</div>
      </div>
      <dl className="grid grid-cols-[4.5rem_1fr] gap-x-2 gap-y-1 text-muted">
        <dt className="text-faint">Image</dt>
        <dd className="truncate" title={c.image}>
          {c.image}
        </dd>
        <dt className="text-faint">ID</dt>
        <dd className="truncate font-mono">{c.id.slice(0, 12)}</dd>
        {c.ports.length > 0 && (
          <>
            <dt className="text-faint">Ports</dt>
            <dd className="break-words">{portsText(c)}</dd>
          </>
        )}
        {c.project && (
          <>
            <dt className="text-faint">Compose</dt>
            <dd className="truncate">
              {c.project}
              {c.service ? ` / ${c.service}` : ''}
            </dd>
          </>
        )}
      </dl>
      {c.state === 'running' && (
        <div className="flex flex-col gap-2" data-testid="docker-stats">
          <div>
            <div className="flex justify-between text-faint">
              <span>CPU</span>
              <span className="text-muted tabular-nums">
                {last ? `${last.cpuPercent.toFixed(1)}%` : '…'}
              </span>
            </div>
            <Sparkline
              values={stats.map((s) => s.cpuPercent)}
              max={Math.max(100, ...stats.map((s) => s.cpuPercent))}
            />
          </div>
          <div>
            <div className="flex justify-between text-faint">
              <span>Memory</span>
              <span className="text-muted tabular-nums">
                {last
                  ? `${formatSize(last.memUsage)}${last.memLimit ? ` / ${formatSize(last.memLimit)}` : ''}`
                  : '…'}
              </span>
            </div>
            <Sparkline
              values={stats.map((s) => s.memUsage)}
              max={last?.memLimit || Math.max(...stats.map((s) => s.memUsage), 1)}
            />
          </div>
          {last && (
            <div className="flex justify-between text-faint">
              <span>Network</span>
              <span className="text-muted tabular-nums">
                ↓ {formatSize(last.netRx)} · ↑ {formatSize(last.netTx)}
              </span>
            </div>
          )}
        </div>
      )}
    </aside>
  )
}

function PullDialog({
  pull,
  onClose,
  onPull
}: {
  pull: { status: string; progress: number | null; done: boolean; error?: string } | null
  onClose: () => void
  onPull: (ref: string) => void
}): React.JSX.Element {
  const [ref, setRef] = useState('')
  const valid = /^[A-Za-z0-9][A-Za-z0-9_.:/@-]*$/.test(ref.trim())
  return (
    <Modal
      title="Pull an image"
      onClose={onClose}
      testId="docker-pull-dialog"
      footer={
        pull?.done ? (
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              data-testid="docker-pull-submit"
              disabled={!valid || pull !== null}
              onClick={() => {
                onPull(ref.trim())
              }}
            >
              Pull
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-3">
        <Input
          autoFocus
          mono
          placeholder="nginx:1.27 or ghcr.io/org/app:tag"
          data-testid="docker-pull-ref"
          value={ref}
          disabled={pull !== null}
          onChange={(e) => {
            setRef(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && valid && pull === null) onPull(ref.trim())
          }}
        />
        {pull && (
          <div className="flex flex-col gap-1.5" data-testid="docker-pull-progress">
            {pull.progress !== null && !pull.error && (
              <div className="h-1.5 overflow-hidden rounded-full bg-subtle">
                <div
                  className="h-full bg-accent-solid transition-[width]"
                  style={{ width: `${Math.round(pull.progress * 100)}%` }}
                />
              </div>
            )}
            <p className={cx('truncate text-xs', pull.error ? 'text-danger' : 'text-muted')}>
              {pull.status}
            </p>
          </div>
        )}
      </div>
    </Modal>
  )
}

function RenameDialog({
  container,
  onClose,
  onRename
}: {
  container: ContainerRow
  onClose: () => void
  onRename: (name: string) => void
}): React.JSX.Element {
  const [name, setName] = useState(container.name)
  const valid = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name) && name !== container.name
  return (
    <Modal
      title={`Rename ${container.name}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!valid}
            data-testid="docker-rename-submit"
            onClick={() => {
              onRename(name)
            }}
          >
            Rename
          </Button>
        </>
      }
    >
      <Input
        autoFocus
        mono
        value={name}
        data-testid="docker-rename-input"
        onChange={(e) => {
          setName(e.target.value)
        }}
      />
    </Modal>
  )
}
