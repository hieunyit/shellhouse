import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownToLine,
  Boxes,
  Container,
  Copy,
  Eye,
  FileText,
  FolderOpen,
  Hammer,
  HardDrive,
  KeyRound,
  LayoutDashboard,
  Layers,
  Network,
  Pause,
  Pencil,
  Play,
  Plug,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  Square,
  SquareTerminal,
  Tag,
  Terminal,
  Trash2,
  Upload,
  X,
  Zap
} from 'lucide-react'
import { Button, cx, Notice } from '../../../renderer/src/components/ui'
import { useContextMenu, type MenuEntry } from '../../../renderer/src/components/ContextMenu'
import { FileTable, type FileColumn } from '../../../renderer/src/components/files/FileTable'
import { Empty, ToolButton } from '../../../renderer/src/components/files/parts'
import { KeyHints, Pill, TONE_TEXT } from '../../../renderer/src/components/panels'
import type { SortState } from '../../../renderer/src/components/SortMenu'
import { cleanError } from '../../../renderer/src/lib/format'
import {
  ConnectionPrompt,
  formatBytes,
  formatDateTime,
  formatPercent,
  t,
  tn,
  toast
} from '../../registry/renderer-kit'
import type { ModuleTabProps } from '../../registry/renderer-types'
import { wslDistroOf } from '../shared/ipc'
import type {
  BuildSpec,
  ComposeAction,
  ContainerAction,
  ContainerRow,
  DockerEngineParams,
  DockerOp,
  EngineInfo,
  ImageRow,
  NetworkRow,
  NetworkSpec,
  PruneResult,
  PruneTarget,
  RunSpec,
  StatsSample,
  VolumeRow,
  VolumeSpec
} from '../shared/ops'
import { keyLabel, RowActions, toMenu, type DetailAction } from './actions'
import {
  BulkDialog,
  containerBulkLabel,
  containerPlan,
  imagePullPlan,
  imageRemovePlan,
  networkRemovePlan,
  RowCheck,
  SelectionBar,
  volumeRemovePlan,
  type BulkButton,
  type BulkPlan
} from './Bulk'
import { composeLabels, ComposeView } from './ComposeView'
import { dockerApi, openLogs, openProjectLogs, openShell, publishHost } from './api'
import {
  ContainerDetail,
  HealthPill,
  ImageDetail,
  stateLabel,
  stateTone,
  type DetailTab
} from './ContainerDetail'
import { DockerOverview } from './DockerOverview'
import {
  ConfirmDialog,
  ExecDialog,
  ImageTransferDialog,
  InspectDialog,
  PruneDialog,
  RenameDialog,
  RunDialog,
  type ConfirmRequest,
  type TransferProgress
} from './dialogs'
import {
  BuildDialog,
  ConnectNetworkDialog,
  CreateNetworkDialog,
  CreateVolumeDialog,
  RegistriesDialog,
  TagDialog
} from './ResourceDialogs'
import { registryFor } from '../shared/ipc'
import {
  CONTAINER_BULK,
  containerApplies,
  pullAndWait,
  toggleKey,
  type ContainerBulk
} from '../shared/bulk'
import { useDocker } from './store'
import { useDockerSession } from './useDockerSession'
import {
  ago,
  confirmFor,
  groupProjects,
  imageName,
  isUnhealthy,
  latestSample,
  matches,
  namesText,
  portsText,
  sortList as sortBy,
  type ComposeProject,
  type SortKey
} from '../shared/view-model'

type Section = 'overview' | 'containers' | 'images' | 'volumes' | 'networks' | 'compose'
type StatusFilter = 'all' | 'running' | 'stopped' | 'unhealthy'

const SECTION_ICONS: Record<Section, React.ReactNode> = {
  overview: <LayoutDashboard size={14} />,
  containers: <Container size={14} />,
  images: <Layers size={14} />,
  volumes: <HardDrive size={14} />,
  networks: <Network size={14} />,
  compose: <Boxes size={14} />
}

function sectionLabel(s: Section): string {
  switch (s) {
    case 'overview':
      return t('Overview')
    case 'containers':
      return t('Containers')
    case 'images':
      return t('Images')
    case 'volumes':
      return t('Volumes')
    case 'networks':
      return t('Networks')
    case 'compose':
      return t('Compose')
  }
}

const SECTIONS: readonly Section[] = [
  'overview',
  'containers',
  'images',
  'volumes',
  'networks',
  'compose'
]

type Dialog =
  | {
      kind: 'prune'
      what: PruneTarget
      /** Volume: cả volume có tên; image: mọi image không dùng. */
      all: boolean
      preview: PruneResult | null
      error: string | null
    }
  | { kind: 'confirm'; request: ConfirmRequest }
  | { kind: 'transfer'; mode: 'pull' | 'push'; ref: string; refs?: string[] }
  | { kind: 'rename'; container: ContainerRow }
  | { kind: 'inspect'; title: string; data: unknown }
  | { kind: 'exec'; container: ContainerRow }
  | { kind: 'run'; image: string }
  | { kind: 'volume' }
  | { kind: 'network' }
  | { kind: 'connect'; container?: ContainerRow; network?: NetworkRow }
  | { kind: 'tag'; image: ImageRow }
  | { kind: 'registries' }
  | { kind: 'build' }
  | { kind: 'bulk'; plan: BulkPlan }
  | null

interface TransferAttempt {
  subscription: string
  cancelled: boolean
  done: boolean
}

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

/** Đang gõ chữ (ô chọn / radio không tính — Esc, Ctrl+A vẫn dùng được sau khi bấm ô chọn). */
const isTyping = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement &&
  ((t instanceof HTMLInputElement && t.type !== 'checkbox' && t.type !== 'radio') ||
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
  const [sort, setSort] = useState<SortState<SortKey>>({
    key: 'name',
    dir: 'asc'
  })
  const [dialog, setDialog] = useState<Dialog>(null)
  const [detailTab, setDetailTab] = useState<DetailTab>('overview')
  const [helpOpen, setHelpOpen] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [transfer, setTransfer] = useState<(TransferProgress & { subscription: string }) | null>(
    null
  )
  const registries = useDocker((s) => s.registries)
  /** CPU / RAM của mọi container đang chạy (3 giây một mẫu) + lịch sử ngắn cho biểu đồ. */
  const [samples, setSamples] = useState<Record<string, StatsSample[]>>({})
  /** Lỗi lấy CPU / RAM (Session Host báo thay vì im lặng). */
  const [statsError, setStatsError] = useState<string | null>(null)
  const statsAllSub = useRef<string | null>(null)
  /** Lần kéo / đẩy image đang chạy (huỷ được kể cả trước khi có id đăng ký). */
  const transferRef = useRef<TransferAttempt | null>(null)
  const reloadTimer = useRef<number | null>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  /** Người nghe sự kiện phiên khác (build). */
  const [listeners] = useState(() => new Set<(event: string, data: unknown) => void>())
  const { menu, open: openMenu } = useContextMenu()

  const reload = useRef<() => void>(() => undefined)
  const onEvent = useCallback(
    (event: string, data: unknown) => {
      const d = data as { subscription?: string }
      for (const l of listeners) l(event, data)
      if (event === 'engine') {
        // Container đổi trạng thái → tải lại danh sách. Gộp sự kiện dồn dập (compose up: hàng chục sự
        // kiện) thành một lần tải mỗi 300 ms — không dời mãi khi sự kiện tới liên tục.
        if (reloadTimer.current !== null) return
        reloadTimer.current = window.setTimeout(() => {
          reloadTimer.current = null
          reload.current()
        }, 300)
      } else if (event === 'statsAll' && d.subscription === statsAllSub.current) {
        const { samples: incoming, error } = data as {
          samples: Record<string, StatsSample>
          error?: string
        }
        setStatsError(error ?? null)
        // Lỗi: giữ số liệu cũ (không vẽ lại cả bảng chỉ để xoá cột).
        if (error) return
        setSamples((prev) => {
          const next: Record<string, StatsSample[]> = {}
          for (const [id, sample] of Object.entries(incoming))
            next[id] = [...(prev[id] ?? []).slice(-39), sample]
          return next
        })
      } else if (event === 'pull' || event === 'push') {
        const attempt = transferRef.current
        if (attempt && attempt.subscription === d.subscription && (data as { done?: boolean }).done)
          attempt.done = true
        setTransfer((p) =>
          p && p.subscription === d.subscription ? { ...p, ...(data as object) } : p
        )
      }
    },
    [listeners]
  )
  const subscribeEvents = useCallback(
    (l: (event: string, data: unknown) => void) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    [listeners]
  )
  const session = useDockerSession(tabId, hostId, onEvent)
  const { request, ready, readOnly } = session
  useEffect(
    () => () => {
      if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current)
      reloadTimer.current = null
    },
    []
  )
  // Registry đã lưu (chọn sẵn khi pull / push); đổi ở nơi khác → store tự tải lại.
  useEffect(() => {
    void dockerApi.registries().then(
      (registries) => {
        useDocker.setState({ registries })
      },
      () => undefined
    )
  }, [])

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

  // CPU / RAM mọi container — chỉ khi tab đang hiện VÀ đang xem danh sách container (cột CPU /
  // RAM, bảng chi tiết). Mỗi lượt là một request stats cho từng container đang chạy → không hỏi
  // khi xem image / volume / Compose.
  const wantStats = ready && active && section === 'containers'
  useEffect(() => {
    if (!wantStats) return
    return subscribeOnce('statsAll.subscribe', (id) => {
      statsAllSub.current = id
      if (id === null) setStatsError(null)
    })
  }, [wantStats, subscribeOnce])

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

  /** Hỏi lại bằng hộp thoại của app (không dùng window.confirm). */
  const confirm = (request: ConfirmRequest): void => {
    setDialog({ kind: 'confirm', request })
  }

  /** Mốc cho Shift+bấm ô chọn (chọn một khoảng). */
  const checkAnchor = useRef<string | null>(null)
  const openBulk = (plan: BulkPlan): void => {
    setDialog({ kind: 'bulk', plan })
  }
  /** Bấm ô chọn của một dòng (Shift = cả khoảng từ lần bấm trước). */
  const toggleCheck = (keys: readonly string[], key: string, range: boolean): void => {
    setSelected(toggleKey(keys, selected, key, checkAnchor.current, range))
    checkAnchor.current = key
  }
  const copyNames = (names: readonly string[]): void => {
    void window.shellhouse.writeClipboard(names.join('\n')).then(() => {
      toast.success(tn(names.length, 'Copied {n} name', 'Copied {n} names'))
    })
  }

  const actionFailed = (action: ContainerAction): string => {
    switch (action) {
      case 'start':
        return t('Start failed')
      case 'stop':
        return t('Stop failed')
      case 'restart':
        return t('Restart failed')
      case 'pause':
        return t('Pause failed')
      case 'unpause':
        return t('Resume failed')
      case 'kill':
        return t('Kill failed')
      case 'remove':
        return t('Remove failed')
    }
  }

  const containerAction = (
    items: ContainerRow[],
    action: ContainerAction,
    viaShortcut = false
  ): void => {
    if (items.length === 0) return
    // Nhiều container: hộp thoại hàng loạt (tóm tắt, bỏ qua mục không áp dụng, kết quả từng mục).
    if (items.length > 1) {
      openBulk(containerPlan(action, items, request))
      return
    }
    const go = (volumes: boolean): void => {
      void run(actionFailed(action), () =>
        Promise.all(
          items.map((c) =>
            request({
              op: 'action',
              id: c.id,
              action,
              ...(action === 'remove'
                ? { force: c.state === 'running', ...(volumes ? { volumes: true } : {}) }
                : {})
            })
          )
        )
      )
    }
    const ask = confirmFor(action, items, viaShortcut)
    if (!ask) {
      go(false)
      return
    }
    confirm({
      title: ask.title,
      message: ask.message,
      confirmLabel: ask.confirmLabel,
      danger: ask.danger,
      ...(ask.volumesOption
        ? { option: { label: t('Also remove anonymous volumes of the container (docker rm -v)') } }
        : {}),
      onConfirm: go
    })
  }

  const loadPrunePreview = (what: PruneTarget, all: boolean): void => {
    setDialog({ kind: 'prune', what, all, preview: null, error: null })
    request<PruneResult>({ op: 'prune', what, dryRun: true, all }).then(
      (preview) => {
        setDialog((d) =>
          d?.kind === 'prune' && d.what === what && d.all === all ? { ...d, preview } : d
        )
      },
      (e: unknown) => {
        setDialog((d) =>
          d?.kind === 'prune' && d.what === what && d.all === all
            ? { ...d, error: cleanError(e) }
            : d
        )
      }
    )
  }
  const openPrune = (what: PruneTarget, all = false): void => {
    loadPrunePreview(what, all)
  }

  const compose = (p: ComposeProject, action: ComposeAction): void => {
    const label = composeLabels()[action].label
    const go = (): void => {
      void run(
        t('Compose {action} failed', { action: label }),
        () => request({ op: 'compose', project: p.name, action }),
        t('Compose {action}: {project}', { action: label, project: p.name })
      )
    }
    if (action !== 'down' && action !== 'stop') {
      go()
      return
    }
    confirm({
      title:
        action === 'down'
          ? t('Take down the Compose project {name}?', { name: p.name })
          : t('Stop the Compose project {name}?', { name: p.name }),
      message:
        action === 'down'
          ? t(
              'Every container of {name} is stopped and removed, with its networks (docker compose down). Volumes are kept.',
              { name: p.name }
            )
          : t('Every container of {name} is stopped.', { name: p.name }),
      confirmLabel: action === 'down' ? t('Take down') : t('Stop'),
      danger: action === 'down',
      onConfirm: go
    })
  }

  /** Xoá image / volume / network sau khi hỏi lại. */
  const confirmRemove = (
    kind: 'image' | 'volume' | 'network',
    names: string[],
    remove: () => Promise<unknown>
  ): void => {
    const plural = names.length > 1
    const list = namesText(names)
    confirm({
      title: plural
        ? kind === 'image'
          ? t('Remove {n} images?', { n: names.length })
          : kind === 'volume'
            ? t('Remove {n} volumes?', { n: names.length })
            : t('Remove {n} networks?', { n: names.length })
        : t('Remove {name}?', { name: names[0] ?? '' }),
      message:
        kind === 'volume'
          ? plural
            ? t('{names} are deleted with all the data in them. This cannot be undone.', {
                names: list
              })
            : t('{names} is deleted with all the data in it. This cannot be undone.', {
                names: list
              })
          : plural
            ? t('{names} are removed.', { names: list })
            : t('{names} is removed.', { names: list }),
      confirmLabel: t('Remove'),
      danger: true,
      onConfirm: () => {
        void run(t('Remove failed'), remove)
      }
    })
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
        toast.error(t('Could not inspect {name}', { name: title }), { description: cleanError(e) })
      }
    )
  }

  const copy = (text: string): void => {
    void window.shellhouse.writeClipboard(text)
    toast.success(t('Copied'))
  }

  const disconnect = (network: string, c: ContainerRow): void => {
    confirm({
      title: t('Disconnect {name} from {network}?', { name: c.name, network }),
      message: t('{name} can no longer reach the other containers on {network}.', {
        name: c.name,
        network
      }),
      confirmLabel: t('Disconnect'),
      danger: true,
      onConfirm: () => {
        void run(
          t('Disconnect failed'),
          () => request({ op: 'network.disconnect', network, container: c.id, force: false }),
          t('Disconnected {name} from {network}', { name: c.name, network })
        )
      }
    })
  }

  // ——— Thao tác trên container (menu, phím tắt, thanh chi tiết) ———
  /** `viaShortcut` = chạy bằng phím tắt một chữ (stop / restart hỏi lại). */
  const containerActions = (c: ContainerRow, viaShortcut = false): DetailAction[] => {
    const running = c.state === 'running'
    const out: DetailAction[] = [
      {
        id: 'logs',
        label: t('Logs'),
        icon: <FileText size={14} />,
        key: 'l',
        run: () => openLogs(hostId, c)
      }
    ]
    // Shell / exec chạy được mọi lệnh trong container → ẩn ở chế độ chỉ đọc (Session Host cũng chặn).
    if (running && !readOnly) {
      out.push(
        {
          id: 'shell',
          label: t('Shell'),
          icon: <SquareTerminal size={14} />,
          key: 's',
          run: () => openShell(hostId, c)
        },
        {
          id: 'exec',
          label: t('Exec…'),
          icon: <Terminal size={14} />,
          key: 'x',
          run: () => {
            setDialog({ kind: 'exec', container: c })
          }
        }
      )
    }
    out.push(
      {
        id: 'files',
        label: t('Files'),
        icon: <FolderOpen size={14} />,
        key: 'f',
        run: () => {
          setSelected(new Set([c.name]))
          setDetailTab('files')
        }
      },
      {
        id: 'inspect',
        label: t('Inspect'),
        icon: <Search size={14} />,
        key: 'i',
        // Bảng chi tiết đã có tab Inspect → chỉ để trong menu.
        secondary: true,
        run: () => {
          inspect('container', c.id, c.name)
        }
      },
      // Chỉ trong menu (không thành nút chính của bảng chi tiết).
      {
        id: 'copy-name',
        label: t('Copy name'),
        icon: <Copy size={14} />,
        secondary: true,
        run: () => {
          copy(c.name)
        }
      },
      {
        id: 'copy-id',
        label: t('Copy ID'),
        icon: <Copy size={14} />,
        secondary: true,
        run: () => {
          copy(c.id)
        }
      }
    )
    if (readOnly) return out
    if (running)
      out.push(
        {
          id: 'restart',
          label: t('Restart'),
          icon: <RotateCw size={14} />,
          key: 'r',
          run: () => {
            containerAction([c], 'restart', viaShortcut)
          }
        },
        {
          id: 'stop',
          label: t('Stop'),
          icon: <Square size={14} />,
          key: 't',
          run: () => {
            containerAction([c], 'stop', viaShortcut)
          }
        },
        {
          id: 'pause',
          label: t('Pause'),
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
        label: t('Resume'),
        icon: <Play size={14} />,
        key: 'p',
        run: () => {
          containerAction([c], 'unpause')
        }
      })
    else
      out.push({
        id: 'start',
        label: t('Start'),
        icon: <Play size={14} />,
        key: 't',
        run: () => {
          containerAction([c], 'start')
        }
      })
    out.push(
      {
        id: 'rename',
        label: t('Rename…'),
        icon: <Pencil size={14} />,
        key: 'F2',
        secondary: true,
        run: () => {
          setDialog({ kind: 'rename', container: c })
        }
      },
      {
        id: 'connect',
        label: t('Connect to a network…'),
        icon: <Plug size={14} />,
        secondary: true,
        run: () => {
          void load('networks')
          setDialog({ kind: 'connect', container: c })
        }
      },
      {
        id: 'run-like',
        label: t('Run another from this image…'),
        icon: <Plus size={14} />,
        secondary: true,
        run: () => {
          setDialog({ kind: 'run', image: c.image })
        }
      }
    )
    if (running)
      out.push({
        id: 'kill',
        label: t('Kill'),
        icon: <Zap size={14} />,
        key: 'ctrl+k',
        danger: true,
        run: () => {
          containerAction([c], 'kill')
        }
      })
    out.push({
      id: 'remove',
      label: t('Remove'),
      icon: <Trash2 size={14} />,
      key: 'ctrl+d',
      danger: true,
      run: () => {
        containerAction([c], 'remove')
      }
    })
    return out
  }

  const removeImages = (items: ImageRow[]): void => {
    if (items.length > 1) {
      openBulk(imageRemovePlan(items, request))
      return
    }
    confirmRemove('image', items.map(imageName), () =>
      Promise.all(items.map((i) => request({ op: 'image.remove', id: i.id })))
    )
  }

  const imageActions = (i: ImageRow): DetailAction[] => [
    ...(!readOnly
      ? [
          {
            id: 'run',
            label: t('Run…'),
            icon: <Play size={14} />,
            key: 'r',
            run: () => {
              setDialog({ kind: 'run', image: imageName(i) })
            }
          },
          {
            id: 'tag',
            label: t('Tag…'),
            icon: <Tag size={14} />,
            key: 't',
            run: () => {
              setDialog({ kind: 'tag', image: i })
            }
          },
          {
            id: 'push',
            label: t('Push…'),
            icon: <Upload size={14} />,
            key: 'u',
            disabled: i.tags.length === 0,
            run: () => {
              if (i.tags.length)
                setDialog({ kind: 'transfer', mode: 'push', ref: i.tags[0] ?? '', refs: i.tags })
            }
          }
        ]
      : []),
    {
      id: 'inspect',
      label: t('Inspect'),
      icon: <Search size={14} />,
      key: 'i',
      run: () => {
        inspect('image', i.id, imageName(i))
      }
    },
    {
      id: 'copy-id',
      label: t('Copy ID'),
      icon: <Copy size={14} />,
      secondary: true,
      run: () => {
        copy(i.id.replace(/^sha256:/, ''))
      }
    },
    ...(!readOnly
      ? [
          {
            id: 'remove',
            label: t('Remove'),
            icon: <Trash2 size={14} />,
            key: 'ctrl+d',
            danger: true,
            run: () => {
              removeImages([i])
            }
          }
        ]
      : [])
  ]

  const removeVolumes = (items: VolumeRow[]): void => {
    if (items.length > 1) {
      openBulk(volumeRemovePlan(items, request))
      return
    }
    confirmRemove(
      'volume',
      items.map((v) => v.name),
      () => Promise.all(items.map((v) => request({ op: 'volume.remove', name: v.name })))
    )
  }

  const volumeActions = (v: VolumeRow): DetailAction[] => [
    {
      id: 'inspect',
      label: t('Inspect'),
      icon: <Search size={14} />,
      key: 'i',
      run: () => {
        inspect('volume', v.name, v.name)
      }
    },
    {
      id: 'copy-name',
      label: t('Copy name'),
      icon: <Copy size={14} />,
      secondary: true,
      run: () => {
        copy(v.name)
      }
    },
    ...(!readOnly
      ? [
          {
            id: 'remove',
            label: t('Remove'),
            icon: <Trash2 size={14} />,
            key: 'ctrl+d',
            danger: true,
            run: () => {
              removeVolumes([v])
            }
          }
        ]
      : [])
  ]

  const removeNetworks = (items: NetworkRow[]): void => {
    if (items.length > 1) {
      openBulk(networkRemovePlan(items, request))
      return
    }
    const removable = items.filter((n) => !n.builtin)
    if (removable.length === 0) return
    confirmRemove(
      'network',
      removable.map((n) => n.name),
      () => Promise.all(removable.map((n) => request({ op: 'network.remove', id: n.id })))
    )
  }

  const networkActions = (n: NetworkRow): DetailAction[] => [
    {
      id: 'inspect',
      label: t('Inspect'),
      icon: <Search size={14} />,
      key: 'i',
      run: () => {
        inspect('network', n.id, n.name)
      }
    },
    ...(!readOnly && n.name !== 'host' && n.name !== 'none'
      ? [
          {
            id: 'connect',
            label: t('Connect a container…'),
            icon: <Plug size={14} />,
            key: 'c',
            run: () => {
              setDialog({ kind: 'connect', network: n })
            }
          }
        ]
      : []),
    {
      id: 'copy-name',
      label: t('Copy name'),
      icon: <Copy size={14} />,
      secondary: true,
      run: () => {
        copy(n.name)
      }
    },
    ...(!readOnly && !n.builtin
      ? [
          {
            id: 'remove',
            label: t('Remove'),
            icon: <Trash2 size={14} />,
            key: 'ctrl+d',
            danger: true,
            run: () => {
              removeNetworks([n])
            }
          }
        ]
      : [])
  ]

  // ——— Danh sách (memo: mẫu CPU / RAM tới mỗi 3 giây không lọc + sắp xếp lại mọi thứ) ———
  const q = filter.trim().toLowerCase()
  const sampleOf = (c: ContainerRow): StatsSample | undefined => latestSample(samples, c.id)
  // Mẫu stats chỉ ảnh hưởng thứ tự khi sắp theo CPU / RAM.
  const sortSamples = sort.key === 'cpu' || sort.key === 'mem' ? samples : null
  const containerRows = useMemo(
    () =>
      sortBy(
        (containers ?? []).filter(
          (c) =>
            matches(q, c.name, c.image, c.project, c.state, c.health, portsText(c)) &&
            (status === 'all' ||
              (status === 'unhealthy'
                ? c.health === 'unhealthy' || c.state === 'restarting' || c.state === 'dead'
                : (status === 'running') === (c.state === 'running')))
        ),
        sort,
        (c) => c.name,
        (c) => c.created,
        {
          cpu: (c) => (sortSamples ? latestSample(sortSamples, c.id)?.cpuPercent : undefined) ?? -1,
          mem: (c) => (sortSamples ? latestSample(sortSamples, c.id)?.memUsage : undefined) ?? -1
        }
      ),
    [containers, q, status, sort, sortSamples]
  )
  const projects = useMemo(() => groupProjects(containers ?? [], q), [containers, q])
  const allProjects = useMemo(
    () => new Set((containers ?? []).map((c) => c.project).filter(Boolean)).size,
    [containers]
  )
  const imageRows = useMemo(
    () =>
      sortBy(
        (images ?? []).filter((i) => matches(q, ...i.tags, i.id)),
        sort,
        imageName,
        (i) => i.created,
        { size: (i) => i.size }
      ),
    [images, q, sort]
  )
  const volumeRows = useMemo(
    () =>
      sortBy(
        (volumes ?? []).filter((v) => matches(q, v.name, v.project, v.driver)),
        sort,
        (v) => v.name,
        (v) => v.created ?? 0
      ),
    [volumes, q, sort]
  )
  const networkRows = useMemo(
    () =>
      sortBy(
        (networks ?? []).filter((n) => matches(q, n.name, n.driver)),
        sort,
        (n) => n.name,
        () => 0
      ),
    [networks, q, sort]
  )

  const selectedContainers = containerRows.filter((c) => selected.has(c.name))
  const one =
    section === 'containers' && selectedContainers.length === 1 ? selectedContainers[0] : undefined
  const oneImage =
    section === 'images' && selected.size === 1
      ? imageRows.find((i) => selected.has(imageName(i)))
      : undefined
  const oneVolume =
    section === 'volumes' && selected.size === 1
      ? volumeRows.find((v) => selected.has(v.name))
      : undefined
  const oneNetwork =
    section === 'networks' && selected.size === 1
      ? networkRows.find((n) => selected.has(n.name))
      : undefined
  const selectedActions: DetailAction[] | null = one
    ? containerActions(one, true)
    : oneImage
      ? imageActions(oneImage)
      : oneVolume
        ? volumeActions(oneVolume)
        : oneNetwork
          ? networkActions(oneNetwork)
          : null

  // ——— Chọn nhiều dòng → thao tác hàng loạt ———
  const visibleKeys: string[] | null =
    section === 'containers'
      ? containerRows.map((c) => c.name)
      : section === 'images'
        ? imageRows.map(imageName)
        : section === 'volumes'
          ? volumeRows.map((v) => v.name)
          : section === 'networks'
            ? networkRows.map((n) => n.name)
            : null
  const selectedImages = imageRows.filter((i) => selected.has(imageName(i)))
  const selectedVolumes = volumeRows.filter((v) => selected.has(v.name))
  const selectedNetworks = networkRows.filter((n) => selected.has(n.name))
  /** Kéo bản mới của một tag (đăng nhập registry đã lưu khớp host của tag). */
  const pullLatest = useCallback(
    (ref: string): Promise<void> =>
      pullAndWait(request, subscribeEvents, ref, registryFor(ref, registries)?.id ?? null),
    [request, subscribeEvents, registries]
  )
  const BULK_ICONS: Record<ContainerBulk, React.ReactNode> = {
    start: <Play size={12} />,
    stop: <Square size={12} />,
    restart: <RotateCw size={12} />,
    pause: <Pause size={12} />,
    unpause: <Play size={12} />,
    kill: <Zap size={12} />,
    remove: <Trash2 size={12} />
  }
  const copyButton = (names: readonly string[]): BulkButton => ({
    id: 'copy',
    label: t('Copy names'),
    icon: <Copy size={12} />,
    onClick: () => {
      copyNames(names)
    }
  })
  const containerBulkButtons = (items: readonly ContainerRow[]): BulkButton[] => [
    ...(readOnly
      ? []
      : CONTAINER_BULK.map((kind): BulkButton => {
          const n = items.filter((c) => containerApplies(kind, c)).length
          return {
            id: kind,
            label: containerBulkLabel(kind),
            icon: BULK_ICONS[kind],
            danger: kind === 'kill' || kind === 'remove',
            disabled: n === 0,
            title: tn(n, 'Applies to {n} selected container', 'Applies to {n} selected containers'),
            onClick: () => {
              openBulk(containerPlan(kind, items, request))
            }
          }
        })),
    copyButton(items.map((c) => c.name))
  ]
  const imageBulkButtons = (items: readonly ImageRow[]): BulkButton[] => [
    ...(readOnly
      ? []
      : [
          {
            id: 'pull',
            label: t('Pull latest'),
            icon: <ArrowDownToLine size={12} />,
            disabled: items.every((i) => i.tags.length === 0),
            title: t('Pull the newest version of every tag'),
            onClick: () => {
              openBulk(imagePullPlan(items, pullLatest))
            }
          },
          {
            id: 'remove',
            label: t('Remove'),
            icon: <Trash2 size={12} />,
            danger: true,
            onClick: () => {
              openBulk(imageRemovePlan(items, request))
            }
          }
        ]),
    copyButton(items.map(imageName))
  ]
  const volumeBulkButtons = (items: readonly VolumeRow[]): BulkButton[] => [
    ...(readOnly
      ? []
      : [
          {
            id: 'remove',
            label: t('Remove'),
            icon: <Trash2 size={12} />,
            danger: true,
            onClick: () => {
              openBulk(volumeRemovePlan(items, request))
            }
          }
        ]),
    copyButton(items.map((v) => v.name))
  ]
  const networkBulkButtons = (items: readonly NetworkRow[]): BulkButton[] => [
    ...(readOnly
      ? []
      : [
          {
            id: 'remove',
            label: t('Remove'),
            icon: <Trash2 size={12} />,
            danger: true,
            disabled: items.every((n) => n.builtin),
            onClick: () => {
              openBulk(networkRemovePlan(items, request))
            }
          }
        ]),
    copyButton(items.map((n) => n.name))
  ]
  /** Menu chuột phải khi chọn nhiều dòng = các nút của thanh hàng loạt. */
  const bulkMenu = (buttons: readonly BulkButton[]): MenuEntry[] => {
    const out: MenuEntry[] = []
    let danger = false
    for (const b of buttons) {
      if (b.danger && !danger && out.length) {
        out.push('separator')
        danger = true
      }
      if (!b.danger && danger) out.push('separator')
      out.push({
        id: b.id,
        label: b.label,
        icon: b.icon,
        ...(b.danger ? { danger: true } : {}),
        ...(b.disabled ? { disabled: true } : {}),
        onSelect: b.onClick
      })
      if (!b.danger) danger = false
    }
    return out
  }
  const selectionBar = (
    noun: 'container' | 'image' | 'volume' | 'network',
    total: number,
    actions: BulkButton[]
  ): React.JSX.Element => (
    <SelectionBar
      keys={visibleKeys ?? []}
      selected={selected}
      total={total}
      noun={noun}
      actions={actions}
      onSelect={(keys) => {
        checkAnchor.current = null
        setSelected(keys)
      }}
      onClear={() => {
        setSelected(new Set())
      }}
    />
  )

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
    // Ctrl/Cmd+A khi không gõ chữ: chọn mọi dòng đang hiện (bảng có focus tự xử lý trước).
    if (k === 'ctrl+a' && visibleKeys) {
      e.preventDefault()
      setSelected(new Set(visibleKeys))
      return
    }
    if (selectedActions) {
      const a = selectedActions.find((x) => x.key === k && !x.disabled)
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

  /** Nút nhanh trên dòng container (cùng thao tác với menu; chú thích có phím tắt). */
  const quick = (c: ContainerRow): React.JSX.Element => {
    const actions = containerActions(c)
    const pick = (id: string): DetailAction | undefined => actions.find((a) => a.id === id)
    const shell = pick('shell')
    const startStop = pick('stop') ?? pick('start') ?? pick('unpause')
    const quickList = [
      pick('logs'),
      readOnly
        ? undefined
        : (shell ?? {
            id: 'shell',
            label: t('Shell'),
            icon: <SquareTerminal size={14} />,
            disabled: true,
            run: () => undefined
          }),
      startStop,
      pick('restart')
    ].filter((a): a is DetailAction => Boolean(a))
    return (
      <RowActions
        name={c.name}
        quick={quickList.map((a) => ({
          ...a,
          icon:
            a.id === 'stop' ? (
              <Square size={12} />
            ) : a.id === 'start' || a.id === 'unpause' ? (
              <Play size={13} />
            ) : a.id === 'restart' ? (
              <RotateCw size={13} />
            ) : a.id === 'logs' ? (
              <FileText size={13} />
            ) : (
              <SquareTerminal size={13} />
            ),
          testId: `docker-row-${a.id === 'unpause' ? 'start' : a.id}`
        }))}
        all={actions}
        openMenu={openMenu}
        testIdPrefix="docker-row"
      />
    )
  }

  const containerColumns: FileColumn<ContainerRow, 'name' | 'created' | 'size' | 'cpu' | 'mem'>[] =
    [
      {
        id: 'state',
        label: t('State'),
        render: (c) => (
          // Container có healthcheck đang chạy: chip health (khoẻ ⇒ đang chạy); chú thích đủ cả hai.
          <span title={c.status} className="inline-flex items-center gap-1">
            {c.state === 'running' && c.health ? (
              <HealthPill health={c.health} />
            ) : (
              <Pill tone={stateTone(c.state)}>{stateLabel(c.state)}</Pill>
            )}
          </span>
        )
      },
      {
        id: 'image',
        label: t('Image'),
        className: 'hidden @3xl:block',
        render: (c) => <span title={c.image}>{c.image}</span>
      },
      {
        id: 'cpu',
        label: t('CPU'),
        align: 'right',
        sort: { key: 'cpu', label: t('CPU'), kind: 'number' },
        className: 'hidden @xl:block',
        render: (c) => {
          const s = sampleOf(c)
          return c.state === 'running' && s && s.cpuPercent >= 0
            ? formatPercent(s.cpuPercent / 100, 1)
            : '—'
        }
      },
      {
        id: 'mem',
        label: t('Memory'),
        align: 'right',
        sort: { key: 'mem', label: t('Memory'), kind: 'number' },
        className: 'hidden @xl:block',
        render: (c) => {
          const s = sampleOf(c)
          return c.state === 'running' && s ? formatBytes(s.memUsage) : '—'
        }
      },
      {
        id: 'ports',
        label: t('Ports'),
        className: 'hidden @4xl:block',
        render: (c) => portsText(c)
      },
      {
        id: 'created',
        label: t('Created'),
        sort: { key: 'created', label: t('Created'), kind: 'date' },
        className: 'hidden @2xl:block',
        render: (c) => <span title={formatDateTime(c.created)}>{ago(c.created)}</span>
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
          <p className="text-sm text-fg" data-testid="docker-error" role="alert">
            {session.error}
          </p>
          <Button size="sm" icon={<RefreshCw size={13} />} onClick={session.retry}>
            {t('Try again')}
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
  const unhealthyCount = containers?.filter(isUnhealthy).length ?? 0
  const counts: Partial<Record<Section, number>> = {
    containers: containers?.length,
    images: images?.length,
    volumes: volumes?.length,
    networks: networks?.length,
    compose: projects.length
  }
  const hints: (readonly [string, string])[] = [
    ['/', t('filter')],
    ...(selectedActions
      ? selectedActions
          .filter((a) => a.key && !a.danger && !a.disabled)
          .slice(0, 3)
          .map((a) => [keyLabel(a.key ?? ''), a.label.replace(/…$/, '').toLowerCase()] as const)
      : []),
    ['Esc', t('clear')]
  ]
  const allKeys = [
    {
      title: t('Navigate'),
      keys: [
        ['/', t('Filter the list')],
        ['↑ ↓', t('Move')],
        ['Enter', t('Logs of the container')],
        ['Ctrl+A', t('Select all')],
        ['Del', t('Remove the selection')],
        ['Esc', t('Clear selection / filter')]
      ] as const
    },
    {
      title: t('Selected container'),
      keys: [
        ['L', t('Logs')],
        ['S', t('Open shell')],
        ['X', t('Exec a command')],
        ['F', t('Browse files')],
        ['I', t('Inspect')],
        ['R', t('Restart')],
        ['T', t('Start / stop')],
        ['P', t('Pause / resume')],
        ['Ctrl+K', t('Kill')],
        ['Ctrl+D', t('Remove')]
      ] as const
    },
    {
      title: t('Selected image'),
      keys: [
        ['R', t('Run…')],
        ['T', t('Tag…')],
        ['U', t('Push…')],
        ['I', t('Inspect')]
      ] as const
    }
  ]

  const clearFilterButton = (
    <Button
      size="sm"
      variant="ghost"
      icon={<X size={13} />}
      onClick={() => {
        setFilter('')
        setStatus('all')
      }}
    >
      {t('Clear filter')}
    </Button>
  )
  const where = !hostId ? 'local' : wslDistroOf(hostId) ? 'wsl' : 'ssh'

  const startTransfer = (mode: 'pull' | 'push', ref: string, registry: string | null): void => {
    // Bấm đúp / Enter hai lần: chỉ một lượt (trạng thái đặt ngay, trước khi có id).
    if (transferRef.current) return
    const attempt: TransferAttempt = { subscription: '', cancelled: false, done: false }
    transferRef.current = attempt
    setTransfer({ subscription: '', status: t('Starting…'), progress: null, done: false })
    request<{ subscription: string }>({
      op: mode === 'pull' ? 'image.pull' : 'image.push',
      ref,
      registry
    }).then(
      (r) => {
        attempt.subscription = r.subscription
        if (attempt.cancelled) {
          void request({ op: 'unsubscribe', subscription: r.subscription }).catch(() => undefined)
          return
        }
        setTransfer((p) => (p ? { ...p, subscription: r.subscription } : p))
      },
      (e: unknown) => {
        attempt.done = true
        if (attempt.cancelled) return
        setTransfer({
          subscription: '',
          status: cleanError(e),
          progress: null,
          done: true,
          error: cleanError(e)
        })
      }
    )
  }

  const toolbar = (
    <>
      {readOnly && (
        <span
          className="flex items-center gap-1 rounded bg-warning-soft px-1.5 py-px text-xs font-medium text-warning"
          data-testid="docker-read-only"
          title={t('Actions that change something are hidden')}
        >
          <Eye size={12} /> {t('Read-only')}
        </span>
      )}
      {!readOnly && (section === 'containers' || section === 'images') && (
        <ToolButton
          primary
          icon={<Play size={13} />}
          label={t('Run')}
          title={t('Run a container (like docker run -d)')}
          labelAt="md"
          testId="docker-run"
          onClick={() => {
            setDialog({ kind: 'run', image: oneImage ? imageName(oneImage) : '' })
          }}
        />
      )}
      {!readOnly && section === 'volumes' && (
        <ToolButton
          primary
          icon={<Plus size={13} />}
          label={t('New volume')}
          labelAt="md"
          testId="docker-new-volume"
          onClick={() => {
            setDialog({ kind: 'volume' })
          }}
        />
      )}
      {!readOnly && section === 'networks' && (
        <ToolButton
          primary
          icon={<Plus size={13} />}
          label={t('New network')}
          labelAt="md"
          testId="docker-new-network"
          onClick={() => {
            setDialog({ kind: 'network' })
          }}
        />
      )}
      {!readOnly && section === 'images' && (
        <>
          <ToolButton
            icon={<ArrowDownToLine size={13} />}
            label={t('Pull')}
            title={t('Pull an image from a registry')}
            labelAt="2xl"
            testId="docker-pull"
            onClick={() => {
              setDialog({ kind: 'transfer', mode: 'pull', ref: '' })
            }}
          />
          <ToolButton
            icon={<Hammer size={13} />}
            label={t('Build')}
            title={t('Build an image from a Dockerfile')}
            labelAt="2xl"
            testId="docker-build"
            onClick={() => {
              setDialog({ kind: 'build' })
            }}
          />
          <ToolButton
            icon={<KeyRound size={13} />}
            label={t('Registries')}
            title={t('Logins for private registries')}
            labelAt="4xl"
            testId="docker-registries-open"
            onClick={() => {
              setDialog({ kind: 'registries' })
            }}
          />
        </>
      )}
      {!readOnly &&
        (section === 'containers' ||
          section === 'images' ||
          section === 'volumes' ||
          section === 'networks') && (
          <ToolButton
            icon={<Trash2 size={13} />}
            label={t('Clean up')}
            title={
              section === 'containers'
                ? t('Remove stopped containers')
                : section === 'images'
                  ? t('Remove dangling images')
                  : section === 'volumes'
                    ? t('Remove unused anonymous volumes')
                    : t('Remove unused networks')
            }
            labelAt="3xl"
            testId="docker-prune"
            onClick={() => {
              openPrune(section)
            }}
          />
        )}
      <ToolButton
        icon={<RefreshCw size={13} className={cx(busy && 'animate-spin')} />}
        label={t('Refresh')}
        labelAt="5xl"
        testId="docker-refresh"
        onClick={() => {
          setReloadKey((n) => n + 1)
        }}
      />
    </>
  )

  const emptyText = (
    filtered: boolean,
    icon: React.ReactNode,
    title: string,
    text: string,
    action: React.ReactNode
  ): React.JSX.Element => (
    <Empty
      icon={icon}
      title={filtered ? t('Nothing matches') : title}
      text={filtered ? t('Nothing matches “{filter}”.', { filter }) : text}
      action={filtered ? clearFilterButton : action}
    />
  )

  return (
    <div
      ref={rootRef}
      className="relative flex h-full flex-col bg-surface"
      data-testid="docker-view"
      data-ready={ready && list !== null}
    >
      <div className="flex min-h-0 flex-1">
        <nav
          className="flex w-44 shrink-0 flex-col gap-0.5 border-r border-line bg-subtle p-2"
          aria-label={t('Docker sections')}
        >
          {SECTIONS.map((s) => (
            <button
              key={s}
              type="button"
              data-testid={`docker-nav-${s}`}
              aria-current={section === s}
              className={cx(
                'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px]',
                section === s
                  ? 'bg-surface font-medium text-fg shadow-sm'
                  : 'text-muted hover:bg-hover hover:text-fg'
              )}
              onClick={() => {
                setSection(s)
                setFilter('')
                setSelected(new Set())
              }}
            >
              {SECTION_ICONS[s]}
              <span className="flex-1">{sectionLabel(s)}</span>
              {counts[s] !== undefined && (
                <span className="text-[11px] text-faint tabular-nums">{counts[s]}</span>
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
                {info.via === 'cli' && <div>{t('via docker CLI')}</div>}
                <div className="mt-1">{params.label}</div>
                {statsError && (
                  <div
                    className="mt-1 text-warning"
                    title={statsError}
                    data-testid="docker-stats-error"
                  >
                    {t('CPU / memory unavailable')}
                  </div>
                )}
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
                  aria-label={t('Filter')}
                  placeholder={t('Filter…  ( / )')}
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
                aria-label={t('Show')}
                className="inline-flex rounded-md border border-line bg-subtle p-0.5"
              >
                {(['all', 'running', 'stopped', 'unhealthy'] as const)
                  .filter((st) => st !== 'unhealthy' || unhealthyCount > 0 || status === st)
                  .map((st) => (
                    <button
                      key={st}
                      type="button"
                      role="radio"
                      aria-checked={status === st}
                      data-testid={`docker-status-${st}`}
                      className={cx(
                        'h-7 rounded px-2 text-xs font-medium whitespace-nowrap',
                        status === st ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg',
                        st === 'unhealthy' && status !== st && 'text-danger'
                      )}
                      onClick={() => {
                        setStatus(st)
                      }}
                    >
                      {st === 'all'
                        ? t('All')
                        : st === 'running'
                          ? containers
                            ? t('Running {n}', { n: runningCount })
                            : t('Running')
                          : st === 'stopped'
                            ? t('Stopped')
                            : t('Unhealthy {n}', { n: unhealthyCount })}
                    </button>
                  ))}
              </div>
            )}
            <div className="flex-1" />
            {toolbar}
          </div>
          {loadError && (
            <div className="border-b border-line p-2">
              <Notice tone="danger" testId="docker-action-error">
                {loadError}
              </Notice>
            </div>
          )}
          {!ready || list === null ? (
            <div
              className="flex flex-1 items-center justify-center gap-2 text-xs text-faint"
              role="status"
            >
              <RefreshCw size={13} className="animate-spin" />
              {ready ? t('Loading…') : session.status}
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
                setFilter('')
                if (sec === 'containers')
                  setStatus(f === 'running' || f === 'stopped' || f === 'unhealthy' ? f : 'all')
              }}
              onPrune={openPrune}
            />
          ) : section === 'containers' ? (
            <>
              {selectionBar(
                'container',
                containers?.length ?? 0,
                containerBulkButtons(selectedContainers)
              )}
              <FileTable
                items={containerRows}
                getKey={(c) => c.name}
                icon={(c) => (
                  <>
                    <RowCheck
                      checked={selected.has(c.name)}
                      name={c.name}
                      onToggle={(range) => {
                        toggleCheck(visibleKeys ?? [], c.name, range)
                      }}
                    />
                    <Container
                      size={14}
                      className={cx('shrink-0', TONE_TEXT[stateTone(c.state)])}
                    />
                  </>
                )}
                badge={(c) =>
                  c.project ? (
                    <span className="shrink-0 rounded bg-subtle px-1 text-[10px] text-faint">
                      {c.project}
                    </span>
                  ) : null
                }
                columns={containerColumns}
                gridClass="grid-cols-[minmax(13rem,2.5fr)_6.5rem_8rem] @xl:grid-cols-[minmax(13rem,2.5fr)_6.5rem_4.5rem_5rem_8rem] @2xl:grid-cols-[minmax(13rem,2.5fr)_6.5rem_4.5rem_5rem_6.5rem_8rem] @3xl:grid-cols-[minmax(13rem,2.5fr)_6.5rem_minmax(7rem,1.5fr)_4.5rem_5rem_6.5rem_8rem] @4xl:grid-cols-[minmax(13rem,2.5fr)_6.5rem_minmax(7rem,1.5fr)_4.5rem_5rem_minmax(6rem,1fr)_6.5rem_8rem]"
                nameSort={{ key: 'name', label: t('Name'), kind: 'text' }}
                sort={sort}
                onSort={setSort}
                selected={selected}
                onSelect={setSelected}
                onOpen={(c) => openLogs(hostId, c)}
                {...(!readOnly
                  ? {
                      onDelete: (items: ContainerRow[]) => {
                        containerAction(items, 'remove')
                      },
                      onRename: (c: ContainerRow) => {
                        setDialog({ kind: 'rename', container: c })
                      }
                    }
                  : {})}
                onContextMenu={(e, items) => {
                  const first = items[0]
                  if (items.length === 1 && first) openMenu(e, toMenu(containerActions(first)))
                  else if (items.length > 1) openMenu(e, bulkMenu(containerBulkButtons(items)))
                }}
                ariaLabel={t('Containers')}
                rowTestId="docker-container"
              >
                {containerRows.length === 0 &&
                  emptyText(
                    Boolean(q) || status !== 'all',
                    <Container size={18} />,
                    t('No containers'),
                    t('Run one from an image, or with docker compose.'),
                    !readOnly ? (
                      <Button
                        size="sm"
                        icon={<Play size={13} />}
                        onClick={() => {
                          setDialog({ kind: 'run', image: '' })
                        }}
                      >
                        {t('Run a container')}
                      </Button>
                    ) : null
                  )}
              </FileTable>
            </>
          ) : section === 'images' ? (
            <>
              {selectionBar('image', images?.length ?? 0, imageBulkButtons(selectedImages))}
              <FileTable
                items={imageRows}
                getKey={imageName}
                icon={(i) => (
                  <>
                    <RowCheck
                      checked={selected.has(imageName(i))}
                      name={imageName(i)}
                      onToggle={(range) => {
                        toggleCheck(visibleKeys ?? [], imageName(i), range)
                      }}
                    />
                    <Layers size={14} className="shrink-0 text-muted" />
                  </>
                )}
                badge={(i) =>
                  i.dangling ? (
                    <span className="rounded bg-subtle px-1 text-[10px] text-faint">
                      {t('dangling')}
                    </span>
                  ) : i.tags.length > 1 ? (
                    <span
                      className="rounded bg-subtle px-1 text-[10px] text-faint"
                      title={i.tags.join('\n')}
                    >
                      {`+${String(i.tags.length - 1)}`}
                    </span>
                  ) : null
                }
                columns={[
                  {
                    id: 'size',
                    label: t('Size'),
                    align: 'right',
                    sort: { key: 'size', label: t('Size'), kind: 'number' },
                    render: (i) => formatBytes(i.size)
                  },
                  {
                    id: 'created',
                    label: t('Created'),
                    sort: { key: 'created', label: t('Created'), kind: 'date' },
                    className: 'hidden @xl:block',
                    render: (i) => <span title={formatDateTime(i.created)}>{ago(i.created)}</span>
                  },
                  {
                    id: 'used',
                    label: t('Used by'),
                    className: 'hidden @lg:block',
                    render: (i) =>
                      i.containers ? (
                        <Pill tone="ok">{tn(i.containers, '{n} container', '{n} containers')}</Pill>
                      ) : (
                        <span className="text-faint">{t('unused')}</span>
                      )
                  },
                  {
                    id: 'actions',
                    label: '',
                    align: 'right',
                    render: (i) => {
                      const actions = imageActions(i)
                      return (
                        <RowActions
                          name={imageName(i)}
                          quick={actions.filter((a) => a.id === 'run' || a.id === 'push')}
                          all={actions}
                          openMenu={openMenu}
                          testIdPrefix="docker-image-row"
                        />
                      )
                    }
                  }
                ]}
                gridClass="grid-cols-[minmax(10rem,2fr)_6rem_5rem] @lg:grid-cols-[minmax(10rem,2fr)_6rem_8rem_5rem] @xl:grid-cols-[minmax(10rem,2fr)_6rem_7rem_8rem_5rem]"
                nameSort={{ key: 'name', label: t('Name'), kind: 'text' }}
                sort={sort}
                onSort={setSort}
                selected={selected}
                onSelect={setSelected}
                onOpen={(i) => {
                  if (!readOnly) setDialog({ kind: 'run', image: imageName(i) })
                }}
                {...(!readOnly ? { onDelete: removeImages } : {})}
                onContextMenu={(e, items) => {
                  const first = items[0]
                  if (items.length === 1 && first) openMenu(e, toMenu(imageActions(first)))
                  else if (items.length > 1) openMenu(e, bulkMenu(imageBulkButtons(items)))
                }}
                ariaLabel={t('Images')}
                rowTestId="docker-image"
              >
                {imageRows.length === 0 &&
                  emptyText(
                    Boolean(q),
                    <Layers size={18} />,
                    t('No images'),
                    t('Images appear here after you pull or build them, or run a container.'),
                    !readOnly ? (
                      <Button
                        size="sm"
                        icon={<ArrowDownToLine size={13} />}
                        onClick={() => {
                          setDialog({ kind: 'transfer', mode: 'pull', ref: '' })
                        }}
                      >
                        {t('Pull an image')}
                      </Button>
                    ) : null
                  )}
              </FileTable>
            </>
          ) : section === 'volumes' ? (
            <>
              {selectionBar('volume', volumes?.length ?? 0, volumeBulkButtons(selectedVolumes))}
              <FileTable
                items={volumeRows}
                getKey={(v) => v.name}
                icon={(v) => (
                  <>
                    <RowCheck
                      checked={selected.has(v.name)}
                      name={v.name}
                      onToggle={(range) => {
                        toggleCheck(visibleKeys ?? [], v.name, range)
                      }}
                    />
                    <HardDrive size={14} className="shrink-0 text-muted" />
                  </>
                )}
                columns={[
                  { id: 'driver', label: t('Driver'), render: (v) => v.driver },
                  {
                    id: 'project',
                    label: t('Project'),
                    className: 'hidden @lg:block',
                    render: (v) => v.project ?? '—'
                  },
                  {
                    id: 'mount',
                    label: t('Mountpoint'),
                    className: 'hidden @2xl:block',
                    render: (v) => (
                      <span className="font-mono" title={v.mountpoint}>
                        {v.mountpoint}
                      </span>
                    )
                  },
                  {
                    id: 'actions',
                    label: '',
                    align: 'right',
                    render: (v) => {
                      const actions = volumeActions(v)
                      return (
                        <RowActions
                          name={v.name}
                          quick={actions.filter((a) => a.id === 'inspect')}
                          all={actions}
                          openMenu={openMenu}
                          testIdPrefix="docker-volume-row"
                        />
                      )
                    }
                  }
                ]}
                gridClass="grid-cols-[minmax(10rem,2fr)_6rem_4rem] @lg:grid-cols-[minmax(10rem,2fr)_6rem_8rem_4rem] @2xl:grid-cols-[minmax(10rem,2fr)_6rem_8rem_minmax(10rem,2fr)_4rem]"
                nameSort={{ key: 'name', label: t('Name'), kind: 'text' }}
                sort={sort}
                onSort={setSort}
                selected={selected}
                onSelect={setSelected}
                onOpen={(v) => {
                  inspect('volume', v.name, v.name)
                }}
                {...(!readOnly ? { onDelete: removeVolumes } : {})}
                onContextMenu={(e, items) => {
                  const first = items[0]
                  if (items.length === 1 && first) openMenu(e, toMenu(volumeActions(first)))
                  else if (items.length > 1) openMenu(e, bulkMenu(volumeBulkButtons(items)))
                }}
                ariaLabel={t('Volumes')}
                rowTestId="docker-volume"
              >
                {volumeRows.length === 0 &&
                  emptyText(
                    Boolean(q),
                    <HardDrive size={18} />,
                    t('No volumes'),
                    t('Named volumes keep data when containers are removed.'),
                    !readOnly ? (
                      <Button
                        size="sm"
                        icon={<Plus size={13} />}
                        onClick={() => {
                          setDialog({ kind: 'volume' })
                        }}
                      >
                        {t('New volume')}
                      </Button>
                    ) : null
                  )}
              </FileTable>
            </>
          ) : section === 'networks' ? (
            <>
              {selectionBar('network', networks?.length ?? 0, networkBulkButtons(selectedNetworks))}
              <FileTable
                items={networkRows}
                getKey={(n) => n.name}
                icon={(n) => (
                  <>
                    <RowCheck
                      checked={selected.has(n.name)}
                      name={n.name}
                      onToggle={(range) => {
                        toggleCheck(visibleKeys ?? [], n.name, range)
                      }}
                    />
                    <Network size={14} className="shrink-0 text-muted" />
                  </>
                )}
                badge={(n) =>
                  n.builtin ? (
                    <span className="rounded bg-subtle px-1 text-[10px] text-faint">
                      {t('built-in')}
                    </span>
                  ) : null
                }
                columns={[
                  { id: 'driver', label: t('Driver'), render: (n) => n.driver },
                  {
                    id: 'scope',
                    label: t('Scope'),
                    className: 'hidden @lg:block',
                    render: (n) => n.scope
                  },
                  {
                    id: 'actions',
                    label: '',
                    align: 'right',
                    render: (n) => {
                      const actions = networkActions(n)
                      return (
                        <RowActions
                          name={n.name}
                          quick={actions.filter((a) => a.id === 'inspect' || a.id === 'connect')}
                          all={actions}
                          openMenu={openMenu}
                          testIdPrefix="docker-network-row"
                        />
                      )
                    }
                  }
                ]}
                gridClass="grid-cols-[minmax(10rem,2fr)_6rem_5rem] @lg:grid-cols-[minmax(10rem,2fr)_6rem_6rem_5rem]"
                nameSort={{ key: 'name', label: t('Name'), kind: 'text' }}
                sort={sort}
                onSort={setSort}
                selected={selected}
                onSelect={setSelected}
                onOpen={(n) => {
                  inspect('network', n.id, n.name)
                }}
                {...(!readOnly ? { onDelete: removeNetworks } : {})}
                onContextMenu={(e, items) => {
                  const first = items[0]
                  if (items.length === 1 && first) openMenu(e, toMenu(networkActions(first)))
                  else if (items.length > 1) openMenu(e, bulkMenu(networkBulkButtons(items)))
                }}
                ariaLabel={t('Networks')}
                rowTestId="docker-network"
              >
                {networkRows.length === 0 &&
                  emptyText(
                    Boolean(q),
                    <Network size={18} />,
                    t('No networks'),
                    t('Networks connect containers to each other.'),
                    !readOnly ? (
                      <Button
                        size="sm"
                        icon={<Plus size={13} />}
                        onClick={() => {
                          setDialog({ kind: 'network' })
                        }}
                      >
                        {t('New network')}
                      </Button>
                    ) : null
                  )}
              </FileTable>
            </>
          ) : (
            <ComposeView
              projects={projects}
              totalProjects={allProjects}
              busy={busy}
              readOnly={readOnly}
              filtered={Boolean(q)}
              openMenu={openMenu}
              onAction={compose}
              onLogs={(p) => openProjectLogs(hostId, p.name, p.containers)}
              onServiceLogs={(p, sv) => {
                const only = sv.containers.length === 1 ? sv.containers[0] : undefined
                if (only) openLogs(hostId, only)
                else openProjectLogs(hostId, `${p.name}-${sv.name}`, sv.containers)
              }}
              onShell={(c) => openShell(hostId, c)}
              onContainerAction={(cs, action) => {
                // Một container: chạy ngay như nút nhanh trên dòng; nhiều replica: hộp thoại hàng loạt.
                containerAction(cs, action)
              }}
              containerMenu={(c) => toMenu(containerActions(c))}
              quick={quick}
              onCopy={copy}
              emptyFiltered={emptyText(true, <Boxes size={18} />, '', '', null)}
            />
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
            tab={detailTab}
            onTabChange={setDetailTab}
            readOnly={readOnly}
            onConnect={() => {
              void load('networks')
              setDialog({ kind: 'connect', container: one })
            }}
            onDisconnect={(network) => {
              disconnect(network, one)
            }}
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
            actions={imageActions(oneImage)}
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
          all={dialog.all}
          preview={dialog.preview}
          error={dialog.error}
          onAllChange={(all) => {
            loadPrunePreview(dialog.what, all)
          }}
          onClose={() => {
            setDialog(null)
          }}
          onConfirm={() => {
            const { what, all } = dialog
            setDialog(null)
            void run(t('Clean up failed'), async () => {
              const r = await request<PruneResult>({
                op: 'prune',
                what,
                dryRun: false,
                ...(what === 'volumes' || what === 'images' ? { all } : {})
              })
              toast.success(
                r.reclaimed
                  ? t('Cleaned up — {size} freed', { size: formatBytes(r.reclaimed) })
                  : t('Cleaned up')
              )
              setReloadKey((n) => n + 1)
            })
          }}
        />
      )}
      {dialog?.kind === 'bulk' && (
        <BulkDialog
          plan={dialog.plan}
          onClose={() => {
            setDialog(null)
          }}
          onFinished={(results) => {
            if (dialog.plan.removes) {
              const gone = new Set(results.filter((r) => r.ok).map((r) => r.key))
              setSelected((prev) => new Set([...prev].filter((k) => !gone.has(k))))
            }
            void load(section)
            if (section !== 'containers') void load('containers')
          }}
        />
      )}
      {dialog?.kind === 'confirm' && (
        <ConfirmDialog
          request={dialog.request}
          onClose={() => {
            setDialog(null)
          }}
        />
      )}
      {dialog?.kind === 'transfer' && (
        <ImageTransferDialog
          mode={dialog.mode}
          initialRef={dialog.ref}
          {...(dialog.refs ? { refs: dialog.refs } : {})}
          registries={registries}
          progress={transfer}
          onManageRegistries={() => {
            if (transferRef.current && !transferRef.current.done) return
            transferRef.current = null
            setTransfer(null)
            setDialog({ kind: 'registries' })
          }}
          onClose={() => {
            // Đóng / Stop khi đang kéo / đẩy → huỷ thật ở Session Host (không để luồng chạy ngầm).
            const current = transferRef.current
            transferRef.current = null
            if (current && !current.done) {
              current.cancelled = true
              if (current.subscription)
                void request({ op: 'unsubscribe', subscription: current.subscription }).catch(
                  () => undefined
                )
            }
            setDialog(null)
            setTransfer(null)
            void load('images')
          }}
          onStart={(ref, registry) => {
            startTransfer(dialog.mode, ref, registry)
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
            void run(t('Rename failed'), () => request({ op: 'rename', id, name }))
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
            toast.success(t('Started {name}', { name: spec.name || spec.image }))
            void load('containers')
          }}
        />
      )}
      {dialog?.kind === 'volume' && (
        <CreateVolumeDialog
          onClose={() => {
            setDialog(null)
          }}
          onCreate={async (spec: VolumeSpec) => {
            const r = await request<{ name: string }>({ op: 'volume.create', spec })
            setDialog(null)
            toast.success(t('Created the volume {name}', { name: r.name }))
            void load('volumes')
          }}
        />
      )}
      {dialog?.kind === 'network' && (
        <CreateNetworkDialog
          onClose={() => {
            setDialog(null)
          }}
          onCreate={async (spec: NetworkSpec) => {
            await request({ op: 'network.create', spec })
            setDialog(null)
            toast.success(t('Created the network {name}', { name: spec.name }))
            void load('networks')
          }}
        />
      )}
      {dialog?.kind === 'connect' && (
        <ConnectNetworkDialog
          {...(dialog.container ? { container: dialog.container } : {})}
          {...(dialog.network ? { network: dialog.network } : {})}
          containers={containers ?? []}
          networks={networks ?? []}
          onClose={() => {
            setDialog(null)
          }}
          onConnect={async (network, container, aliases, ipv4) => {
            await request({
              op: 'network.connect',
              network,
              container,
              aliases,
              ...(ipv4 ? { ipv4 } : {})
            })
            setDialog(null)
            const n = networks?.find((x) => x.id === network)?.name ?? network
            const c = containers?.find((x) => x.id === container)?.name ?? container
            toast.success(t('Connected {name} to {network}', { name: c, network: n }))
            void load('containers')
          }}
        />
      )}
      {dialog?.kind === 'tag' && (
        <TagDialog
          source={imageName(dialog.image)}
          onClose={() => {
            setDialog(null)
          }}
          onTag={async (target) => {
            await request({ op: 'image.tag', id: dialog.image.id, target })
            setDialog(null)
            toast.success(t('Tagged as {tag}', { tag: target }))
            void load('images')
          }}
        />
      )}
      {dialog?.kind === 'registries' && (
        <RegistriesDialog
          registries={registries}
          onTest={(id) =>
            request<{ status: string }>({ op: 'registry.check', registry: id }).then(
              (r) => r.status
            )
          }
          onClose={() => {
            setDialog(null)
          }}
        />
      )}
      {dialog?.kind === 'build' && (
        <BuildDialog
          where={where}
          storageKey={`docker-build:${hostId ?? 'local'}`}
          start={(spec: BuildSpec) =>
            request<{ subscription: string }>({ op: 'build', spec }).then((r) => r.subscription)
          }
          cancel={(subscription) => {
            void request({ op: 'unsubscribe', subscription }).catch(() => undefined)
          }}
          subscribe={subscribeEvents}
          onClose={() => {
            setDialog(null)
          }}
          onBuilt={(tags) => {
            toast.success(
              tags.length ? t('Built {tags}', { tags: tags.join(', ') }) : t('Build finished')
            )
            void load('images')
          }}
        />
      )}
      {menu}
    </div>
  )
}
