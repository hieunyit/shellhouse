import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeftRight,
  PanelLeft,
  Box,
  ChevronRight,
  Copy,
  FileCode,
  Eye,
  Plus,
  RefreshCw,
  Search,
  Ship,
  Tag,
  Terminal,
  TerminalSquare,
  X
} from 'lucide-react'
import { Button, cx, IconButton, Notice } from '../../../renderer/src/components/ui'
import { useContextMenu, type MenuEntry } from '../../../renderer/src/components/ContextMenu'
import { FileTable, type FileColumn } from '../../../renderer/src/components/files/FileTable'
import { Empty } from '../../../renderer/src/components/files/parts'
import { KeyHints, Pill, TONE_TEXT, type Tone } from '../../../renderer/src/components/panels'
import type { SortState } from '../../../renderer/src/components/SortMenu'
import { cleanError } from '../../../renderer/src/lib/format'
import { formatNumber, language, t, tn, toast } from '../../registry/renderer-kit'
import { tk } from './i18n'
import { KindIcon } from './icons'
import type { FormKind } from '../shared/forms'
import {
  ConnectionPrompt,
  ExplorerNav,
  setModuleTabParams,
  environmentFromColor,
  showCommands,
  useEnvironments,
  useNavPlacement,
  useReportEnvironment,
  useSourceEnvironmentMap
} from '../../registry/renderer-kit'
import { findEnvironment } from '@shared/environments'
import { listCommands } from '../shared/commands'
import { EnvLabel } from '../../../renderer/src/ds'
import { KubernetesIcon } from '../../registry/renderer-icons'
import type { ModuleTabProps } from '../../registry/renderer-types'
import { contextKey, COUNT_CAPPED, type K8sClusterParams } from '../shared/ops'
import {
  BUILTIN_KINDS,
  COLUMNS,
  formatCpu,
  formatMemory,
  parseCpu,
  parseMemory,
  selectorString,
  type K8sObject,
  type ResourceRow
} from '../shared/resources'
import { actionsFor, HAS_PODS, keyLabel, toMenu } from './actions'
import { openPodLogs, openPodShell } from './api'
import { Detail, RELATED_KINDS, type DetailTab } from './Detail'
import { useContextEnvironment } from './K8sSection'
import { HelmView } from './HelmView'
import { MapView } from './MapView'
import type { MapRef } from './mapModel'
import { HELM, MAP, OVERVIEW, parseCommand, suggest } from './nav'
import { ClusterOverview } from './Overview'
import { useK8s } from './store'
import { fitColumns } from '../shared/columns'
import { ResourceNav } from './ResourceNav'
import { useK8sSession } from './useK8sSession'
import { objectKey, useResourceList, type EventBus } from './useResourceList'
import { GuardProvider, useGuardProvider } from './confirm'
import { ContextPicker, NamespacePicker } from './Pickers'
import { ForwardsPanel } from './ForwardsPanel'
import { cellTone, type Row } from '../shared/rows'
import { ClusterDialogs, type Dialog } from './ClusterDialogs'
import { useClusterCatalog, useClusterMetrics } from './useClusterData'
import { focusGrid, useClusterKeys } from './useClusterKeys'
import { notify, useK8sActions } from './useK8sActions'
import { useResourceRows } from './useResourceRows'
import { BULK_KEYS, BulkBar, bulkKinds, copyYaml, type BulkKind } from './Bulk'
import { EventsView } from './Events'

/** Đang xem loại nào → mở form của loại đó khi bấm Create. */
const FORM_FOR_KIND: Record<string, FormKind> = {
  'deployments.apps': 'Deployment',
  'statefulsets.apps': 'StatefulSet',
  'daemonsets.apps': 'DaemonSet',
  'jobs.batch': 'Job',
  'cronjobs.batch': 'CronJob',
  services: 'Service',
  'ingresses.networking.k8s.io': 'Ingress',
  configmaps: 'ConfigMap',
  secrets: 'Secret',
  persistentvolumeclaims: 'PersistentVolumeClaim',
  'horizontalpodautoscalers.autoscaling': 'HorizontalPodAutoscaler',
  namespaces: 'Namespace'
}

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

const NAV_HIDDEN_KEY = 'shellhouse.k8s.navHidden'

interface Drill {
  /** Breadcrumb: "deployment/web". */
  label: string
  kind: string
  namespace?: string | undefined
  labelSelector?: string | undefined
  fieldSelector?: string | undefined
}

/** Tab một cluster (context) — điều hướng kiểu k9s, chi tiết kiểu Lens. */
export function ClusterTab({
  tabId,
  params,
  active
}: ModuleTabProps<K8sClusterParams>): React.JSX.Element {
  const contexts = useK8s((st) => st.contexts)
  const entry = contexts.find((c) => c.key === contextKey(params.ref))
  // Môi trường của context (Settings › Environments; context cũ màu đỏ = Production): nhãn trên
  // header, vạch trên cùng, chỉ đọc mặc định, mức xác nhận khi xoá ("Type name" = gõ tên).
  const env = useContextEnvironment(contextKey(params.ref), entry?.settings.color ?? null)
  const environments = useEnvironments()
  const sourceEnvs = useSourceEnvironmentMap()
  useReportEnvironment(tabId, env?.id)
  /** Cài đặt chỉ đọc của context (gửi khi connect) — hoặc môi trường mặc định chỉ đọc. */
  const readOnlySetting = (entry?.settings.readOnly ?? false) || env?.readOnly === true
  const production = env?.confirm === 'type'
  const [view, setView] = useState<string>('pods')
  const [drill, setDrill] = useState<Drill[]>([])
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
  /** Số port-forward (nút trên thanh) — danh sách do ForwardsPanel tự giữ. */
  const [forwardCount, setForwardCount] = useState(0)
  const [showForwards, setShowForwards] = useState(false)
  const openForwards = useCallback(() => {
    setShowForwards(true)
  }, [])
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
  const navPlacement = useNavPlacement()
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
      if (event === 'edit') {
        const d = data as { name: string; ok: boolean; error?: string }
        if (d.ok)
          toast.success(t('Saved {name} to the cluster', { name: d.name }), {
            group: `edit:${d.name}`
          })
        else
          toast.error(t('Could not save {name}', { name: d.name }), {
            description: d.error ?? t('Unknown error'),
            group: `edit:${d.name}`
          })
      }
    },
    [bus]
  )
  const session = useK8sSession(tabId, params.ref, params.bastionHostId, readOnlySetting, onEvent)
  const { ready, request, cluster } = session
  // Chỉ đọc thật sự = cài đặt ở đây HOẶC Session Host báo (gộp cài đặt lưu trong DB).
  const readOnly = readOnlySetting || cluster?.readOnly === true
  const guardProvider = useGuardProvider(production)
  const { guard } = guardProvider.value

  const refKey = contextKey(params.ref)
  const { kinds, allNamespaces, namespaces, setNamespaces, counts } = useClusterCatalog({
    ready,
    request,
    active,
    reloadKey,
    refKey,
    initialNamespace: params.namespace,
    clusterNamespace: cluster?.namespace
  })

  const top = drill.at(-1)
  const kindId = top?.kind ?? view
  const kind = kinds?.find((k) => k.id === kindId) ?? BUILTIN_KINDS.find((k) => k.id === kindId)
  const scopeNs = top?.namespace ? [top.namespace] : (namespaces ?? [])
  const onOverview = view === OVERVIEW && !top
  const onMap = view === MAP && !top
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

  const { metrics, metricScope } = useClusterMetrics({ ready, request, active, kindId, scopeNs })

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

  const openRefLate = (k: string, ns: string | undefined, name: string): void => {
    openRef(k, ns, name)
  }
  const handlers = useK8sActions({
    params,
    refKey,
    kindId,
    kind,
    production,
    request,
    guard,
    setDialog,
    openRef: openRefLate
  })

  // ——— Dòng của bảng ———
  const commandMode = query.startsWith(':')
  const objects = list.objects
  const { rows, q, selector, single, detail } = useResourceRows({
    objects,
    kindId,
    query,
    sort,
    metrics,
    selected,
    detailKey,
    active
  })
  // Loại đang xem: số sống theo bảng (watch), không đợi lần đếm sau. Nhớ lại → thanh điều hướng
  // (memo) không vẽ lại theo mỗi lô watch khi số không đổi.
  const liveCount = !top && objects ? objects.size : null
  const truncated = list.truncated !== null
  const navCounts = useMemo(
    () =>
      liveCount === null
        ? counts
        : {
            ...counts,
            [view]: liveCount,
            // Bảng bị cắt ở số trang tối đa → số trong bảng cũng chỉ là mức tối thiểu.
            [`${COUNT_CAPPED}${view}`]: truncated ? 1 : null
          },
    [counts, view, liveCount, truncated]
  )
  const multiNs = kind?.namespaced === true && scopeNs.length !== 1
  const showMetrics = Boolean(metricScope && metrics?.available)
  const allColumns = useMemo<FileColumn<Row, 'name' | 'age' | 'cpu' | 'mem'>[]>(() => {
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
    return [
      ...(multiNs ? [{ id: 'ns', label: 'Namespace', render: (r: Row) => r.row.namespace }] : []),
      ...(COLUMNS[kindId] ?? []).map((c) => ({
        id: c.id,
        // Nhãn cột là hằng tiếng Anh (shared/resources) → dịch lúc vẽ.
        label: tk(c.label),
        render: (r: Row) => {
          const text = r.row.cells[c.id] ?? ''
          const tone =
            c.id === 'status'
              ? TONE[r.row.tone]
              : c.id === 'health' || c.id === 'sync'
                ? argoTone(text)
                : null
          if (tone && text)
            return (
              <span className="min-w-0" title={text}>
                <Pill tone={tone}>{text}</Pill>
              </span>
            )
          const cell = cellTone(c.id, text, r.row.tone)
          return cell ? <span className={cx('font-medium', TONE_TEXT[cell])}>{text}</span> : text
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
              label: t('Memory'),
              align: 'right' as const,
              sort: { key: 'mem' as const, label: t('Memory'), kind: 'number' as const },
              render: (r: Row) => usageCell(r, 'memory')
            }
          ]
        : []),
      {
        id: 'age',
        label: t('Age'),
        align: 'right',
        sort: { key: 'age', label: t('Age'), kind: 'date' },
        render: (r) => r.row.cells['age'] ?? ''
      }
    ]
  }, [multiNs, kindId, showMetrics, metrics])
  const fit = useMemo(
    () =>
      fitColumns(
        allColumns.map((c) => c.id),
        tableWidth,
        { wide: kindId === 'nodes' }
      ),
    [allColumns, tableWidth, kindId]
  )
  const columns = useMemo(() => allColumns.filter((c) => fit.keep.has(c.id)), [allColumns, fit])

  const drillable = kindId === 'nodes' || kindId === 'namespaces'

  /** Pod của workload / service trong bảng chính, có breadcrumb (kiểu k9s). */
  const drillPods = (o: K8sObject): void => {
    const sel = selectorString(o.spec?.['selector'])
    if (!sel) {
      notify(t('{name} has no pod selector', { name: o.metadata.name }), 'danger')
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

  /** Từ bản đồ: namespace → xem tài nguyên của nó; còn lại → bảng của loại đó + chi tiết. */
  const openFromMap = (ref: MapRef): void => {
    if (ref.kind === 'namespaces') {
      setNamespaces([ref.name])
      go('pods')
      return
    }
    openRef(ref.kind, ref.ns, ref.name)
  }

  const openRef = (kind: string, ns: string | undefined, name: string): void => {
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
    // Dữ liệu của context cũ được bỏ khi params.ref đổi (xem refKey ở trên).
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
      notify(t('Unknown command “{command}”', { command: text.replace(/^:/, '') }), 'danger')
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
        notify(t('No context “{name}”', { name: cmd.name }), 'danger')
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
    if (selected.size > 1) {
      setSelected(new Set())
      return true
    }
    return false
  }

  // ——— Chọn nhiều dòng → thao tác hàng loạt ———
  const selectedRows = rows.filter((r) => selected.has(r.row.key))
  const multi = selectedRows.length > 1
  const bulkAvailable = bulkKinds(kindId, readOnly)
  const runBulk = (action: BulkKind, list = selectedRows): void => {
    if (list.length === 0) return
    setDialog({ kind: 'bulk', action, objects: list.map((r) => r.obj) })
  }
  const copyNames = (list = selectedRows): void => {
    void window.shellhouse.writeClipboard(list.map((r) => r.row.name).join('\n')).then(() => {
      toast.success(tn(list.length, 'Copied {n} name', 'Copied {n} names'))
    })
  }
  const copyYamlOf = (list = selectedRows): void => {
    copyYaml(
      request,
      kindId,
      list.map((r) => r.obj)
    ).catch((e: unknown) => {
      notify(cleanError(e), 'danger')
    })
  }
  const toggleRow = (key: string): void => {
    const next = new Set(selected)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setSelected(next)
  }
  const allChecked = rows.length > 0 && selectedRows.length === rows.length

  // ——— Phím tắt (kiểu k9s) ———
  const loaded = list.objects !== null
  useClusterKeys(rootRef, {
    active,
    ready,
    loaded,
    kindId,
    readOnly,
    dialogOpen: dialog !== null,
    helpOpen,
    setHelpOpen,
    single,
    handlers,
    focusFilter: (command) => {
      setQuery(command ? ':' : '')
      inputRef.current?.focus()
    },
    allNamespaces: () => {
      setNamespaces([])
    },
    openDetail: setDetailKey,
    back,
    multiCount: selectedRows.length,
    bulk: (key) => {
      const action = BULK_KEYS[key]
      if (!action || !bulkAvailable.includes(action)) return false
      runBulk(action)
      return true
    },
    selectAll: () => {
      setSelected(new Set(rows.map((r) => r.row.key)))
    }
  })

  if (session.error)
    return (
      <div className="flex h-full items-center justify-center bg-canvas p-6" data-testid="k8s-view">
        <div className="flex max-w-md flex-col items-center gap-3 text-center">
          <Ship size={28} className="text-faint" />
          <p className="text-sm text-fg" data-testid="k8s-error">
            {session.error}
          </p>
          <Button size="sm" icon={<RefreshCw size={13} />} onClick={session.retry}>
            {t('Try again')}
          </Button>
        </div>
      </div>
    )

  const titleOf = (id: string): string =>
    id === HELM
      ? t('Helm releases')
      : (BUILTIN_KINDS.find((b) => b.id === id)?.title ??
        kinds?.find((k) => k.id === id)?.kind ??
        id)
  /** Nhãn thao tác → gợi ý phím viết thường ("View YAML…" → "view yaml"; tiếng Việt chỉ hạ chữ đầu). */
  const hintLabel = (label: string): string => {
    const text = label.replace(/…$/, '')
    return language() === 'en'
      ? text.toLowerCase()
      : `${text.charAt(0).toLocaleLowerCase()}${text.slice(1)}`
  }
  const tableHints: (readonly [string, string])[] = [
    [':', t('go to')],
    ['/', t('filter')],
    ['Enter', drillable ? 'pods' : t('details')],
    ...(single
      ? actionsFor(kindId, single.obj, readOnly, handlers)
          .filter((x) => x.key && !x.danger)
          .slice(0, 3)
          .map((x) => [keyLabel(x.key ?? ''), hintLabel(x.label)] as const)
      : []),
    ['Esc', t('back')]
  ]
  const hintItems: (readonly [string, string])[] = onMap
    ? [
        [t('Drag'), t('move')],
        [t('Scroll'), t('zoom')],
        [t('Double-click'), t('zoom in')],
        ['/', t('find')],
        ['0', t('fit')],
        ['Enter', t('open')],
        ['Esc', t('clear')]
      ]
    : tableHints

  const allKeys = [
    {
      title: t('Navigate'),
      keys: [
        [':', t('Go to a resource, namespace or context')],
        ['/', t('Filter the list')],
        ['↑ ↓', t('Move')],
        ['Enter', t('Pods of it / details')],
        ['d', t('Details')],
        ['0', t('All namespaces')],
        ['Esc', t('Back / close')]
      ] as const
    },
    {
      title: t('Selected resource'),
      keys: [
        ['l', t('Logs')],
        ['s', t('Open shell')],
        ['f', t('Forward a port')],
        ['y', t('View YAML')],
        ['e', t('Edit YAML')],
        ['S', t('Scale')],
        ['r', t('Restart (drain for nodes)')],
        ['h', t('Rollout history')],
        ['c', t('Cordon / uncordon')],
        ['b', t('Debug (ephemeral container / node)')],
        ['t', t('Run CronJob now')],
        ['Ctrl+D', t('Delete')],
        ['Ctrl+K', t('Force delete')]
      ] as const
    },
    {
      title: t('Several selected'),
      keys: [
        ['Shift+click', t('Select a range')],
        ['Ctrl+click', t('Add / remove a row')],
        ['Ctrl+A', t('Select all rows')],
        ['Ctrl+D', t('Delete the selected objects')],
        ['r', t('Restart / S: scale / c: cordon')],
        ['Esc', t('Clear the selection')]
      ] as const
    }
  ]

  return (
    <GuardProvider value={guardProvider.value}>
      <div
        ref={rootRef}
        className="relative flex h-full flex-col bg-surface"
        data-testid="k8s-view"
        data-tab={tabId}
        data-ready={ready && (loaded || onOverview || onMap)}
      >
        {/* Header (thiết kế v0.5): Kubernetes / context ⇅ / namespace / loại tài nguyên + nhãn môi
            trường; thao tác chung bên phải. z-40: menu thả xuống của header nằm trên thanh công cụ của
            Map (z-30) và bảng chi tiết. */}
        <div className="relative z-40 flex h-ds-header shrink-0 items-center gap-1 border-b border-ds-border-subtle pr-2 pl-3">
          {navPlacement === 'inline' && (
            <IconButton
              label={navHidden ? t('Show the resource list') : t('Hide the resource list')}
              size="sm"
              active={!navHidden}
              data-testid="k8s-nav-toggle"
              className="mr-1"
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
          )}
          <span className="flex shrink-0 items-center gap-1.5 px-1 text-[13px] font-medium text-muted">
            <KubernetesIcon size={14} strokeWidth={1.5} className="text-faint" aria-hidden />
            Kubernetes
          </span>
          <span aria-hidden className="shrink-0 text-ds-fg-disabled">
            /
          </span>
          <ContextPicker
            current={contextKey(params.ref)}
            label={params.label}
            version={cluster?.version}
            contexts={contexts
              .filter((c) => !c.settings.hidden)
              .map((c) => {
                const ctxEnv = findEnvironment(
                  environments,
                  sourceEnvs[`k8s:${c.key}`] ?? environmentFromColor(c.settings.color ?? null)
                )
                return {
                  key: c.key,
                  name: c.name,
                  source: c.sourceLabel,
                  ...(ctxEnv ? { env: ctxEnv } : {})
                }
              })}
            onPick={switchContext}
          />
          <span aria-hidden className="shrink-0 text-ds-fg-disabled">
            /
          </span>
          <div
            className="flex min-w-0 shrink items-center gap-1 px-1 text-[13px]"
            data-testid="k8s-breadcrumb"
          >
            <button
              type="button"
              className={cx(
                'shrink-0 truncate rounded-ds-sm font-semibold',
                top ? 'text-muted hover:text-fg' : 'text-fg'
              )}
              onClick={() => {
                setDrill([])
              }}
            >
              {titleOf(view)}
            </button>
            {drill.map((d, i) => (
              <span key={d.label} className="flex min-w-0 items-center gap-1">
                <ChevronRight size={12} className="shrink-0 text-faint" />
                <button
                  type="button"
                  className={cx(
                    'truncate',
                    i === drill.length - 1 ? 'font-semibold text-fg' : 'text-muted hover:text-fg'
                  )}
                  onClick={() => {
                    setDrill((x) => x.slice(0, i + 1))
                  }}
                >
                  {d.label}
                </button>
                <span className="shrink-0 text-faint">· pods</span>
              </span>
            ))}
          </div>
          <span className="ml-1 shrink-0">
            <NamespacePicker
              all={allNamespaces}
              value={namespaces ?? []}
              onChange={(v) => {
                setNamespaces(v)
                setSelected(new Set())
              }}
            />
          </span>
          {env && <EnvLabel env={env} size="md" className="ml-1.5" />}
          <div className="min-w-2 flex-1" />
          {readOnly && (
            <span
              className="flex items-center gap-1 rounded bg-warning-soft px-1.5 py-px text-xs font-medium text-warning"
              data-testid="k8s-read-only"
            >
              <Eye size={12} /> {t('Read-only')}
            </span>
          )}
          {!readOnly && (
            <span className="flex items-center">
              <Button
                size="sm"
                variant="primary"
                icon={<Plus size={13} />}
                data-testid="k8s-create"
                title={t('Create a resource with a form')}
                onClick={() => {
                  setDialog({ kind: 'create', initial: FORM_FOR_KIND[kindId] ?? 'Deployment' })
                }}
              >
                {t('Create')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                data-testid="k8s-create-yaml"
                title={t('Create or update objects from YAML')}
                onClick={() => {
                  setDialog({
                    kind: 'yaml',
                    mode: 'create',
                    title: t('Create from YAML'),
                    text: ''
                  })
                }}
              >
                YAML
              </Button>
            </span>
          )}
          <Button
            size="sm"
            variant={showForwards ? 'secondary' : 'ghost'}
            icon={<ArrowLeftRight size={13} />}
            title={t('Port forwards')}
            data-testid="k8s-forwards-toggle"
            onClick={() => {
              setShowForwards(!showForwards)
            }}
          >
            {forwardCount ? String(forwardCount) : null}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label={t('Reload')}
            icon={<RefreshCw size={13} />}
            onClick={() => {
              setReloadKey((n) => n + 1)
            }}
          />
        </div>

        {/* Chi tiết phóng to (trang đầy đủ) → ẩn bảng. */}
        <div className="flex min-h-0 flex-1 [&:has(>aside[data-expanded])>[data-main]]:hidden">
          <ExplorerNav active={active}>
            {(placement) =>
              placement === 'explorer' || !navHidden ? (
                <ResourceNav
                  kinds={kinds}
                  view={view}
                  drilled={Boolean(top)}
                  counts={navCounts}
                  onGo={go}
                  placement={placement}
                />
              ) : null
            }
          </ExplorerNav>

          <div ref={tableRef} data-main className="@container flex min-w-0 flex-1 flex-col">
            {/* Thanh công cụ: chọn tất cả · lọc / lệnh (:) · đếm. */}
            <div className="relative z-30 flex h-ds-toolbar shrink-0 items-center gap-2 border-b border-ds-border-subtle px-3 text-xs">
              {!onOverview && !onMap && !onHelm && kindId !== 'events' && rows.length > 0 && (
                <input
                  type="checkbox"
                  className="mr-1 size-3.5 shrink-0 accent-[var(--ds-accent)]"
                  aria-label={allChecked ? t('Clear the selection') : t('Select all rows')}
                  title={allChecked ? t('Clear the selection') : t('Select all rows (Ctrl+A)')}
                  data-testid="k8s-select-all"
                  checked={allChecked}
                  ref={(el) => {
                    if (el) el.indeterminate = selectedRows.length > 0 && !allChecked
                  }}
                  onChange={() => {
                    setSelected(allChecked ? new Set() : new Set(rows.map((r) => r.row.key)))
                  }}
                />
              )}
              <div className="relative w-72 max-w-[55%] min-w-40">
                <div
                  className={cx(
                    'flex h-ds-ctl items-center gap-1.5 rounded-ds-md border bg-subtle px-2',
                    commandMode
                      ? 'border-ds-accent ring-3 ring-ds-accent-soft'
                      : selector && !selector.ok
                        ? 'border-ds-danger ring-3 ring-ds-danger-soft'
                        : 'border-ds-border-control hover:border-faint'
                  )}
                  data-selector={selector ? (selector.ok ? 'ok' : 'error') : undefined}
                >
                  {commandMode ? (
                    <Terminal size={13} className="text-accent" />
                  ) : selector ? (
                    <Tag size={13} className={selector.ok ? 'text-ds-info' : 'text-ds-danger'} />
                  ) : (
                    <Search size={13} className="text-faint" />
                  )}
                  <input
                    ref={inputRef}
                    type="search"
                    spellCheck={false}
                    placeholder={t('Filter…   ( : command · / filter )')}
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
                  {selector?.ok && (
                    <span
                      className="shrink-0 rounded-ds-xs bg-ds-info-soft px-1 font-mono text-[11px] text-ds-info"
                      data-testid="k8s-selector-badge"
                      title={t('Label selector (kubectl -l)')}
                    >
                      -l · {selector.requirements.length}
                    </span>
                  )}
                </div>
                {selector && !selector.ok && (
                  <div
                    role="alert"
                    className="absolute top-9 right-0 left-0 z-30 rounded-ds-md bg-ds-popover px-2.5 py-1.5 text-xs text-ds-danger shadow-ds-popover"
                    data-testid="k8s-selector-error"
                  >
                    {selector.error}
                  </div>
                )}
                {commandMode && suggestions.length > 0 && (
                  <div
                    className="absolute top-9 right-0 left-0 z-30 max-h-72 overflow-auto rounded-md bg-ds-popover p-1 shadow-ds-popover"
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
              <div className="flex-1" />
              {!onOverview && !onMap && !onHelm && (
                <IconButton
                  label={t('Copy as command')}
                  size="sm"
                  data-testid="k8s-copy-command"
                  onClick={() => {
                    showCommands(
                      t('{kind} as kubectl', { kind: titleOf(view) }),
                      listCommands({
                        ref: params.ref,
                        kindId,
                        namespaces: namespaces && namespaces.length > 0 ? namespaces : null,
                        selector: selector?.ok ? selector.text : undefined
                      }).map((command) => ({ label: t('List'), command }))
                    )
                  }}
                >
                  <TerminalSquare size={14} />
                </IconButton>
              )}
              {!onOverview && !onMap && (
                <span className="text-faint tabular-nums" data-testid="k8s-count">
                  {list.objects
                    ? q
                      ? t('{shown} of {total}', {
                          shown: formatNumber(rows.length),
                          total: formatNumber(list.objects.size)
                        })
                      : formatNumber(rows.length)
                    : ''}
                </span>
              )}
            </div>
            {multi && !onOverview && !onMap && !onHelm && (
              <BulkBar
                count={selectedRows.length}
                kinds={bulkAvailable}
                onLogs={
                  kindId === 'pods'
                    ? () => {
                        // Mỗi namespace một tab log (kubectl logs chỉ trong một namespace).
                        const byNs = new Map<string, string[]>()
                        for (const r of selectedRows) {
                          const ns = r.obj.metadata.namespace ?? ''
                          byNs.set(ns, [...(byNs.get(ns) ?? []), r.obj.metadata.name])
                        }
                        for (const [ns, pods] of byNs)
                          openPodLogs({
                            ref: params.ref,
                            ...(params.bastionHostId
                              ? { bastionHostId: params.bastionHostId }
                              : {}),
                            namespace: ns,
                            pods: pods.slice(0, 20),
                            title: tn(pods.length, '{n} pod', '{n} pods')
                          })
                      }
                    : undefined
                }
                onRun={(k) => {
                  runBulk(k)
                }}
                onCopyNames={() => {
                  copyNames()
                }}
                onCopyYaml={() => {
                  copyYamlOf()
                }}
                onClear={() => {
                  setSelected(new Set())
                }}
              />
            )}
            {list.error && (
              <div className="border-b border-line p-2">
                <Notice tone="danger" testId="k8s-notice">
                  {list.error}
                </Notice>
              </div>
            )}
            {list.truncated !== null && !onOverview && !onMap && !onHelm && (
              <div className="border-b border-line p-2">
                <Notice tone="warning" testId="k8s-truncated">
                  {t(
                    'Showing the first {count} objects. Pick a namespace or open a narrower view to see the rest.',
                    { count: formatNumber(list.truncated) }
                  )}
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
                <HelmView
                  request={request}
                  namespaces={namespaces}
                  active={active}
                  filter={query}
                  readOnly={readOnly}
                />
              )
            ) : onMap ? (
              namespaces === null ? null : (
                <MapView
                  tabId={tabId}
                  request={request}
                  namespaces={namespaces}
                  active={active}
                  onOpen={openFromMap}
                  onLogs={(ref, labels) => {
                    const base = {
                      ref: params.ref,
                      ...(params.bastionHostId ? { bastionHostId: params.bastionHostId } : {}),
                      namespace: ref.ns ?? ''
                    }
                    if (ref.kind === 'pods') openPodLogs({ ...base, pod: ref.name })
                    else {
                      const selector = Object.entries(labels ?? {})
                        .map(([k, v]) => `${k}=${v}`)
                        .join(',')
                      if (!selector)
                        notify(t('{name} has no pod labels', { name: ref.name }), 'danger')
                      else
                        openPodLogs({
                          ...base,
                          selector,
                          title: `${ref.kind.split('.')[0]?.replace(/s$/, '') ?? ''}/${ref.name}`
                        })
                    }
                  }}
                  onPortForward={
                    readOnly
                      ? undefined
                      : (ref) => {
                          // Topology chỉ có tham chiếu — lấy object để biết cổng (pod: containerPort,
                          // service: port), rồi mở đúng hộp thoại forward như từ bảng.
                          if (ref.kind !== 'pods' && ref.kind !== 'services') return
                          request<K8sObject>({
                            op: 'get',
                            kind: ref.kind,
                            ...(ref.ns ? { namespace: ref.ns } : {}),
                            name: ref.name,
                            format: 'json'
                          }).then(
                            (obj) => {
                              const ports =
                                ref.kind === 'pods'
                                  ? (
                                      (obj.spec?.['containers'] as
                                        { ports?: { containerPort: number }[] }[] | undefined) ?? []
                                    ).flatMap((c) => (c.ports ?? []).map((p) => p.containerPort))
                                  : (
                                      (obj.spec?.['ports'] as { port: number }[] | undefined) ?? []
                                    ).map((p) => p.port)
                              setDialog({ kind: 'forward', obj, ports })
                            },
                            (e: unknown) => {
                              notify(cleanError(e), 'danger')
                            }
                          )
                        }
                  }
                  onShell={
                    readOnly
                      ? undefined
                      : (ref) => {
                          openPodShell(
                            { ref: params.ref, namespace: ref.ns ?? '', pod: ref.name },
                            params.bastionHostId
                          )
                        }
                  }
                />
              )
            ) : onOverview ? (
              namespaces === null ? null : (
                <ClusterOverview
                  request={request}
                  namespaces={namespaces}
                  active={active}
                  onNavigate={go}
                  onOpen={openRef}
                />
              )
            ) : !loaded ? (
              <div
                className="flex flex-1 items-center justify-center text-xs text-faint"
                data-testid="k8s-status"
              >
                {t('Loading…')}
              </div>
            ) : kindId === 'events' && !top ? (
              <EventsView objects={objects} error={list.error} onOpen={openRef} />
            ) : (
              <FileTable
                items={rows}
                getKey={(r) => r.row.key}
                getLabel={(r) => r.row.name}
                icon={(r) => (
                  <>
                    <input
                      type="checkbox"
                      className="size-3.5 shrink-0 accent-[var(--sh-accent)]"
                      aria-label={t('Select {name}', { name: r.row.name })}
                      data-testid="k8s-row-check"
                      tabIndex={-1}
                      checked={selected.has(r.row.key)}
                      onClick={(e) => {
                        // Không để dòng nhận cú bấm (chọn một dòng) — ô chọn bật / tắt riêng dòng này.
                        e.stopPropagation()
                      }}
                      onDoubleClick={(e) => {
                        e.stopPropagation()
                      }}
                      onChange={() => {
                        toggleRow(r.row.key)
                      }}
                    />
                    <Box size={14} strokeWidth={1.6} className="shrink-0 text-faint" />
                  </>
                )}
                columns={columns}
                gridClass=""
                gridStyle={{ gridTemplateColumns: fit.template }}
                nameSort={{ key: 'name', label: t('Name'), kind: 'text' }}
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
                    label:
                      items.length > 1
                        ? tn(items.length, 'Copy {n} name', 'Copy {n} names')
                        : t('Copy name'),
                    icon: <Copy size={14} />,
                    onSelect: () =>
                      void window.shellhouse.writeClipboard(items.map((r) => r.row.name).join('\n'))
                  }
                  if (first && items.length === 1)
                    openMenu(e, [
                      {
                        id: 'describe',
                        label: t('Describe'),
                        hint: 'd',
                        onSelect: () => {
                          setDetailKey(first.row.key)
                        }
                      },
                      copyNames,
                      ...toMenu(actionsFor(kindId, first.obj, readOnly, handlers))
                    ])
                  else if (items.length > 1)
                    openMenu(e, [
                      copyNames,
                      {
                        id: 'copy-yaml',
                        label: tn(
                          items.length,
                          'Copy YAML of {n} object',
                          'Copy YAML of {n} objects'
                        ),
                        icon: <FileCode size={14} />,
                        onSelect: () => {
                          copyYamlOf(items)
                        }
                      },
                      ...(bulkAvailable.length ? (['separator'] as const) : []),
                      ...bulkAvailable.map((k): MenuEntry => ({
                        id: `bulk-${k}`,
                        label:
                          k === 'delete'
                            ? tn(items.length, 'Delete {n} object…', 'Delete {n} objects…')
                            : k === 'restart'
                              ? tn(items.length, 'Restart {n} workload', 'Restart {n} workloads')
                              : k === 'scale'
                                ? tn(items.length, 'Scale {n} workload…', 'Scale {n} workloads…')
                                : k === 'cordon'
                                  ? tn(items.length, 'Cordon {n} node', 'Cordon {n} nodes')
                                  : tn(items.length, 'Uncordon {n} node', 'Uncordon {n} nodes'),
                        ...(k === 'delete' ? { danger: true } : {}),
                        onSelect: () => {
                          runBulk(k, items)
                        }
                      }))
                    ])
                }}
                ariaLabel={kind?.kind ?? t('Resources')}
                rowTestId="k8s-row"
              >
                {rows.length === 0 && (
                  <EmptyList
                    kindId={kindId}
                    what={titleOf(kindId).toLowerCase()}
                    kindName={kind?.kind ?? titleOf(kindId)}
                    filter={q ? query.trim() : null}
                    namespaces={scopeNs}
                    onClearFilter={() => {
                      setQuery('')
                    }}
                    onCreate={
                      !readOnly && FORM_FOR_KIND[kindId]
                        ? () => {
                            setDialog({
                              kind: 'create',
                              initial: FORM_FOR_KIND[kindId] ?? 'Deployment'
                            })
                          }
                        : undefined
                    }
                    onShowAll={
                      kind?.namespaced && scopeNs.length > 0 && allNamespaces.length > 1
                        ? () => {
                            setNamespaces([])
                          }
                        : undefined
                    }
                  />
                )}
              </FileTable>
            )}
            <ForwardsPanel
              bus={bus}
              request={request}
              open={showForwards}
              onCount={setForwardCount}
            />
          </div>

          {detail && (
            <Detail
              key={detail.row.key}
              kindId={kindId}
              obj={detail.obj}
              request={request}
              actions={actionsFor(kindId, detail.obj, readOnly, handlers)}
              nodeUsage={
                kindId === 'nodes' ? (metrics?.items[objectKey(detail.obj)] ?? null) : null
              }
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
              onNavigate={(kind, name, namespace) => {
                const info =
                  BUILTIN_KINDS.find((k) => k.id === kind) ??
                  (kinds ?? []).find((k) => k.id === kind)
                openRef(
                  kind,
                  namespace ??
                    (info?.namespaced === false ? undefined : detail.obj.metadata.namespace),
                  name
                )
              }}
              readOnly={readOnly}
              bus={bus}
              onNotify={(text, tone) => {
                notify(text, tone ?? 'success')
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
        <ClusterDialogs
          dialog={dialog}
          setDialog={setDialog}
          request={request}
          kindId={kindId}
          kind={kind}
          scopeNs={scopeNs}
          allNamespaces={allNamespaces}
          clusterNamespace={cluster?.namespace}
          production={production}
          readOnly={readOnly}
          detailKey={detailKey}
          setDetailKey={setDetailKey}
          openRef={openRef}
          onForwardStarted={openForwards}
          contextRef={params.ref}
          contextName={params.label}
          bastionHostId={params.bastionHostId}
          onBulkDeleted={(keys) => {
            const gone = new Set(keys)
            setSelected((s) => new Set([...s].filter((k) => !gone.has(k))))
            if (detailKey && gone.has(detailKey)) setDetailKey(null)
          }}
        />
        {menu}
        {guardProvider.element}
      </div>
    </GuardProvider>
  )
}

/**
 * Bảng trống (không có đối tượng / lọc không ra). Tách thành component: chữ dịch tính từ props
 * (React Compiler không coi tham số của t() làm đổi kindId → giữ được memo của bảng).
 */
function EmptyList({
  kindId,
  what,
  kindName,
  filter,
  namespaces,
  onClearFilter,
  onCreate,
  onShowAll
}: {
  kindId: string
  /** Tên loại, chữ thường ("pods"). */
  what: string
  kindName: string
  /** Chữ lọc đang áp dụng; null = không lọc. */
  filter: string | null
  namespaces: readonly string[]
  onClearFilter: () => void
  onCreate: (() => void) | undefined
  onShowAll: (() => void) | undefined
}): React.JSX.Element {
  return (
    <Empty
      icon={<KindIcon kind={kindId} size={22} />}
      title={filter !== null ? t('Nothing matches') : t('No {what}', { what })}
      text={
        filter !== null
          ? t('Nothing matches “{query}”.', { query: filter })
          : namespaces.length
            ? t('There are no {what} in {namespaces}.', { what, namespaces: namespaces.join(', ') })
            : t('There are no {what} in any namespace.', { what })
      }
      action={
        filter !== null ? (
          <Button size="sm" variant="ghost" icon={<X size={13} />} onClick={onClearFilter}>
            {t('Clear filter')}
          </Button>
        ) : (
          <span className="flex gap-2">
            {onCreate && (
              <Button
                size="sm"
                variant="primary"
                icon={<Plus size={13} />}
                data-testid="k8s-empty-create"
                onClick={onCreate}
              >
                {t('Create {kind}', { kind: kindName })}
              </Button>
            )}
            {onShowAll && (
              <Button size="sm" variant="ghost" onClick={onShowAll}>
                {t('Show all namespaces')}
              </Button>
            )}
          </span>
        )
      }
    />
  )
}
