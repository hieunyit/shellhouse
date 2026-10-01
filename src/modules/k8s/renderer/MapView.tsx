import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Box,
  ExternalLink,
  FileText,
  Locate,
  Maximize,
  Minus,
  Plus,
  RefreshCw,
  Search,
  SquareTerminal,
  X
} from 'lucide-react'
import { cx } from '../../../renderer/src/components/ui'
import { Heading, Pill, SidePanel } from '../../../renderer/src/components/panels'
import { cleanError } from '../../../renderer/src/lib/format'
import {
  TECH,
  impactOf,
  layoutMap,
  workloadKindLabel,
  type MapData,
  type MapEdge,
  type MapLayout,
  type MapNode,
  type MapTone
} from '../shared/map'
import type { K8sOp } from '../shared/ops'

type Request = <T>(op: K8sOp) => Promise<T>

export interface MapRef {
  kind: string
  ns?: string
  name: string
}

interface Viewport {
  /** Dịch (px màn hình) và tỉ lệ: màn hình = thế giới × scale + (x, y). */
  x: number
  y: number
  scale: number
}

/** Mức chi tiết theo tỉ lệ (zoom). */
const LOD = { cards: 0.34, pills: 0.34, edges: 0.34, cardText: 0.34, pods: 0.42, pillText: 0.4 }
const MIN_SCALE = 0.02
const MAX_SCALE = 3
const REFRESH_MS = 20_000
const OPTIONS_KEY = 'shellhouse.k8s.map'

/** Vị trí xem theo tab — quay lại Map thấy đúng chỗ cũ (không lưu đĩa). */
const savedViewports = new Map<string, Viewport>()

interface Palette {
  canvas: string
  surface: string
  subtle: string
  line: string
  lineStrong: string
  fg: string
  muted: string
  faint: string
  accent: string
  ok: string
  warn: string
  bad: string
  okSoft: string
  warnSoft: string
  badSoft: string
}

function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string): string =>
    css.getPropertyValue(name).trim() || fallback
  return {
    canvas: v('--sh-canvas', '#f4f5f7'),
    surface: v('--sh-surface', '#ffffff'),
    subtle: v('--sh-subtle', '#f0f2f5'),
    line: v('--sh-line', '#e2e5ea'),
    lineStrong: v('--sh-line-strong', '#cdd2d9'),
    fg: v('--sh-fg', '#1a1d21'),
    muted: v('--sh-muted', '#4b5360'),
    faint: v('--sh-faint', '#606977'),
    accent: v('--sh-accent', '#0f766e'),
    ok: v('--sh-success', '#137a3f'),
    warn: v('--sh-warning', '#a15c07'),
    bad: v('--sh-danger', '#c42e17'),
    okSoft: v('--sh-success-soft', '#e5f5ec'),
    warnSoft: v('--sh-warning-soft', '#fdf3e2'),
    badSoft: v('--sh-danger-soft', '#fdecea')
  }
}

const toneColor = (p: Palette, t: MapTone): string =>
  t === 'bad' ? p.bad : t === 'warn' ? p.warn : t === 'ok' ? p.ok : p.faint

function loadOptions(): { hideSystem: boolean; pods: boolean; edges: boolean } {
  try {
    const raw = window.localStorage.getItem(OPTIONS_KEY)
    if (raw) return { hideSystem: true, pods: true, edges: true, ...(JSON.parse(raw) as object) }
  } catch {
    // Bỏ qua.
  }
  return { hideSystem: true, pods: true, edges: true }
}

/** Thứ tự vẽ / bấm: vùng dưới cùng, pod trên cùng. */
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

const isPill = (k: MapNode['kind']): boolean =>
  k === 'route' || k === 'service' || k === 'pvc' || k === 'gateway' || k === 'policy'

const PILL_ICON: Partial<Record<MapNode['kind'], string>> = {
  gateway: '⇉',
  route: '⇢',
  service: '◆',
  pvc: '▤',
  policy: '◇'
}

function routeTitle(kind: string): string {
  if (kind.startsWith('ingresses')) return 'Ingress'
  if (kind.startsWith('httproutes')) return 'HTTPRoute'
  if (kind.startsWith('grpcroutes')) return 'GRPCRoute'
  return 'Route'
}

/**
 * Bản đồ cluster (kiểu "Google Maps cho Kubernetes"): vùng → namespace → workload → pod, cùng
 * route → service → workload → PVC. Vẽ bằng canvas, chỉ phần đang thấy, chi tiết theo mức zoom —
 * cluster hàng nghìn workload vẫn mượt. Dữ liệu tự làm mới khi tab đang mở.
 */
export function MapView({
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
  /** Mở tài nguyên trong bảng (chọn + chi tiết). */
  onOpen: (ref: MapRef) => void
  onLogs: (ref: MapRef, labels: Record<string, string> | null) => void
  onShell: (ref: MapRef) => void
}): React.JSX.Element {
  const [data, setData] = useState<MapData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [updated, setUpdated] = useState(0)
  const [tick, setTick] = useState(0)
  const [options, setOptions] = useState(loadOptions)
  const [problemsOnly, setProblemsOnly] = useState(false)
  const [impactMode, setImpactMode] = useState(false)
  const [selectedRaw, setSelected] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [wrapWidth, setWrapWidth] = useState(0)
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null)
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [zoomPct, setZoomPct] = useState(100)
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const miniRef = useRef<HTMLCanvasElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const view = useRef<Viewport>(savedViewports.get(tabId) ?? { x: 40, y: 40, scale: 0.5 })
  const fitted = useRef(savedViewports.has(tabId))
  const dirty = useRef(true)
  const frame = useRef<number | null>(null)
  const palette = useRef<Palette | null>(null)
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null)
  const anim = useRef<number | null>(null)
  const nsKey = namespaces.join(',')

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

  const layout = useMemo<MapLayout | null>(
    () => (data ? layoutMap(data, { hideSystem: options.hideSystem }) : null),
    [data, options.hideSystem]
  )
  const index = useMemo(() => {
    const byId = new Map<string, MapNode>()
    const edgesOf = new Map<string, MapEdge[]>()
    const ordered = [...(layout?.nodes ?? [])].sort((a, b) => Z[a.kind] - Z[b.kind])
    for (const n of ordered) byId.set(n.id, n)
    for (const e of layout?.edges ?? []) {
      edgesOf.set(e.from, [...(edgesOf.get(e.from) ?? []), e])
      edgesOf.set(e.to, [...(edgesOf.get(e.to) ?? []), e])
    }
    return { byId, edgesOf, ordered }
  }, [layout])

  // Mục đang chọn biến mất sau khi làm mới (pod bị thay…) → coi như không chọn.
  const selected = selectedRaw && index.byId.has(selectedRaw) ? selectedRaw : null

  // Liên quan tới mục đang chọn / trỏ: chính nó, cha, con, và mọi thứ nối qua cạnh (2 bước).
  const focusId = selected ?? hover?.id ?? null
  const related = useMemo(() => {
    const set = new Set<string>()
    if (!focusId) return set
    const visit = (id: string, depth: number): void => {
      set.add(id)
      if (depth === 0) return
      for (const e of index.edgesOf.get(id) ?? []) {
        const other = e.from === id ? e.to : e.from
        if (!set.has(other)) visit(other, depth - 1)
      }
    }
    const node = index.byId.get(focusId)
    // Namespace / vùng: không làm mờ gì (chỉ viền chọn).
    if (!node || node.kind === 'namespace' || node.kind === 'region') return set
    // Blast radius: chỉ những gì bị ảnh hưởng khi mục đang chọn đổi / hỏng.
    if (impactMode && selected && layout && focusId === selected) {
      for (const id of impactOf(layout, selected)) set.add(id)
      set.add(selected)
      return set
    }
    // Pod → nhìn theo workload của nó.
    visit(node.kind === 'pod' && node.parent ? node.parent : focusId, 3)
    set.add(focusId)
    return set
  }, [focusId, index, impactMode, selected, layout])

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

  const invalidate = useCallback(() => {
    dirty.current = true
  }, [])

  // ——— Vẽ ———
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const dpr = window.devicePixelRatio || 1
    const W = wrap.clientWidth
    const H = wrap.clientHeight
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr)
      canvas.height = Math.round(H * dpr)
      canvas.style.width = `${W}px`
      canvas.style.height = `${H}px`
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const p = (palette.current ??= readPalette())
    const { x: tx, y: ty, scale: s } = view.current
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = p.canvas
    ctx.fillRect(0, 0, W, H)
    if (!layout) return
    // Vùng thế giới đang thấy (+ lề) — chỉ vẽ phần này.
    const wx0 = -tx / s - 50
    const wy0 = -ty / s - 50
    const wx1 = (W - tx) / s + 50
    const wy1 = (H - ty) / s + 50
    const visible = (n: MapNode): boolean =>
      n.x < wx1 && n.x + n.w > wx0 && n.y < wy1 && n.y + n.h > wy0
    const sx = (x: number): number => x * s + tx
    const sy = (y: number): number => y * s + ty
    const dim = (n: MapNode): boolean =>
      (problemsOnly &&
        (n.kind === 'workload' || n.kind === 'pod' || n.kind === 'pvc') &&
        n.tone === 'ok') ||
      (related.size > 0 && n.kind !== 'region' && n.kind !== 'namespace' && !related.has(n.id))
    const roundRect = (x: number, y: number, w: number, h: number, r: number): void => {
      ctx.beginPath()
      ctx.roundRect(sx(x), sy(y), w * s, h * s, Math.min(r * s, (w * s) / 2, (h * s) / 2))
    }
    const text = (
      str: string,
      x: number,
      y: number,
      maxW: number,
      size: number,
      color: string,
      weight = 400,
      align: CanvasTextAlign = 'left'
    ): void => {
      if (maxW < 12 || size < 7) return
      ctx.font = `${weight} ${size}px ui-sans-serif, system-ui, sans-serif`
      ctx.fillStyle = color
      ctx.textAlign = align
      ctx.textBaseline = 'middle'
      let t = str
      if (ctx.measureText(t).width > maxW) {
        while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1)
        t = `${t}…`
      }
      ctx.fillText(t, x, y)
    }

    /** Huy hiệu công nghệ: vòng tròn màu + 2 chữ. */
    const badge = (
      x: number,
      y: number,
      r: number,
      info: { short: string; color: string }
    ): void => {
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fillStyle = info.color
      ctx.fill()
      if (r >= 6) {
        ctx.font = `700 ${Math.round(r * 0.95)}px ui-sans-serif, system-ui, sans-serif`
        ctx.fillStyle = '#ffffff'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(info.short, x, y + 0.5)
      }
    }

    // 1) Vùng + namespace.
    for (const n of index.ordered) {
      if (n.kind !== 'region' && n.kind !== 'namespace') continue
      if (!visible(n)) continue
      if (n.kind === 'region') {
        roundRect(n.x, n.y, n.w, n.h, 18)
        ctx.fillStyle = p.subtle
        ctx.fill()
        ctx.lineWidth = 1
        ctx.strokeStyle = p.line
        ctx.stroke()
        // Nhãn vùng vừa phần đầu vùng (44 đơn vị) — không đè lên tên namespace bên dưới.
        const head = 44 * s
        text(
          n.label.toUpperCase(),
          sx(n.x) + Math.max(8, 24 * s),
          sy(n.y) + head * 0.5,
          n.w * s - 16,
          Math.max(8, Math.min(16, head * 0.42)),
          p.muted,
          600
        )
        continue
      }
      roundRect(n.x, n.y, n.w, n.h, 12)
      ctx.fillStyle = p.surface
      ctx.fill()
      const sel = selected === n.id
      ctx.lineWidth = sel ? 2.5 : n.tone === 'bad' || n.tone === 'warn' ? 1.5 : 1
      ctx.strokeStyle = sel
        ? p.accent
        : n.tone === 'bad'
          ? p.bad
          : n.tone === 'warn'
            ? p.warn
            : p.lineStrong
      ctx.stroke()
      if (s < LOD.cards) {
        // Nhìn xa: tên to ở giữa + số liệu + thanh tình trạng.
        const cx0 = sx(n.x + n.w / 2)
        const cy0 = sy(n.y + n.h / 2)
        const fs = Math.max(9, Math.min(16, n.w * s * 0.09))
        text(n.label, cx0, cy0 - fs * 0.6, n.w * s - 12, fs, p.fg, 600, 'center')
        text(n.sub, cx0, cy0 + fs * 0.7, n.w * s - 12, Math.max(8, fs - 3), p.faint, 400, 'center')
        const st = n.stats
        if (st && st.workloads > 0 && n.w * s > 30) {
          const bw = n.w * s - 16
          const bx = sx(n.x) + 8
          const by = sy(n.y + n.h) - 10
          const okN = Math.max(0, st.workloads - st.warn - st.bad)
          let x = bx
          for (const [count, color] of [
            [okN, p.ok],
            [st.warn, p.warn],
            [st.bad, p.bad]
          ] as const) {
            const w = (count / st.workloads) * bw
            ctx.fillStyle = color
            ctx.fillRect(x, by, w, 4)
            x += w
          }
        }
        // Công nghệ chính trong namespace (huy hiệu dưới tên).
        if (n.techs?.length && n.w * s > 60) {
          const r = Math.max(5, Math.min(11, fs * 0.6))
          const total = n.techs.length * (2 * r + 4) - 4
          n.techs.forEach((id, i) => {
            const info = TECH[id]
            if (!info) return
            badge(cx0 - total / 2 + r + i * (2 * r + 4), cy0 + fs * 0.7 + r + 8, r, info)
          })
        }
      } else
        text(n.label, sx(n.x + 16), sy(n.y + 18), n.w * s - 32, Math.min(15, 9 + 8 * s), p.fg, 600)
    }
    if (s < LOD.cards) return

    // 2) Cạnh (dưới thẻ): route → service → workload → PVC.
    if (options.edges && s >= LOD.edges) {
      for (const e of layout.edges) {
        const a = index.byId.get(e.from)
        const b = index.byId.get(e.to)
        if (!a || !b) continue
        if (
          !visible({
            ...a,
            x: Math.min(a.x, b.x),
            y: Math.min(a.y, b.y),
            w: Math.abs(a.x - b.x) + a.w + b.w,
            h: Math.abs(a.y - b.y) + a.h + b.h
          })
        )
          continue
        const hot = related.size > 0 && related.has(e.from) && related.has(e.to)
        // Policy áp lên cả namespace → rất nhiều cạnh; chỉ vẽ khi đang xem quan hệ.
        if (e.kind === 'policy' && !hot) continue
        if (related.size > 0 && !hot) ctx.globalAlpha = 0.12
        else ctx.globalAlpha = hot ? 1 : 0.45
        const ax = sx(a.x + a.w / 2)
        const ay = sy(a.y + a.h)
        const bx = sx(b.x + b.w / 2)
        const by = sy(e.kind === 'storage' ? b.y : b.y)
        const fromBelow = b.y >= a.y + a.h
        const y0 = fromBelow ? ay : sy(a.y)
        ctx.beginPath()
        ctx.moveTo(ax, y0)
        const mid = (y0 + by) / 2
        ctx.bezierCurveTo(ax, mid, bx, mid, bx, fromBelow ? by : sy(b.y + b.h))
        ctx.lineWidth = hot ? 2 : 1.2
        ctx.strokeStyle = e.kind === 'storage' ? p.muted : e.kind === 'policy' ? p.warn : p.accent
        ctx.setLineDash(e.kind === 'storage' ? [4, 3] : e.kind === 'policy' ? [6, 3] : [])
        ctx.stroke()
        ctx.setLineDash([])
      }
      ctx.globalAlpha = 1
    }

    // 3) Route / service / PVC (viên thuốc).
    if (s >= LOD.pills)
      for (const n of index.ordered) {
        if (!isPill(n.kind)) continue
        if (!visible(n)) continue
        ctx.globalAlpha = dim(n) ? 0.25 : 1
        roundRect(n.x, n.y, n.w, n.h, n.kind === 'pvc' || n.kind === 'policy' ? 4 : n.h / 2)
        ctx.fillStyle = n.kind === 'pvc' || n.kind === 'policy' ? p.subtle : p.surface
        ctx.fill()
        ctx.lineWidth = selected === n.id ? 2.5 : 1.2
        ctx.strokeStyle =
          selected === n.id
            ? p.accent
            : n.kind === 'route' || n.kind === 'gateway'
              ? p.accent
              : n.kind === 'pvc'
                ? toneColor(p, n.tone)
                : n.kind === 'policy'
                  ? p.warn
                  : p.lineStrong
        if (n.kind === 'route' || n.kind === 'policy') ctx.setLineDash([5, 3])
        if (n.kind === 'gateway') ctx.lineWidth += 1
        ctx.stroke()
        ctx.setLineDash([])
        if (s >= LOD.pillText) {
          const icon = PILL_ICON[n.kind] ?? '•'
          text(
            icon,
            sx(n.x + 12),
            sy(n.y + n.h / 2),
            14,
            11 * Math.min(1, s * 1.4),
            n.kind === 'route' || n.kind === 'gateway'
              ? p.accent
              : n.kind === 'policy'
                ? p.warn
                : p.muted
          )
          text(
            n.label,
            sx(n.x + 24),
            sy(n.y + n.h / 2),
            (n.w - 30) * s,
            Math.min(12, 6 + 9 * s),
            p.fg,
            500
          )
        }
      }
    ctx.globalAlpha = 1

    // 4) Thẻ workload.
    for (const n of index.ordered) {
      if (n.kind !== 'workload' || !visible(n)) continue
      ctx.globalAlpha = dim(n) ? 0.25 : 1
      roundRect(n.x, n.y, n.w, n.h, 8)
      ctx.fillStyle = n.tone === 'bad' ? p.badSoft : n.tone === 'warn' ? p.warnSoft : p.surface
      ctx.fill()
      const sel = selected === n.id
      ctx.lineWidth = sel ? 2.5 : 1
      ctx.strokeStyle = sel
        ? p.accent
        : n.tone === 'bad'
          ? p.bad
          : n.tone === 'warn'
            ? p.warn
            : p.lineStrong
      ctx.stroke()
      // Sọc trạng thái bên trái.
      ctx.fillStyle = toneColor(p, n.tone)
      ctx.fillRect(sx(n.x), sy(n.y + 6), Math.max(2, 3 * s), (n.h - 12) * s)
      if (s >= LOD.cardText) {
        text(
          n.label,
          sx(n.x + 12),
          sy(n.y + 15),
          (n.w - (n.tech ? 40 : 20)) * s,
          Math.min(13, 6 + 9 * s),
          p.fg,
          600
        )
        text(
          `${n.sub}${n.badges?.length ? ` · ${n.badges.join(' · ')}` : ''}`,
          sx(n.x + 12),
          sy(n.y + 32),
          (n.w - (n.tech ? 40 : 20)) * s,
          Math.min(11, 5 + 7 * s),
          p.faint
        )
      }
      const tech = n.tech ? TECH[n.tech] : undefined
      if (tech && s >= LOD.cardText) badge(sx(n.x + n.w - 16), sy(n.y + 16), 10 * s, tech)
    }
    ctx.globalAlpha = 1

    // 5) Pod (chấm).
    if (options.pods && s >= LOD.pods)
      for (const n of index.ordered) {
        if (n.kind !== 'pod' || !visible(n)) continue
        ctx.globalAlpha = dim(n) ? 0.25 : 1
        ctx.beginPath()
        ctx.arc(sx(n.x + n.w / 2), sy(n.y + n.h / 2), (n.w / 2) * s, 0, Math.PI * 2)
        ctx.fillStyle = toneColor(p, n.tone)
        ctx.fill()
        if (selected === n.id || hover?.id === n.id) {
          ctx.lineWidth = 2
          ctx.strokeStyle = p.fg
          ctx.stroke()
        }
      }
    ctx.globalAlpha = 1
  }, [layout, index, related, selected, hover, options.edges, options.pods, problemsOnly])

  // Đổi mục chọn → tắt blast radius (bật lại khi cần).
  const [impactFor, setImpactFor] = useState<string | null>(null)
  if (impactFor !== selected) {
    setImpactFor(selected)
    if (impactMode) setImpactMode(false)
  }

  // Minimap: vùng + namespace + khung đang thấy.
  const drawMini = useCallback(() => {
    const mini = miniRef.current
    const wrap = wrapRef.current
    if (!mini || !wrap || !layout) return
    const ctx = mini.getContext('2d')
    if (!ctx) return
    const p = (palette.current ??= readPalette())
    const dpr = window.devicePixelRatio || 1
    const MW = 180
    const MH = 120
    mini.width = MW * dpr
    mini.height = MH * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = p.surface
    ctx.fillRect(0, 0, MW, MH)
    const k = Math.min((MW - 8) / Math.max(1, layout.width), (MH - 8) / Math.max(1, layout.height))
    const ox = (MW - layout.width * k) / 2
    const oy = (MH - layout.height * k) / 2
    for (const n of index.ordered) {
      if (n.kind !== 'region' && n.kind !== 'namespace') continue
      ctx.fillStyle =
        n.kind === 'region'
          ? p.subtle
          : n.tone === 'bad'
            ? p.bad
            : n.tone === 'warn'
              ? p.warn
              : p.lineStrong
      ctx.fillRect(ox + n.x * k, oy + n.y * k, Math.max(1, n.w * k), Math.max(1, n.h * k))
    }
    const { x, y, scale } = view.current
    ctx.strokeStyle = p.accent
    ctx.lineWidth = 1.5
    ctx.strokeRect(
      ox + (-x / scale) * k,
      oy + (-y / scale) * k,
      (wrap.clientWidth / scale) * k,
      (wrap.clientHeight / scale) * k
    )
  }, [layout, index])

  // Vòng vẽ: chỉ vẽ lại khi có thay đổi (pan / zoom / dữ liệu / chọn).
  useEffect(() => {
    dirty.current = true
    const loop = (): void => {
      if (dirty.current) {
        dirty.current = false
        draw()
        drawMini()
        savedViewports.set(tabId, view.current)
      }
      frame.current = requestAnimationFrame(loop)
    }
    frame.current = requestAnimationFrame(loop)
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
    }
  }, [draw, drawMini, tabId])

  // Kích thước khung / theme đổi → vẽ lại (đọc lại màu).
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const ro = new ResizeObserver(() => {
      dirty.current = true
      setWrapWidth(wrap.clientWidth)
    })
    ro.observe(wrap)
    const mo = new MutationObserver(() => {
      palette.current = null
      dirty.current = true
    })
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'style']
    })
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onScheme = (): void => {
      palette.current = null
      dirty.current = true
    }
    mq.addEventListener('change', onScheme)
    return () => {
      ro.disconnect()
      mo.disconnect()
      mq.removeEventListener('change', onScheme)
    }
  }, [])

  const setView = useCallback((v: Viewport) => {
    view.current = { ...v, scale: Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.scale)) }
    dirty.current = true
    setZoomPct(Math.round(view.current.scale * 100))
  }, [])

  /** Bay tới khung (animation 350 ms, như bản đồ). */
  const flyTo = useCallback(
    (box: { x: number; y: number; w: number; h: number }, maxScale = 1.2) => {
      const wrap = wrapRef.current
      if (!wrap) return
      const W = wrap.clientWidth
      const H = wrap.clientHeight
      const pad = 60
      const scale = Math.max(
        MIN_SCALE,
        Math.min(maxScale, (W - 2 * pad) / Math.max(1, box.w), (H - 2 * pad) / Math.max(1, box.h))
      )
      const target = {
        scale,
        x: W / 2 - (box.x + box.w / 2) * scale,
        y: H / 2 - (box.y + box.h / 2) * scale
      }
      const from = { ...view.current }
      const start = performance.now()
      if (anim.current !== null) cancelAnimationFrame(anim.current)
      const step = (now: number): void => {
        const t = Math.min(1, (now - start) / 350)
        const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
        // Nội suy log cho tỉ lệ (zoom mượt như bản đồ).
        const scaleT = Math.exp(
          Math.log(from.scale) + (Math.log(target.scale) - Math.log(from.scale)) * e
        )
        const cxw =
          (W / 2 - from.x) / from.scale +
          ((W / 2 - target.x) / target.scale - (W / 2 - from.x) / from.scale) * e
        const cyw =
          (H / 2 - from.y) / from.scale +
          ((H / 2 - target.y) / target.scale - (H / 2 - from.y) / from.scale) * e
        setView({ scale: scaleT, x: W / 2 - cxw * scaleT, y: H / 2 - cyw * scaleT })
        anim.current = t < 1 ? requestAnimationFrame(step) : null
      }
      anim.current = requestAnimationFrame(step)
    },
    [setView]
  )

  const fit = useCallback(() => {
    if (!layout) return
    flyTo({ x: 0, y: 0, w: layout.width, h: layout.height }, 1)
  }, [layout, flyTo])

  // Lần đầu có dữ liệu: vừa khung.
  useEffect(() => {
    if (!layout || fitted.current) return
    const wrap = wrapRef.current
    if (!wrap) return
    fitted.current = true
    const scale = Math.min(
      1,
      (wrap.clientWidth - 80) / Math.max(1, layout.width),
      (wrap.clientHeight - 80) / Math.max(1, layout.height)
    )
    setView({
      scale,
      x: (wrap.clientWidth - layout.width * scale) / 2,
      y: (wrap.clientHeight - layout.height * scale) / 2
    })
  }, [layout, setView])

  // Dữ liệu / tuỳ chọn đổi → vẽ lại.
  useEffect(invalidate, [layout, related, selected, hover, options, problemsOnly, invalidate])

  /** Node ở điểm màn hình (sâu nhất, theo mức chi tiết đang vẽ). */
  const hitTest = useCallback(
    (px: number, py: number): MapNode | null => {
      const { x, y, scale: s } = view.current
      const wx = (px - x) / s
      const wy = (py - y) / s
      for (let i = index.ordered.length - 1; i >= 0; i--) {
        const n = index.ordered[i]
        if (!n) continue
        if (n.kind === 'pod' && (!options.pods || s < LOD.pods)) continue
        if (n.kind === 'workload' && s < LOD.cards) continue
        if (isPill(n.kind) && s < LOD.pills) continue
        // Pod nhỏ: nới vùng bấm cho dễ trúng.
        const slack = n.kind === 'pod' ? 2 : 0
        if (
          wx >= n.x - slack &&
          wx <= n.x + n.w + slack &&
          wy >= n.y - slack &&
          wy <= n.y + n.h + slack
        )
          return n
      }
      return null
    },
    [index, options.pods]
  )

  const local = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = canvasRef.current?.getBoundingClientRect()
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) }
  }

  const zoomAt = (px: number, py: number, factor: number): void => {
    const v = view.current
    const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.scale * factor))
    const k = scale / v.scale
    setView({ scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k })
  }

  // Wheel: phải gắn listener không passive để chặn cuộn trang.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const r = canvas.getBoundingClientRect()
      const px = e.clientX - r.left
      const py = e.clientY - r.top
      // Trackpad cuộn hai ngón (không Ctrl) → di chuyển; chuột lăn / pinch (Ctrl) → zoom.
      if (!e.ctrlKey && Math.abs(e.deltaX) > 0 && Math.abs(e.deltaY) < 40) {
        const v = view.current
        setView({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY })
        return
      }
      const v = view.current
      const scale = Math.max(
        MIN_SCALE,
        Math.min(MAX_SCALE, v.scale * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)))
      )
      const k = scale / v.scale
      setView({ scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k })
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      canvas.removeEventListener('wheel', onWheel)
    }
  }, [setView])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const wrap = wrapRef.current
    if (!wrap) return
    const cxp = wrap.clientWidth / 2
    const cyp = wrap.clientHeight / 2
    const v = view.current
    const step = 80
    const handled = (): void => {
      e.preventDefault()
      e.stopPropagation()
    }
    if (e.key === '+' || e.key === '=') {
      handled()
      zoomAt(cxp, cyp, 1.25)
    } else if (e.key === '-' || e.key === '_') {
      handled()
      zoomAt(cxp, cyp, 0.8)
    } else if (e.key === '0') {
      handled()
      fit()
    } else if (e.key === 'ArrowLeft') {
      handled()
      setView({ ...v, x: v.x + step })
    } else if (e.key === 'ArrowRight') {
      handled()
      setView({ ...v, x: v.x - step })
    } else if (e.key === 'ArrowUp') {
      handled()
      setView({ ...v, y: v.y + step })
    } else if (e.key === 'ArrowDown') {
      handled()
      setView({ ...v, y: v.y - step })
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

  const select = (n: MapNode | null): void => {
    setSelected(n?.id ?? null)
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

  const setOpt = (patch: Partial<typeof options>): void => {
    const next = { ...options, ...patch }
    setOptions(next)
    try {
      window.localStorage.setItem(OPTIONS_KEY, JSON.stringify(next))
    } catch {
      // Bỏ qua.
    }
  }

  const goTo = (n: MapNode): void => {
    setSelected(n.id)
    setQuery('')
    setSearchOpen(false)
    const parent = n.kind === 'pod' && n.parent ? index.byId.get(n.parent) : undefined
    flyTo(parent ?? n, n.kind === 'namespace' ? 1 : 1.4)
    canvasRef.current?.focus()
  }

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

  return (
    <div className="flex min-h-0 flex-1" data-testid="k8s-map">
      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* Thanh công cụ của bản đồ */}
        <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-2 py-1.5 text-xs">
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
                    canvasRef.current?.focus()
                  }
                }}
              />
            </div>
            {searchOpen && matches.length > 0 && (
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
              </div>
            )}
          </div>
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
            on={problemsOnly}
            testId="k8s-map-problems"
            onClick={() => {
              setProblemsOnly(!problemsOnly)
            }}
          >
            Problems only
          </Chip>
          <div className="flex-1" />
          {(counts.bad > 0 || counts.warn > 0) && (
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
          <span className="text-faint tabular-nums" data-testid="k8s-map-summary">
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
        <div
          ref={wrapRef}
          className="relative min-h-0 flex-1 overflow-hidden"
          onPointerLeave={() => {
            setHover(null)
          }}
        >
          <canvas
            ref={canvasRef}
            tabIndex={0}
            role="application"
            aria-label="Cluster map — drag to move, scroll to zoom, click to select"
            data-testid="k8s-map-canvas"
            className={cx(
              'block size-full outline-none',
              dragging ? 'cursor-grabbing' : 'cursor-default'
            )}
            onKeyDown={onKeyDown}
            onPointerDown={(e) => {
              if (e.button !== 0) return
              e.currentTarget.setPointerCapture(e.pointerId)
              const v = view.current
              drag.current = { x: e.clientX, y: e.clientY, vx: v.x, vy: v.y, moved: false }
              e.currentTarget.focus()
            }}
            onPointerMove={(e) => {
              const d = drag.current
              if (d) {
                const dx = e.clientX - d.x
                const dy = e.clientY - d.y
                if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return
                if (!d.moved) setDragging(true)
                d.moved = true
                setHover(null)
                setView({ ...view.current, x: d.vx + dx, y: d.vy + dy })
                return
              }
              const { x, y } = local(e)
              const n = hitTest(x, y)
              const hid = n && n.kind !== 'region' ? n.id : null
              if (
                hid !== (hover?.id ?? null) ||
                (hid && hover && (Math.abs(hover.x - x) > 12 || Math.abs(hover.y - y) > 12))
              )
                setHover(hid ? { id: hid, x, y } : null)
            }}
            onPointerUp={(e) => {
              const d = drag.current
              drag.current = null
              setDragging(false)
              if (e.currentTarget.hasPointerCapture(e.pointerId))
                e.currentTarget.releasePointerCapture(e.pointerId)
              // Chỉ khi nhấn cũng trên canvas (nhả chuột sau khi bấm kết quả tìm kiếm không tính).
              if (!d || d.moved) return
              const { x, y } = local(e)
              select(hitTest(x, y))
            }}
            onDoubleClick={(e) => {
              const { x, y } = local(e)
              const n = hitTest(x, y)
              if (n) flyTo(n.kind === 'pod' && n.parent ? (index.byId.get(n.parent) ?? n) : n, 1.4)
              else zoomAt(x, y, 1.6)
            }}
          />
          {!data && !error && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-faint">
              Drawing the cluster map…
            </div>
          )}
          {hoverNode && hover && !dragging && (
            <div
              className="pointer-events-none absolute z-20 max-w-72 rounded-md border border-line bg-elevated px-2 py-1.5 text-xs shadow-lg"
              style={{
                left: Math.min(hover.x + 14, wrapWidth - 280),
                top: hover.y + 14
              }}
              data-testid="k8s-map-tooltip"
            >
              <div className="flex items-center gap-1.5">
                <span className={cx('size-2 shrink-0 rounded-full', DOT[hoverNode.tone])} />
                <span className="truncate font-medium text-fg">{hoverNode.label}</span>
              </div>
              <div className="mt-0.5 text-faint">
                {hoverNode.kind === 'route'
                  ? routeTitle(hoverNode.ref?.kind ?? '')
                  : KIND_TITLE[hoverNode.kind]}
                {hoverNode.sub ? ` · ${hoverNode.sub}` : ''}
              </div>
            </div>
          )}
          {/* Điều khiển zoom + minimap + chú giải */}
          <div className="absolute right-3 bottom-3 flex flex-col items-end gap-2">
            <div className="flex overflow-hidden rounded-md border border-line bg-surface shadow-sm">
              <MapButton
                label="Zoom out ( - )"
                onClick={() => {
                  zoomAt(
                    (wrapRef.current?.clientWidth ?? 0) / 2,
                    (wrapRef.current?.clientHeight ?? 0) / 2,
                    0.8
                  )
                }}
              >
                <Minus size={13} />
              </MapButton>
              <span
                className="flex w-12 items-center justify-center border-x border-line text-[11px] text-faint tabular-nums"
                data-testid="k8s-map-zoom"
              >
                {zoomPct}%
              </span>
              <MapButton
                label="Zoom in ( + )"
                onClick={() => {
                  zoomAt(
                    (wrapRef.current?.clientWidth ?? 0) / 2,
                    (wrapRef.current?.clientHeight ?? 0) / 2,
                    1.25
                  )
                }}
              >
                <Plus size={13} />
              </MapButton>
              <MapButton label="Fit the whole cluster ( 0 )" testId="k8s-map-fit" onClick={fit}>
                <Maximize size={13} />
              </MapButton>
            </div>
            <canvas
              ref={miniRef}
              className="h-[120px] w-[180px] cursor-pointer rounded-md border border-line shadow-sm"
              data-testid="k8s-map-minimap"
              onPointerDown={(e) => {
                const mini = e.currentTarget
                const move = (ev: { clientX: number; clientY: number }): void => {
                  const wrap = wrapRef.current
                  if (!layout || !wrap) return
                  const r = mini.getBoundingClientRect()
                  const k = Math.min(
                    172 / Math.max(1, layout.width),
                    112 / Math.max(1, layout.height)
                  )
                  const ox = (180 - layout.width * k) / 2
                  const oy = (120 - layout.height * k) / 2
                  const wx = (ev.clientX - r.left - ox) / k
                  const wy = (ev.clientY - r.top - oy) / k
                  const v = view.current
                  setView({
                    ...v,
                    x: wrap.clientWidth / 2 - wx * v.scale,
                    y: wrap.clientHeight / 2 - wy * v.scale
                  })
                }
                move(e)
                mini.setPointerCapture(e.pointerId)
                mini.onpointermove = move
                mini.onpointerup = () => {
                  mini.onpointermove = null
                }
              }}
            />
          </div>
          <div className="pointer-events-none absolute bottom-3 left-3 flex items-center gap-3 rounded-md border border-line bg-surface/90 px-2 py-1 text-[11px] text-faint">
            <Legend color="bg-success" label="Healthy" />
            <Legend color="bg-warning" label="Degraded" />
            <Legend color="bg-danger-solid" label="Failing" />
            <span>⇉ gateway · ⇢ route · ◆ service · ▤ volume · ◇ policy</span>
          </div>
        </div>
      </div>
      {selectedNode && (
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
            impact={impactMode}
            onImpact={setImpactMode}
          />
        </SidePanel>
      )}
    </div>
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
  children
}: {
  on: boolean
  onClick: () => void
  testId?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={on}
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
  impact,
  onImpact
}: {
  node: MapNode
  layout: MapLayout | null
  index: { byId: Map<string, MapNode>; edgesOf: Map<string, MapEdge[]>; ordered: MapNode[] }
  onClose: () => void
  onGo: (n: MapNode) => void
  onOpen: (ref: MapRef) => void
  onLogs: (ref: MapRef) => void
  onShell: (ref: MapRef) => void
  impact: boolean
  onImpact: (on: boolean) => void
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
            <span
              className="inline-flex size-4 items-center justify-center rounded-full text-[8px] font-bold text-white"
              style={{ background: tech.color }}
            >
              {tech.short}
            </span>
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
