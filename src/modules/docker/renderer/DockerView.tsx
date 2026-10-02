import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Boxes,
  Container,
  Copy,
  Download,
  Eye,
  FileText,
  HardDrive,
  LayoutDashboard,
  Layers,
  Network,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  Square,
  SquareTerminal,
  Terminal,
  Trash2,
  X,
  Zap
} from 'lucide-react'
import { Button, cx, Notice } from '../../../renderer/src/components/ui'
import { useContextMenu, type MenuEntry } from '../../../renderer/src/components/ContextMenu'
import { FileTable, type FileColumn } from '../../../renderer/src/components/files/FileTable'
import { Empty } from '../../../renderer/src/components/files/parts'
import { KeyHints, Pill, TONE_TEXT } from '../../../renderer/src/components/panels'
import type { SortState } from '../../../renderer/src/components/SortMenu'
import { cleanError, formatSize, nameOrder } from '../../../renderer/src/lib/format'
import { toast, ConnectionPrompt } from '../../registry/renderer-kit'
import type { ModuleTabProps } from '../../registry/renderer-types'
import type {
  ComposeAction,
  ContainerAction,
  ContainerRow,
  DockerEngineParams,
  DockerOp,
  EngineInfo,
  ImageRow,
  NetworkRow,
  PruneResult,
  PruneTarget,
  RunSpec,
  StatsSample,
  VolumeRow
} from '../shared/ops'
import { openLogs, openProjectLogs, openShell, publishHost } from './api'
import { ContainerDetail, ImageDetail, stateTone, type DetailAction } from './ContainerDetail'
import { DockerOverview } from './DockerOverview'
import {
  ExecDialog,
  InspectDialog,
  PruneDialog,
  PullDialog,
  RenameDialog,
  RunDialog
} from './dialogs'
import { useDockerSession } from './useDockerSession'

type Section = 'overview' | 'containers' | 'images' | 'volumes' | 'networks' | 'compose'
type StatusFilter = 'all' | 'running' | 'stopped'

const SECTIONS: { id: Section; label: string; icon: React.ReactNode }[] = [
  { id: 'overview', label: 'Overview', icon: <LayoutDashboard size={14} /> },
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
  // Quá vài tuần: tháng / năm ("2,210 days ago" khó đọc).
  if (abs < 86400 * 45) return relative.format(Math.round(s / 86400), 'day')
  if (abs < 86400 * 365) return relative.format(Math.round(s / (86400 * 30)), 'month')
  return relative.format(Math.round(s / (86400 * 365)), 'year')
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
  | { kind: 'exec'; container: ContainerRow }
  | { kind: 'run'; image: string }
  | null

type SectionData =
  | { section: 'containers'; data: ContainerRow[] }
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
      return {
        section: 'containers',
        data: await request<ContainerRow[]>({ op: 'containers', all: true })
      }
  }
}

const isTyping = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement &&
  (t.tagName === 'INPUT' ||
    t.tagName === 'TEXTAREA' ||
    t.tagName === 'SELECT' ||
    t.isContentEditable)

const keyOf = (e: KeyboardEvent): string =>
  `${e.ctrlKey || e.metaKey ? 'ctrl+' : ''}${e.ctrlKey || e.metaKey ? e.key.toLowerCase() : e.key}`

/** Tab Docker của một nguồn (máy này hoặc server qua SSH). */
export function DockerTab({
  tabId,
  params,
  active
}: ModuleTabProps<DockerEngineParams>): React.JSX.Element {
  const hostId = params.hostId
  const [section, setSection] = useState<Section>('containers')
  const [info, setInfo] = useState<EngineInfo | null>(null)
  const [containers, setContainers] = useState<ContainerRow[] | null>(null)
  const [images, setImages] = useState<ImageRow[] | null>(null)
  const [volumes, setVolumes] = useState<VolumeRow[] | null>(null)
  const [networks, setNetworks] = useState<NetworkRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [sort, setSort] = useState<SortState<'name' | 'created' | 'size' | 'cpu' | 'mem'>>({
    key: 'name',
    dir: 'asc'
  })
  const [dialog, setDialog] = useState<Dialog>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [pull, setPull] = useState<{
    subscription: string
    status: string
    progress: number | null
    done: boolean
    error?: string
  } | null>(null)
  /** CPU / RAM của mọi container đang chạy (3 giây một mẫu) + lịch sử ngắn cho biểu đồ. */
  const [samples, setSamples] = useState<Record<string, StatsSample[]>>({})
  const statsAllSub = useRef<string | null>(null)
  const reloadTimer = useRef<number | null>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
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
    } else if (event === 'statsAll' && d.subscription === statsAllSub.current) {
      const incoming = (data as { samples: Record<string, StatsSample> }).samples
      setSamples((prev) => {
        const next: Record<string, StatsSample[]> = {}
        for (const [id, sample] of Object.entries(incoming))
          next[id] = [...(prev[id] ?? []).slice(-39), sample]
        return next
      })
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
      if (section !== 'containers') void load('containers')
    }
  }, [load, section])

  /**
   * Đăng ký một luồng của phiên; trả hàm huỷ. Huỷ trước khi đăng ký xong vẫn bỏ đăng ký đúng (không
   * để lại luồng chạy mãi trong Session Host).
   */
  const subscribeOnce = useCallback(
    (op: 'events.subscribe' | 'statsAll.subscribe', onId?: (id: string | null) => void) => {
      let cancelled = false
      let sub: string | null = null
      void request<{ subscription: string }>({ op }).then(
        (r) => {
          if (cancelled) {
            void request({ op: 'unsubscribe', subscription: r.subscription }).catch(() => undefined)
            return
          }
          sub = r.subscription
          onId?.(sub)
        },
        () => undefined
      )
      return () => {
        cancelled = true
        onId?.(null)
        if (sub) void request({ op: 'unsubscribe', subscription: sub }).catch(() => undefined)
      }
    },
    [request]
  )

  // Kết nối xong: thông tin engine + theo dõi sự kiện (không cần poll).
  useEffect(() => {
    if (!ready) return
    void request<EngineInfo>({ op: 'info' }).then(setInfo, (e: unknown) => {
      setLoadError(cleanError(e))
    })
    return subscribeOnce('events.subscribe')
  }, [ready, request, subscribeOnce])

  // CPU / RAM mọi container — chỉ khi tab đang hiện (tab ẩn không tốn request).
  useEffect(() => {
    if (!ready || !active) return
    return subscribeOnce('statsAll.subscribe', (id) => {
      statsAllSub.current = id
    })
  }, [ready, active, subscribeOnce])

  useEffect(() => {
    if (!ready) return
    let cancelled = false
    const sections: Section[] =
      section === 'containers' || section === 'compose' || section === 'overview'
        ? ['containers']
        : [section, 'containers']
    for (const sec of sections)
      fetchSection(request, sec).then(
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
  }, [ready, section, request, apply, reloadKey])

  const run = async (label: string, fn: () => Promise<unknown>, done?: string): Promise<void> => {
    setBusy(true)
    try {
      await fn()
      if (done) toast.success(done)
    } catch (e) {
      toast.error(label, { description: cleanError(e) })
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
    void run(
      `Compose ${action} failed`,
      () => request({ op: 'compose', project: p.name, action }),
      `Compose ${action}: ${p.name}`
    )
  }

  const inspect = (
    kind: 'container' | 'image' | 'volume' | 'network',
    id: string,
    title: string
  ): void => {
    request({ op: 'inspect', kind, id }).then(
      (data) => {
        setDialog({ kind: 'inspect', title, data })
      },
      (e: unknown) => {
        toast.error(`Could not inspect ${title}`, { description: cleanError(e) })
      }
    )
  }

  // ——— Thao tác trên container (menu, phím tắt, thanh chi tiết) ———
  const containerActions = (c: ContainerRow): DetailAction[] => {
    const running = c.state === 'running'
    const out: DetailAction[] = [
      {
        id: 'logs',
        label: 'Logs',
        icon: <FileText size={14} />,
        key: 'l',
        run: () => openLogs(hostId, c)
      }
    ]
    if (running) {
      out.push(
        {
          id: 'shell',
          label: 'Shell',
          icon: <SquareTerminal size={14} />,
          key: 's',
          run: () => openShell(hostId, c)
        },
        {
          id: 'exec',
          label: 'Exec…',
          icon: <Terminal size={14} />,
          key: 'x',
          run: () => {
            setDialog({ kind: 'exec', container: c })
          }
        }
      )
    }
    out.push({
      id: 'inspect',
      label: 'Inspect',
      icon: <Search size={14} />,
      key: 'i',
      // Bảng chi tiết đã có tab Inspect → chỉ để trong menu.
      secondary: true,
      run: () => {
        inspect('container', c.id, c.name)
      }
    })
    // Chỉ trong menu (không thành nút chính của bảng chi tiết).
    out.push(
      {
        id: 'copy-name',
        label: 'Copy name',
        icon: <Copy size={14} />,
        secondary: true,
        run: () => void window.shellhouse.writeClipboard(c.name)
      },
      {
        id: 'copy-id',
        label: 'Copy ID',
        icon: <Copy size={14} />,
        secondary: true,
        run: () => void window.shellhouse.writeClipboard(c.id)
      }
    )
    if (readOnly) return out
    if (running)
      out.push(
        {
          id: 'restart',
          label: 'Restart',
          icon: <RotateCw size={14} />,
          key: 'r',
          run: () => {
            containerAction([c], 'restart')
          }
        },
        {
          id: 'stop',
          label: 'Stop',
          icon: <Square size={14} />,
          key: 't',
          run: () => {
            containerAction([c], 'stop')
          }
        },
        {
          id: 'pause',
          label: 'Pause',
          icon: <Pause size={14} />,
          key: 'p',
          run: () => {
            containerAction([c], 'pause')
          }
        }
      )
    else if (c.state === 'paused')
      out.push({
        id: 'unpause',
        label: 'Resume',
        icon: <Play size={14} />,
        key: 'p',
        run: () => {
          containerAction([c], 'unpause')
        }
      })
    else
      out.push({
        id: 'start',
        label: 'Start',
        icon: <Play size={14} />,
        key: 't',
        run: () => {
          containerAction([c], 'start')
        }
      })
    out.push(
      {
        id: 'rename',
        label: 'Rename…',
        icon: <Pencil size={14} />,
        run: () => {
          setDialog({ kind: 'rename', container: c })
        }
      },
      {
        id: 'run-like',
        label: 'Run another from this image…',
        icon: <Plus size={14} />,
        run: () => {
          setDialog({ kind: 'run', image: c.image })
        }
      }
    )
    if (running)
      out.push({
        id: 'kill',
        label: 'Kill',
        icon: <Zap size={14} />,
        key: 'ctrl+k',
        danger: true,
        run: () => {
          containerAction([c], 'kill')
        }
      })
    out.push({
      id: 'remove',
      label: 'Remove',
      icon: <Trash2 size={14} />,
      key: 'ctrl+d',
      danger: true,
      run: () => {
        containerAction([c], 'remove')
      }
    })
    return out
  }

  const toMenu = (actions: DetailAction[]): MenuEntry[] => {
    const out: MenuEntry[] = []
    let danger = false
    for (const a of actions) {
      if (a.danger && !danger && out.length) {
        out.push('separator')
        danger = true
      }
      out.push({
        id: a.id,
        label: a.label,
        icon: a.icon,
        ...(a.key ? { hint: a.key.replace('ctrl+', 'Ctrl+').toUpperCase() } : {}),
        ...(a.danger ? { danger: true } : {}),
        onSelect: () => {
          a.run()
        }
      })
    }
    return out
  }

  // ——— Danh sách ———
  const q = filter.trim().toLowerCase()
  const match = (...parts: (string | null | undefined)[]): boolean =>
    !q || parts.some((p) => p?.toLowerCase().includes(q))
  const sampleOf = (c: ContainerRow): StatsSample | undefined =>
    (samples[c.id] ?? samples[c.id.slice(0, 12)])?.at(-1)
  const sortList = <T,>(
    list: T[],
    name: (x: T) => string,
    created: (x: T) => number,
    extra?: { size?: (x: T) => number; cpu?: (x: T) => number; mem?: (x: T) => number }
  ): T[] => {
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...list].sort((a, b) => {
      if (sort.key === 'created') return (created(a) - created(b)) * dir
      const f =
        sort.key === 'size'
          ? extra?.size
          : sort.key === 'cpu'
            ? extra?.cpu
            : sort.key === 'mem'
              ? extra?.mem
              : undefined
      if (f) return (f(a) - f(b)) * dir
      return nameOrder.compare(name(a), name(b)) * dir
    })
  }
  const containerRows = sortList(
    (containers ?? []).filter(
      (c) =>
        match(c.name, c.image, c.project, c.state, portsText(c)) &&
        (status === 'all' || (status === 'running') === (c.state === 'running'))
    ),
    (c) => c.name,
    (c) => c.created,
    { cpu: (c) => sampleOf(c)?.cpuPercent ?? -1, mem: (c) => sampleOf(c)?.memUsage ?? -1 }
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
  const imageRows = sortList(
    (images ?? []).filter((i) => match(...i.tags, i.id)),
    imageName,
    (i) => i.created,
    { size: (i) => i.size }
  )

  const selectedContainers = containerRows.filter((c) => selected.has(c.name))
  const one =
    section === 'containers' && selectedContainers.length === 1 ? selectedContainers[0] : undefined
  const oneImage =
    section === 'images' && selected.size === 1
      ? imageRows.find((i) => selected.has(imageName(i)))
      : undefined

  // ——— Phím tắt (nghe ở window khi tab đang hiện; bảng vừa tải lại vẫn nhận phím) ———
  const onKey = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || isTyping(e.target) || dialog) return
    const k = keyOf(e)
    if (k === '/') {
      e.preventDefault()
      filterRef.current?.focus()
      return
    }
    if (k === '?') {
      setHelpOpen((o) => !o)
      return
    }
    if (k === 'Escape') {
      if (helpOpen) setHelpOpen(false)
      else if (selected.size) setSelected(new Set())
      else if (filter) setFilter('')
      return
    }
    if (one) {
      const a = containerActions(one).find((x) => x.key === k)
      if (a) {
        e.preventDefault()
        a.run()
      }
    }
  }
  const keyHandler = useRef(onKey)
  useEffect(() => {
    keyHandler.current = onKey
  })
  useEffect(() => {
    if (!active) return
    const listener = (e: KeyboardEvent): void => {
      const focused = document.activeElement
      if (focused && focused !== document.body && !rootRef.current?.contains(focused)) return
      keyHandler.current(e)
    }
    window.addEventListener('keydown', listener)
    return () => {
      window.removeEventListener('keydown', listener)
    }
  }, [active])

  const quick = (c: ContainerRow): React.JSX.Element => (
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
        <>
          {c.state === 'running' ? (
            <QuickButton
              label={`Stop ${c.name}`}
              testId="docker-row-stop"
              onClick={() => {
                containerAction([c], 'stop')
              }}
            >
              <Square size={12} />
            </QuickButton>
          ) : (
            <QuickButton
              label={`Start ${c.name}`}
              testId="docker-row-start"
              onClick={() => {
                containerAction([c], 'start')
              }}
            >
              <Play size={13} />
            </QuickButton>
          )}
          <QuickButton
            label={`Restart ${c.name}`}
            testId="docker-row-restart"
            onClick={() => {
              containerAction([c], 'restart')
            }}
          >
            <RotateCw size={13} />
          </QuickButton>
        </>
      )}
    </span>
  )

  const containerColumns: FileColumn<ContainerRow, 'name' | 'created' | 'size' | 'cpu' | 'mem'>[] =
    [
      {
        id: 'state',
        label: 'State',
        render: (c) => (
          <span title={c.status}>
            <Pill tone={stateTone(c.state)}>{c.state}</Pill>
          </span>
        )
      },
      {
        id: 'image',
        label: 'Image',
        className: 'hidden @3xl:block',
        render: (c) => <span title={c.image}>{c.image}</span>
      },
      {
        id: 'cpu',
        label: 'CPU',
        align: 'right',
        sort: { key: 'cpu', label: 'CPU', kind: 'number' },
        className: 'hidden @xl:block',
        render: (c) => {
          const s = sampleOf(c)
          return c.state === 'running' && s && s.cpuPercent >= 0
            ? `${s.cpuPercent.toFixed(1)}%`
            : '—'
        }
      },
      {
        id: 'mem',
        label: 'Memory',
        align: 'right',
        sort: { key: 'mem', label: 'Memory', kind: 'number' },
        className: 'hidden @xl:block',
        render: (c) => {
          const s = sampleOf(c)
          return c.state === 'running' && s ? formatSize(s.memUsage) : '—'
        }
      },
      { id: 'ports', label: 'Ports', className: 'hidden @4xl:block', render: (c) => portsText(c) },
      {
        id: 'created',
        label: 'Created',
        sort: { key: 'created', label: 'Created', kind: 'date' },
        className: 'hidden @2xl:block',
        render: (c) => ago(c.created)
      },
      { id: 'quick', label: '', align: 'right', render: quick }
    ]

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
    section === 'overview' || section === 'containers' || section === 'compose'
      ? containers
      : section === 'images'
        ? images
        : section === 'volumes'
          ? volumes
          : networks
  const runningCount = containers?.filter((c) => c.state === 'running').length ?? 0
  const counts: Partial<Record<Section, number>> = {
    containers: containers?.length,
    images: images?.length,
    volumes: volumes?.length,
    networks: networks?.length,
    compose: projects.length
  }
  const hints: (readonly [string, string])[] = [
    ['/', 'filter'],
    ...(section === 'containers' && one
      ? containerActions(one)
          .filter((a) => a.key && !a.danger)
          .slice(0, 3)
          .map((a) => [a.key ?? '', a.label.replace(/…$/, '').toLowerCase()] as const)
      : []),
    ['Esc', 'clear']
  ]
  const allKeys = [
    {
      title: 'Navigate',
      keys: [
        ['/', 'Filter the list'],
        ['↑ ↓', 'Move'],
        ['Enter', 'Logs of the container'],
        ['Ctrl+A', 'Select all'],
        ['Esc', 'Clear selection / filter']
      ] as const
    },
    {
      title: 'Selected container',
      keys: [
        ['l', 'Logs'],
        ['s', 'Open shell'],
        ['x', 'Exec a command'],
        ['i', 'Inspect'],
        ['r', 'Restart'],
        ['t', 'Start / stop'],
        ['p', 'Pause / resume'],
        ['Ctrl+K', 'Kill'],
        ['Ctrl+D', 'Remove']
      ] as const
    }
  ]

  return (
    <div
      ref={rootRef}
      className="relative flex h-full flex-col bg-surface"
      data-testid="docker-view"
      data-ready={ready && list !== null}
    >
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-44 shrink-0 flex-col gap-0.5 border-r border-line bg-subtle p-2">
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
              <span className="flex-1">{s.label}</span>
              {counts[s.id] !== undefined && (
                <span className="text-[11px] text-faint tabular-nums">{counts[s.id]}</span>
              )}
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
                <div className="mt-1">{params.label}</div>
              </>
            ) : (
              session.status
            )}
          </div>
        </nav>
        <div className="@container flex min-w-0 flex-1 flex-col">
          <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-line px-2">
            {section !== 'overview' && (
              <div className="flex h-8 w-40 min-w-24 shrink items-center gap-1.5 rounded-md border @2xl:w-60 border-line bg-subtle px-2">
                <Search size={13} className="text-faint" />
                <input
                  ref={filterRef}
                  type="search"
                  placeholder="Filter…  ( / )"
                  data-testid="docker-filter"
                  className="min-w-0 flex-1 bg-transparent text-xs text-fg outline-none placeholder:text-faint"
                  value={filter}
                  onChange={(e) => {
                    setFilter(e.target.value)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setFilter('')
                      e.currentTarget.blur()
                    }
                  }}
                />
              </div>
            )}
            {section === 'containers' && (
              <div
                role="radiogroup"
                className="inline-flex rounded-md border border-line bg-subtle p-0.5"
              >
                {(['all', 'running', 'stopped'] as const).map((st) => (
                  <button
                    key={st}
                    type="button"
                    role="radio"
                    aria-checked={status === st}
                    data-testid={`docker-status-${st}`}
                    className={cx(
                      'h-7 rounded px-2 text-xs font-medium whitespace-nowrap capitalize',
                      status === st ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg'
                    )}
                    onClick={() => {
                      setStatus(st)
                    }}
                  >
                    {st}
                    {st === 'running' && containers ? ` ${runningCount}` : ''}
                  </button>
                ))}
              </div>
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
            {!readOnly && (section === 'containers' || section === 'images') && (
              <Button
                size="sm"
                variant="primary"
                icon={<Play size={13} />}
                data-testid="docker-run"
                onClick={() => {
                  setDialog({ kind: 'run', image: oneImage ? imageName(oneImage) : '' })
                }}
              >
                Run
              </Button>
            )}
            {!readOnly && section === 'images' && (
              <Button
                size="sm"
                variant="ghost"
                icon={<Download size={13} />}
                data-testid="docker-pull"
                aria-label="Pull"
                onClick={() => {
                  setDialog({ kind: 'pull' })
                }}
              >
                <span className="hidden @2xl:inline">Pull</span>
              </Button>
            )}
            {!readOnly &&
              (section === 'containers' ||
                section === 'images' ||
                section === 'volumes' ||
                section === 'networks') && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Trash2 size={13} />}
                  data-testid="docker-prune"
                  title={
                    section === 'containers'
                      ? 'Remove stopped'
                      : section === 'images'
                        ? 'Remove dangling'
                        : 'Remove unused'
                  }
                  onClick={() => {
                    openPrune(section)
                  }}
                  aria-label="Clean up"
                >
                  <span className="hidden @3xl:inline">Clean up</span>
                </Button>
              )}
            <Button
              size="sm"
              variant="ghost"
              aria-label="Refresh"
              icon={<RefreshCw size={13} className={cx(busy && 'animate-spin')} />}
              data-testid="docker-refresh"
              onClick={() => {
                setReloadKey((n) => n + 1)
              }}
            />
          </div>
          {selectedContainers.length > 1 && section === 'containers' && !readOnly && (
            <div
              className="flex h-9 shrink-0 items-center gap-1 border-b border-line bg-accent-soft px-3 text-xs"
              data-testid="docker-bulk"
            >
              <span className="mr-2 font-medium text-fg">{selectedContainers.length} selected</span>
              <Button
                size="sm"
                variant="ghost"
                icon={<Play size={12} />}
                onClick={() => {
                  containerAction(selectedContainers, 'start')
                }}
              >
                Start
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon={<Square size={12} />}
                onClick={() => {
                  containerAction(
                    selectedContainers.filter((c) => c.state === 'running'),
                    'stop'
                  )
                }}
              >
                Stop
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon={<RotateCw size={12} />}
                data-testid="docker-bulk-restart"
                onClick={() => {
                  containerAction(selectedContainers, 'restart')
                }}
              >
                Restart
              </Button>
              <Button
                size="sm"
                variant="danger-ghost"
                icon={<Trash2 size={12} />}
                onClick={() => {
                  containerAction(selectedContainers, 'remove')
                }}
              >
                Remove
              </Button>
              <button
                type="button"
                aria-label="Clear selection"
                className="ml-auto text-faint hover:text-fg"
                onClick={() => {
                  setSelected(new Set())
                }}
              >
                <X size={13} />
              </button>
            </div>
          )}
          {loadError && (
            <div className="border-b border-line p-2">
              <Notice tone="danger" testId="docker-action-error">
                {loadError}
              </Notice>
            </div>
          )}
          {!ready || list === null ? (
            <div className="flex flex-1 items-center justify-center text-xs text-faint">
              {session.status}
            </div>
          ) : section === 'overview' ? (
            <DockerOverview
              info={info}
              containers={containers}
              request={request}
              readOnly={readOnly}
              reloadKey={reloadKey}
              onNavigate={(sec, f) => {
                setSection(sec)
                setSelected(new Set())
                if (sec === 'containers' && (f === 'running' || f === 'stopped')) setStatus(f)
              }}
              onPrune={openPrune}
            />
          ) : section === 'containers' ? (
            <FileTable
              items={containerRows}
              getKey={(c) => c.name}
              icon={(c) => <Container size={14} className={TONE_TEXT[stateTone(c.state)]} />}
              badge={(c) =>
                c.project ? (
                  <span className="shrink-0 rounded bg-subtle px-1 text-[10px] text-faint">
                    {c.project}
                  </span>
                ) : null
              }
              columns={containerColumns}
              gridClass="grid-cols-[minmax(9rem,2fr)_5.5rem_7rem] @xl:grid-cols-[minmax(9rem,2fr)_5.5rem_4.5rem_5rem_7rem] @2xl:grid-cols-[minmax(9rem,2fr)_5.5rem_4.5rem_5rem_6.5rem_7rem] @3xl:grid-cols-[minmax(9rem,2fr)_5.5rem_minmax(7rem,1.5fr)_4.5rem_5rem_6.5rem_7rem] @4xl:grid-cols-[minmax(9rem,2fr)_5.5rem_minmax(7rem,1.5fr)_4.5rem_5rem_minmax(6rem,1fr)_6.5rem_7rem]"
              nameSort={{ key: 'name', label: 'Name', kind: 'text' }}
              sort={sort}
              onSort={setSort}
              selected={selected}
              onSelect={setSelected}
              onOpen={(c) => openLogs(hostId, c)}
              onContextMenu={(e, items) => {
                const first = items[0]
                if (items.length === 1 && first) openMenu(e, toMenu(containerActions(first)))
                else if (items.length > 1 && !readOnly)
                  openMenu(e, [
                    {
                      id: 'start',
                      label: `Start ${items.length}`,
                      icon: <Play size={14} />,
                      onSelect: () => {
                        containerAction(items, 'start')
                      }
                    },
                    {
                      id: 'stop',
                      label: `Stop ${items.length}`,
                      icon: <Square size={14} />,
                      onSelect: () => {
                        containerAction(
                          items.filter((c) => c.state === 'running'),
                          'stop'
                        )
                      }
                    },
                    {
                      id: 'restart',
                      label: `Restart ${items.length}`,
                      icon: <RotateCw size={14} />,
                      onSelect: () => {
                        containerAction(items, 'restart')
                      }
                    },
                    'separator',
                    {
                      id: 'remove',
                      label: `Remove ${items.length}`,
                      icon: <Trash2 size={14} />,
                      danger: true,
                      onSelect: () => {
                        containerAction(items, 'remove')
                      }
                    }
                  ])
              }}
              ariaLabel="Containers"
              rowTestId="docker-container"
            >
              {containerRows.length === 0 && (
                <Empty
                  icon={<Container size={18} />}
                  title={q || status !== 'all' ? 'Nothing matches' : 'No containers'}
                  text={
                    q || status !== 'all'
                      ? 'Try another filter.'
                      : 'Run one from an image, or with docker compose.'
                  }
                  action={
                    q || status !== 'all' ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<X size={13} />}
                        onClick={() => {
                          setFilter('')
                          setStatus('all')
                        }}
                      >
                        Clear filter
                      </Button>
                    ) : !readOnly ? (
                      <Button
                        size="sm"
                        icon={<Play size={13} />}
                        onClick={() => {
                          setDialog({ kind: 'run', image: '' })
                        }}
                      >
                        Run a container
                      </Button>
                    ) : null
                  }
                />
              )}
            </FileTable>
          ) : section === 'images' ? (
            <FileTable
              items={imageRows}
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
                    i.containers ? (
                      <Pill tone="ok">{`${i.containers} container${i.containers > 1 ? 's' : ''}`}</Pill>
                    ) : (
                      <span className="text-faint">unused</span>
                    )
                }
              ]}
              gridClass="grid-cols-[minmax(10rem,2fr)_6rem] @lg:grid-cols-[minmax(10rem,2fr)_6rem_8rem] @xl:grid-cols-[minmax(10rem,2fr)_6rem_7rem_8rem]"
              nameSort={{ key: 'name', label: 'Name', kind: 'text' }}
              sort={sort}
              onSort={setSort}
              selected={selected}
              onSelect={setSelected}
              onOpen={(i) => {
                if (!readOnly) setDialog({ kind: 'run', image: imageName(i) })
              }}
              onContextMenu={(e, items) => {
                const first = items[0]
                openMenu(e, [
                  ...(items.length === 1 && first
                    ? [
                        ...(!readOnly
                          ? [
                              {
                                id: 'run',
                                label: 'Run…',
                                icon: <Play size={14} />,
                                onSelect: () => {
                                  setDialog({ kind: 'run', image: imageName(first) })
                                }
                              }
                            ]
                          : []),
                        {
                          id: 'inspect',
                          label: 'Inspect',
                          icon: <Search size={14} />,
                          onSelect: () => {
                            inspect('image', first.id, imageName(first))
                          }
                        }
                      ]
                    : []),
                  ...(readOnly
                    ? []
                    : [
                        'separator' as const,
                        {
                          id: 'rmi',
                          label:
                            items.length > 1 ? `Remove ${items.length} images` : 'Remove image',
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
                      ])
                ])
              }}
              ariaLabel="Images"
              rowTestId="docker-image"
            >
              {(images ?? []).length === 0 && (
                <Empty
                  icon={<Layers size={18} />}
                  title={q ? 'Nothing matches' : 'No images'}
                  text={
                    q
                      ? `Nothing matches “${filter}”.`
                      : 'Images appear here after you pull or build them, or run a container.'
                  }
                  action={
                    q ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<X size={13} />}
                        onClick={() => {
                          setFilter('')
                        }}
                      >
                        Clear filter
                      </Button>
                    ) : null
                  }
                />
              )}
            </FileTable>
          ) : section === 'volumes' ? (
            <FileTable
              items={sortList(
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
                },
                {
                  id: 'mount',
                  label: 'Mountpoint',
                  className: 'hidden @2xl:block',
                  render: (v) => <span className="font-mono">{v.mountpoint}</span>
                }
              ]}
              gridClass="grid-cols-[minmax(10rem,2fr)_6rem] @lg:grid-cols-[minmax(10rem,2fr)_6rem_8rem] @2xl:grid-cols-[minmax(10rem,2fr)_6rem_8rem_minmax(10rem,2fr)]"
              nameSort={{ key: 'name', label: 'Name', kind: 'text' }}
              sort={sort}
              onSort={setSort}
              selected={selected}
              onSelect={setSelected}
              onOpen={(v) => {
                inspect('volume', v.name, v.name)
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
            >
              {(volumes ?? []).length === 0 && (
                <Empty
                  icon={<HardDrive size={18} />}
                  title={q ? 'Nothing matches' : 'No volumes'}
                  text={
                    q
                      ? `Nothing matches “${filter}”.`
                      : 'Named volumes keep data when containers are removed.'
                  }
                  action={
                    q ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<X size={13} />}
                        onClick={() => {
                          setFilter('')
                        }}
                      >
                        Clear filter
                      </Button>
                    ) : null
                  }
                />
              )}
            </FileTable>
          ) : section === 'networks' ? (
            <FileTable
              items={sortList(
                (networks ?? []).filter((n) => match(n.name, n.driver)),
                (n) => n.name,
                () => 0
              )}
              getKey={(n) => n.name}
              icon={() => <Network size={14} className="text-muted" />}
              badge={(n) =>
                n.builtin ? (
                  <span className="rounded bg-subtle px-1 text-[10px] text-faint">built-in</span>
                ) : null
              }
              columns={[
                { id: 'driver', label: 'Driver', render: (n) => n.driver },
                {
                  id: 'scope',
                  label: 'Scope',
                  className: 'hidden @lg:block',
                  render: (n) => n.scope
                }
              ]}
              gridClass="grid-cols-[minmax(10rem,2fr)_6rem] @lg:grid-cols-[minmax(10rem,2fr)_6rem_6rem]"
              nameSort={{ key: 'name', label: 'Name', kind: 'text' }}
              sort={sort}
              onSort={setSort}
              selected={selected}
              onSelect={setSelected}
              onOpen={(n) => {
                inspect('network', n.id, n.name)
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
                            if (
                              window.confirm(`Remove ${removable.map((n) => n.name).join(', ')}?`)
                            )
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
            >
              {(networks ?? []).length === 0 && (
                <Empty
                  icon={<Network size={18} />}
                  title={q ? 'Nothing matches' : 'No networks'}
                  text={
                    q
                      ? `Nothing matches “${filter}”.`
                      : 'Networks connect containers to each other.'
                  }
                  action={
                    q ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<X size={13} />}
                        onClick={() => {
                          setFilter('')
                        }}
                      >
                        Clear filter
                      </Button>
                    ) : null
                  }
                />
              )}
            </FileTable>
          ) : (
            <div className="min-h-0 flex-1 overflow-auto p-3" data-testid="docker-compose">
              {projects.length === 0 ? (
                <Empty
                  icon={<Boxes size={18} />}
                  title="No Compose projects"
                  text="Containers started with docker compose are grouped here by project."
                  action={null}
                />
              ) : (
                <div className="grid gap-3 @3xl:grid-cols-2">
                  {projects.map((p) => (
                    <div
                      key={p.name}
                      className="rounded-lg border border-line"
                      data-testid="docker-project"
                      data-name={p.name}
                    >
                      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
                        <Boxes size={15} className="text-accent" />
                        <span className="flex-1 text-[13px] font-semibold text-fg">{p.name}</span>
                        <Pill
                          tone={
                            p.running === p.containers.length ? 'ok' : p.running ? 'warn' : 'muted'
                          }
                        >
                          {`${p.running}/${p.containers.length} running`}
                        </Pill>
                      </div>
                      <div className="divide-y divide-line">
                        {p.containers.map((c) => (
                          <div key={c.id} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                            <span
                              className={cx(
                                'size-1.5 shrink-0 rounded-full',
                                c.state === 'running' ? 'bg-success' : 'bg-line-strong'
                              )}
                            />
                            <span className="min-w-0 flex-1 truncate text-fg">
                              {c.service ?? c.name}
                            </span>
                            <span className="truncate text-faint">{portsText(c)}</span>
                            {quick(c)}
                          </div>
                        ))}
                      </div>
                      <div className="flex flex-wrap gap-1 border-t border-line px-2 py-1.5">
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<FileText size={12} />}
                          data-testid="docker-compose-logs"
                          onClick={() => openProjectLogs(hostId, p.name, p.containers)}
                        >
                          Logs
                        </Button>
                        {!readOnly &&
                          (['up', 'restart', 'stop', 'start', 'pull', 'down'] as const).map((a) => (
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
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        {one && (
          <ContainerDetail
            key={one.id}
            container={one}
            request={request}
            host={publishHost(hostId)}
            stats={samples[one.id] ?? samples[one.id.slice(0, 12)] ?? []}
            actions={containerActions(one)}
            onClose={() => {
              setSelected(new Set())
            }}
          />
        )}
        {oneImage && (
          <ImageDetail
            key={oneImage.id}
            title={imageName(oneImage)}
            id={oneImage.id}
            tags={oneImage.tags}
            size={oneImage.size}
            created={oneImage.created}
            request={request}
            actions={[
              ...(!readOnly
                ? [
                    {
                      id: 'run',
                      label: 'Run…',
                      icon: <Play size={14} />,
                      run: () => {
                        setDialog({ kind: 'run', image: imageName(oneImage) })
                      }
                    }
                  ]
                : []),
              {
                id: 'inspect',
                label: 'Inspect',
                icon: <Search size={14} />,
                run: () => {
                  inspect('image', oneImage.id, imageName(oneImage))
                }
              },
              ...(!readOnly
                ? [
                    {
                      id: 'remove',
                      label: 'Remove',
                      icon: <Trash2 size={14} />,
                      danger: true,
                      run: () => {
                        if (window.confirm(`Remove ${imageName(oneImage)}?`))
                          void run('Remove failed', () =>
                            request({ op: 'image.remove', id: oneImage.id })
                          )
                      }
                    }
                  ]
                : [])
            ]}
            onClose={() => {
              setSelected(new Set())
            }}
          />
        )}
      </div>
      <KeyHints items={hints} all={allKeys} open={helpOpen} onOpenChange={setHelpOpen} />
      {session.prompt && <ConnectionPrompt prompt={session.prompt} onAnswer={session.answer} />}
      {dialog?.kind === 'inspect' && (
        <InspectDialog
          title={dialog.title}
          data={dialog.data}
          onClose={() => {
            setDialog(null)
          }}
        />
      )}
      {dialog?.kind === 'prune' && (
        <PruneDialog
          what={dialog.what}
          preview={dialog.preview}
          error={dialog.error}
          onClose={() => {
            setDialog(null)
          }}
          onConfirm={() => {
            const what = dialog.what
            setDialog(null)
            void run(
              'Clean up failed',
              () => request({ op: 'prune', what, dryRun: false }),
              'Cleaned up'
            )
          }}
        />
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
      {dialog?.kind === 'exec' && (
        <ExecDialog
          container={dialog.container}
          onClose={() => {
            setDialog(null)
          }}
          onOpen={(command, user) => {
            const c = dialog.container
            setDialog(null)
            openShell(hostId, c, { command, user })
          }}
        />
      )}
      {dialog?.kind === 'run' && (
        <RunDialog
          image={dialog.image}
          onClose={() => {
            setDialog(null)
          }}
          onRun={async (spec: RunSpec) => {
            await request({ op: 'run', spec })
            setDialog(null)
            setSection('containers')
            toast.success(`Started ${spec.name || spec.image}`)
            void load('containers')
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
