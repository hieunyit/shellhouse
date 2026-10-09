import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertTriangle,
  ChevronsDownUp,
  ChevronsUpDown,
  Crosshair,
  Maximize,
  Minus,
  Plus,
  RotateCcw,
  Search,
  SlidersHorizontal,
  X
} from 'lucide-react'
import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  type NodeChange,
  type Viewport
} from '@xyflow/react'
import '@xyflow/react/dist/base.css'
import { cx, Modal } from '../../../../renderer/src/components/ui'
import { SidePanel } from '../../../../renderer/src/components/panels'
import { cleanError } from '../../../../renderer/src/lib/format'
import { t, tn } from '../../../registry/renderer-kit'
import {
  buildTopology,
  layoutTopology,
  pathThrough,
  workloadId,
  type TopoGraph,
  type TopoLayout,
  type TopoNode
} from '../../shared/appTopology'
import type { EgressRow } from '../../shared/egress'
import { useConnections } from '../useConnections'
import {
  groupNamespaces,
  groupOrder,
  parseLabelSelector,
  selectorMatches,
  type MapData,
  type MapGrouping,
  type MapPod
} from '../../shared/map'
import { WORKLOAD_KIND_ID, byPair, type TrafficPeer } from '../../shared/traffic'
import { KindIcon } from '../icons'
import {
  useCloseOnOutside,
  MapButton,
  MenuButton,
  MenuHeading,
  MenuItem,
  MenuToggle,
  NamespaceGrouping,
  TrafficMenu,
  ZoomLabel
} from '../MapControls'
import { regionTitle, type MapRef, type Request } from '../mapModel'
import type { ToolbarFit } from '../../shared/toolbarFit'
import type { TrafficState } from '../useTraffic'
import { laneHint, laneTitle } from './text'
import { TopoInspector, type NodeTraffic } from './TopoInspector'
import {
  FAR_ZOOM,
  TINY_ZOOM,
  TOPO_EDGE_TYPES,
  TOPO_NODE_TYPES,
  TopoContext,
  type TopoCtx,
  type TopoFlowEdge,
  type TopoFlowNode,
  type TopoTraffic
} from './TopoFlow'
import { idleBelow, useTrafficUnit } from '../trafficUnit'

const OPTIONS_KEY = 'shellhouse.k8s.topology'
/** Từ chừng này namespace / workload trở lên: mặc định gập hết, mở cái cần xem. */
const AUTO_FOLD_NAMESPACES = 6
const AUTO_FOLD_WORKLOADS = 200
/** Đánh dấu "đã có chỗ xem lưu theo tab" (chưa biết phạm vi namespace). */
const SAVED_VIEW = '\u0000saved'
/**
 * Zoom nhỏ nhất khi tự vừa khung (mở bản đồ, tập trung, bay tới mục) — dưới mức này chữ khó đọc:
 * cuộn để xem thêm. "Vừa tất cả" (phím 0) thì không giới hạn (thẻ rút gọn khi thu nhỏ xa).
 */
const READABLE_ZOOM = 0.75
const MIN_ZOOM = 0.08
const MAX_ZOOM = 2

interface Options {
  showDeps: boolean
  hideSystem: boolean
}

function loadOptions(): Options {
  // Làn Config & lưu trữ tắt sẵn (vấn đề về config vẫn hiện trên thẻ workload) — bản đồ gọn, đủ rộng.
  const base: Options = { showDeps: false, hideSystem: true }
  try {
    const raw = window.localStorage.getItem(OPTIONS_KEY)
    if (raw) return { ...base, ...(JSON.parse(raw) as Partial<Options>) }
  } catch {
    // Bỏ qua.
  }
  return base
}

/** Trạng thái xem theo tab (không lưu đĩa): quay lại thấy đúng như cũ. */
interface TabState {
  /** `auto`: giá trị tự động lúc ghi nhớ — đổi (vd. chọn lại namespace) thì bỏ lựa chọn cũ. */
  fold: { all: boolean; except: ReadonlySet<string>; auto: boolean } | null
  showAll: ReadonlySet<string>
  expanded: ReadonlySet<string>
  focus: string | null
  viewport: Viewport | null
  moved: Readonly<Record<string, { x: number; y: number }>>
}
const saved = new Map<string, TabState>()
const blank = (): TabState => ({
  fold: null,
  showAll: new Set(),
  expanded: new Set(),
  focus: null,
  viewport: null,
  moved: {}
})

export interface TopologyMapProps {
  tabId: string
  data: MapData | null
  error: string | null
  request: Request
  traffic: TrafficState
  trafficOn: boolean
  onTrafficOn: (on: boolean) => void
  /** Làn Outbound: điểm đến khai báo trong cấu hình (env, ConfigMap, Secret). */
  egress: {
    on: boolean
    rows: readonly EgressRow[] | null
    secrets: boolean
    onOn: (on: boolean) => void
    onSecrets: (on: boolean) => void
  }
  /** Phân giải cả tên nội bộ (.corp…) bằng DNS của máy này khi ghép khai báo với traffic. */
  internalDns: boolean
  darkCanvas: boolean
  onDarkCanvas: (on: boolean) => void
  /** Cách gom namespace của lưới tổng quan (lưu chung với tuỳ chọn Map). */
  grouping: MapGrouping
  /** Khoá nhãn hay dùng để gom (gợi ý trong menu). */
  groupKeys: readonly string[]
  onGrouping: (grouping: MapGrouping) => void
  /** Ô trên thanh công cụ của Map để đặt điều khiển (một hàng). */
  toolbar: HTMLElement | null
  /** Mức gọn của thanh công cụ (theo độ rộng thật) — mặc định đầy đủ. */
  barFit?: ToolbarFit
  /** Khung hẹp: bảng chi tiết nổi đè lên canvas (xem panelOverlay). */
  overlayPanel?: boolean
  onOpen: (ref: MapRef) => void
  onLogs: (ref: MapRef, labels: Record<string, string> | null) => void
  onShell?: ((ref: MapRef) => void) | undefined
  /** Mở hộp thoại port-forward của K8sView (không truyền → ẩn nút). */
  onPortForward?: ((ref: MapRef) => void) | undefined
}

/**
 * Topology tĩnh — nhân vật chính của Map: Entry → Routes → Services → Workloads → Pods → Config,
 * theo dải namespace. Đẹp và dùng được không cần traffic; traffic (Caretta) chỉ là lớp phủ tuỳ chọn.
 */
export function TopologyMap(props: TopologyMapProps): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <TopologyInner {...props} />
    </ReactFlowProvider>
  )
}

function TopologyInner({
  tabId,
  data,
  error,
  request,
  traffic,
  trafficOn,
  onTrafficOn,
  egress,
  internalDns,
  darkCanvas,
  onDarkCanvas,
  grouping,
  groupKeys,
  onGrouping,
  toolbar,
  barFit = 'full',
  overlayPanel = false,
  onOpen,
  onLogs,
  onShell,
  onPortForward
}: TopologyMapProps): React.JSX.Element {
  const unit = useTrafficUnit()
  const rf = useReactFlow<TopoFlowNode, TopoFlowEdge>()
  const [options, setOptionsRaw] = useState(loadOptions)
  const setOptions = (patch: Partial<Options>): void => {
    const next = { ...options, ...patch }
    setOptionsRaw(next)
    try {
      window.localStorage.setItem(OPTIONS_KEY, JSON.stringify(next))
    } catch {
      // Bỏ qua.
    }
  }
  const [tab, setTabRaw] = useState<TabState>(() => saved.get(tabId) ?? blank())
  const setTab = useCallback(
    (patch: Partial<TabState> | ((s: TabState) => Partial<TabState>)) => {
      setTabRaw((s) => {
        const next = { ...s, ...(typeof patch === 'function' ? patch(s) : patch) }
        saved.set(tabId, next)
        return next
      })
    },
    [tabId]
  )
  const [selectedRaw, setSelected] = useState<string | null>(null)
  const [selectedPod, setSelectedPod] = useState<{ group: string; pod: MapPod } | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const searchBoxRef = useRef<HTMLDivElement | null>(null)
  useCloseOnOutside(searchOpen, searchBoxRef, () => {
    setSearchOpen(false)
  })
  const [problemsOnly, setProblemsOnly] = useState(false)
  const [yaml, setYaml] = useState<{ title: string; text: string | null; error?: string } | null>(
    null
  )
  const [pendingGo, setPendingGo] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  // Chỉ vẽ lại thẻ khi vượt ngưỡng (không phải mỗi bước zoom).
  const far = useStore((s) => s.transform[2] < FAR_ZOOM)
  const tiny = useStore((s) => s.transform[2] < TINY_ZOOM)

  // ——— Đồ thị + bố cục ———
  const autoFold =
    (data?.namespaces.length ?? 0) >= AUTO_FOLD_NAMESPACES ||
    (data?.workloads.length ?? 0) >= AUTO_FOLD_WORKLOADS
  // Lựa chọn thu gọn / mở của người dùng chỉ còn giá trị khi cách tự động không đổi: chọn lại
  // namespace (1 ↔ nhiều) thì bản đồ theo quy tắc tự động như lúc mới mở.
  const foldOf = useCallback(
    (s: TabState): { all: boolean; except: ReadonlySet<string>; auto: boolean } =>
      s.fold?.auto === autoFold ? s.fold : { all: autoFold, except: new Set(), auto: autoFold },
    [autoFold]
  )
  const fold = useMemo(() => foldOf(tab), [tab, foldOf])
  const isFolded = useCallback((ns: string) => fold.all !== fold.except.has(ns), [fold])
  /** Vừa mở / gập namespace: bản đồ đổi bề rộng → vừa khung lại nếu phần mở ra tràn khỏi màn. */
  const toggledRef = useRef(false)
  const toggleNs = useCallback(
    (ns: string) => {
      toggledRef.current = true
      setTab((s) => {
        const f = foldOf(s)
        const except = new Set(f.except)
        if (except.has(ns)) except.delete(ns)
        else except.add(ns)
        return { fold: { all: f.all, except, auto: autoFold } }
      })
    },
    [setTab, foldOf, autoFold]
  )
  // Nhóm của namespace cho lưới tổng quan (mục đích / tiền tố / nhãn).
  const groups = useMemo(() => {
    if (!data) return null
    const of = groupNamespaces(data, grouping)
    return { of, order: groupOrder(of.values(), grouping) }
  }, [data, grouping])
  // Điểm đến khai báo ghép với traffic quan sát (cùng luồng Caretta / Hubble đã đọc cho bản đồ).
  const conn = useConnections({
    request,
    declared: egress.on ? egress.rows : null,
    data,
    active: egress.on && trafficOn,
    internalDns,
    traffic,
    observe: trafficOn
  })
  const graph = useMemo<TopoGraph | null>(() => {
    if (!data) return null
    const base = {
      hideSystem: options.hideSystem,
      showDeps: options.showDeps,
      ...(egress.on && conn.rows ? { egress: conn.rows } : {}),
      expanded: tab.expanded,
      collapsed: isFolded,
      showAll: tab.showAll,
      ...(groups ? { groupOf: (ns: string) => groups.of.get(ns) ?? '' } : {})
    }
    const g = buildTopology(data, { ...base, focus: tab.focus })
    // Mục đang tập trung đã không còn (bị xoá) → hiện tất cả.
    return tab.focus && !g.nodes.length ? buildTopology(data, base) : g
  }, [
    data,
    groups,
    options.hideSystem,
    options.showDeps,
    egress.on,
    conn.rows,
    tab.expanded,
    isFolded,
    tab.showAll,
    tab.focus
  ])
  const layout = useMemo<TopoLayout | null>(
    () => (graph ? layoutTopology(graph, groups?.order ?? []) : null),
    [graph, groups]
  )
  const byId = useMemo(() => new Map((layout?.nodes ?? []).map((n) => [n.id, n])), [layout])
  // Mục chọn biến mất sau khi làm mới / đổi bộ lọc → coi như không chọn.
  const selected = selectedRaw && byId.has(selectedRaw) ? selectedRaw : null
  const selectedNode = selected ? byId.get(selected) : undefined

  // ——— Traffic (lớp phủ) ———
  const podOwner = useMemo(() => {
    const m = new Map<string, string>()
    for (const p of data?.pods ?? []) {
      const kind = p.owner ? WORKLOAD_KIND_ID[p.owner.kind] : undefined
      if (kind && p.owner) m.set(`${p.ns}/${p.name}`, workloadId(kind, p.ns, p.owner.name))
    }
    return m
  }, [data])
  const peerWorkload = useCallback(
    (p: TrafficPeer): string | null => {
      const kind = WORKLOAD_KIND_ID[p.kind]
      if (kind) return workloadId(kind, p.ns, p.name)
      if (p.kind === 'Pod') return podOwner.get(`${p.ns}/${p.name}`) ?? null
      return null
    },
    [podOwner]
  )
  const pairs = useMemo(
    () => (trafficOn && traffic.status === 'live' ? byPair(traffic.rates) : []),
    [trafficOn, traffic.status, traffic.rates]
  )
  const topoTraffic = useMemo<TopoTraffic | null>(() => {
    if (!pairs.length) return null
    const rates = new Map<string, { in: number; out: number }>()
    const bump = (id: string | null, key: 'in' | 'out', v: number): void => {
      if (!id) return
      const r = rates.get(id) ?? { in: 0, out: 0 }
      r[key] += v
      rates.set(id, r)
    }
    for (const r of pairs) {
      const c = peerWorkload(r.client)
      const s = peerWorkload(r.server)
      if (c && c === s) continue
      bump(s, 'in', r.rate)
      bump(c, 'out', r.rate)
    }
    return { rates, updated: traffic.updated }
  }, [pairs, peerWorkload, traffic.updated])

  // ——— Làm nổi / tìm ———
  // Mục đang trỏ có thể vừa biến mất (bấm ô namespace → ô thành dải) — không làm mờ cả bản đồ.
  const focusId = selectedPod?.group ?? selected ?? (hover && byId.has(hover) ? hover : null)
  const lit = useMemo(
    () => (focusId && layout ? pathThrough(layout.edges, focusId) : null),
    [focusId, layout]
  )
  const parsedQuery = useMemo(() => {
    const q = query.trim()
    if (!q) return null
    if (/[=!]|\s(in|notin)\s*\(/.test(q)) {
      const sel = parseLabelSelector(q)
      return sel && !('error' in sel) ? { selector: sel } : { text: q.toLowerCase() }
    }
    return { text: q.toLowerCase() }
  }, [query])
  const matchNode = useCallback(
    (n: TopoNode): boolean => {
      if (!parsedQuery) return false
      if ('selector' in parsedQuery)
        return n.labels ? selectorMatches(parsedQuery.selector, n.labels, true) : false
      const q = parsedQuery.text
      return (
        (n.kind !== 'pods' && n.name.toLowerCase().includes(q)) ||
        (n.kind === 'ingress' || n.kind === 'route'
          ? (n.route?.hosts ?? []).some((h) => h.toLowerCase().includes(q))
          : false) ||
        (n.kind === 'pods' && (n.pods ?? []).some((p) => p.name.toLowerCase().includes(q)))
      )
    },
    [parsedQuery]
  )
  const matches = useMemo(() => {
    if (!parsedQuery || !layout) return null
    return new Set(layout.nodes.filter(matchNode).map((n) => n.id))
  }, [parsedQuery, layout, matchNode])
  /** Nhóm pod có tên chỉ là số lượng ("1") — gợi ý hiện tên pod khớp với chuỗi tìm. */
  const resultLabel = useCallback(
    (n: TopoNode): string => {
      if (n.kind !== 'pods' || !parsedQuery || !('text' in parsedQuery)) return n.name
      const q = parsedQuery.text ?? ''
      const hits = (n.pods ?? []).filter((p) => p.name.toLowerCase().includes(q))
      const first = hits[0]
      if (!first) return n.name
      return hits.length > 1 ? `${first.name} (+${String(hits.length - 1)})` : first.name
    },
    [parsedQuery]
  )
  const results = useMemo(() => {
    if (!parsedQuery || !layout) return []
    return layout.nodes
      .filter((n) => n.kind !== 'more' && matchNode(n))
      .sort((a, b) => a.y - b.y)
      .slice(0, 12)
  }, [parsedQuery, layout, matchNode])
  /** Khớp trong namespace đang gập / bị cắt bớt (chọn → mở ra rồi bay tới). */
  const hiddenResults = useMemo(() => {
    if (!parsedQuery || !data || 'selector' in parsedQuery) return []
    const q = parsedQuery.text
    const shown = new Set(layout?.nodes.map((n) => n.id) ?? [])
    const out: { id: string; ns: string; name: string; kind: string }[] = []
    for (const w of data.workloads) {
      if (out.length >= 8) break
      const id = workloadId(w.kind, w.ns, w.name)
      if (!shown.has(id) && w.name.toLowerCase().includes(q))
        out.push({ id, ns: w.ns, name: w.name, kind: w.kind })
    }
    for (const s of data.services) {
      if (out.length >= 8) break
      const id = `svc:${s.ns}/${s.name}`
      if (!shown.has(id) && s.name.toLowerCase().includes(q))
        out.push({ id, ns: s.ns, name: s.name, kind: 'services' })
    }
    return out
  }, [parsedQuery, data, layout])

  // ——— Khung nhìn ———
  /**
   * all: thấy toàn bộ (nút Fit / phím 0). Không thì vừa bề ngang nhưng không nhỏ hơn mức đọc được —
   * đồ thị dài / rộng thì cuộn để xem tiếp (chữ luôn ≥ 11 px trên màn hình).
   */
  const fitWidth = useCallback(
    (l: TopoLayout, all: boolean, duration = 0) => {
      const wrap = wrapRef.current
      if (!wrap || !wrap.clientWidth) return false
      const W = wrap.clientWidth
      const H = wrap.clientHeight - 30
      const zoom = all
        ? Math.max(MIN_ZOOM, Math.min(1, (W - 32) / l.width, (H - 32) / l.height))
        : Math.max(READABLE_ZOOM, Math.min(1, (W - 32) / l.width))
      void rf.setViewport(
        {
          zoom,
          x: Math.max(16, (W - l.width * zoom) / 2),
          y: all ? Math.max(34, 30 + (H - l.height * zoom) / 2) : 34
        },
        duration ? { duration } : undefined
      )
      return true
    },
    [rf]
  )
  // Vừa khung một lần cho mỗi phạm vi namespace (đổi phạm vi — vd. một namespace → tất cả — bản đồ
  // khác hẳn: vừa khung lại); làm mới cùng phạm vi giữ nguyên chỗ đang xem.
  const scopeKey = useMemo(() => (data ? data.namespaces.map((n) => n.name).join(',') : ''), [data])
  // Quay lại tab đã có chỗ xem: giữ nguyên cho phạm vi đầu tiên nạp được.
  const fittedRef = useRef<string | null>(tab.viewport !== null ? SAVED_VIEW : null)
  useEffect(() => {
    if (!layout || !scopeKey || fittedRef.current === scopeKey) return
    if (fittedRef.current === SAVED_VIEW) {
      fittedRef.current = scopeKey
      return
    }
    if (fitWidth(layout, false)) fittedRef.current = scopeKey
  }, [layout, scopeKey, fitWidth])
  useEffect(() => {
    if (!layout || !toggledRef.current) return
    toggledRef.current = false
    const wrap = wrapRef.current
    if (!wrap?.clientWidth) return
    const v = rf.getViewport()
    if (layout.width * v.zoom + v.x > wrap.clientWidth - 8) fitWidth(layout, false, 200)
  }, [layout, rf, fitWidth])
  const centerOn = useCallback(
    (id: string) => {
      const n = byId.get(id)
      const wrap = wrapRef.current
      if (!n || !wrap) return
      const v = rf.getViewport()
      const zoom = Math.max(v.zoom, READABLE_ZOOM)
      const pos = tab.moved[id] ?? { x: n.x, y: n.y }
      void rf.setViewport(
        {
          zoom,
          x: wrap.clientWidth / 2 - (pos.x + n.w / 2) * zoom,
          y: wrap.clientHeight / 2 - (pos.y + n.h / 2) * zoom
        },
        { duration: 300 }
      )
    },
    [byId, rf, tab.moved]
  )
  const go = useCallback(
    (id: string) => {
      setSelected(id)
      setSelectedPod(null)
      setQuery('')
      setSearchOpen(false)
      // Bảng bên phải mở ra làm khung hẹp lại — đợi bố cục xong rồi mới canh giữa.
      setTimeout(() => {
        centerOn(id)
      }, 40)
      wrapRef.current?.focus()
    },
    [centerOn]
  )
  /** Mục chưa có trên bản đồ: mở namespace / hiện đủ rồi bay tới khi đã vẽ. */
  const reveal = useCallback(
    (id: string, ns: string) => {
      setTab((s) => {
        const f = foldOf(s)
        const except = new Set(f.except)
        if (f.all) except.add(ns)
        else except.delete(ns)
        return {
          fold: { all: f.all, except, auto: autoFold },
          showAll: new Set([...s.showAll, ns]),
          focus: null
        }
      })
      setQuery('')
      setSearchOpen(false)
      setPendingGo(id)
    },
    [setTab, foldOf, autoFold]
  )
  useEffect(() => {
    if (!pendingGo || !byId.has(pendingGo)) return
    const id = pendingGo
    const timer = setTimeout(() => {
      setPendingGo(null)
      go(id)
    }, 0)
    return () => {
      clearTimeout(timer)
    }
  }, [pendingGo, byId, go])

  /** Bật "làm nổi lỗi": dải namespace có lỗi đầu tiên chưa thấy trên khung → cuộn tới (giữ zoom). */
  const highlightProblems = (on: boolean): void => {
    setProblemsOnly(on)
    const wrap = wrapRef.current
    if (!on || !layout || !graph || !wrap) return
    const bad = new Set(
      graph.problems.filter((p) => p.problem.severity !== 'info').map((p) => p.ns)
    )
    const band = layout.bands.find((b) => bad.has(b.ns))
    if (!band) return
    const v = rf.getViewport()
    const top = v.y + band.y * v.zoom
    if (top >= 30 && top + Math.min(band.h, 200) * v.zoom <= wrap.clientHeight) return
    void rf.setViewport({ ...v, y: 34 - band.y * v.zoom }, { duration: 250 })
  }

  /**
   * Tập trung / bỏ tập trung. Vào: vừa bề ngang đồ thị mới (sau khi vẽ). Ra: bay về đúng mục vừa
   * tập trung trên bản đồ đầy đủ — không để khung nhìn lạc ra chỗ trống.
   */
  const refitRef = useRef(false)
  const setFocus = (id: string | null): void => {
    const prev = tab.focus
    setTab({ focus: id })
    if (id) refitRef.current = true
    else if (prev) setPendingGo(prev)
  }
  useEffect(() => {
    if (layout && refitRef.current && fitWidth(layout, false, 200)) refitRef.current = false
  }, [layout, fitWidth])

  const zoomBy = (factor: number): void => {
    const wrap = wrapRef.current
    if (!wrap) return
    const v = rf.getViewport()
    const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.zoom * factor))
    const cx0 = wrap.clientWidth / 2
    const cy0 = wrap.clientHeight / 2
    const k = zoom / v.zoom
    void rf.setViewport({ zoom, x: cx0 - (cx0 - v.x) * k, y: cy0 - (cy0 - v.y) * k })
  }

  // ——— React Flow ———
  const onNodesChange = useCallback(
    (changes: NodeChange<TopoFlowNode>[]) => {
      const next: Record<string, { x: number; y: number }> = {}
      for (const c of changes) if (c.type === 'position' && c.position) next[c.id] = c.position
      if (Object.keys(next).length) setTab((s) => ({ moved: { ...s.moved, ...next } }))
    },
    [setTab]
  )
  const flowNodes = useMemo<TopoFlowNode[]>(() => {
    if (!layout || !graph) return []
    const out: TopoFlowNode[] = []
    const nsInfo = new Map(graph.namespaces.map((n) => [n.name, n]))
    for (const b of layout.bands) {
      if (b.group !== undefined) {
        // Dải của lưới tổng quan: tên nhóm, số namespace, tổng pod lỗi của nhóm.
        const members = graph.namespaces.filter((n) => n.collapsed && (n.group ?? '') === b.group)
        out.push({
          id: `band:${b.ns}`,
          type: 'band',
          position: { x: b.x, y: b.y },
          width: b.w,
          height: b.h,
          zIndex: -1,
          draggable: false,
          selectable: false,
          connectable: false,
          focusable: false,
          data: {
            band: b,
            label: b.group ? regionTitle(b.group) : t('Namespaces'),
            stats: tn(b.count ?? members.length, '{n} namespace', '{n} namespaces'),
            bad: members.reduce((sum, n) => sum + n.stats.failingPods, 0),
            warn: 0
          }
        })
        continue
      }
      const info = nsInfo.get(b.ns)
      const st = info?.stats
      out.push({
        id: `band:${b.ns}`,
        type: 'band',
        position: { x: b.x, y: b.y },
        width: b.w,
        height: b.h,
        zIndex: -1,
        draggable: false,
        selectable: false,
        connectable: false,
        focusable: false,
        data: {
          band: b,
          label: b.ns,
          stats: st
            ? [
                tn(st.workloads, '{n} workload', '{n} workloads'),
                tn(st.pods, '{n} pod', '{n} pods'),
                ...(info.hidden ? [tn(info.hidden, '{n} hidden', '{n} hidden')] : [])
              ].join(' · ')
            : '',
          bad: st?.problems.bad ?? 0,
          warn: st?.problems.warn ?? 0
        }
      })
    }
    for (const n of layout.nodes)
      out.push({
        id: n.id,
        type:
          n.kind === 'workload'
            ? 'workload'
            : n.kind === 'pods'
              ? 'pods'
              : n.kind === 'namespace'
                ? 'namespace'
                : n.kind === 'more'
                  ? 'more'
                  : 'card',
        position: tab.moved[n.id] ?? { x: n.x, y: n.y },
        width: n.w,
        height: n.h,
        draggable: n.kind !== 'namespace' && n.kind !== 'more',
        selectable: false,
        connectable: false,
        data: { node: n }
      })
    return out
  }, [layout, graph, tab.moved])
  const flowEdges = useMemo<TopoFlowEdge[]>(() => {
    if (!layout) return []
    const labelled = new Set<string>()
    return layout.edges.map((e) => {
      // Cạnh `select` (Service → workload): tốc độ vào của workload. Cạnh `calls` (làn Outbound): tốc độ
      // của đúng cặp workload → đích, đã ghép từ traffic quan sát.
      const rate =
        e.kind === 'select'
          ? topoTraffic?.rates.get(e.to)?.in
          : e.kind === 'calls'
            ? e.rate
            : undefined
      const labelKey = e.kind === 'calls' ? e.id : e.to
      const label = rate !== undefined && rate >= idleBelow(unit) && !labelled.has(labelKey)
      if (label) labelled.add(labelKey)
      return {
        id: e.id,
        source: e.from,
        target: e.to,
        sourceHandle: 'r',
        targetHandle: 'l',
        type: 'topo',
        data: { edge: e, ...(rate !== undefined ? { rate } : {}), ...(label ? { label } : {}) }
      }
    })
  }, [layout, topoTraffic, unit])

  const ctx = useMemo<TopoCtx>(
    () => ({
      selected,
      selectedPod: selectedPod?.pod.name ?? null,
      lit,
      strong: selected !== null || selectedPod !== null,
      matches,
      problemsOnly,
      far,
      tiny,
      traffic: topoTraffic,
      onToggleNs: toggleNs,
      onShowAll: (ns) => {
        setTab((s) => ({ showAll: new Set([...s.showAll, ns]) }))
      },
      onTogglePods: (id) => {
        setTab((s) => {
          const next = new Set(s.expanded)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return { expanded: next }
        })
      },
      onSelectPod: (group, pod) => {
        setSelected(group)
        setSelectedPod({ group, pod })
        wrapRef.current?.focus()
      }
    }),
    [selected, selectedPod, lit, matches, problemsOnly, far, tiny, topoTraffic, toggleNs, setTab]
  )

  // ——— Traffic của mục đang chọn ———
  const nodeTraffic = useMemo<NodeTraffic | null>(() => {
    if (!trafficOn || !selectedNode || selectedNode.kind !== 'workload') return null
    const self = (p: TrafficPeer): boolean => peerWorkload(p) === selectedNode.id
    return {
      status: traffic.status,
      reason: traffic.reason,
      incoming: pairs
        .filter((r) => self(r.server) && !self(r.client))
        .sort((a, b) => b.rate - a.rate),
      outgoing: pairs
        .filter((r) => self(r.client) && !self(r.server))
        .sort((a, b) => b.rate - a.rate),
      updated: traffic.updated
    }
  }, [
    trafficOn,
    selectedNode,
    traffic.status,
    traffic.reason,
    traffic.updated,
    pairs,
    peerWorkload
  ])

  const openYaml = (ref: MapRef): void => {
    setYaml({ title: ref.name, text: null })
    request<string>({
      op: 'get',
      kind: ref.kind,
      ...(ref.ns ? { namespace: ref.ns } : {}),
      name: ref.name,
      format: 'yaml'
    }).then(
      (text) => {
        setYaml((y) => (y && y.title === ref.name ? { ...y, text } : y))
      },
      (e: unknown) => {
        setYaml((y) => (y && y.title === ref.name ? { ...y, error: cleanError(e) } : y))
      }
    )
  }

  // ——— Bàn phím ———
  const onKeyDown = (e: React.KeyboardEvent): void => {
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    const handled = (): void => {
      e.preventDefault()
      e.stopPropagation()
    }
    const v = rf.getViewport()
    if (e.key === '/' || (e.key === 'f' && (e.ctrlKey || e.metaKey))) {
      handled()
      searchRef.current?.focus()
    } else if (e.key === '+' || e.key === '=') {
      handled()
      zoomBy(1.2)
    } else if (e.key === '-' || e.key === '_') {
      handled()
      zoomBy(1 / 1.2)
    } else if (e.key === '0') {
      handled()
      if (layout) fitWidth(layout, true, 250)
    } else if (e.key === 'Escape') {
      if (selected || selectedPod) {
        handled()
        setSelected(null)
        setSelectedPod(null)
      } else if (tab.focus) {
        handled()
        setFocus(null)
      }
    } else if (e.key === 'Enter' && selectedNode) {
      const ref = selectedPod
        ? { kind: 'pods', ns: selectedPod.pod.ns, name: selectedPod.pod.name }
        : selectedNode.ref
      if (ref && !selectedNode.missing) {
        handled()
        onOpen(ref)
      }
    } else if (e.key === 'f' && selectedNode) {
      handled()
      setFocus(tab.focus ? null : selectedNode.id)
    } else if (e.key.startsWith('Arrow')) {
      handled()
      if (!selectedNode || !layout) {
        // Không chọn gì: mũi tên để cuộn.
        const dx = e.key === 'ArrowLeft' ? 80 : e.key === 'ArrowRight' ? -80 : 0
        const dy = e.key === 'ArrowUp' ? 80 : e.key === 'ArrowDown' ? -80 : 0
        void rf.setViewport({ ...v, x: v.x + dx, y: v.y + dy })
        return
      }
      // Trái / phải: sang làn trước / sau theo cạnh; lên / xuống: mục trước / sau trong cùng làn.
      let next: string | undefined
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const right = e.key === 'ArrowRight'
        const cands = layout.edges
          .filter((x) => (right ? x.from === selectedNode.id : x.to === selectedNode.id))
          .map((x) => byId.get(right ? x.to : x.from))
          .filter((x): x is NonNullable<typeof x> => Boolean(x))
          .sort((a, b) => Math.abs(a.y - selectedNode.y) - Math.abs(b.y - selectedNode.y))
        next = cands[0]?.id
      } else {
        // Route xếp thụt dưới Gateway trong làn Entry: cùng cột.
        const colOf = (l: TopoNode['lane']): string => (l === 'route' ? 'entry' : l)
        const col = layout.nodes
          .filter((x) => colOf(x.lane) === colOf(selectedNode.lane) && x.kind !== 'more')
          .sort((a, b) => a.y - b.y)
        const i = col.findIndex((x) => x.id === selectedNode.id)
        next = col[e.key === 'ArrowDown' ? i + 1 : i - 1]?.id
      }
      if (next) go(next)
    }
  }

  const problemCount = graph?.problems.filter((p) => p.problem.severity !== 'info').length ?? 0
  const badCount = graph?.problems.filter((p) => p.problem.severity === 'bad').length ?? 0
  const movedAny = Object.keys(tab.moved).length > 0
  const anyFolded = graph?.namespaces.some((n) => n.collapsed) ?? false
  const focusNode = tab.focus ? byId.get(tab.focus) : undefined

  const controls = (
    <div
      className={cx('flex min-w-0 flex-1 items-center gap-1.5', barFit === 'narrow' && 'flex-wrap')}
      data-testid="k8s-topo-toolbar"
    >
      <div
        ref={searchBoxRef}
        className={cx('relative min-w-24 shrink-[3]', barFit === 'narrow' ? 'w-40' : 'w-64')}
      >
        <div className="flex h-7 items-center gap-1.5 rounded-md border border-line bg-subtle px-2 focus-within:border-accent">
          <Search size={12} className="shrink-0 text-faint" />
          <input
            ref={searchRef}
            type="search"
            spellCheck={false}
            placeholder={t('Find by name or label…  ( / )')}
            aria-label={t('Find on the topology')}
            data-testid="k8s-topo-search"
            className="min-w-0 flex-1 bg-transparent text-xs text-fg outline-none placeholder:text-faint"
            value={query}
            onFocus={() => {
              setSearchOpen(true)
            }}
            onChange={(e) => {
              setQuery(e.target.value)
              setSearchOpen(true)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                const first = results[0]
                const hidden = hiddenResults[0]
                if (first) go(first.id)
                else if (hidden) reveal(hidden.id, hidden.ns)
              } else if (e.key === 'Escape') {
                setQuery('')
                wrapRef.current?.focus()
              }
            }}
          />
        </div>
        {searchOpen && parsedQuery && !results.length && !hiddenResults.length && (
          // Không khớp gì: bản đồ đang mờ hết — nói rõ thay vì để người dùng đoán.
          <div
            className="absolute top-8 right-0 left-0 z-40 rounded-lg bg-ds-popover px-3 py-2 text-xs text-muted shadow-ds-popover"
            data-testid="k8s-topo-no-results"
          >
            {t('Nothing on the map matches “{query}”', { query: query.trim() })}
          </div>
        )}
        {searchOpen && (results.length > 0 || hiddenResults.length > 0) && (
          <div
            className="absolute top-8 right-0 left-0 z-40 max-h-80 overflow-auto rounded-lg bg-ds-popover p-1 shadow-ds-popover"
            data-testid="k8s-topo-results"
          >
            {results.map((n) => (
              <button
                key={n.id}
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-hover"
                data-testid="k8s-topo-result"
                data-kind={n.kind}
                data-ref={n.ref?.kind}
                onMouseDown={(e) => {
                  e.preventDefault()
                  go(n.id)
                }}
              >
                <KindIcon kind={n.ref?.kind ?? 'pods'} size={14} />
                <span className="min-w-0 flex-1 truncate font-mono text-fg">{resultLabel(n)}</span>
                <span className="shrink-0 text-faint">
                  {n.title} · {n.ns}
                </span>
              </button>
            ))}
            {hiddenResults.map((r) => (
              <button
                key={r.id}
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-hover"
                data-testid="k8s-topo-result"
                onMouseDown={(e) => {
                  e.preventDefault()
                  reveal(r.id, r.ns)
                }}
              >
                <KindIcon kind={r.kind} size={14} />
                <span className="min-w-0 flex-1 truncate font-mono text-fg">{r.name}</span>
                <span className="shrink-0 text-faint">
                  {r.ns} · {t('hidden')}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      {problemCount > 0 ? (
        <MenuButton
          testId="k8s-topo-problems"
          active={problemsOnly}
          align="left"
          width="w-[26rem]"
          icon={<AlertTriangle size={12} className={badCount ? 'text-danger' : 'text-warning'} />}
          // Hẹp: chỉ còn số (chữ đầy đủ ở tooltip).
          label={
            barFit === 'full'
              ? tn(problemCount, '{n} problem', '{n} problems')
              : String(problemCount)
          }
          title={tn(problemCount, '{n} problem', '{n} problems')}
        >
          {(close) => (
            <>
              <MenuToggle
                on={problemsOnly}
                label={t('Highlight problems')}
                hint={t('Dim everything that is healthy')}
                testId="k8s-topo-problems-only"
                onChange={highlightProblems}
              />
              <div className="mx-2 my-1 border-t border-line" />
              <div className="max-h-80 overflow-auto" data-testid="k8s-topo-problem-list">
                {(graph?.problems ?? [])
                  .filter((p) => p.problem.severity !== 'info')
                  .slice(0, 200)
                  .map((p, i) => (
                    <button
                      key={`${p.node}:${String(i)}`}
                      type="button"
                      className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hover"
                      data-testid="k8s-topo-problem"
                      data-code={p.problem.code}
                      onClick={() => {
                        close()
                        if (byId.has(p.node)) go(p.node)
                        else reveal(p.node, p.ns)
                      }}
                    >
                      <span
                        className={cx(
                          'mt-1 size-2 shrink-0 rounded-full',
                          p.problem.severity === 'bad' ? 'bg-danger-solid' : 'bg-warning'
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-fg">
                          <span className="font-mono font-medium">{p.name}</span>
                          <span className="text-faint">
                            {' '}
                            · {p.title} · {p.ns}
                          </span>
                        </span>
                        <span className="block text-[11.5px] leading-snug text-muted">
                          {p.problem.text}
                        </span>
                      </span>
                    </button>
                  ))}
              </div>
            </>
          )}
        </MenuButton>
      ) : graph ? (
        <span
          className="flex h-7 shrink-0 items-center gap-1.5 px-1 whitespace-nowrap text-success"
          title={t('No problems found')}
          data-testid="k8s-topo-healthy"
        >
          <span className="size-1.5 rounded-full bg-success" />
          {barFit === 'full' && t('No problems found')}
        </span>
      ) : null}
      {focusNode && (
        <span
          className="flex h-7 max-w-64 min-w-0 shrink items-center gap-1.5 rounded-md border border-accent/40 bg-accent-soft pr-1 pl-2 text-fg"
          title={t('Path of {name}', { name: focusNode.name })}
          data-testid="k8s-topo-focus-chip"
        >
          <Crosshair size={12} className="shrink-0 text-accent" />
          <span className="min-w-0 truncate">{t('Path of {name}', { name: focusNode.name })}</span>
          <button
            type="button"
            aria-label={t('Show everything')}
            title={t('Show everything ( Esc )')}
            className="shrink-0 rounded p-0.5 text-faint hover:bg-hover hover:text-fg"
            onClick={() => {
              setFocus(null)
            }}
          >
            <X size={12} />
          </button>
        </span>
      )}
      <span className="flex-1" />
      <TrafficMenu
        on={trafficOn}
        traffic={traffic}
        compact={barFit !== 'full'}
        onChange={onTrafficOn}
      />
      <MenuButton
        testId="k8s-topo-view"
        icon={<SlidersHorizontal size={12} />}
        label={t('View')}
        title={t('View options')}
        iconOnly={barFit !== 'full'}
        active={!options.showDeps || !options.hideSystem || darkCanvas || grouping !== 'purpose'}
      >
        {(close) => (
          <>
            <MenuToggle
              on={options.showDeps}
              label={t('Config & storage lane')}
              hint={t('ConfigMaps, Secrets and volumes each workload needs')}
              testId="k8s-topo-deps"
              onChange={(on) => {
                setOptions({ showDeps: on })
              }}
            />
            <MenuToggle
              on={egress.on}
              label={t('Outbound lane')}
              hint={t('Hosts and ports the workloads are configured to connect to')}
              testId="k8s-topo-egress"
              onChange={egress.onOn}
            />
            <MenuToggle
              on={egress.secrets}
              label={t('Read Secrets for destinations')}
              hint={t(
                'Reads only the Secrets a workload references, keeps just the host and port, and is recorded in the audit log'
              )}
              testId="k8s-topo-egress-secrets"
              onChange={egress.onSecrets}
            />
            <MenuToggle
              on={!options.hideSystem}
              label={t('System namespaces')}
              hint="kube-system, …"
              testId="k8s-topo-system"
              onChange={(on) => {
                setOptions({ hideSystem: !on })
              }}
            />
            <MenuToggle
              on={darkCanvas}
              label={t('Dark canvas')}
              hint={t('Dark background for the map, whatever the app theme')}
              testId="k8s-topo-dark-canvas"
              onChange={onDarkCanvas}
            />
            <MenuHeading>{t('Namespaces')}</MenuHeading>
            <NamespaceGrouping value={grouping} keys={groupKeys} onChange={onGrouping} />
            <MenuItem
              label={anyFolded ? t('Expand all') : t('Collapse all')}
              icon={anyFolded ? <ChevronsUpDown size={13} /> : <ChevronsDownUp size={13} />}
              testId="k8s-topo-fold-all"
              onClick={() => {
                toggledRef.current = true
                setTab({ fold: { all: !anyFolded, except: new Set(), auto: autoFold } })
                close()
              }}
            />
            {movedAny && (
              <MenuItem
                label={t('Reset layout')}
                icon={<RotateCcw size={13} />}
                testId="k8s-topo-reset"
                onClick={() => {
                  setTab({ moved: {} })
                  close()
                }}
              />
            )}
          </>
        )}
      </MenuButton>
    </div>
  )

  const showMinimap = (layout?.nodes.length ?? 0) > 60
  return (
    <div className="relative flex min-h-0 flex-1" data-testid="k8s-topology-map">
      {toolbar && createPortal(controls, toolbar)}
      <div
        ref={wrapRef}
        tabIndex={0}
        role="application"
        aria-label={t('Topology — scroll to move, Ctrl + scroll to zoom, click to select')}
        data-testid="k8s-topo-canvas"
        className={cx(
          'k8s-map @container relative min-h-0 min-w-0 flex-1 overflow-hidden outline-none',
          darkCanvas && 'k8s-map-dark'
        )}
        onKeyDown={onKeyDown}
        onPointerLeave={() => {
          setHover(null)
        }}
      >
        <TopoContext.Provider value={ctx}>
          <ReactFlow<TopoFlowNode, TopoFlowEdge>
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={TOPO_NODE_TYPES}
            edgeTypes={TOPO_EDGE_TYPES}
            defaultViewport={tab.viewport ?? { x: 24, y: 34, zoom: 1 }}
            minZoom={MIN_ZOOM}
            maxZoom={MAX_ZOOM}
            panOnScroll
            zoomOnScroll={false}
            zoomOnDoubleClick={false}
            nodesDraggable
            onNodesChange={onNodesChange}
            nodesConnectable={false}
            elementsSelectable={false}
            nodesFocusable={false}
            edgesFocusable={false}
            disableKeyboardA11y
            onlyRenderVisibleElements
            proOptions={{ hideAttribution: true }}
            onMoveEnd={(_, v) => {
              setTab({ viewport: v })
            }}
            onNodeClick={(_, n) => {
              if (n.type === 'band') return
              setSelected(n.id === selected && !selectedPod ? null : n.id)
              setSelectedPod(null)
              wrapRef.current?.focus()
            }}
            onNodeDoubleClick={(_, n) => {
              const m = byId.get(n.id)
              if (m?.ref && !m.missing) onOpen(m.ref)
            }}
            onNodeMouseEnter={(_, n) => {
              if (n.type !== 'band') setHover(n.id)
            }}
            onNodeMouseLeave={() => {
              setHover(null)
            }}
            onPaneClick={() => {
              setSelected(null)
              setSelectedPod(null)
              wrapRef.current?.focus()
            }}
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={24}
              size={1}
              className="!bg-transparent"
            />
            {showMinimap && (
              <MiniMap
                pannable
                zoomable
                position="bottom-right"
                className="!m-3 !mb-12 overflow-hidden rounded-md border border-line !bg-surface shadow-sm"
                style={{ width: 170, height: 120 }}
                maskColor="rgb(120 130 145 / 0.18)"
                nodeColor={(n) => {
                  if (n.type === 'band') return 'rgb(150 160 175 / 0.14)'
                  const m = (n.data as { node?: TopoNode }).node
                  return m?.tone === 'bad' ? '#d9381e' : m?.tone === 'warn' ? '#c27a0e' : '#9aa3b0'
                }}
                nodeStrokeWidth={0}
              />
            )}
          </ReactFlow>
          {layout && <LaneHeaders layout={layout} />}
          <ZoomVar target={wrapRef} />
        </TopoContext.Provider>
        {!data && !error && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-faint">
            {t('Mapping the topology…')}
          </div>
        )}
        {data && layout && !layout.nodes.length && (
          <div
            className="absolute inset-0 flex items-center justify-center p-6 text-center text-xs text-faint"
            data-testid="k8s-topo-empty"
          >
            <p className="max-w-sm">
              {options.hideSystem
                ? t(
                    'Nothing to show in these namespaces. Pick other namespaces, or show system namespaces in View.'
                  )
                : t('Nothing to show in these namespaces.')}
            </p>
          </div>
        )}
        {/* Chú giải: canvas hẹp → bớt dần (không đè nút zoom góc phải). */}
        <div className="pointer-events-none absolute bottom-3 left-3 z-10 hidden items-center gap-3 rounded-md border border-line bg-surface/90 px-2 py-1 text-[11px] text-faint @lg:flex">
          <span className="hidden items-center gap-3 @3xl:flex">
            <LegendLine color="var(--map-accent)" label={t('Request path')} />
            <LegendLine color="var(--map-edge-muted)" dash label={t('Uses')} />
            <LegendLine color="var(--map-bad)" dash label={t('Broken')} />
          </span>
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-full bg-success" /> {t('Healthy')}
          </span>
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-full bg-warning" /> {t('Degraded')}
          </span>
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-full bg-danger-solid" /> {t('Failing')}
          </span>
        </div>
        <div className="absolute right-3 bottom-3 z-10 flex overflow-hidden rounded-md border border-line bg-surface shadow-sm">
          <MapButton
            label={t('Zoom out ( - )')}
            onClick={() => {
              zoomBy(1 / 1.2)
            }}
          >
            <Minus size={13} />
          </MapButton>
          <ZoomLabel />
          <MapButton
            label={t('Zoom in ( + )')}
            onClick={() => {
              zoomBy(1.2)
            }}
          >
            <Plus size={13} />
          </MapButton>
          <MapButton
            label={t('Fit everything ( 0 )')}
            testId="k8s-topo-fit"
            onClick={() => {
              if (layout) fitWidth(layout, true, 250)
            }}
          >
            <Maximize size={13} />
          </MapButton>
        </div>
      </div>
      {selectedNode && (
        <SidePanel
          storageKey="k8s-topology"
          defaultWidth={360}
          maxRatio={0.4}
          overlay={overlayPanel}
          testId="k8s-topo-panel"
        >
          <TopoInspector
            node={selectedNode}
            pod={selectedPod?.pod ?? null}
            nodes={byId}
            edges={layout?.edges ?? []}
            traffic={nodeTraffic}
            focused={tab.focus === selectedNode.id}
            onClose={() => {
              setSelected(null)
              setSelectedPod(null)
            }}
            onGo={go}
            onOpen={onOpen}
            onLogs={(ref) => {
              onLogs(ref, selectedNode.workload?.labels ?? null)
            }}
            onShell={onShell}
            onPortForward={onPortForward}
            onYaml={openYaml}
            onFocus={setFocus}
          />
        </SidePanel>
      )}
      {yaml && (
        <Modal
          title={yaml.title}
          width="max-w-3xl"
          testId="k8s-topo-yaml-dialog"
          onClose={() => {
            setYaml(null)
          }}
        >
          {yaml.error ? (
            <p className="text-xs text-danger">{yaml.error}</p>
          ) : yaml.text === null ? (
            <p className="text-xs text-faint">{t('Loading…')}</p>
          ) : (
            <pre className="max-h-[60vh] overflow-auto rounded-md bg-subtle p-3 font-mono text-[11.5px] leading-relaxed text-fg">
              {yaml.text}
            </pre>
          )}
        </Modal>
      )}
    </div>
  )
}

function LegendLine({
  color,
  label,
  dash
}: {
  color: string
  label: string
  dash?: boolean
}): React.JSX.Element {
  return (
    <span className="flex items-center gap-1">
      <svg width="18" height="6" aria-hidden>
        <line
          x1="1"
          y1="3"
          x2="17"
          y2="3"
          style={{ stroke: color, strokeWidth: 2, ...(dash ? { strokeDasharray: '4 3' } : {}) }}
        />
      </svg>
      {label}
    </span>
  )
}

/** Biến CSS --topo-zoom trên khung: thẻ rút gọn tính cỡ chữ theo zoom mà không phải vẽ lại. */
function ZoomVar({ target }: { target: React.RefObject<HTMLDivElement | null> }): null {
  const zoom = useStore((s) => s.transform[2])
  useEffect(() => {
    target.current?.style.setProperty('--topo-zoom', String(zoom))
  }, [zoom, target])
  return null
}

/** Tiêu đề làn dính ở trên cùng, chạy theo khung nhìn ngang (thấy làn nào là làn nào khi cuộn). */
function LaneHeaders({ layout }: { layout: TopoLayout }): React.JSX.Element {
  const [tx, , zoom] = useStore((s) => s.transform)
  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 z-10 h-7 overflow-hidden border-b border-[color-mix(in_srgb,var(--map-island-border)_80%,transparent)] bg-[color-mix(in_srgb,var(--map-canvas)_88%,transparent)] backdrop-blur-[2px]"
      data-testid="k8s-topo-lanes"
    >
      {layout.columns.map((c, i) => (
        <span
          key={`${c.lane}@${String(c.x)}`}
          className={cx(
            'pointer-events-auto absolute top-0 flex h-7 items-center truncate font-semibold text-faint uppercase',
            zoom < FAR_ZOOM ? 'text-[11px] tracking-normal' : 'text-[11px] tracking-wider'
          )}
          // Rộng tới làn kế (gồm khoảng trống): thu nhỏ vẫn đủ chỗ cho tên làn.
          style={{
            left: tx + c.x * zoom,
            // Cột cuối của một khối: kế tiếp là khối khác (cách xa) — không kéo dài nhãn sang đó.
            width: Math.max(
              40,
              Math.min((layout.columns[i + 1]?.x ?? c.x + c.w) - c.x, c.w + 120) * zoom
            )
          }}
          title={laneHint(c.lane)}
          data-lane={c.lane}
        >
          <span className={cx('truncate', zoom < FAR_ZOOM ? 'pl-1' : 'pl-3')}>
            {laneTitle(c.lane)}
          </span>
        </span>
      ))}
    </div>
  )
}
