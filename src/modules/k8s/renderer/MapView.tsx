import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronsDownUp,
  ChevronsUpDown,
  Maximize,
  Minus,
  Plus,
  RefreshCw,
  Search,
  Tag,
  X
} from 'lucide-react'
import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Viewport
} from '@xyflow/react'
import '@xyflow/react/dist/base.css'
import { cx, Segmented } from '../../../renderer/src/components/ui'
import { Pill, SidePanel } from '../../../renderer/src/components/panels'
import { cleanError } from '../../../renderer/src/lib/format'
import {
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
  type MapNode
} from '../shared/map'
import { BANDS, WORKLOAD_KIND_ID, byPair, type TrafficPeer } from '../shared/traffic'
import {
  EDGE_TYPES,
  MapContext,
  NEAR_ZOOM,
  NODE_TYPES,
  type Band,
  type MapCtx,
  type MapFlowEdge,
  type MapFlowNode
} from './MapFlow'
import { NodesView } from './NodesView'
import { TrafficMap } from './TrafficMap'
import { useTraffic } from './useTraffic'
import {
  type Request,
  type MapRef,
  OPTIONS_KEY,
  readPalette,
  MAX_ANIMATED_EDGES,
  type Options,
  loadOptions,
  KIND_TITLE,
  Z,
  routeTitle,
  DOT
} from './mapModel'
import { ZoomLabel, TrafficDot, Chip, MapButton, Legend } from './MapControls'
import { MapPanel, HoverCard } from './MapPanel'
import { buildMapEdges } from './mapEdges'

const MIN_ZOOM = 0.02
const MAX_ZOOM = 3
const REFRESH_MS = 20_000

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
  const [hover, setHover] = useState<{
    id: string
    x: number
    y: number
    w: number
    h: number
  } | null>(null)
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [band, setBand] = useState<Band>(() =>
    (savedViewports.get(tabId)?.zoom ?? 0.5) >= NEAR_ZOOM ? 'near' : 'far'
  )
  /** Khung bản đồ (callback ref) — đọc token màu sau khi gắn vào DOM. */
  const [mapEl, setMapEl] = useState<HTMLDivElement | null>(null)
  // Callback ref ổn định (ref viết inline đổi mỗi lần render → React gọi lại null/el → render lặp).
  const attachMap = useCallback((el: HTMLDivElement | null) => {
    wrapRef.current = el
    setMapEl(el)
  }, [])
  const [themeTick, setThemeTick] = useState(0)
  const palette = useMemo(
    () => readPalette(mapEl),
    // themeTick / darkCanvas: đọc lại khi theme hay nền bản đồ đổi.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mapEl, themeTick, options.darkCanvas]
  )
  const reducedMotion = useMemo(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    []
  )
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
  const trafficView = options.view === 'traffic'
  // Nodes / Traffic: không vẽ bản đồ workload (ẩn các điều khiển của nó).
  const nodesView = options.view !== 'workloads'
  const traffic = useTraffic(
    request,
    active && (trafficView || (options.traffic && options.view === 'workloads'))
  )

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
      setThemeTick((n) => n + 1)
    })
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'style']
    })
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onScheme = (): void => {
      setThemeTick((n) => n + 1)
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
      if (p.kind === 'Pod') {
        const parent = index.byId.get(`p:${p.ns}/${p.name}`)?.parent
        if (parent) return parent
      }
      // Workload không có thẻ (namespace đang thu gọn) → nối vào đảo namespace của nó.
      return p.ns && index.byId.has(`n:${p.ns}`) ? `n:${p.ns}` : null
    },
    [index]
  )
  const trafficEdges = useMemo(() => {
    // Nhiều workload cùng một đảo thu gọn → gộp cặp trùng (id cạnh phải duy nhất).
    const out = new Map<string, { from: string; to: string; rate: number }>()
    for (const r of byPair(traffic.rates)) {
      const a = peerNode(r.client)
      const b = peerNode(r.server)
      if (!a || !b || a === b) continue
      const key = `${a}>${b}`
      out.set(key, { from: a, to: b, rate: (out.get(key)?.rate ?? 0) + r.rate })
    }
    return [...out.values()]
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
    // Lan theo đúng hướng phụ thuộc: xuôi (thứ nó gọi tới: route → service → workload → PVC) và
    // ngược (thứ gọi tới nó), không quay đầu giữa chừng — chọn Ingress A không làm sáng Ingress B
    // chỉ vì cùng trỏ tới một Service.
    const walk = (from: string, dir: 'down' | 'up', depth: number): void => {
      if (depth === 0) return
      // NetworkPolicy áp lên cả nhóm workload — không lan tiếp qua nó.
      if (from !== focusId && index.byId.get(from)?.kind === 'policy') return
      for (const e of index.edgesOf.get(from) ?? []) {
        const next =
          dir === 'down' ? (e.from === from ? e.to : null) : e.to === from ? e.from : null
        if (next === null || set.has(next)) continue
        set.add(next)
        walk(next, dir, depth - 1)
      }
    }
    const visit = (id: string, depth: number): void => {
      set.add(id)
      walk(id, 'down', depth)
      walk(id, 'up', depth)
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

  const edges = useMemo(
    () =>
      buildMapEdges({
        band,
        layout,
        byId: index.byId,
        related,
        focusId,
        palette,
        structural: options.edges,
        traffic: options.traffic ? trafficEdges : []
      }),
    [band, options.edges, options.traffic, layout, related, palette, trafficEdges, index, focusId]
  )

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

  const local = (e: {
    clientX: number
    clientY: number
  }): { x: number; y: number; w: number; h: number } => {
    const r = wrapRef.current?.getBoundingClientRect()
    return {
      x: e.clientX - (r?.left ?? 0),
      y: e.clientY - (r?.top ?? 0),
      w: r?.width ?? 600,
      h: r?.height ?? 400
    }
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
      onToggleNs: toggleNs,
      strong: selected !== null,
      particles:
        band === 'near' &&
        !reducedMotion &&
        options.traffic &&
        trafficEdges.length <= MAX_ANIMATED_EDGES
    }),
    [
      band,
      selected,
      related,
      problemsOnly,
      options.pods,
      index,
      toggleNs,
      reducedMotion,
      options.traffic,
      trafficEdges.length
    ]
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
              { value: 'nodes', label: 'Nodes' },
              { value: 'traffic', label: 'Traffic' }
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
              on={options.darkCanvas}
              testId="k8s-map-dark-canvas"
              title="Dark background for the map, whatever the app theme"
              onClick={() => {
                setOpt({ darkCanvas: !options.darkCanvas })
              }}
            >
              Dark canvas
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
        {options.view === 'nodes' && data && shownData && (
          <NodesView data={data} shown={shownData} onOpen={onOpen} />
        )}
        {trafficView && (
          <div className={cx('k8s-map flex min-h-0 flex-1', options.darkCanvas && 'k8s-map-dark')}>
            <TrafficMap
              traffic={traffic}
              scope={namespaces}
              palette={palette.ramp}
              particles={!reducedMotion && traffic.rates.length <= MAX_ANIMATED_EDGES}
              onOpen={onOpen}
            />
          </div>
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
          ref={attachMap}
          tabIndex={0}
          role="application"
          aria-label="Cluster map — drag to move, scroll to zoom, click to select"
          data-testid="k8s-map-canvas"
          className={cx(
            'k8s-map relative min-h-0 flex-1 overflow-hidden outline-none',
            options.darkCanvas && 'k8s-map-dark',
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
                // Chữ nhìn xa giữ cỡ trên màn hình (CSS chia cho zoom) — không render lại node.
                wrapRef.current?.style.setProperty('--map-zoom', String(v.zoom))
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
                // Namespace / vùng đã có tên + số liệu ngay trên khung — bảng nổi chỉ che thẻ bên trong.
                if (n.type === 'region' || n.type === 'namespace') return
                const at = local(e)
                // Đang trỏ một pod trong thẻ này → giữ bảng của pod.
                setHover((h) =>
                  h && index.byId.get(h.id)?.parent === n.id ? h : { id: n.id, ...at }
                )
              }}
              onNodeMouseLeave={() => {
                setHover(null)
              }}
            >
              <Background
                variant={BackgroundVariant.Dots}
                gap={24}
                size={1}
                className="!bg-transparent"
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
            <HoverCard
              node={hoverNode}
              podsOf={index.podsOf}
              x={Math.max(8, Math.min(hover.x + 16, hover.w - 300))}
              // Gần đáy → bảng hiện phía trên con trỏ.
              {...(hover.y + 230 > hover.h
                ? { bottom: hover.h - hover.y + 12 }
                : { y: hover.y + 16 })}
            />
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
                <svg width="46" height="10" aria-hidden>
                  <defs>
                    <linearGradient id="k8s-map-ramp" x1="0" x2="1" y1="0" y2="0">
                      {palette.ramp.map((c, i) => (
                        <stop key={c} offset={i / (palette.ramp.length - 1)} stopColor={c} />
                      ))}
                    </linearGradient>
                  </defs>
                  <path
                    d="M1 7 L45 3"
                    stroke="url(#k8s-map-ramp)"
                    strokeWidth="3"
                    strokeLinecap="round"
                  />
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
