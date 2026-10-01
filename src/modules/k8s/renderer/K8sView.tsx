import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowLeftRight,
  PanelLeft,
  Box,
  ChevronRight,
  Copy,
  Eye,
  Plus,
  RefreshCw,
  Search,
  Ship,
  Terminal,
  X
} from 'lucide-react'
import { Button, cx, IconButton, Notice } from '../../../renderer/src/components/ui'
import { useContextMenu, type MenuEntry } from '../../../renderer/src/components/ContextMenu'
import { FileTable, type FileColumn } from '../../../renderer/src/components/files/FileTable'
import { Empty } from '../../../renderer/src/components/files/parts'
import { KeyHints, Pill, TONE_TEXT, type Tone } from '../../../renderer/src/components/panels'
import type { SortState } from '../../../renderer/src/components/SortMenu'
import { cleanError } from '../../../renderer/src/lib/format'
import { ConnectionPrompt, setModuleTabParams } from '../../registry/renderer-kit'
import type { ModuleTabProps } from '../../registry/renderer-types'
import {
  contextKey,
  type DiscoveredKind,
  type K8sClusterParams,
  type MetricsResult,
  type PortForwardInfo,
  type Usage
} from '../shared/ops'
import {
  BUILTIN_KINDS,
  COLUMNS,
  formatCpu,
  formatMemory,
  parseCpu,
  parseMemory,
  selectorString,
  toRow,
  type K8sObject,
  type ResourceRow
} from '../shared/resources'
import {
  actionsFor,
  containersOf,
  eventKey,
  HAS_PODS,
  keyLabel,
  toMenu,
  type ActionHandlers
} from './actions'
import { openPodLogs, openPodShell } from './api'
import { Detail, RELATED_KINDS, type DetailTab } from './Detail'
import {
  DeleteDialog,
  DrainDialog,
  ForwardDialog,
  HistoryDialog,
  ScaleDialog,
  YamlEditor
} from './dialogs'
import { COLOR_DOT } from './K8sSection'
import { HelmView } from './HelmView'
import { HELM, OVERVIEW, parseCommand, suggest } from './nav'
import { ClusterOverview } from './Overview'
import { useK8s } from './store'
import { fitColumns } from '../shared/columns'
import { ResourceNav } from './ResourceNav'
import { useK8sSession } from './useK8sSession'
import { objectKey, useResourceList, type EventBus } from './useResourceList'

const TONE: Record<ResourceRow['tone'], Tone> = {
  ok: 'ok',
  warn: 'warn',
  bad: 'bad',
  muted: 'muted'
}
/** Màu trạng thái Argo CD (Health / Sync). */
function argoTone(text: string): Tone {
  if (text === 'Healthy' || text === 'Synced') return 'ok'
  if (text === 'Degraded' || text === 'Missing') return 'bad'
  if (text === 'Progressing' || text === 'OutOfSync' || text === 'Suspended') return 'warn'
  return 'muted'
}

/**
 * Dòng bảng nhớ theo đối tượng: watch thay đối tượng đổi bằng đối tượng mới, đối tượng không đổi
 * giữ nguyên → chỉ tính lại dòng thay đổi (3000 pod, mỗi lô vài pod). Làm mới mỗi 30 giây cho
 * cột tuổi.
 */
const rowCache = new WeakMap<K8sObject, { kind: string; bucket: number; row: ResourceRow }>()
function cachedRow(kindId: string, obj: K8sObject): ResourceRow {
  const bucket = Math.floor(Date.now() / 30_000)
  const hit = rowCache.get(obj)
  if (hit && hit.kind === kindId && hit.bucket === bucket) return hit.row
  const row = toRow(kindId, obj)
  rowCache.set(obj, { kind: kindId, bucket, row })
  return row
}

const METRIC_EVERY_MS = 15_000
const NAV_HIDDEN_KEY = 'shellhouse.k8s.navHidden'
/** Thông báo thành công tự tắt sau chừng này (lỗi thì giữ tới khi người dùng đóng). */
const NOTICE_MS = 4000

interface Drill {
  /** Breadcrumb: "deployment/web". */
  label: string
  kind: string
  namespace?: string | undefined
  labelSelector?: string | undefined
  fieldSelector?: string | undefined
}

type Dialog =
  | { kind: 'yaml'; mode: 'view' | 'edit' | 'create'; title: string; text: string }
  | { kind: 'delete'; obj: K8sObject; force: boolean }
  | { kind: 'forward'; obj: K8sObject; ports: number[] }
  | { kind: 'scale'; obj: K8sObject }
  | { kind: 'drain'; obj: K8sObject }
  | { kind: 'history'; obj: K8sObject }
  | null

type Row = { obj: K8sObject; row: ResourceRow }

const isTyping = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement &&
  (t.tagName === 'INPUT' ||
    t.tagName === 'TEXTAREA' ||
    t.tagName === 'SELECT' ||
    t.isContentEditable)

const focusGrid = (root: HTMLElement | null): void => {
  root?.querySelector<HTMLElement>('[role="grid"]')?.focus()
}

/** Tab một cluster (context) — điều hướng kiểu k9s, chi tiết kiểu Lens. */
export function ClusterTab({
  tabId,
  params,
  active
}: ModuleTabProps<K8sClusterParams>): React.JSX.Element {
  const contexts = useK8s((st) => st.contexts)
  const entry = contexts.find((c) => c.key === contextKey(params.ref))
  const readOnly = entry?.settings.readOnly ?? false
  const production = entry?.settings.color === 'red'
  const [kinds, setKinds] = useState<DiscoveredKind[] | null>(null)
  const [view, setView] = useState<string>('pods')
  const [drill, setDrill] = useState<Drill[]>([])
  const [allNamespaces, setAllNamespaces] = useState<string[]>([])
  const [namespaces, setNamespaces] = useState<string[] | null>(
    params.namespace ? [params.namespace] : null
  )
  const [notice, setNotice] = useState<{ tone: 'danger' | 'success'; text: string } | null>(null)
  const [query, setQuery] = useState('')
  const [suggestAt, setSuggestAt] = useState(0)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [detailKey, setDetailKey] = useState<string | null>(null)
  /** Tab mở sẵn khi mở chi tiết (bấm đúp workload → Related). */
  const [detailTab, setDetailTab] = useState<DetailTab>('overview')
  const [sort, setSort] = useState<SortState<'name' | 'age' | 'cpu' | 'mem'>>({
    key: 'name',
    dir: 'asc'
  })
  const [forwards, setForwards] = useState<PortForwardInfo[]>([])
  const [showForwards, setShowForwards] = useState(false)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [reloadKey, setReloadKey] = useState(0)
  /** Thu gọn thanh điều hướng (nhớ theo máy) — nhường chỗ cho bảng và chi tiết. */
  const [navHidden, setNavHidden] = useState(() => {
    try {
      return window.localStorage.getItem(NAV_HIDDEN_KEY) === '1'
    } catch {
      return false
    }
  })
  /** reloadKey của lần discover gần nhất (khác → người dùng vừa bấm Reload). */
  const discoveredAt = useRef(0)
  const [metrics, setMetrics] = useState<MetricsResult | null>(null)
  const [counts, setCounts] = useState<Record<string, number | null>>({})
  const [history, setHistory] = useState<Record<string, Usage[]>>({})
  const [helpOpen, setHelpOpen] = useState(false)
  const [tableWidth, setTableWidth] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const tableRef = useRef<HTMLDivElement>(null)
  const { menu, open: openMenu } = useContextMenu()
  const [bus] = useState<EventBus>(() => new Set())

  const onEvent = useCallback(
    (event: string, data: unknown) => {
      for (const l of bus) l(event, data)
      if (event === 'forwards') setForwards(data as PortForwardInfo[])
      else if (event === 'edit') {
        const d = data as { name: string; ok: boolean; error?: string }
        setNotice(
          d.ok
            ? { tone: 'success', text: `Saved ${d.name} to the cluster` }
            : { tone: 'danger', text: `Could not save ${d.name}: ${d.error ?? 'unknown error'}` }
        )
      }
    },
    [bus]
  )
  const session = useK8sSession(tabId, params.ref, params.bastionHostId, readOnly, onEvent)
  const { ready, request, cluster } = session
  const nsForAccess = namespaces?.length === 1 ? namespaces[0] : undefined

  // Loại tài nguyên (gồm CRD) + quyền; danh sách namespace.
  useEffect(() => {
    if (!ready) return
    let cancelled = false
    // Bấm Reload → hỏi lại danh mục loại + quyền (không dùng bản nhớ của Session Host).
    const refresh = reloadKey !== discoveredAt.current
    discoveredAt.current = reloadKey
    request<DiscoveredKind[]>({
      op: 'discover',
      ...(nsForAccess ? { namespace: nsForAccess } : {}),
      ...(refresh ? { refresh: true } : {})
    }).then(
      (k) => {
        if (!cancelled) setKinds(k)
      },
      (e: unknown) => {
        if (!cancelled) setNotice({ tone: 'danger', text: cleanError(e) })
      }
    )
    request<{ names: string[]; canList: boolean }>({ op: 'namespaces' }).then(
      (r) => {
        if (cancelled) return
        setAllNamespaces(r.names)
        setNamespaces((cur) => cur ?? (r.canList ? [cluster?.namespace ?? 'default'] : r.names))
      },
      () => undefined
    )
    return () => {
      cancelled = true
    }
  }, [ready, request, nsForAccess, cluster?.namespace, reloadKey])

  const top = drill.at(-1)
  const kindId = top?.kind ?? view
  const kind = kinds?.find((k) => k.id === kindId) ?? BUILTIN_KINDS.find((k) => k.id === kindId)
  const scopeNs = top?.namespace ? [top.namespace] : (namespaces ?? [])
  const onOverview = view === OVERVIEW && !top
  const onHelm = view === HELM && !top
  const listQuery =
    onOverview || namespaces === null || !kind
      ? null
      : {
          kind: kind.id,
          namespaced: kind.namespaced,
          namespaces: scopeNs,
          labelSelector: top?.labelSelector,
          fieldSelector: top?.fieldSelector
        }
  const list = useResourceList(ready, request, bus, listQuery, reloadKey, active)

  // Số đối tượng mỗi loại cho thanh điều hướng (như Rancher): khi đổi namespace / tải lại và
  // 60 giây một lần khi tab đang hiện.
  const countKey = (kinds ?? [])
    .filter((k) => !k.forbidden)
    .map((k) => k.id)
    .join(',')
  const countNs = (namespaces ?? []).join(',')
  useEffect(() => {
    if (!ready || !active || !countKey || namespaces === null) return
    let cancelled = false
    const poll = (): void => {
      request<Record<string, number | null>>({
        op: 'counts',
        kinds: countKey.split(','),
        namespaces: countNs ? countNs.split(',') : []
      }).then(
        (c) => {
          if (!cancelled) setCounts(c)
        },
        () => undefined
      )
    }
    poll()
    const t = setInterval(poll, 60_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- countKey / countNs đại diện cho kinds / namespaces
  }, [ready, active, request, countKey, countNs, reloadKey])

  // CPU / RAM (metrics-server) cho pod và node, 15 giây một lần khi tab đang hiện.
  const metricScope = kindId === 'pods' ? 'pods' : kindId === 'nodes' ? 'nodes' : null
  const metricNs = kindId === 'pods' && scopeNs.length === 1 ? scopeNs[0] : undefined
  useEffect(() => {
    if (!ready || !metricScope || !active) return
    let cancelled = false
    const poll = (): void => {
      request<MetricsResult>({
        op: 'metrics',
        scope: metricScope,
        ...(metricNs ? { namespace: metricNs } : {})
      }).then(
        (m) => {
          if (cancelled) return
          setMetrics(m)
          if (metricScope === 'pods' && m.available)
            setHistory((h) => {
              const next: Record<string, Usage[]> = {}
              for (const [k, u] of Object.entries(m.items))
                next[k] = [...(h[k] ?? []).slice(-19), u]
              return next
            })
        },
        () => undefined
      )
    }
    poll()
    const t = setInterval(poll, METRIC_EVERY_MS)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [ready, request, metricScope, metricNs, active])

  // Thông báo thành công tự tắt; lỗi giữ lại.
  useEffect(() => {
    if (notice?.tone !== 'success') return
    const t = setTimeout(() => {
      setNotice((n) => (n === notice ? null : n))
    }, NOTICE_MS)
    return () => {
      clearTimeout(t)
    }
  }, [notice])

  // Độ rộng vùng bảng → số cột vừa (mở chi tiết / thu nhỏ cửa sổ thì bỏ bớt cột phụ).
  useEffect(() => {
    const el = tableRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w) setTableWidth(w)
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
    }
  }, [ready])

  const go = useCallback((id: string, filter = '') => {
    setView(id)
    setDrill([])
    setSelected(new Set())
    setDetailKey(null)
    setQuery(filter)
  }, [])

  const notify = (text: string, tone: 'success' | 'danger' = 'success'): void => {
    setNotice({ tone, text })
  }
  const run = (label: string, fn: () => Promise<unknown>, done?: string): void => {
    setNotice(null)
    fn().then(
      () => {
        if (done) notify(done)
      },
      (e: unknown) => {
        notify(`${label}: ${cleanError(e)}`, 'danger')
      }
    )
  }
  const nsOf = (obj: K8sObject): { namespace?: string } =>
    obj.metadata.namespace ? { namespace: obj.metadata.namespace } : {}

  const handlers: ActionHandlers = {
    logs: (obj, opts) => {
      const base = {
        ref: params.ref,
        ...(params.bastionHostId ? { bastionHostId: params.bastionHostId } : {}),
        namespace: obj.metadata.namespace ?? ''
      }
      if (kindId === 'pods') {
        const first = containersOf(obj)[0]
        openPodLogs({
          ...base,
          pod: obj.metadata.name,
          ...(opts?.allContainers ? { allContainers: true } : first ? { container: first } : {})
        })
        return
      }
      const sel = selectorString(obj.spec?.['selector'])
      if (!sel) {
        notify(`${obj.metadata.name} has no pod selector`, 'danger')
        return
      }
      openPodLogs({
        ...base,
        selector: sel,
        title: `${(kind?.kind ?? kindId).toLowerCase()}/${obj.metadata.name}`
      })
    },
    shell: (obj, container) => {
      const c = container ?? containersOf(obj)[0]
      openPodShell(
        {
          ref: params.ref,
          namespace: obj.metadata.namespace ?? '',
          pod: obj.metadata.name,
          ...(c ? { container: c } : {})
        },
        params.bastionHostId
      )
    },
    yaml: (obj) => {
      request<string>({
        op: 'get',
        kind: kindId,
        ...nsOf(obj),
        name: obj.metadata.name,
        format: 'yaml'
      }).then(
        (text) => {
          setDialog({
            kind: 'yaml',
            mode: 'view',
            title: `${obj.kind ?? ''} ${obj.metadata.name}`,
            text
          })
        },
        (e: unknown) => {
          notify(cleanError(e), 'danger')
        }
      )
    },
    edit: (obj) => {
      request<string>({
        op: 'get',
        kind: kindId,
        ...nsOf(obj),
        name: obj.metadata.name,
        format: 'yaml'
      }).then(
        (text) => {
          setDialog({
            kind: 'yaml',
            mode: 'edit',
            title: `Edit ${obj.kind ?? ''} ${obj.metadata.name}`,
            text
          })
        },
        (e: unknown) => {
          notify(cleanError(e), 'danger')
        }
      )
    },
    editExternal: (obj) => {
      run(
        'Edit failed',
        async () => {
          const localPath = await window.shellhouse.prepareRemoteEdit(
            `${obj.metadata.name}.${kindId}.yaml`
          )
          await request({
            op: 'edit',
            kind: kindId,
            ...nsOf(obj),
            name: obj.metadata.name,
            localPath
          })
          await window.shellhouse.openInEditor(localPath)
        },
        `Editing ${obj.metadata.name} — every save is applied to the cluster`
      )
    },
    forward: (obj) => {
      const ports =
        kindId === 'pods'
          ? (
              (obj.spec?.['containers'] as { ports?: { containerPort: number }[] }[] | undefined) ??
              []
            ).flatMap((c) => (c.ports ?? []).map((p) => p.containerPort))
          : ((obj.spec?.['ports'] as { port: number }[] | undefined) ?? []).map((p) => p.port)
      setDialog({ kind: 'forward', obj, ports })
    },
    scale: (obj) => {
      setDialog({ kind: 'scale', obj })
    },
    restart: (obj) => {
      if (
        production &&
        window.prompt(
          `Restart ${obj.metadata.name} in a production context?\nType the name to confirm:`
        ) !== obj.metadata.name
      )
        return
      run(
        'Restart failed',
        () =>
          request({
            op: 'rolloutRestart',
            kind: kindId as 'deployments.apps',
            namespace: obj.metadata.namespace ?? '',
            name: obj.metadata.name
          }),
        `Restarting ${obj.metadata.name}`
      )
    },
    pause: (obj, paused) => {
      run(
        'Failed',
        () =>
          request({
            op: 'rolloutPause',
            namespace: obj.metadata.namespace ?? '',
            name: obj.metadata.name,
            paused
          }),
        paused ? 'Rollout paused' : 'Rollout resumed'
      )
    },
    history: (obj) => {
      setDialog({ kind: 'history', obj })
    },
    remove: (obj, force) => {
      setDialog({ kind: 'delete', obj, force })
    },
    cordon: (obj, unschedulable) => {
      run(
        'Failed',
        () => request({ op: 'cordon', node: obj.metadata.name, unschedulable }),
        `${unschedulable ? 'Cordoned' : 'Uncordoned'} ${obj.metadata.name}`
      )
    },
    drain: (obj) => {
      setDialog({ kind: 'drain', obj })
    },
    trigger: (obj) => {
      run('Could not start the job', async () => {
        const job = await request<string>({
          op: 'cronTrigger',
          namespace: obj.metadata.namespace ?? '',
          name: obj.metadata.name
        })
        notify(`Started job ${job}`)
      })
    },
    argoSync: (obj, prune) => {
      if (
        prune &&
        !window.confirm(
          `Sync ${obj.metadata.name} and prune?\nResources that are no longer in Git are deleted from the cluster.`
        )
      )
        return
      if (
        production &&
        window.prompt(
          `Sync ${obj.metadata.name} in a production context?\nType the name to confirm:`
        ) !== obj.metadata.name
      )
        return
      run(
        'Sync failed',
        () =>
          request({
            op: 'argoSync',
            namespace: obj.metadata.namespace ?? '',
            name: obj.metadata.name,
            prune
          }),
        `Syncing ${obj.metadata.name}`
      )
    },
    argoRefresh: (obj, hard) => {
      run(
        'Refresh failed',
        () =>
          request({
            op: 'argoRefresh',
            namespace: obj.metadata.namespace ?? '',
            name: obj.metadata.name,
            hard
          }),
        `${hard ? 'Hard refresh' : 'Refresh'} requested for ${obj.metadata.name}`
      )
    },
    suspend: (obj, suspend) => {
      run(
        'Failed',
        () =>
          request({
            op: 'cronSuspend',
            namespace: obj.metadata.namespace ?? '',
            name: obj.metadata.name,
            suspend
          }),
        suspend ? 'Schedule suspended' : 'Schedule resumed'
      )
    }
  }

  // ——— Dòng của bảng ———
  const commandMode = query.startsWith(':')
  const q = commandMode ? '' : query.trim().toLowerCase()
  const rows = ((): Row[] => {
    const items = [...(list.objects?.values() ?? [])].map((obj) => ({
      obj,
      row: cachedRow(kindId, obj)
    }))
    const filtered = q
      ? items.filter(
          ({ row }) =>
            row.name.toLowerCase().includes(q) ||
            row.namespace.includes(q) ||
            Object.values(row.cells).some((c) => c.toLowerCase().includes(q))
        )
      : items
    const usage = (o: K8sObject): Usage | undefined => metrics?.items[objectKey(o)]
    const dir = sort.dir === 'asc' ? 1 : -1
    return filtered.sort((x, y) => {
      if (sort.key === 'age') return (x.row.created - y.row.created) * dir
      if (sort.key === 'cpu') return ((usage(x.obj)?.cpu ?? -1) - (usage(y.obj)?.cpu ?? -1)) * dir
      if (sort.key === 'mem')
        return ((usage(x.obj)?.memory ?? -1) - (usage(y.obj)?.memory ?? -1)) * dir
      return x.row.key.localeCompare(y.row.key) * dir
    })
  })()
  const single = selected.size === 1 ? rows.find((r) => selected.has(r.row.key)) : undefined
  const detail = detailKey ? rows.find((r) => r.row.key === detailKey) : undefined

  const multiNs = kind?.namespaced === true && scopeNs.length !== 1
  const showMetrics = Boolean(metricScope && metrics?.available)
  const usageCell = (r: Row, which: 'cpu' | 'memory'): string => {
    const u = metrics?.items[objectKey(r.obj)]
    if (!u) return '—'
    const text = which === 'cpu' ? formatCpu(u.cpu) : formatMemory(u.memory)
    if (kindId !== 'nodes') return text
    const alloc = (r.obj.status?.['allocatable'] as Record<string, string> | undefined) ?? {}
    const cap = which === 'cpu' ? parseCpu(alloc['cpu']) : parseMemory(alloc['memory'])
    const used = which === 'cpu' ? u.cpu : u.memory
    return `${text} (${cap ? Math.round((used / cap) * 100) : 0}%)`
  }
  const allColumns: FileColumn<Row, 'name' | 'age' | 'cpu' | 'mem'>[] = [
    ...(multiNs ? [{ id: 'ns', label: 'Namespace', render: (r: Row) => r.row.namespace }] : []),
    ...(COLUMNS[kindId] ?? []).map((c) => ({
      id: c.id,
      label: c.label,
      render: (r: Row) => {
        const text = r.row.cells[c.id] ?? ''
        const tone =
          c.id === 'status'
            ? TONE[r.row.tone]
            : c.id === 'health' || c.id === 'sync'
              ? argoTone(text)
              : null
        return tone && text ? (
          <span className="min-w-0" title={text}>
            <Pill tone={tone}>{text}</Pill>
          </span>
        ) : (
          text
        )
      }
    })),
    ...(showMetrics
      ? [
          {
            id: 'cpu',
            label: 'CPU',
            align: 'right' as const,
            sort: { key: 'cpu' as const, label: 'CPU', kind: 'number' as const },
            render: (r: Row) => usageCell(r, 'cpu')
          },
          {
            id: 'mem',
            label: 'Memory',
            align: 'right' as const,
            sort: { key: 'mem' as const, label: 'Memory', kind: 'number' as const },
            render: (r: Row) => usageCell(r, 'memory')
          }
        ]
      : []),
    {
      id: 'age',
      label: 'Age',
      align: 'right',
      sort: { key: 'age', label: 'Age', kind: 'date' },
      render: (r) => r.row.cells['age'] ?? ''
    }
  ]
  const fit = fitColumns(
    allColumns.map((c) => c.id),
    tableWidth,
    { wide: kindId === 'nodes' }
  )
  const columns = allColumns.filter((c) => fit.keep.has(c.id))

  const drillable = kindId === 'nodes' || kindId === 'namespaces'

  /** Pod của workload / service trong bảng chính, có breadcrumb (kiểu k9s). */
  const drillPods = (o: K8sObject): void => {
    const sel = selectorString(o.spec?.['selector'])
    if (!sel) {
      notify(`${o.metadata.name} has no pod selector`, 'danger')
      return
    }
    setDrill((d) => [
      ...d,
      {
        label: `${(o.kind ?? kindId).toLowerCase()}/${o.metadata.name}`,
        kind: 'pods',
        namespace: o.metadata.namespace,
        labelSelector: sel
      }
    ])
    setSelected(new Set())
    setDetailKey(null)
  }

  /** Mở một tài nguyên liên quan (tab Related): sang loại đó, chọn và mở chi tiết. */
  const openRelated = (from: K8sObject, kind: string, name: string): void => {
    const ns = from.metadata.namespace
    const known =
      BUILTIN_KINDS.some((k) => k.id === kind) || (kinds ?? []).some((k) => k.id === kind)
    if (!known) {
      // Loại không có trong điều hướng (ServiceAccount, HPA…): xem YAML.
      request<string>({
        op: 'get',
        kind,
        ...(ns ? { namespace: ns } : {}),
        name,
        format: 'yaml'
      }).then(
        (text) => {
          setDialog({ kind: 'yaml', mode: 'view', title: name, text })
        },
        (e: unknown) => {
          notify(cleanError(e), 'danger')
        }
      )
      return
    }
    if (ns && namespaces && namespaces.length > 0 && !namespaces.includes(ns)) setNamespaces([ns])
    const key = ns ? `${ns}/${name}` : name
    setView(kind)
    setDrill([])
    setQuery('')
    setSelected(new Set([key]))
    setDetailTab('overview')
    setDetailKey(key)
  }

  /**
   * Bấm đúp / Enter: namespace → chuyển namespace; node → pod trên node; workload, service,
   * ConfigMap… → chi tiết ở tab Related (kiểu Rancher); loại khác → chi tiết.
   */
  const open = (r: Row): void => {
    const o = r.obj
    const name = o.metadata.name
    if (kindId === 'namespaces') {
      setNamespaces([name])
      go('pods')
      return
    }
    if (kindId === 'nodes') {
      setDrill((d) => [
        ...d,
        { label: `node/${name}`, kind: 'pods', fieldSelector: `spec.nodeName=${name}` }
      ])
      setSelected(new Set())
      setDetailKey(null)
      return
    }
    setDetailTab(RELATED_KINDS.includes(kindId) && kindId !== 'pods' ? 'related' : 'overview')
    setDetailKey(r.row.key)
  }

  // ——— Thanh lệnh `:` ———
  const suggestions = commandMode
    ? suggest(
        query,
        kinds ?? [],
        contexts.map((c) => c.name),
        allNamespaces
      )
    : []

  const switchContext = (key: string): void => {
    const c = contexts.find((x) => x.key === key)
    if (!c) return
    setNamespaces(c.settings.namespace ? [c.settings.namespace] : null)
    setKinds(null)
    go('pods')
    setModuleTabParams(tabId, {
      ref: c.ref,
      label: c.name,
      ...(c.settings.bastionHostId ? { bastionHostId: c.settings.bastionHostId } : {}),
      ...(c.settings.namespace ? { namespace: c.settings.namespace } : {})
    })
  }

  const runCommand = (text: string): void => {
    const cmd = parseCommand(text, kinds ?? [])
    if (!cmd) {
      notify(`Unknown command “${text.replace(/^:/, '')}”`, 'danger')
      return
    }
    setQuery('')
    if (cmd.kind === 'view') go(cmd.id)
    else if (cmd.kind === 'namespace') {
      setNamespaces(cmd.name ? [cmd.name] : [])
      setSelected(new Set())
    } else {
      const target = contexts.find((c) => c.name === cmd.name)
      if (!target) {
        notify(`No context “${cmd.name}”`, 'danger')
        return
      }
      switchContext(target.key)
    }
    focusGrid(rootRef.current)
  }

  const back = (): boolean => {
    if (detailKey) {
      setDetailKey(null)
      return true
    }
    if (drill.length) {
      setDrill((d) => d.slice(0, -1))
      setSelected(new Set())
      return true
    }
    if (query) {
      setQuery('')
      return true
    }
    return false
  }

  // ——— Phím tắt (kiểu k9s) ———
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || isTyping(e.target) || dialog) return
    const k = eventKey(e)
    if (k === ':' || k === '/') {
      e.preventDefault()
      setQuery(k === ':' ? ':' : '')
      inputRef.current?.focus()
      return
    }
    if (k === '?') {
      setHelpOpen((o) => !o)
      return
    }
    if (k === 'Escape') {
      if (helpOpen) setHelpOpen(false)
      else if (back()) e.preventDefault()
      return
    }
    if (k === '0') {
      setNamespaces([])
      return
    }
    if (k === 'd' && single) {
      setDetailKey(single.row.key)
      return
    }
    if (single) {
      const action = actionsFor(kindId, single.obj, readOnly, handlers).find((x) => x.key === k)
      if (action) {
        e.preventDefault()
        action.run()
      }
    }
  }

  // Phím tắt nghe ở window: bảng vừa tải lại (focus rơi về <body>) vẫn nhận phím. Chỉ khi tab
  // đang hiện và focus ở trong tab hoặc chưa ở đâu.
  const keyHandler = useRef(onKeyDown)
  useEffect(() => {
    keyHandler.current = onKeyDown
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

  // Tab được chọn → đưa focus vào bảng để dùng phím ngay.
  const loaded = list.objects !== null
  useEffect(() => {
    if (!active || !ready || !loaded) return
    const t = setTimeout(() => {
      if (!rootRef.current?.contains(document.activeElement)) focusGrid(rootRef.current)
    }, 50)
    return () => {
      clearTimeout(t)
    }
  }, [active, ready, kindId, loaded])

  if (session.error)
    return (
      <div className="flex h-full items-center justify-center bg-canvas p-6" data-testid="k8s-view">
        <div className="flex max-w-md flex-col items-center gap-3 text-center">
          <Ship size={28} className="text-faint" />
          <p className="text-sm text-fg" data-testid="k8s-error">
            {session.error}
          </p>
          <Button size="sm" icon={<RefreshCw size={13} />} onClick={session.retry}>
            Try again
          </Button>
        </div>
      </div>
    )

  const titleOf = (id: string): string =>
    id === HELM
      ? 'Helm releases'
      : (BUILTIN_KINDS.find((b) => b.id === id)?.title ??
        kinds?.find((k) => k.id === id)?.kind ??
        id)
  const hintItems: (readonly [string, string])[] = [
    [':', 'go to'],
    ['/', 'filter'],
    ['Enter', drillable ? 'pods' : 'details'],
    ...(single
      ? actionsFor(kindId, single.obj, readOnly, handlers)
          .filter((x) => x.key && !x.danger)
          .slice(0, 3)
          .map((x) => [keyLabel(x.key ?? ''), x.label.replace(/…$/, '').toLowerCase()] as const)
      : []),
    ['Esc', 'back']
  ]
  const allKeys = [
    {
      title: 'Navigate',
      keys: [
        [':', 'Go to a resource, namespace or context'],
        ['/', 'Filter the list'],
        ['↑ ↓', 'Move'],
        ['Enter', 'Pods of it / details'],
        ['d', 'Details'],
        ['0', 'All namespaces'],
        ['Esc', 'Back / close']
      ] as const
    },
    {
      title: 'Selected resource',
      keys: [
        ['l', 'Logs'],
        ['s', 'Open shell'],
        ['f', 'Forward a port'],
        ['y', 'View YAML'],
        ['e', 'Edit YAML'],
        ['S', 'Scale'],
        ['r', 'Restart (drain for nodes)'],
        ['h', 'Rollout history'],
        ['c', 'Cordon / uncordon'],
        ['t', 'Run CronJob now'],
        ['Ctrl+D', 'Delete'],
        ['Ctrl+K', 'Force delete']
      ] as const
    }
  ]

  return (
    <div
      ref={rootRef}
      className="relative flex h-full flex-col bg-surface"
      data-testid="k8s-view"
      data-tab={tabId}
      data-ready={ready && (loaded || onOverview)}
    >
      {/* Thanh trên: context, namespace, lọc / lệnh, thao tác chung. */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-2">
        <IconButton
          label={navHidden ? 'Show the resource list' : 'Hide the resource list'}
          size="sm"
          active={!navHidden}
          data-testid="k8s-nav-toggle"
          onClick={() => {
            setNavHidden(!navHidden)
            try {
              window.localStorage.setItem(NAV_HIDDEN_KEY, navHidden ? '0' : '1')
            } catch {
              // Bỏ qua: không lưu được thì chỉ áp dụng cho lần này.
            }
          }}
        >
          <PanelLeft size={14} />
        </IconButton>
        <ContextPicker
          current={contextKey(params.ref)}
          label={params.label}
          color={entry?.settings.color ? COLOR_DOT[entry.settings.color] : 'bg-line-strong'}
          version={cluster?.version}
          contexts={contexts
            .filter((c) => !c.settings.hidden)
            .map((c) => ({
              key: c.key,
              name: c.name,
              source: c.sourceLabel,
              color: c.settings.color ? COLOR_DOT[c.settings.color] : 'bg-line-strong'
            }))}
          onPick={switchContext}
        />
        <NamespacePicker
          all={allNamespaces}
          value={namespaces ?? []}
          onChange={(v) => {
            setNamespaces(v)
            setSelected(new Set())
          }}
        />
        <div className="relative min-w-0 flex-1">
          <div
            className={cx(
              'flex h-8 items-center gap-1.5 rounded-md border bg-subtle px-2',
              commandMode ? 'border-accent ring-3 ring-accent/20' : 'border-line'
            )}
          >
            {commandMode ? (
              <Terminal size={13} className="text-accent" />
            ) : (
              <Search size={13} className="text-faint" />
            )}
            <input
              ref={inputRef}
              type="search"
              spellCheck={false}
              placeholder="Filter…   ( : command · / filter )"
              data-testid="k8s-filter"
              className="min-w-0 flex-1 bg-transparent font-mono text-xs text-fg outline-none placeholder:font-sans placeholder:text-faint"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setSuggestAt(0)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setQuery('')
                  focusGrid(rootRef.current)
                } else if (commandMode && e.key === 'ArrowDown') {
                  e.preventDefault()
                  setSuggestAt((i) => Math.min(i + 1, suggestions.length - 1))
                } else if (commandMode && e.key === 'ArrowUp') {
                  e.preventDefault()
                  setSuggestAt((i) => Math.max(i - 1, 0))
                } else if (commandMode && e.key === 'Tab') {
                  e.preventDefault()
                  const sg = suggestions[suggestAt]
                  if (sg) setQuery(`:${sg.value}`)
                } else if (e.key === 'Enter') {
                  e.preventDefault()
                  if (commandMode) {
                    const typed = query.slice(1).trim()
                    const sg = suggestions[suggestAt]
                    // Gõ đủ lệnh → chạy đúng lệnh đã gõ; không thì lấy gợi ý đang chọn.
                    runCommand(parseCommand(typed, kinds ?? []) || !sg ? typed : sg.value)
                  } else focusGrid(rootRef.current)
                }
              }}
            />
          </div>
          {commandMode && suggestions.length > 0 && (
            <div
              className="absolute top-9 right-0 left-0 z-30 max-h-72 overflow-auto rounded-md border border-line bg-elevated p-1 shadow-lg"
              data-testid="k8s-command-suggestions"
            >
              {suggestions.map((sg, i) => (
                <button
                  key={`${sg.value}${sg.label}`}
                  type="button"
                  className={cx(
                    'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs',
                    i === suggestAt ? 'bg-accent-soft text-fg' : 'text-muted hover:bg-hover'
                  )}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    if (sg.value.endsWith(' ')) setQuery(`:${sg.value}`)
                    else runCommand(sg.value)
                  }}
                >
                  <span className="flex-1 text-fg">{sg.label}</span>
                  <span className="font-mono text-faint">:{sg.hint}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {readOnly && (
          <span
            className="flex items-center gap-1 rounded bg-warning-soft px-1.5 py-px text-xs font-medium text-warning"
            data-testid="k8s-read-only"
          >
            <Eye size={12} /> Read-only
          </span>
        )}
        {!readOnly && (
          <Button
            size="sm"
            variant="ghost"
            icon={<Plus size={13} />}
            data-testid="k8s-create"
            title="Create or update objects from YAML"
            onClick={() => {
              setDialog({ kind: 'yaml', mode: 'create', title: 'Create from YAML', text: '' })
            }}
          >
            Create
          </Button>
        )}
        <Button
          size="sm"
          variant={showForwards ? 'secondary' : 'ghost'}
          icon={<ArrowLeftRight size={13} />}
          title="Port forwards"
          data-testid="k8s-forwards-toggle"
          onClick={() => {
            setShowForwards(!showForwards)
          }}
        >
          {forwards.length ? String(forwards.length) : null}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Reload"
          icon={<RefreshCw size={13} />}
          onClick={() => {
            setReloadKey((n) => n + 1)
          }}
        />
      </div>

      <div className="flex min-h-0 flex-1">
        {!navHidden && (
          <ResourceNav
            kinds={kinds}
            view={view}
            drilled={Boolean(top)}
            counts={
              // Loại đang xem: số sống theo bảng (watch), không đợi lần đếm sau.
              !top && list.objects ? { ...counts, [view]: list.objects.size } : counts
            }
            onGo={go}
          />
        )}

        <div ref={tableRef} className="@container flex min-w-0 flex-1 flex-col">
          {!onOverview && (
            <div
              className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-3 text-xs"
              data-testid="k8s-breadcrumb"
            >
              <button
                type="button"
                className={cx('font-medium', top ? 'text-muted hover:text-fg' : 'text-fg')}
                onClick={() => {
                  setDrill([])
                }}
              >
                {titleOf(view)}
              </button>
              {drill.map((d, i) => (
                <span key={d.label} className="flex items-center gap-1">
                  <ChevronRight size={12} className="text-faint" />
                  <button
                    type="button"
                    className={i === drill.length - 1 ? 'text-fg' : 'text-muted hover:text-fg'}
                    onClick={() => {
                      setDrill((x) => x.slice(0, i + 1))
                    }}
                  >
                    {d.label}
                  </button>
                  <span className="text-faint">· pods</span>
                </span>
              ))}
              <span className="ml-auto text-faint tabular-nums" data-testid="k8s-count">
                {list.objects ? `${rows.length}${q ? ` of ${list.objects.size}` : ''}` : ''}
              </span>
            </div>
          )}
          {(list.error ?? notice) && (
            <div className="border-b border-line p-2">
              <Notice tone={list.error ? 'danger' : (notice?.tone ?? 'danger')} testId="k8s-notice">
                <span className="flex items-center gap-2">
                  <span className="flex-1">{list.error ?? notice?.text}</span>
                  {notice && !list.error && (
                    <button
                      type="button"
                      aria-label="Dismiss"
                      onClick={() => {
                        setNotice(null)
                      }}
                    >
                      <X size={12} />
                    </button>
                  )}
                </span>
              </Notice>
            </div>
          )}
          {!ready ? (
            <div
              className="flex flex-1 items-center justify-center text-xs text-faint"
              data-testid="k8s-status"
            >
              {session.status}
            </div>
          ) : onHelm ? (
            namespaces === null ? null : (
              <HelmView request={request} namespaces={namespaces} active={active} filter={query} />
            )
          ) : onOverview ? (
            namespaces === null ? null : (
              <ClusterOverview
                request={request}
                namespaces={namespaces}
                active={active}
                onNavigate={go}
              />
            )
          ) : !loaded ? (
            <div
              className="flex flex-1 items-center justify-center text-xs text-faint"
              data-testid="k8s-status"
            >
              Loading…
            </div>
          ) : (
            <FileTable
              items={rows}
              getKey={(r) => r.row.key}
              getLabel={(r) => r.row.name}
              icon={(r) => <Box size={14} className={TONE_TEXT[TONE[r.row.tone]]} />}
              columns={columns}
              gridClass=""
              gridStyle={{ gridTemplateColumns: fit.template }}
              nameSort={{ key: 'name', label: 'Name', kind: 'text' }}
              sort={sort}
              onSort={setSort}
              selected={selected}
              onSelect={(sel) => {
                setSelected(sel)
                // Chi tiết đang mở → đi theo dòng chọn.
                if (detailKey && sel.size === 1) setDetailKey([...sel][0] ?? null)
              }}
              onOpen={open}
              onContextMenu={(e, items) => {
                const first = items[0]
                const copyNames: MenuEntry = {
                  id: 'copy-name',
                  label: items.length > 1 ? `Copy ${items.length} names` : 'Copy name',
                  icon: <Copy size={14} />,
                  onSelect: () =>
                    void window.shellhouse.writeClipboard(items.map((r) => r.row.name).join('\n'))
                }
                if (first && items.length === 1)
                  openMenu(e, [
                    {
                      id: 'describe',
                      label: 'Describe',
                      hint: 'd',
                      onSelect: () => {
                        setDetailKey(first.row.key)
                      }
                    },
                    copyNames,
                    ...toMenu(actionsFor(kindId, first.obj, readOnly, handlers))
                  ])
                else if (items.length > 1) openMenu(e, [copyNames])
              }}
              ariaLabel={kind?.kind ?? 'Resources'}
              rowTestId="k8s-row"
            >
              {rows.length === 0 && (
                <Empty
                  icon={<Box size={18} />}
                  title={q ? 'Nothing matches' : 'Nothing here'}
                  text={
                    q
                      ? 'Try another filter.'
                      : `No ${titleOf(kindId).toLowerCase()} in ${scopeNs.length ? scopeNs.join(', ') : 'any namespace'}.`
                  }
                  action={null}
                />
              )}
            </FileTable>
          )}
          {showForwards && (
            <div
              className="max-h-44 shrink-0 overflow-auto border-t border-line p-2 text-xs"
              data-testid="k8s-forwards"
            >
              <div className="mb-1 text-[11px] font-semibold tracking-wider text-faint uppercase">
                Port forwards
              </div>
              {forwards.length === 0 ? (
                <p className="text-faint">None. Select a pod or service and press f.</p>
              ) : (
                forwards.map((f) => (
                  <div
                    key={f.id}
                    className="flex items-center gap-2 py-0.5"
                    data-testid="k8s-forward"
                  >
                    <span className="font-mono text-fg">localhost:{f.localPort}</span>
                    <span className="text-faint">→</span>
                    <span className="truncate text-muted">
                      {f.namespace}/{f.target}:{f.remotePort}
                    </span>
                    <span className="text-faint">{f.connections} open</span>
                    {f.error && <span className="truncate text-danger">{f.error}</span>}
                    <div className="flex-1" />
                    <button
                      type="button"
                      title="Copy address"
                      className="text-faint hover:text-fg"
                      onClick={() =>
                        void window.shellhouse.writeClipboard(`localhost:${f.localPort}`)
                      }
                    >
                      <Copy size={12} />
                    </button>
                    <button
                      type="button"
                      title="Stop"
                      className="text-faint hover:text-danger"
                      onClick={() => void request({ op: 'portForward.stop', id: f.id })}
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {detail && (
          <Detail
            key={detail.row.key}
            kindId={kindId}
            obj={detail.obj}
            request={request}
            actions={actionsFor(kindId, detail.obj, readOnly, handlers)}
            usage={kindId === 'pods' ? (history[objectKey(detail.obj)] ?? null) : null}
            nodeUsage={kindId === 'nodes' ? (metrics?.items[objectKey(detail.obj)] ?? null) : null}
            onClose={() => {
              setDetailKey(null)
            }}
            onOpenPod={(pod) => {
              setDrill([])
              setView('pods')
              setSelected(new Set([objectKey(pod)]))
              setDetailTab('overview')
              setDetailKey(objectKey(pod))
            }}
            initialTab={detailTab}
            onNavigate={(kind, name) => {
              openRelated(detail.obj, kind, name)
            }}
            {...(HAS_PODS.includes(kindId)
              ? {
                  onShowPods: () => {
                    drillPods(detail.obj)
                  }
                }
              : {})}
          />
        )}
      </div>

      <KeyHints items={hintItems} all={allKeys} open={helpOpen} onOpenChange={setHelpOpen} />

      {session.prompt && <ConnectionPrompt prompt={session.prompt} onAnswer={session.answer} />}
      {dialog?.kind === 'yaml' && (
        <YamlEditor
          title={dialog.title}
          initial={dialog.text}
          mode={dialog.mode}
          namespace={scopeNs.length === 1 ? scopeNs[0] : undefined}
          request={request}
          onClose={() => {
            setDialog(null)
          }}
          onDone={(t) => {
            notify(t)
          }}
        />
      )}
      {dialog?.kind === 'delete' && (
        <DeleteDialog
          obj={dialog.obj}
          force={dialog.force}
          production={production}
          onClose={() => {
            setDialog(null)
          }}
          onDelete={() => {
            const { obj, force } = dialog
            setDialog(null)
            if (detailKey === objectKey(obj)) setDetailKey(null)
            run('Delete failed', () =>
              request({
                op: 'delete',
                kind: kindId,
                ...nsOf(obj),
                name: obj.metadata.name,
                ...(force ? { force: true } : {})
              })
            )
          }}
        />
      )}
      {dialog?.kind === 'forward' && (
        <ForwardDialog
          obj={dialog.obj}
          ports={dialog.ports}
          onClose={() => {
            setDialog(null)
          }}
          onForward={(local, remote) => {
            const t = dialog.obj
            setDialog(null)
            setShowForwards(true)
            run('Port forward failed', () =>
              request({
                op: 'portForward',
                namespace: t.metadata.namespace ?? '',
                target: `${kindId === 'pods' ? 'pod' : 'service'}/${t.metadata.name}`,
                ports: [[local, remote]]
              })
            )
          }}
        />
      )}
      {dialog?.kind === 'scale' && (
        <ScaleDialog
          obj={dialog.obj}
          production={production}
          onClose={() => {
            setDialog(null)
          }}
          onScale={(replicas) => {
            const t = dialog.obj
            setDialog(null)
            run(
              'Scale failed',
              () =>
                request({
                  op: 'scale',
                  kind: kindId as 'deployments.apps',
                  namespace: t.metadata.namespace ?? '',
                  name: t.metadata.name,
                  replicas
                }),
              `Scaling ${t.metadata.name} to ${replicas}`
            )
          }}
        />
      )}
      {dialog?.kind === 'drain' && (
        <DrainDialog
          node={dialog.obj}
          request={request}
          onClose={() => {
            setDialog(null)
          }}
        />
      )}
      {dialog?.kind === 'history' && (
        <HistoryDialog
          obj={dialog.obj}
          request={request}
          readOnly={readOnly}
          onClose={() => {
            setDialog(null)
          }}
          onDone={(t) => {
            notify(t)
          }}
        />
      )}
      {menu}
    </div>
  )
}

/** Hộp thả xuống đóng khi bấm ra ngoài. */
function useOutsideClose(open: boolean, close: () => void): React.RefObject<HTMLDivElement | null> {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!box.current?.contains(e.target as Node)) close()
    }
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('mousedown', onDown)
    }
  }, [open, close])
  return box
}

function ContextPicker({
  current,
  label,
  color,
  version,
  contexts,
  onPick
}: {
  current: string
  label: string
  color: string
  version: string | undefined
  contexts: { key: string; name: string; source: string; color: string }[]
  onPick: (key: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => {
    setOpen(false)
  }, [])
  const box = useOutsideClose(open, close)
  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        data-testid="k8s-context-picker"
        className="flex h-8 max-w-56 items-center gap-2 rounded-md px-2 hover:bg-hover"
        onClick={() => {
          setOpen(!open)
        }}
      >
        <span className={cx('size-2 shrink-0 rounded-full', color)} />
        <span
          className="truncate text-[13px] font-semibold text-fg"
          data-testid="k8s-context-label"
        >
          {label}
        </span>
        {version && <span className="text-[11px] text-faint">{version}</span>}
        <span className="text-faint">▾</span>
      </button>
      {open && (
        <div
          className="absolute top-9 left-0 z-30 max-h-80 w-72 overflow-auto rounded-md border border-line bg-elevated p-1 shadow-lg"
          data-testid="k8s-context-menu"
        >
          {contexts.map((c) => (
            <button
              key={c.key}
              type="button"
              data-testid="k8s-context-option"
              data-name={c.name}
              className={cx(
                'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-hover',
                c.key === current && 'bg-accent-soft'
              )}
              onClick={() => {
                setOpen(false)
                if (c.key !== current) onPick(c.key)
              }}
            >
              <span className={cx('size-2 shrink-0 rounded-full', c.color)} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-fg">{c.name}</span>
                <span className="block truncate text-faint">{c.source}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function NamespacePicker({
  all,
  value,
  onChange
}: {
  all: string[]
  value: string[]
  onChange: (v: string[]) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const close = useCallback(() => {
    setOpen(false)
  }, [])
  const box = useOutsideClose(open, close)
  const label =
    value.length === 0
      ? 'All namespaces'
      : value.length === 1
        ? value[0]
        : `${value.length} namespaces`
  const shown = all.filter((n) => n.includes(filter.trim()))
  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        data-testid="k8s-namespace"
        className="h-8 max-w-48 truncate rounded-md border border-line bg-surface px-2 text-xs text-fg hover:border-line-strong"
        onClick={() => {
          setOpen(!open)
        }}
      >
        {label} ▾
      </button>
      {open && (
        <div
          className="absolute top-9 left-0 z-30 w-60 rounded-md border border-line bg-elevated p-1 shadow-lg"
          data-testid="k8s-namespace-menu"
        >
          {all.length > 8 && (
            <input
              autoFocus
              placeholder="Find namespace…"
              className="mb-1 h-7 w-full rounded border border-line bg-subtle px-2 text-xs text-fg outline-none"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value)
              }}
            />
          )}
          <div className="max-h-72 overflow-auto">
            <button
              type="button"
              className={cx(
                'block w-full rounded px-2 py-1 text-left text-xs hover:bg-hover',
                value.length === 0 && 'font-medium text-accent'
              )}
              onClick={() => {
                onChange([])
                setOpen(false)
              }}
            >
              All namespaces
            </button>
            {shown.map((ns) => (
              <label
                key={ns}
                className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-hover"
              >
                <input
                  type="checkbox"
                  data-testid={`k8s-ns-${ns}`}
                  checked={value.includes(ns)}
                  onChange={(e) => {
                    onChange(e.target.checked ? [...value, ns] : value.filter((v) => v !== ns))
                  }}
                />
                <span className="truncate">{ns}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
