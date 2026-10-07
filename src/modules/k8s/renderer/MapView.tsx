import { useEffect, useMemo, useState } from 'react'
import { RefreshCw, Tag, X } from 'lucide-react'
import { cx } from '../../../renderer/src/components/ui'
import { cleanError } from '../../../renderer/src/lib/format'
import { formatTime, t } from '../../registry/renderer-kit'
import { filterMapData, groupingKeys, parseLabelSelector, type MapData } from '../shared/map'
import { NodesView } from './NodesView'
import { TrafficMap } from './TrafficMap'
import { useTraffic } from './useTraffic'
import { type Request, type MapRef, OPTIONS_KEY, type Options, loadOptions } from './mapModel'
import { ViewSwitch, useElementWidth } from './MapControls'
import { panelOverlayStable, toolbarFitStable, type ToolbarFit } from '../shared/toolbarFit'
import { TopologyMap } from './topology/TopologyMap'
import { TrafficUnitContext } from './trafficUnit'

const REFRESH_MS = 20_000

const savedSelectors = new Map<string, string>()

/**
 * Bản đồ cluster, ba cách xem — mỗi cách một câu hỏi:
 *   Topology — request đi vào app theo đường nào (namespace gập thành lưới tổng quan);
 *   Nodes — pod nằm trên máy nào, máy nào quá tải;
 *   Traffic — ai gọi ai, tốc độ bao nhiêu (Caretta / Hubble).
 */
export function MapView({
  tabId,
  request,
  namespaces,
  active,
  onOpen,
  onLogs,
  onShell,
  onPortForward
}: {
  tabId: string
  request: Request
  namespaces: readonly string[]
  active: boolean
  onOpen: (ref: MapRef) => void
  onLogs: (ref: MapRef, labels: Record<string, string> | null) => void
  onShell?: ((ref: MapRef) => void) | undefined
  /** Mở hộp thoại port-forward (Service / pod) — không truyền → ẩn nút. */
  onPortForward?: ((ref: MapRef) => void) | undefined
}): React.JSX.Element {
  /** Dữ liệu kèm phiên (request) và phạm vi namespace đã đọc — đổi cluster / namespace thì dữ liệu
   * cũ không hiện nữa (không thấy bản đồ của cluster trước trong lúc chờ). */
  const [loaded, setLoaded] = useState<{
    request: Request
    ns: string
    data: MapData
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [updated, setUpdated] = useState(0)
  const [tick, setTick] = useState(0)
  const [options, setOptions] = useState(loadOptions)
  const [selectorText, setSelectorTextRaw] = useState(() => savedSelectors.get(tabId) ?? '')
  const setSelectorText = (v: string): void => {
    savedSelectors.set(tabId, v)
    setSelectorTextRaw(v)
  }
  const nsKey = namespaces.join(',')
  const data = loaded && loaded.request === request && loaded.ns === nsKey ? loaded.data : null
  const view = options.view
  const traffic = useTraffic(
    request,
    active && (view === 'traffic' || (options.traffic && view === 'topology'))
  )
  /** Ô trên thanh công cụ để Topology đặt điều khiển của nó (một hàng). */
  const [toolbarSlot, setToolbarSlot] = useState<HTMLDivElement | null>(null)
  // Độ rộng thật của thanh công cụ → mức gọn (cửa sổ hẹp / sidebar host rộng / bảng tài nguyên).
  const [toolbarRef, toolbarWidth] = useElementWidth()
  // Khoảng đệm chống dao động ở sát ngưỡng (đổi mức → xuống dòng / thanh cuộn → độ rộng đổi → …).
  // Giữ mức trước trong state, cập nhật ngay trong lúc render (pattern "state suy ra" của React).
  const [prevFit, setPrevFit] = useState<ToolbarFit | null>(null)
  const barFit = toolbarFitStable(toolbarWidth, prevFit)
  if (barFit !== prevFit) setPrevFit(barFit)
  const [prevOverlay, setPrevOverlay] = useState<boolean | null>(null)
  const overlay = panelOverlayStable(toolbarWidth, prevOverlay)
  if (overlay !== prevOverlay) setPrevOverlay(overlay)

  // ——— Dữ liệu ———
  useEffect(() => {
    if (!active) return
    let cancelled = false
    // Một lần đọc tại một thời điểm: cluster chậm (> 20 s) không chồng nhiều lần đọc, kết quả cũ
    // không đè kết quả mới.
    let inFlight = false
    let lastJson = ''
    const load = (): void => {
      if (inFlight) return
      inFlight = true
      setLoading(true)
      request<MapData>({ op: 'map', namespaces: nsKey ? nsKey.split(',') : [] }).then(
        (d) => {
          inFlight = false
          if (cancelled) return
          // Không đổi gì → giữ nguyên đối tượng cũ (bản đồ không tính / vẽ lại).
          const json = JSON.stringify(d)
          if (json !== lastJson) {
            lastJson = json
            setLoaded({ request, ns: nsKey, data: d })
          }
          setError(null)
          setUpdated(Date.now())
          setLoading(false)
        },
        (e: unknown) => {
          inFlight = false
          if (cancelled) return
          setError(cleanError(e))
          setLoading(false)
        }
      )
    }
    load()
    const timer = setInterval(load, REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [request, nsKey, active, tick])

  // ——— Lọc nhãn (Nodes): pod không khớp được làm mờ ———
  const parsedSelector = useMemo(() => parseLabelSelector(selectorText), [selectorText])
  const selectorError = parsedSelector && 'error' in parsedSelector ? parsedSelector.error : null
  const shownData = useMemo(
    () =>
      data && parsedSelector && !('error' in parsedSelector)
        ? filterMapData(data, parsedSelector)
        : data,
    [data, parsedSelector]
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

  const setOpt = (patch: Partial<Options>): void => {
    const next = { ...options, ...patch }
    setOptions(next)
    try {
      window.localStorage.setItem(OPTIONS_KEY, JSON.stringify(next))
    } catch {
      // Bỏ qua.
    }
  }

  return (
    <TrafficUnitContext.Provider value={traffic.unit ?? 'bytes'}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="k8s-map">
        {/* Thanh công cụ của bản đồ: một hàng, luôn nằm trên canvas và bảng chi tiết (không bị che);
          hẹp dần → nút chỉ còn icon, rồi chọn chế độ xem thành menu. */}
        <div
          ref={toolbarRef}
          className={cx(
            'relative z-30 flex min-h-10 min-w-0 shrink-0 items-center gap-1.5 border-b border-line bg-surface px-2 py-1.5 text-xs',
            // Rất hẹp: xuống dòng thay vì đè lên nhau.
            barFit === 'narrow' && 'flex-wrap'
          )}
          data-testid="k8s-map-toolbar"
          data-fit={barFit}
        >
          <ViewSwitch
            value={view}
            compact={barFit === 'narrow'}
            testIdPrefix="k8s-map-view"
            options={[
              {
                value: 'topology',
                label: t('Topology'),
                hint: t('How requests reach your apps')
              },
              {
                value: 'nodes',
                label: t('Nodes'),
                hint: t('Which machine runs which pods, and which machines are full')
              },
              {
                value: 'traffic',
                label: t('Traffic'),
                hint: t('Who calls whom, and how much')
              }
            ]}
            onChange={(v) => {
              setOpt({ view: v })
            }}
          />
          {view === 'topology' && (
            <div ref={setToolbarSlot} className="flex min-w-0 flex-1 items-center gap-1.5" />
          )}
          {view === 'nodes' && (
            <>
              <div
                className={cx(
                  'flex h-7 w-56 min-w-28 shrink items-center gap-1.5 rounded-md border bg-subtle px-2',
                  selectorError
                    ? 'border-danger'
                    : selectorText.trim()
                      ? 'border-accent/60'
                      : 'border-line focus-within:border-accent'
                )}
                title={
                  selectorError ??
                  t(
                    'Show only pods whose labels match — e.g. tier=backend, app.kubernetes.io/part-of=shop, env in (prod,staging), !canary'
                  )
                }
              >
                <Tag size={12} className="shrink-0 text-faint" />
                <input
                  type="text"
                  list="k8s-map-labels"
                  spellCheck={false}
                  placeholder={t('Filter by label: tier=backend')}
                  aria-label={t('Filter by label')}
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
                    aria-label={t('Clear label filter')}
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
              <div className="flex-1" />
            </>
          )}
          {view !== 'topology' && view !== 'nodes' && <div className="flex-1" />}
          <button
            type="button"
            aria-label={t('Refresh')}
            title={updated ? t('Updated {time}', { time: formatTime(updated) }) : t('Refresh')}
            className="shrink-0 rounded p-1 text-faint hover:bg-hover hover:text-fg"
            data-testid="k8s-map-refresh"
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
            {t(
              'This cluster is very large — only part of it is on the map. Pick fewer namespaces.'
            )}
          </p>
        )}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {view === 'nodes' &&
            (data && shownData ? (
              <NodesView data={data} shown={shownData} onOpen={onOpen} />
            ) : (
              !error && (
                <p className="m-auto text-xs text-faint" data-testid="k8s-map-loading">
                  {t('Drawing the cluster map…')}
                </p>
              )
            ))}
          {view === 'traffic' && (
            <div
              className={cx('k8s-map flex min-h-0 flex-1', options.darkCanvas && 'k8s-map-dark')}
            >
              <TrafficMap traffic={traffic} scope={namespaces} onOpen={onOpen} />
            </div>
          )}
          {view === 'topology' && (
            <TopologyMap
              tabId={tabId}
              data={data}
              error={error}
              request={request}
              traffic={traffic}
              trafficOn={options.traffic}
              onTrafficOn={(on) => {
                setOpt({ traffic: on })
              }}
              darkCanvas={options.darkCanvas}
              onDarkCanvas={(on) => {
                setOpt({ darkCanvas: on })
              }}
              grouping={options.grouping}
              groupKeys={groupKeys}
              onGrouping={(grouping) => {
                setOpt({ grouping })
              }}
              toolbar={toolbarSlot}
              barFit={barFit}
              overlayPanel={overlay}
              onOpen={onOpen}
              onLogs={onLogs}
              onShell={onShell}
              onPortForward={onPortForward}
            />
          )}
        </div>
      </div>
    </TrafficUnitContext.Provider>
  )
}
