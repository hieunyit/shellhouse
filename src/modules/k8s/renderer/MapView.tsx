import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Box,
  ChevronsDownUp,
  ChevronsUpDown,
  ExternalLink,
  FileText,
  Locate,
  Maximize,
  Minus,
  Plus,
  RefreshCw,
  Search,
  SquareTerminal,
  Tag,
  X
} from 'lucide-react'
import {
  Background,
  BackgroundVariant,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  type Viewport
} from '@xyflow/react'
import '@xyflow/react/dist/base.css'
import { cx, Segmented } from '../../../renderer/src/components/ui'
import { Heading, Pill, SidePanel } from '../../../renderer/src/components/panels'
import { cleanError } from '../../../renderer/src/lib/format'
import {
  TECH,
  filterMapData,
  groupingKeys,
  impactOf,
  layoutMap,
  parseLabelSelector,
  type MapGrouping,
  workloadKindLabel,
  type MapData,
  type MapEdge,
  type MapLayout,
  type MapNode,
  type MapTone
} from '../shared/map'
import type { K8sOp } from '../shared/ops'
import {
  BANDS,
  WORKLOAD_KIND_ID,
  byPair,
  formatRate,
  type TrafficPeer,
  type TrafficRate
} from '../shared/traffic'
import {
  EDGE_TYPES,
  MapContext,
  NEAR_ZOOM,
  NODE_TYPES,
  sides,
  type Band,
  type MapCtx,
  type MapFlowEdge,
  type MapFlowNode
} from './MapFlow'
import { TechIcon } from './icons'
import { NodesView } from './NodesView'
import { useTraffic, type TrafficState } from './useTraffic'

type Request = <T>(op: K8sOp) => Promise<T>

export interface MapRef {
  kind: string
  ns?: string
  name: string
}

const MIN_ZOOM = 0.02
const MAX_ZOOM = 3
const REFRESH_MS = 20_000
const OPTIONS_KEY = 'shellhouse.k8s.map'

/** Vị trí xem theo tab — quay lại Map thấy đúng chỗ cũ (không lưu đĩa). */
const savedViewports = new Map<string, Viewport>()

/**
 * Namespace gập: `all` = gập hết trừ `except`, ngược lại chỉ gập `except`. Namespace mới xuất hiện
 * theo mặc định của `all`. null = tự quyết (cluster nhiều namespace → gập hết).
 */
interface Fold {
  all: boolean
  except: ReadonlySet<string>
}
/** Cluster từ chừng này namespace trở lên: mặc định gập hết, mở cái cần xem. */
const AUTO_FOLD_NAMESPACES = 25
const savedFolds = new Map<string, Fold>()
const savedSelectors = new Map<string, string>()

interface Palette {
  accent: string
  muted: string
  warn: string
  faint: string
  traffic: string
  trafficHot: string
}

function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string): string =>
    css.getPropertyValue(name).trim() || fallback
  return {
    accent: v('--sh-accent', '#0f766e'),
    muted: v('--sh-muted', '#4b5360'),
    warn: v('--sh-warning', '#a15c07'),
    faint: v('--sh-faint', '#606977'),
    traffic: '#2f7de1',
    trafficHot: '#e8590c'
  }
}

interface Options {
  hideSystem: boolean
  pods: boolean
  edges: boolean
  traffic: boolean
  grouping: MapGrouping
  /** Bản đồ workload hay theo node (hạ tầng). */
  view: 'workloads' | 'nodes'
}

function loadOptions(): Options {
  const base: Options = {
    hideSystem: true,
    pods: true,
    edges: true,
    traffic: true,
    grouping: 'purpose',
    view: 'workloads'
  }
  try {
    const raw = window.localStorage.getItem(OPTIONS_KEY)
    if (raw) return { ...base, ...(JSON.parse(raw) as Partial<Options>) }
  } catch {
    // Bỏ qua.
  }
  return base
}

const KIND_TITLE: Record<MapNode['kind'], string> = {
  region: 'Region',
  namespace: 'Namespace',
  workload: 'Workload',
  pod: 'Pod',
  service: 'Service',
  route: 'Route',
  gateway: 'Gateway',
  pvc: 'Persistent volume claim',
  policy: 'NetworkPolicy'
}

/** Thứ tự chồng: vùng dưới cùng, thẻ trên cùng. */
const Z: Record<MapNode['kind'], number> = {
  region: 0,
  namespace: 1,
  gateway: 2,
  route: 2,
  service: 2,
  pvc: 2,
  policy: 2,
  workload: 3,
  pod: 4
}

function routeTitle(kind: string): string {
  if (kind.startsWith('ingresses')) return 'Ingress'
  if (kind.startsWith('httproutes')) return 'HTTPRoute'
  if (kind.startsWith('grpcroutes')) return 'GRPCRoute'
  return 'Route'
}

const titleOf = (n: MapNode): string =>
  n.kind === 'route'
    ? routeTitle(n.ref?.kind ?? '')
    : n.kind === 'workload' && n.ref
      ? workloadKindLabel(n.ref.kind)
      : KIND_TITLE[n.kind]

const peerLabel = (p: TrafficPeer): string =>
  p.kind === 'external' || !p.ns ? `${p.name} (${p.kind || 'external'})` : `${p.ns}/${p.name}`

/**
 * Bản đồ cluster (kiểu "Google Maps cho Kubernetes") trên React Flow: vùng → namespace → workload
 * → pod, cùng gateway → route → service → workload → PVC, NetworkPolicy, và đường traffic live từ
 * Caretta (độ dày theo băng cố định). Chi tiết theo mức zoom; chỉ vẽ phần đang thấy.
 */
export function MapView(props: {
  tabId: string
  request: Request
  namespaces: readonly string[]
  active: boolean
  onOpen: (ref: MapRef) => void
  onLogs: (ref: MapRef, labels: Record<string, string> | null) => void
  onShell: (ref: MapRef) => void
}): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <MapInner {...props} />
    </ReactFlowProvider>
  )
}

function ZoomLabel(): React.JSX.Element {
  const pct = useStore((s) => Math.round(s.transform[2] * 100))
  return (
    <span
      className="flex w-12 items-center justify-center border-x border-line text-[11px] text-faint tabular-nums"
      data-testid="k8s-map-zoom"
    >
      {pct}%
    </span>
  )
}

function MapInner({
  tabId,
  request,
  namespaces,
  active,
  onOpen,
  onLogs,
  onShell
}: {
  tabId: string
  request: Request
  namespaces: readonly string[]
  active: boolean
  onOpen: (ref: MapRef) => void
  onLogs: (ref: MapRef, labels: Record<string, string> | null) => void
  onShell: (ref: MapRef) => void
}): React.JSX.Element {
  const rf = useReactFlow<MapFlowNode, MapFlowEdge>()
  const [data, setData] = useState<MapData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [updated, setUpdated] = useState(0)
  const [tick, setTick] = useState(0)
  const [options, setOptions] = useState(loadOptions)
  const [problemsOnly, setProblemsOnly] = useState(false)
  const [impactMode, setImpactMode] = useState(false)
  const [selectedRaw, setSelected] = useState<string | null>(null)
  const [hover, setHover] = useState<{ id: string; x: number; y: number; w: number } | null>(null)
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [band, setBand] = useState<Band>(() =>
    (savedViewports.get(tabId)?.zoom ?? 0.5) >= NEAR_ZOOM ? 'near' : 'far'
  )
  const [palette, setPalette] = useState<Palette>(readPalette)
  const wrapRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const fitted = useRef(savedViewports.has(tabId))
  const [foldRaw, setFoldRaw] = useState<Fold | null>(() => savedFolds.get(tabId) ?? null)
  const [selectorText, setSelectorTextRaw] = useState(() => savedSelectors.get(tabId) ?? '')
  const setSelectorText = (v: string): void => {
    savedSelectors.set(tabId, v)
    setSelectorTextRaw(v)
  }
  /** Bay tới node này khi nó có trên bản đồ (vừa mở namespace chứa nó). */
  const [pendingGo, setPendingGo] = useState<string | null>(null)
  /** Đang nhập khoá nhãn tuỳ ý để gom vùng (null = không). */
  const [customGroup, setCustomGroup] = useState<string | null>(null)
  const goToRef = useRef<(n: MapNode) => void>(() => undefined)
  const nsKey = namespaces.join(',')
  const nodesView = options.view === 'nodes'
  const traffic = useTraffic(request, active && options.traffic && !nodesView)

  // ——— Dữ liệu ———
  useEffect(() => {
    if (!active) return
    let cancelled = false
    const load = (): void => {
      setLoading(true)
      request<MapData>({ op: 'map', namespaces: nsKey ? nsKey.split(',') : [] }).then(
        (d) => {
          if (cancelled) return
          setData(d)
          setError(null)
          setUpdated(Date.now())
          setLoading(false)
        },
        (e: unknown) => {
          if (cancelled) return
          setError(cleanError(e))
          setLoading(false)
        }
      )
    }
    load()
    const t = setInterval(load, REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [request, nsKey, active, tick])

  // Theme đổi → đọc lại màu (cạnh vẽ bằng màu cụ thể).
  useEffect(() => {
    const mo = new MutationObserver(() => {
      setPalette(readPalette())
    })
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'style']
    })
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onScheme = (): void => {
      setPalette(readPalette())
    }
    mq.addEventListener('change', onScheme)
    return () => {
      mo.disconnect()
      mq.removeEventListener('change', onScheme)
    }
  }, [])

  const parsedSelector = useMemo(() => parseLabelSelector(selectorText), [selectorText])
  const selectorError = parsedSelector && 'error' in parsedSelector ? parsedSelector.error : null
  const shownData = useMemo(
    () =>
      data && parsedSelector && !('error' in parsedSelector)
        ? filterMapData(data, parsedSelector)
        : data,
    [data, parsedSelector]
  )
  const fold = useMemo<Fold>(
    () =>
      foldRaw ?? {
        all: (data?.namespaces.length ?? 0) >= AUTO_FOLD_NAMESPACES,
        except: new Set()
      },
    [foldRaw, data]
  )
  const isFolded = useCallback((ns: string) => fold.all !== fold.except.has(ns), [fold])
  const setFold = useCallback(
    (next: Fold) => {
      savedFolds.set(tabId, next)
      setFoldRaw(next)
    },
    [tabId]
  )
  const toggleNs = useCallback(
    (ns: string) => {
      const except = new Set(fold.except)
      if (except.has(ns)) except.delete(ns)
      else except.add(ns)
      setFold({ all: fold.all, except })
    },
    [fold, setFold]
  )
  const groupKeys = useMemo(() => (data ? groupingKeys(data) : []), [data])
  /** Gợi ý cho ô lọc: key=value phổ biến trên nhãn workload. */
  const labelSuggestions = useMemo(() => {
    const count = new Map<string, number>()
    for (const w of data?.workloads ?? [])
      for (const [k, v] of Object.entries(w.labels))
        if (!/pod-template-hash|controller-revision-hash|statefulset\.kubernetes\.io/.test(k))
          count.set(`${k}=${v}`, (count.get(`${k}=${v}`) ?? 0) + 1)
    return [...count.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 60)
      .map(([k]) => k)
  }, [data])
  const layout = useMemo<MapLayout | null>(
    () =>
      shownData
        ? layoutMap(shownData, {
            hideSystem: options.hideSystem,
            grouping: options.grouping,
            collapsed: isFolded
          })
        : null,
    [shownData, options.hideSystem, options.grouping, isFolded]
  )
  const index = useMemo(() => {
    const byId = new Map<string, MapNode>()
    const edgesOf = new Map<string, MapEdge[]>()
    const podsOf = new Map<string, MapNode[]>()
    const ordered = [...(layout?.nodes ?? [])].sort((a, b) => Z[a.kind] - Z[b.kind])
    for (const n of ordered) {
      byId.set(n.id, n)
      if (n.kind === 'pod' && n.parent) podsOf.set(n.parent, [...(podsOf.get(n.parent) ?? []), n])
    }
    for (const e of layout?.edges ?? []) {
      edgesOf.set(e.from, [...(edgesOf.get(e.from) ?? []), e])
      edgesOf.set(e.to, [...(edgesOf.get(e.to) ?? []), e])
    }
    return { byId, edgesOf, ordered, podsOf }
  }, [layout])

  // Mục đang chọn biến mất sau khi làm mới (pod bị thay…) → coi như không chọn.
  const selected = selectedRaw && index.byId.has(selectedRaw) ? selectedRaw : null

  // Đổi mục chọn → tắt blast radius (bật lại khi cần).
  const [impactFor, setImpactFor] = useState<string | null>(null)
  if (impactFor !== selected) {
    setImpactFor(selected)
    if (impactMode) setImpactMode(false)
  }

  // ——— Traffic: peer Caretta → node trên bản đồ ———
  const peerNode = useCallback(
    (p: TrafficPeer): string | null => {
      const kind = WORKLOAD_KIND_ID[p.kind]
      if (kind) {
        const id = `w:${kind}:${p.ns}/${p.name}`
        return index.byId.has(id) ? id : null
      }
      if (p.kind === 'Pod') return index.byId.get(`p:${p.ns}/${p.name}`)?.parent ?? null
      return null
    },
    [index]
  )
  const trafficEdges = useMemo(() => {
    const out: { from: string; to: string; rate: number }[] = []
    for (const r of byPair(traffic.rates)) {
      const a = peerNode(r.client)
      const b = peerNode(r.server)
      if (!a || !b || a === b) continue
      out.push({ from: a, to: b, rate: r.rate })
    }
    return out
  }, [traffic.rates, peerNode])

  // Liên quan tới mục đang chọn / trỏ: chính nó, cha, con, và mọi thứ nối qua cạnh (3 bước).
  const focusId = selected ?? hover?.id ?? null
  const related = useMemo(() => {
    const set = new Set<string>()
    if (!focusId) return set
    const node = index.byId.get(focusId)
    if (!node || node.kind === 'namespace' || node.kind === 'region') return set
    if (impactMode && selected && layout && focusId === selected) {
      for (const id of impactOf(layout, selected)) set.add(id)
      set.add(selected)
      return set
    }
    const visit = (id: string, depth: number): void => {
      set.add(id)
      if (depth === 0) return
      for (const e of index.edgesOf.get(id) ?? []) {
        const other = e.from === id ? e.to : e.from
        if (!set.has(other)) visit(other, depth - 1)
      }
    }
    const start = node.kind === 'pod' && node.parent ? node.parent : focusId
    visit(start, 3)
    // Traffic trực tiếp của workload đang xem.
    for (const t of trafficEdges) {
      if (t.from === start) set.add(t.to)
      if (t.to === start) set.add(t.from)
    }
    set.add(focusId)
    for (const p of index.podsOf.get(start) ?? []) set.add(p.id)
    return set
  }, [focusId, index, impactMode, selected, layout, trafficEdges])

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return index.ordered
      .filter((n) => n.kind !== 'region' && n.label.toLowerCase().includes(q))
      .sort(
        (a, b) =>
          Number(!a.label.toLowerCase().startsWith(q)) -
          Number(!b.label.toLowerCase().startsWith(q))
      )
      .slice(0, 12)
  }, [query, index])
  /** Workload trong namespace đang gập khớp ô tìm (chọn → mở namespace rồi bay tới). */
  const hiddenMatches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q || !shownData) return []
    return shownData.workloads
      .filter((w) => isFolded(w.ns) && w.name.toLowerCase().includes(q))
      .slice(0, 8)
  }, [query, shownData, isFolded])

  // Namespace vừa mở đã vẽ xong → bay tới mục đang chờ.
  useEffect(() => {
    if (!pendingGo) return
    const n = index.byId.get(pendingGo)
    if (!n) return
    const t = setTimeout(() => {
      setPendingGo(null)
      goToRef.current(n)
    }, 0)
    return () => {
      clearTimeout(t)
    }
  }, [pendingGo, index])

  // ——— Node / cạnh cho React Flow ———
  const nodes = useMemo<MapFlowNode[]>(() => {
    const out: MapFlowNode[] = []
    for (const n of index.ordered) {
      if (n.kind === 'pod') continue
      if (band === 'far' && n.kind !== 'region' && n.kind !== 'namespace') continue
      out.push({
        id: n.id,
        type: n.kind,
        position: { x: n.x, y: n.y },
        width: n.w,
        height: n.h,
        zIndex: Z[n.kind],
        data: { node: n },
        draggable: false,
        selectable: false,
        connectable: false
      })
    }
    return out
  }, [index, band])

  const edges = useMemo<MapFlowEdge[]>(() => {
    const out: MapFlowEdge[] = []
    const arrow = (color: string): MapFlowEdge['markerEnd'] => ({
      type: MarkerType.ArrowClosed,
      color,
      width: 12,
      height: 12
    })
    if (band === 'near' && options.edges && layout)
      for (const e of layout.edges) {
        const hot = related.has(e.from) && related.has(e.to)
        // Policy áp lên cả namespace → rất nhiều cạnh; chỉ vẽ đường của chính mục đang chọn.
        if (e.kind === 'policy' && !(hot && focusId && (e.from === focusId || e.to === focusId)))
          continue
        const color =
          e.kind === 'storage' ? palette.muted : e.kind === 'policy' ? palette.warn : palette.accent
        out.push({
          id: `${e.kind}:${e.from}>${e.to}`,
          source: e.from,
          target: e.to,
          sourceHandle: 'sb',
          targetHandle: 'tt',
          type: 'map',
          zIndex: 2,
          data: { kind: e.kind, color },
          ...(e.kind === 'storage' || e.kind === 'policy' ? {} : { markerEnd: arrow(color) })
        })
      }
    if (options.traffic && trafficEdges.length) {
      // Khác namespace: luôn gộp thành đường giữa hai đảo (không xuyên qua thẻ trong đảo);
      // cùng namespace (nhìn gần): đường giữa hai thẻ workload.
      const cross = new Map<string, { from: string; to: string; rate: number }>()
      const local: { from: string; to: string; rate: number }[] = []
      for (const tr of trafficEdges) {
        const a = index.byId.get(tr.from)?.ns
        const b = index.byId.get(tr.to)?.ns
        if (!a || !b) continue
        if (a === b) {
          if (band === 'near') local.push(tr)
          continue
        }
        const key = `n:${a}>n:${b}`
        cross.set(key, {
          from: `n:${a}`,
          to: `n:${b}`,
          rate: (cross.get(key)?.rate ?? 0) + tr.rate
        })
      }
      const list = [...local, ...cross.values()]
      for (const t of list) {
        const color = t.rate >= BANDS[3].max ? palette.trafficHot : palette.traffic
        out.push({
          id: `traffic:${t.from}>${t.to}`,
          source: t.from,
          target: t.to,
          ...(() => {
            const sa = index.byId.get(t.from)
            const sb = index.byId.get(t.to)
            return sa && sb ? sides(sa, sb) : { sourceHandle: 'sr', targetHandle: 'tl' }
          })(),
          type: 'map',
          // Dưới thẻ workload (thẻ che phần đường đi qua) — không đè chữ.
          zIndex: 2,
          data: { kind: 'traffic', rate: t.rate, color },
          markerEnd: arrow(color)
        })
      }
    }
    return out
  }, [band, options.edges, options.traffic, layout, related, palette, trafficEdges, index, focusId])

  // ——— Điều khiển khung nhìn ———
  const flyTo = useCallback(
    (box: { x: number; y: number; w: number; h: number }, maxZoom = 1.2) => {
      const wrap = wrapRef.current
      if (!wrap) return
      const pad = 60
      const zoom = Math.max(
        MIN_ZOOM,
        Math.min(
          maxZoom,
          (wrap.clientWidth - 2 * pad) / Math.max(1, box.w),
          (wrap.clientHeight - 2 * pad) / Math.max(1, box.h)
        )
      )
      void rf.setCenter(box.x + box.w / 2, box.y + box.h / 2, { zoom, duration: 350 })
    },
    [rf]
  )

  const fit = useCallback(() => {
    if (!layout) return
    flyTo({ x: 0, y: 0, w: layout.width, h: layout.height }, 1)
  }, [layout, flyTo])

  // Lần đầu có dữ liệu: vừa khung (không animation).
  useEffect(() => {
    if (!layout || fitted.current) return
    const wrap = wrapRef.current
    if (!wrap || !wrap.clientWidth) return
    fitted.current = true
    const zoom = Math.min(
      1,
      (wrap.clientWidth - 80) / Math.max(1, layout.width),
      (wrap.clientHeight - 80) / Math.max(1, layout.height)
    )
    void rf.setViewport({
      zoom,
      x: (wrap.clientWidth - layout.width * zoom) / 2,
      y: (wrap.clientHeight - layout.height * zoom) / 2
    })
  }, [layout, rf])

  const zoomBy = (factor: number): void => {
    const v = rf.getViewport()
    const wrap = wrapRef.current
    if (!wrap) return
    const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.zoom * factor))
    const cx0 = wrap.clientWidth / 2
    const cy0 = wrap.clientHeight / 2
    const k = zoom / v.zoom
    void rf.setViewport({ zoom, x: cx0 - (cx0 - v.x) * k, y: cy0 - (cy0 - v.y) * k })
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    const v = rf.getViewport()
    const step = 80
    const handled = (): void => {
      e.preventDefault()
      e.stopPropagation()
    }
    if (e.key === '+' || e.key === '=') {
      handled()
      zoomBy(1.25)
    } else if (e.key === '-' || e.key === '_') {
      handled()
      zoomBy(0.8)
    } else if (e.key === '0') {
      handled()
      fit()
    } else if (e.key.startsWith('Arrow')) {
      handled()
      const dx = e.key === 'ArrowLeft' ? step : e.key === 'ArrowRight' ? -step : 0
      const dy = e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0
      void rf.setViewport({ ...v, x: v.x + dx, y: v.y + dy })
    } else if (e.key === 'Escape' && selected) {
      handled()
      setSelected(null)
    } else if (e.key === '/' || (e.key === 'f' && (e.ctrlKey || e.metaKey))) {
      handled()
      searchRef.current?.focus()
    } else if (e.key === 'Enter' && selected) {
      const n = index.byId.get(selected)
      if (n?.ref) {
        handled()
        onOpen(n.ref)
      }
    }
  }

  const selectedNode = selected ? index.byId.get(selected) : undefined
  const hoverNode = hover ? index.byId.get(hover.id) : undefined
  const counts = useMemo(() => {
    const out = { workloads: 0, pods: 0, bad: 0, warn: 0 }
    for (const n of layout?.nodes ?? []) {
      if (n.kind === 'workload') out.workloads++
      if (n.kind === 'pod') out.pods++
      if ((n.kind === 'workload' || n.kind === 'pvc') && n.tone === 'bad') out.bad++
      if ((n.kind === 'workload' || n.kind === 'pvc') && n.tone === 'warn') out.warn++
    }
    return out
  }, [layout])

  const setOpt = (patch: Partial<Options>): void => {
    const next = { ...options, ...patch }
    setOptions(next)
    try {
      window.localStorage.setItem(OPTIONS_KEY, JSON.stringify(next))
    } catch {
      // Bỏ qua.
    }
  }

  const revealWorkload = (w: { kind: string; ns: string; name: string }): void => {
    setQuery('')
    setSearchOpen(false)
    if (isFolded(w.ns)) toggleNs(w.ns)
    setPendingGo(`w:${w.kind}:${w.ns}/${w.name}`)
  }

  const goTo = (n: MapNode): void => {
    setSelected(n.id)
    setQuery('')
    setSearchOpen(false)
    const parent = n.kind === 'pod' && n.parent ? index.byId.get(n.parent) : undefined
    // Bảng bên phải mở ra làm khung hẹp lại — đợi bố cục xong rồi mới bay tới (đúng tâm).
    setTimeout(() => {
      flyTo(parent ?? n, n.kind === 'namespace' ? 1 : 1.4)
    }, 40)
    wrapRef.current?.focus()
  }

  useEffect(() => {
    goToRef.current = goTo
  })

  /** Bay tới mục có vấn đề tiếp theo (workload / PVC đỏ trước, rồi vàng). */
  const nextProblem = (): void => {
    const list = index.ordered
      .filter(
        (n) =>
          (n.kind === 'workload' || n.kind === 'pvc') && (n.tone === 'bad' || n.tone === 'warn')
      )
      .sort((a, b) => (a.tone === b.tone ? 0 : a.tone === 'bad' ? -1 : 1))
    if (!list.length) return
    const at = selected ? list.findIndex((n) => n.id === selected) : -1
    const next = list[(at + 1) % list.length]
    if (next) goTo(next)
  }

  const local = (e: { clientX: number; clientY: number }): { x: number; y: number; w: number } => {
    const r = wrapRef.current?.getBoundingClientRect()
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0), w: r?.width ?? 600 }
  }

  const ctx = useMemo<MapCtx>(
    () => ({
      band,
      selected,
      related,
      problemsOnly,
      showPods: options.pods,
      podsOf: index.podsOf,
      onSelect: (id) => {
        setSelected(id)
      },
      onHoverPod: (pod, e) => {
        setHover(pod && e ? { id: pod.id, ...local(e) } : null)
      },
      onToggleNs: toggleNs
    }),
    [band, selected, related, problemsOnly, options.pods, index, toggleNs]
  )

  /** Traffic của mục đang chọn (bảng bên phải). */
  const nodeTraffic = useMemo(() => {
    if (!selectedNode || selectedNode.kind !== 'workload' || !selectedNode.ref) return null
    const ref = selectedNode.ref
    const self = (p: TrafficPeer): boolean =>
      WORKLOAD_KIND_ID[p.kind] === ref.kind && p.ns === ref.ns && p.name === ref.name
    const rates = byPair(traffic.rates)
    return {
      status: traffic.status,
      reason: traffic.reason,
      incoming: rates.filter((r) => self(r.server)).sort((a, b) => b.rate - a.rate),
      outgoing: rates.filter((r) => self(r.client)).sort((a, b) => b.rate - a.rate)
    }
  }, [selectedNode, traffic])

  return (
    <div className="flex min-h-0 flex-1" data-testid="k8s-map">
      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* Thanh công cụ của bản đồ */}
        <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-2 py-1.5 text-xs">
          <Segmented
            value={options.view}
            testIdPrefix="k8s-map-view"
            options={[
              { value: 'workloads', label: 'Workloads' },
              { value: 'nodes', label: 'Nodes' }
            ]}
            onChange={(view) => {
              setOpt({ view })
            }}
          />
          <div className={cx(nodesView ? 'hidden' : 'contents')}>
            <div className="relative w-64">
              <div className="flex h-7 items-center gap-1.5 rounded-md border border-line bg-subtle px-2 focus-within:border-accent">
                <Search size={12} className="text-faint" />
                <input
                  ref={searchRef}
                  type="search"
                  placeholder="Find on map…  ( / )"
                  data-testid="k8s-map-search"
                  className="min-w-0 flex-1 bg-transparent text-xs text-fg outline-none placeholder:text-faint"
                  value={query}
                  onFocus={() => {
                    setSearchOpen(true)
                  }}
                  onBlur={() => {
                    setTimeout(() => {
                      setSearchOpen(false)
                    }, 150)
                  }}
                  onChange={(e) => {
                    setQuery(e.target.value)
                    setSearchOpen(true)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && matches[0]) {
                      e.preventDefault()
                      goTo(matches[0])
                    } else if (e.key === 'Escape') {
                      setQuery('')
                      wrapRef.current?.focus()
                    }
                  }}
                />
              </div>
              {searchOpen && (matches.length > 0 || hiddenMatches.length > 0) && (
                <div
                  className="absolute top-8 right-0 left-0 z-30 max-h-72 overflow-auto rounded-md border border-line bg-elevated p-1 shadow-lg"
                  data-testid="k8s-map-results"
                >
                  {matches.map((n) => (
                    <button
                      key={n.id}
                      type="button"
                      className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-hover"
                      data-testid="k8s-map-result"
                      onMouseDown={(e) => {
                        e.preventDefault()
                        goTo(n)
                      }}
                    >
                      <span className={cx('size-2 shrink-0 rounded-full', DOT[n.tone])} />
                      <span className="min-w-0 flex-1 truncate text-fg">{n.label}</span>
                      <span className="shrink-0 text-faint">
                        {n.kind === 'route' ? routeTitle(n.ref?.kind ?? '') : KIND_TITLE[n.kind]}
                        {n.ns && n.kind !== 'namespace' ? ` · ${n.ns}` : ''}
                      </span>
                    </button>
                  ))}
                  {hiddenMatches.map((w) => (
                    <button
                      key={`${w.kind}:${w.ns}/${w.name}`}
                      type="button"
                      className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-hover"
                      data-testid="k8s-map-result"
                      onMouseDown={(e) => {
                        e.preventDefault()
                        revealWorkload(w)
                      }}
                    >
                      <span className={cx('size-2 shrink-0 rounded-full', DOT[w.tone])} />
                      <span className="min-w-0 flex-1 truncate text-fg">{w.name}</span>
                      <span className="shrink-0 text-faint">
                        {workloadKindLabel(w.kind)} · {w.ns} (collapsed)
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            {customGroup !== null ? (
              <input
                autoFocus
                type="text"
                spellCheck={false}
                placeholder="Label key, e.g. team"
                aria-label="Group by label key"
                data-testid="k8s-map-grouping-custom"
                className="h-7 w-48 rounded-md border border-accent bg-subtle px-2 font-mono text-xs text-fg outline-none"
                value={customGroup}
                onChange={(e) => {
                  setCustomGroup(e.target.value)
                }}
                onBlur={() => {
                  setCustomGroup(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const key = customGroup.trim()
                    if (key) setOpt({ grouping: `label:${key}` })
                    setCustomGroup(null)
                  } else if (e.key === 'Escape') setCustomGroup(null)
                }}
              />
            ) : (
              <label
                className="flex h-7 items-center gap-1 rounded-md border border-line pl-2 text-muted"
                title="Group namespaces into regions"
              >
                <span className="text-faint">Group</span>
                <select
                  data-testid="k8s-map-grouping"
                  className="h-full max-w-44 cursor-pointer rounded-md bg-transparent pr-1 font-medium text-fg outline-none"
                  value={options.grouping}
                  onChange={(e) => {
                    const v = e.target.value
                    if (v === '__custom') {
                      setCustomGroup('')
                      return
                    }
                    setOpt({ grouping: v as MapGrouping })
                  }}
                >
                  <option value="purpose">by purpose</option>
                  <option value="prefix">by name prefix</option>
                  {[
                    ...groupKeys,
                    ...(options.grouping.startsWith('label:') &&
                    !groupKeys.includes(options.grouping.slice(6))
                      ? [options.grouping.slice(6)]
                      : [])
                  ].map((k) => (
                    <option key={k} value={`label:${k}`}>
                      by {k}
                    </option>
                  ))}
                  <option value="__custom">by label…</option>
                </select>
              </label>
            )}
          </div>
          <div
            className={cx(
              'flex h-7 w-60 items-center gap-1.5 rounded-md border bg-subtle px-2',
              selectorError
                ? 'border-danger'
                : selectorText.trim()
                  ? 'border-accent/60'
                  : 'border-line focus-within:border-accent'
            )}
            title={
              selectorError ??
              'Show only workloads whose pod labels match — e.g. tier=backend, app.kubernetes.io/part-of=shop, env in (prod,staging), !canary'
            }
          >
            <Tag size={12} className="shrink-0 text-faint" />
            <input
              type="text"
              list="k8s-map-labels"
              spellCheck={false}
              placeholder="Filter by label: tier=backend"
              aria-label="Filter by label"
              aria-invalid={Boolean(selectorError)}
              data-testid="k8s-map-label-filter"
              className="min-w-0 flex-1 bg-transparent font-mono text-xs text-fg outline-none placeholder:font-sans placeholder:text-faint"
              value={selectorText}
              onChange={(e) => {
                setSelectorText(e.target.value)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setSelectorText('')
              }}
            />
            {selectorText && (
              <button
                type="button"
                aria-label="Clear label filter"
                className="shrink-0 rounded text-faint hover:text-fg"
                onClick={() => {
                  setSelectorText('')
                }}
              >
                <X size={12} />
              </button>
            )}
            <datalist id="k8s-map-labels">
              {labelSuggestions.map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
          </div>
          <div className={cx(nodesView ? 'hidden' : 'contents')}>
            <button
              type="button"
              className="flex h-7 items-center gap-1 rounded-md border border-line px-2 font-medium whitespace-nowrap text-muted hover:text-fg"
              data-testid="k8s-map-fold-all"
              title={
                fold.all && fold.except.size === 0
                  ? 'Expand every namespace'
                  : 'Collapse every namespace'
              }
              onClick={() => {
                setFold({ all: !(fold.all && fold.except.size === 0), except: new Set() })
              }}
            >
              {fold.all && fold.except.size === 0 ? (
                <>
                  <ChevronsUpDown size={13} /> Expand all
                </>
              ) : (
                <>
                  <ChevronsDownUp size={13} /> Collapse all
                </>
              )}
            </button>
            <Chip
              on={!options.hideSystem}
              testId="k8s-map-system"
              onClick={() => {
                setOpt({ hideSystem: !options.hideSystem })
              }}
            >
              System namespaces
            </Chip>
            <Chip
              on={options.pods}
              onClick={() => {
                setOpt({ pods: !options.pods })
              }}
            >
              Pods
            </Chip>
            <Chip
              on={options.edges}
              onClick={() => {
                setOpt({ edges: !options.edges })
              }}
            >
              Connections
            </Chip>
            <Chip
              on={options.traffic}
              testId="k8s-map-traffic"
              title={
                traffic.status === 'unavailable'
                  ? (traffic.reason ?? 'Live traffic is not available')
                  : 'Live traffic between workloads (Caretta)'
              }
              onClick={() => {
                setOpt({ traffic: !options.traffic })
              }}
            >
              <span className="inline-flex items-center gap-1.5">
                Traffic
                {options.traffic && <TrafficDot status={traffic.status} />}
              </span>
            </Chip>
            <Chip
              on={problemsOnly}
              testId="k8s-map-problems"
              onClick={() => {
                setProblemsOnly(!problemsOnly)
              }}
            >
              Problems only
            </Chip>
          </div>
          <div className="flex-1" />
          {!nodesView && (counts.bad > 0 || counts.warn > 0) && (
            <button
              type="button"
              className="flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-hover"
              title="Go to the next problem"
              data-testid="k8s-map-next-problem"
              onClick={nextProblem}
            >
              {counts.bad > 0 && <Pill tone="bad">{`${counts.bad} failing`}</Pill>}
              {counts.warn > 0 && <Pill tone="warn">{`${counts.warn} degraded`}</Pill>}
            </button>
          )}
          <span
            className={cx('text-faint tabular-nums', nodesView && 'hidden')}
            data-testid="k8s-map-summary"
          >
            {counts.workloads} workloads · {counts.pods} pods
            {data ? ` · nodes ${data.nodes.ready}/${data.nodes.total}` : ''}
          </span>
          <button
            type="button"
            aria-label="Refresh"
            title={updated ? `Updated ${new Date(updated).toLocaleTimeString()}` : 'Refresh'}
            className="rounded p-1 text-faint hover:bg-hover hover:text-fg"
            onClick={() => {
              setTick((n) => n + 1)
            }}
          >
            <RefreshCw size={13} className={cx(loading && 'animate-spin')} />
          </button>
        </div>
        {error && <p className="border-b border-line px-3 py-1.5 text-xs text-danger">{error}</p>}
        {data?.truncated && (
          <p className="border-b border-line px-3 py-1.5 text-xs text-warning">
            This cluster is very large — only part of it is on the map. Pick fewer namespaces.
          </p>
        )}
        {nodesView && data && shownData && (
          <NodesView data={data} shown={shownData} onOpen={onOpen} />
        )}
        {!nodesView && options.traffic && traffic.status === 'unavailable' && (
          <p
            className="border-b border-line px-3 py-1.5 text-xs text-faint"
            data-testid="k8s-map-traffic-note"
          >
            No live traffic data — {traffic.reason ?? 'Caretta is not available'}. Install{' '}
            <span className="font-mono">groundcover-com/caretta</span> to see traffic roads.
          </p>
        )}
        <div
          ref={wrapRef}
          tabIndex={0}
          role="application"
          aria-label="Cluster map — drag to move, scroll to zoom, click to select"
          data-testid="k8s-map-canvas"
          className={cx(
            'k8s-map relative min-h-0 flex-1 overflow-hidden bg-canvas outline-none',
            nodesView && 'hidden'
          )}
          onKeyDown={onKeyDown}
          onPointerLeave={() => {
            setHover(null)
          }}
        >
          <MapContext.Provider value={ctx}>
            <ReactFlow<MapFlowNode, MapFlowEdge>
              nodes={nodes}
              edges={edges}
              nodeTypes={NODE_TYPES}
              edgeTypes={EDGE_TYPES}
              defaultViewport={savedViewports.get(tabId) ?? { x: 40, y: 40, zoom: 0.5 }}
              minZoom={MIN_ZOOM}
              maxZoom={MAX_ZOOM}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
              nodesFocusable={false}
              edgesFocusable={false}
              disableKeyboardA11y
              onlyRenderVisibleElements
              zoomOnDoubleClick
              proOptions={{ hideAttribution: true }}
              onMove={(_, v) => {
                const next: Band = v.zoom >= NEAR_ZOOM ? 'near' : 'far'
                if (next !== band) setBand(next)
              }}
              onMoveEnd={(_, v) => {
                savedViewports.set(tabId, v)
              }}
              onMoveStart={() => {
                setHover(null)
              }}
              onNodeClick={(_, n) => {
                setSelected(n.id)
                wrapRef.current?.focus()
              }}
              onNodeDoubleClick={(_, n) => {
                const m = index.byId.get(n.id)
                if (m) flyTo(m, 1.4)
              }}
              onPaneClick={() => {
                setSelected(null)
                wrapRef.current?.focus()
              }}
              onNodeMouseEnter={(e, n) => {
                if (n.type === 'region') return
                setHover({ id: n.id, ...local(e) })
              }}
              onNodeMouseLeave={() => {
                setHover(null)
              }}
            >
              <Background
                variant={BackgroundVariant.Dots}
                gap={24}
                size={1}
                className="!bg-canvas"
              />
              <MiniMap
                pannable
                zoomable
                position="bottom-right"
                className="!m-3 !mb-12 overflow-hidden rounded-md border border-line !bg-surface shadow-sm"
                style={{ width: 180, height: 120 }}
                maskColor="rgb(120 130 145 / 0.18)"
                nodeColor={(n) => {
                  const m = (n.data as { node?: MapNode } | undefined)?.node
                  if (!m) return 'transparent'
                  if (m.kind === 'region') return 'rgb(150 160 175 / 0.2)'
                  if (m.kind === 'namespace')
                    return m.tone === 'bad'
                      ? 'rgb(217 56 30 / 0.25)'
                      : m.tone === 'warn'
                        ? 'rgb(194 122 14 / 0.25)'
                        : 'rgb(150 160 175 / 0.35)'
                  return m.tone === 'bad' ? '#d9381e' : m.tone === 'warn' ? '#c27a0e' : '#9aa3b0'
                }}
                nodeStrokeWidth={0}
              />
            </ReactFlow>
          </MapContext.Provider>
          {!data && !error && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-faint">
              Drawing the cluster map…
            </div>
          )}
          {hoverNode && hover && (
            <div
              className="pointer-events-none absolute z-20 max-w-72 rounded-md border border-line bg-elevated px-2 py-1.5 text-xs shadow-lg"
              style={{
                left: Math.min(hover.x + 14, hover.w - 280),
                top: hover.y + 14
              }}
              data-testid="k8s-map-tooltip"
            >
              <div className="flex items-center gap-1.5">
                <span className={cx('size-2 shrink-0 rounded-full', DOT[hoverNode.tone])} />
                <span className="truncate font-medium text-fg">{hoverNode.label}</span>
              </div>
              <div className="mt-0.5 text-faint">
                {titleOf(hoverNode)}
                {hoverNode.sub ? ` · ${hoverNode.sub}` : ''}
              </div>
            </div>
          )}
          {/* Điều khiển zoom + chú giải */}
          <div className="absolute right-3 bottom-3 z-10 flex overflow-hidden rounded-md border border-line bg-surface shadow-sm">
            <MapButton
              label="Zoom out ( - )"
              onClick={() => {
                zoomBy(0.8)
              }}
            >
              <Minus size={13} />
            </MapButton>
            <ZoomLabel />
            <MapButton
              label="Zoom in ( + )"
              onClick={() => {
                zoomBy(1.25)
              }}
            >
              <Plus size={13} />
            </MapButton>
            <MapButton label="Fit the whole cluster ( 0 )" testId="k8s-map-fit" onClick={fit}>
              <Maximize size={13} />
            </MapButton>
          </div>
          <div className="pointer-events-none absolute bottom-3 left-3 z-10 flex items-center gap-3 rounded-md border border-line bg-surface/90 px-2 py-1 text-[11px] text-faint">
            <Legend color="bg-success" label="Healthy" />
            <Legend color="bg-warning" label="Degraded" />
            <Legend color="bg-danger-solid" label="Failing" />
            {options.traffic && traffic.status === 'live' && (
              <span className="flex items-center gap-1" data-testid="k8s-map-traffic-legend">
                <svg width="34" height="10" aria-hidden>
                  <line x1="0" y1="5" x2="14" y2="5" stroke={palette.traffic} strokeWidth="1.5" />
                  <line x1="18" y1="5" x2="34" y2="5" stroke={palette.trafficHot} strokeWidth="6" />
                </svg>
                traffic {BANDS[0].label} … {BANDS[BANDS.length - 1]?.label}
              </span>
            )}
          </div>
        </div>
      </div>
      {selectedNode && !nodesView && (
        <SidePanel storageKey="k8s-map" defaultWidth={340} testId="k8s-map-panel">
          <MapPanel
            node={selectedNode}
            layout={layout}
            index={index}
            onClose={() => {
              setSelected(null)
            }}
            onGo={goTo}
            onOpen={onOpen}
            onLogs={(ref) => {
              const w = data?.workloads.find(
                (x) => x.kind === ref.kind && x.ns === ref.ns && x.name === ref.name
              )
              onLogs(ref, w?.labels ?? null)
            }}
            onShell={onShell}
            folded={
              selectedNode.kind === 'namespace' && selectedNode.ns
                ? isFolded(selectedNode.ns)
                : null
            }
            onToggleNs={toggleNs}
            impact={impactMode}
            onImpact={setImpactMode}
            traffic={nodeTraffic}
          />
        </SidePanel>
      )}
    </div>
  )
}

function TrafficDot({ status }: { status: TrafficState['status'] }): React.JSX.Element {
  return (
    <span
      className={cx(
        'size-1.5 rounded-full',
        status === 'live'
          ? 'bg-success'
          : status === 'connecting'
            ? 'animate-pulse bg-warning'
            : 'bg-line-strong'
      )}
      data-testid="k8s-map-traffic-status"
      data-status={status}
    />
  )
}

/** Traffic của workload đang chọn (bảng bên phải). */
function TrafficSection({
  traffic
}: {
  traffic: {
    status: TrafficState['status']
    reason: string | undefined
    incoming: TrafficRate[]
    outgoing: TrafficRate[]
  }
}): React.JSX.Element {
  const row = (r: TrafficRate, peer: TrafficPeer): React.JSX.Element => (
    <div
      key={`${peer.kind}|${peer.ns}|${peer.name}`}
      className="flex h-6 items-center gap-2 text-xs"
      data-testid="k8s-map-traffic-row"
    >
      <span className="min-w-0 flex-1 truncate font-mono text-fg" title={peerLabel(peer)}>
        {peerLabel(peer)}
      </span>
      <span className="shrink-0 text-faint tabular-nums">{formatRate(r.rate)}</span>
    </div>
  )
  return (
    <section data-testid="k8s-map-node-traffic">
      <Heading>Live traffic</Heading>
      {traffic.status === 'unavailable' && (
        <p className="text-xs text-faint">Unavailable — {traffic.reason ?? 'no Caretta'}.</p>
      )}
      {traffic.status === 'connecting' && (
        <p className="text-xs text-faint">Connecting to Caretta…</p>
      )}
      {traffic.status === 'live' && !traffic.incoming.length && !traffic.outgoing.length && (
        <p className="text-xs text-faint">No traffic observed in the last interval.</p>
      )}
      {traffic.incoming.length > 0 && (
        <>
          <div className="mt-1 text-[11px] text-faint">In</div>
          {traffic.incoming.map((r) => row(r, r.client))}
        </>
      )}
      {traffic.outgoing.length > 0 && (
        <>
          <div className="mt-1 text-[11px] text-faint">Out</div>
          {traffic.outgoing.map((r) => row(r, r.server))}
        </>
      )}
    </section>
  )
}

const DOT: Record<MapTone, string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  bad: 'bg-danger-solid',
  muted: 'bg-line-strong'
}

function Chip({
  on,
  onClick,
  testId,
  title,
  children
}: {
  on: boolean
  onClick: () => void
  testId?: string
  title?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={on}
      title={title}
      data-testid={testId}
      className={cx(
        'h-7 rounded-md border px-2 font-medium whitespace-nowrap',
        on ? 'border-accent/40 bg-accent-soft text-fg' : 'border-line text-muted hover:text-fg'
      )}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function MapButton({
  label,
  testId,
  onClick,
  children
}: {
  label: string
  testId?: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-testid={testId}
      className="flex size-7 items-center justify-center text-muted hover:bg-hover hover:text-fg"
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function Legend({ color, label }: { color: string; label: string }): React.JSX.Element {
  return (
    <span className="flex items-center gap-1">
      <span className={cx('size-2 rounded-full', color)} />
      {label}
    </span>
  )
}

/** Bảng bên phải: mục đang chọn, quan hệ (bấm để bay tới), thao tác. */
function MapPanel({
  node,
  layout,
  index,
  onClose,
  onGo,
  onOpen,
  onLogs,
  onShell,
  folded,
  onToggleNs,
  impact,
  onImpact,
  traffic
}: {
  node: MapNode
  layout: MapLayout | null
  index: { byId: Map<string, MapNode>; edgesOf: Map<string, MapEdge[]>; ordered: MapNode[] }
  onClose: () => void
  onGo: (n: MapNode) => void
  onOpen: (ref: MapRef) => void
  onLogs: (ref: MapRef) => void
  onShell: (ref: MapRef) => void
  /** Namespace: đang gập không (null = không phải namespace). */
  folded: boolean | null
  onToggleNs: (ns: string) => void
  impact: boolean
  onImpact: (on: boolean) => void
  traffic: React.ComponentProps<typeof TrafficSection>['traffic'] | null
}): React.JSX.Element {
  const affected = useMemo(
    () =>
      layout && node.kind !== 'region' && node.kind !== 'namespace'
        ? impactOf(layout, node.id)
        : null,
    [layout, node]
  )
  const affectedCounts = (() => {
    const counts = new Map<string, number>()
    for (const id of affected ?? []) {
      const n = index.byId.get(id)
      if (!n) continue
      const label = n.kind === 'route' ? 'route' : n.kind === 'pvc' ? 'volume' : n.kind
      counts.set(label, (counts.get(label) ?? 0) + 1)
    }
    return [...counts.entries()].map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`)
  })()
  const tech = node.tech ? TECH[node.tech] : undefined
  const kindTitle =
    node.kind === 'route'
      ? routeTitle(node.ref?.kind ?? '')
      : node.kind === 'workload' && node.ref
        ? workloadKindLabel(node.ref.kind)
        : KIND_TITLE[node.kind]
  const edges = index.edgesOf.get(node.id) ?? []
  const linked = (dir: 'in' | 'out'): MapNode[] =>
    edges
      .filter((e) => (dir === 'in' ? e.to === node.id : e.from === node.id))
      .map((e) => index.byId.get(dir === 'in' ? e.from : e.to))
      .filter((n): n is MapNode => Boolean(n))
  const incoming = linked('in')
  // NetworkPolicy có mục riêng — không lẫn vào "Uses".
  const outgoing = linked('out').filter((n) => n.kind !== 'policy')
  const children = index.ordered.filter((n) => n.parent === node.id)
  const parent = node.parent ? index.byId.get(node.parent) : undefined
  const policies = layout?.policies[node.id] ?? []
  const podTones = children.filter((c) => c.kind === 'pod')
  const isWorkload = node.kind === 'workload' && Boolean(node.ref)

  const section = (title: string, list: MapNode[]): React.JSX.Element | null =>
    list.length === 0 ? null : (
      <section>
        <Heading>
          {title} <span className="ml-1 font-normal text-faint">{list.length}</span>
        </Heading>
        <div className="flex flex-col">
          {list.slice(0, 200).map((n) => (
            <button
              key={n.id}
              type="button"
              className="group flex h-7 items-center gap-2 rounded px-1 text-left text-xs hover:bg-hover"
              data-testid="k8s-map-link"
              data-name={n.label}
              onClick={() => {
                onGo(n)
              }}
            >
              <span className={cx('size-1.5 shrink-0 rounded-full', DOT[n.tone])} />
              <span className="min-w-0 flex-1 truncate font-mono text-fg group-hover:text-accent">
                {n.label}
              </span>
              <span className="shrink-0 truncate text-faint">
                {n.kind === 'route'
                  ? routeTitle(n.ref?.kind ?? '')
                  : n.kind === 'workload' && n.ref
                    ? workloadKindLabel(n.ref.kind)
                    : KIND_TITLE[n.kind]}
              </span>
            </button>
          ))}
        </div>
      </section>
    )

  return (
    <>
      <div className="flex items-start gap-2 border-b border-line px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-semibold text-fg" title={node.label}>
              {node.label}
            </span>
            {node.kind !== 'region' && node.kind !== 'namespace' && (
              <Pill tone={node.tone}>
                {node.tone === 'ok'
                  ? 'healthy'
                  : node.tone === 'bad'
                    ? 'failing'
                    : node.tone === 'warn'
                      ? 'degraded'
                      : '—'}
              </Pill>
            )}
          </div>
          <div className="truncate text-xs text-faint">
            {kindTitle}
            {node.ns && node.kind !== 'namespace' ? ` · ${node.ns}` : ''}
          </div>
        </div>
        <button
          type="button"
          aria-label="Close"
          className="rounded p-1 text-muted hover:bg-hover hover:text-fg"
          onClick={onClose}
        >
          <X size={15} />
        </button>
      </div>
      <div className="flex flex-wrap gap-1 border-b border-line px-2 py-1.5">
        {node.ref && (
          <PanelAction
            icon={<ExternalLink size={13} />}
            label={node.kind === 'namespace' ? 'Show resources' : 'Open details'}
            testId="k8s-map-open"
            onClick={() => {
              if (node.ref) onOpen(node.ref)
            }}
          />
        )}
        {(isWorkload || node.kind === 'pod') && node.ref?.kind !== 'cronjobs.batch' && (
          <PanelAction
            icon={<FileText size={13} />}
            label="Logs"
            onClick={() => {
              if (node.ref) onLogs(node.ref)
            }}
          />
        )}
        {node.kind === 'pod' && (
          <PanelAction
            icon={<SquareTerminal size={13} />}
            label="Shell"
            onClick={() => {
              if (node.ref) onShell(node.ref)
            }}
          />
        )}
        {folded !== null && (
          <PanelAction
            icon={folded ? <ChevronsUpDown size={13} /> : <ChevronsDownUp size={13} />}
            label={folded ? 'Expand' : 'Collapse'}
            testId="k8s-map-panel-fold"
            onClick={() => {
              if (node.ns) onToggleNs(node.ns)
            }}
          />
        )}
        <PanelAction
          icon={<Locate size={13} />}
          label="Center"
          onClick={() => {
            onGo(node)
          }}
        />
      </div>
      <div
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-3"
        data-testid="k8s-map-details"
      >
        <p className="text-xs text-muted">{node.sub}</p>
        {tech && (
          <p className="flex items-center gap-1.5 text-xs text-muted" data-testid="k8s-map-tech">
            {node.tech && <TechIcon tech={node.tech} size={18} />}
            {tech.label}
          </p>
        )}
        {node.techs && node.techs.length > 0 && (
          <p className="text-xs text-muted">
            Runs {node.techs.map((id) => TECH[id]?.label ?? id).join(', ')}
          </p>
        )}
        {affected && (
          <section data-testid="k8s-map-impact">
            <Heading
              action={
                <button
                  type="button"
                  aria-pressed={impact}
                  data-testid="k8s-map-impact-toggle"
                  className={cx(
                    'rounded px-1.5 py-0.5 text-[11px] font-medium',
                    impact ? 'bg-warning-soft text-warning' : 'text-accent hover:bg-hover'
                  )}
                  onClick={() => {
                    onImpact(!impact)
                  }}
                >
                  {impact ? 'Showing' : 'Show on map'}
                </button>
              }
            >
              Blast radius
            </Heading>
            <p className="text-xs text-muted" data-testid="k8s-map-impact-summary">
              {affected.size === 0
                ? 'Nothing else on the map depends on it.'
                : `If it changes or fails: ${affectedCounts.join(' · ')}.`}
            </p>
          </section>
        )}
        {node.badges && node.badges.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {node.badges.map((b) => (
              <Pill key={b} tone="info">
                {b}
              </Pill>
            ))}
          </div>
        )}
        {node.stats && (
          <div className="grid grid-cols-2 gap-2 text-xs">
            <Stat label="Workloads" value={node.stats.workloads} />
            <Stat label="Pods" value={node.stats.pods} />
            <Stat
              label="Degraded"
              value={node.stats.warn}
              tone={node.stats.warn ? 'text-warning' : undefined}
            />
            <Stat
              label="Failing"
              value={node.stats.bad}
              tone={node.stats.bad ? 'text-danger' : undefined}
            />
          </div>
        )}
        {traffic && traffic.status !== 'off' && <TrafficSection traffic={traffic} />}
        {podTones.length > 0 && (
          <section>
            <Heading>
              Pods <span className="ml-1 font-normal text-faint">{podTones.length}</span>
            </Heading>
            <div className="flex flex-wrap gap-1">
              {podTones.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  title={`${p.label} — ${p.sub}`}
                  className={cx(
                    'size-3 rounded-full ring-offset-1 hover:ring-2 hover:ring-accent',
                    DOT[p.tone]
                  )}
                  onClick={() => {
                    onGo(p)
                  }}
                />
              ))}
            </div>
          </section>
        )}
        {section(
          node.kind === 'workload'
            ? 'Traffic from'
            : node.kind === 'policy'
              ? 'Applies to'
              : node.kind === 'route'
                ? 'Gateways'
                : 'Linked from',
          incoming
        )}
        {section(
          node.kind === 'service'
            ? 'Sends traffic to'
            : node.kind === 'route'
              ? 'Routes to'
              : node.kind === 'gateway'
                ? 'Routes attached'
                : 'Uses',
          outgoing
        )}
        {policies.length > 0 && (
          <section>
            <Heading>Network policies</Heading>
            <div className="flex flex-col gap-0.5 text-xs">
              {policies.map((p) => (
                <span key={p} className="flex items-center gap-1.5 font-mono text-fg">
                  <Box size={11} className="text-faint" /> {p}
                </span>
              ))}
            </div>
          </section>
        )}
        {node.kind !== 'workload' &&
          node.kind !== 'pod' &&
          section(
            node.kind === 'region' ? 'Namespaces' : 'Inside',
            children.filter((c) => c.kind !== 'pod')
          )}
        {parent && parent.kind !== 'region' && (
          <section>
            <Heading>In</Heading>
            <button
              type="button"
              className="flex h-7 items-center gap-2 rounded px-1 text-left text-xs hover:bg-hover"
              onClick={() => {
                onGo(parent)
              }}
            >
              <span className={cx('size-1.5 shrink-0 rounded-full', DOT[parent.tone])} />
              <span className="font-mono text-fg">{parent.label}</span>
              <span className="text-faint">{KIND_TITLE[parent.kind]}</span>
            </button>
          </section>
        )}
      </div>
    </>
  )
}

function PanelAction({
  icon,
  label,
  testId,
  onClick
}: {
  icon: React.ReactNode
  label: string
  testId?: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium whitespace-nowrap text-muted hover:bg-hover hover:text-fg"
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  )
}

function Stat({
  label,
  value,
  tone
}: {
  label: string
  value: number
  tone?: string | undefined
}): React.JSX.Element {
  return (
    <div className="rounded-md border border-line px-2 py-1.5">
      <div className="text-[11px] text-faint">{label}</div>
      <div className={cx('text-sm font-semibold tabular-nums', tone ?? 'text-fg')}>{value}</div>
    </div>
  )
}
