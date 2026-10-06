import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { Box, FileCog, GitCommitVertical, History, Radio, RefreshCw, Server, X } from 'lucide-react'
import { cx, Notice, Segmented } from '../../../renderer/src/components/ui'
import { cleanError } from '../../../renderer/src/lib/format'
import { formatDate, formatDateTimeSeconds, formatTime, t, tn } from '../../registry/renderer-kit'
import type { K8sOp } from '../shared/ops'
import type { K8sObject } from '../shared/resources'
import {
  TIMELINE_LANES,
  type TimelineEntry,
  type TimelineLane,
  type TimelineResult
} from '../shared/timeline'
import { useRefreshTick } from './refresh'

type Request = <T>(op: K8sOp) => Promise<T>

/** Loại có tab Timeline. */
export const TIMELINE_KINDS: ReadonlySet<string> = new Set([
  'deployments.apps',
  'statefulsets.apps',
  'daemonsets.apps'
])

type Range = '1h' | '24h' | '7d'
const RANGE_MS: Record<Range, number> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000
}
/** "Điều gì xảy ra trước?": xem chừng này trước lần chết. */
const BEFORE_MS = 30 * 60_000

const LANE_LABEL: Record<TimelineLane, () => string> = {
  rollout: () => t('Rollouts'),
  pods: () => t('Pods'),
  config: () => t('Config'),
  nodes: () => t('Nodes'),
  events: () => t('Events')
}

const LANE_ICON: Record<TimelineLane, typeof Box> = {
  rollout: GitCommitVertical,
  pods: Box,
  config: FileCog,
  nodes: Server,
  events: Radio
}

/** "registry/shop/api:1.4" → phần đổi giữa hai image (cùng repo: chỉ tag). */
export function imageChange(prev: string, next: string): string {
  const repo = (x: string): string => x.replace(/[:@][^/]*$/, '')
  const tag = (x: string): string => x.slice(repo(x).length + 1) || 'latest'
  if (prev && repo(prev) === repo(next)) {
    const short = repo(next).split('/').pop() ?? repo(next)
    return `${short}: ${tag(prev)} → ${tag(next)}`
  }
  return prev ? `${prev} → ${next}` : next
}

/** Tiêu đề một mục (đã dịch). */
export function entryTitle(e: TimelineEntry): string {
  switch (e.type) {
    case 'rollout':
      return t('Rollout · revision {revision}', { revision: e.revision ?? '?' })
    case 'pod-created':
      return t('Pod {name} created', { name: e.object.name })
    case 'container-terminated':
      return e.severity === 'danger'
        ? t('Container {container} crashed — {reason}, exit code {code}', {
            container: e.container ?? '',
            reason: e.reason ?? t('Error'),
            code: e.exitCode ?? 0
          })
        : t('Container {container} stopped — {reason}', {
            container: e.container ?? '',
            reason: e.reason ?? t('Completed')
          })
    case 'config-changed':
      return t('{kind} {name} changed', { kind: e.object.kind, name: e.object.name })
    case 'node-ready':
      return t('Node {name} became Ready', { name: e.object.name })
    case 'node-not-ready':
      return t('Node {name} became NotReady', { name: e.object.name })
    case 'event':
      return e.reason || t('Event')
  }
}

/** Dòng phụ: image đổi, đối tượng của event, thông báo. */
export function entryDetail(e: TimelineEntry): string {
  if (e.type === 'rollout') {
    const next = e.images ?? []
    const prev = e.previousImages
    if (!prev) return next.join(', ')
    const changed = next
      .map((img, i) => (img !== prev[i] ? imageChange(prev[i] ?? '', img) : ''))
      .filter(Boolean)
    return changed.length ? changed.join(' · ') : t('Same images — pod template settings changed')
  }
  if (e.type === 'container-terminated')
    return [e.object.name, e.message].filter(Boolean).join(' — ')
  if (e.type === 'event')
    return [`${e.object.kind}/${e.object.name}`, e.message].filter(Boolean).join(' — ')
  return e.message ?? ''
}

/** Lần chết gần nhất (container chết bất thường, hoặc event lỗi nặng) — mốc cho "trước đó". */
export function lastCrash(entries: readonly TimelineEntry[]): TimelineEntry | null {
  return (
    entries.find((e) => e.type === 'container-terminated' && e.severity === 'danger') ??
    entries.find((e) => e.type === 'event' && e.severity === 'danger') ??
    null
  )
}

const dayKey = (at: number): string => new Date(at).toDateString()
const sameDay = (x: number, y: number): boolean => dayKey(x) === dayKey(y)

function Row({ e, focus }: { e: TimelineEntry; focus: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const Icon = LANE_ICON[e.lane]
  const detail = entryDetail(e)
  return (
    <li
      className={cx(
        'relative flex gap-3 py-1.5 pr-1 pl-0',
        focus && 'rounded-md bg-danger-soft/60'
      )}
      data-testid="k8s-timeline-entry"
      data-lane={e.lane}
      data-type={e.type}
      data-severity={e.severity}
    >
      <span
        className="w-16 shrink-0 pt-0.5 text-right text-[11px] whitespace-nowrap text-faint tabular-nums"
        title={formatDateTimeSeconds(e.at)}
      >
        {formatTime(e.at, false)}
      </span>
      <span
        className={cx(
          'relative z-10 mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border bg-surface',
          e.severity === 'danger'
            ? 'border-danger text-danger'
            : e.severity === 'warning'
              ? 'border-warning text-warning'
              : 'border-line text-muted'
        )}
        title={LANE_LABEL[e.lane]()}
      >
        <Icon size={11} />
      </span>
      <button
        type="button"
        className="min-w-0 flex-1 text-left outline-none focus-visible:underline"
        onClick={() => {
          setOpen((v) => !v)
        }}
      >
        <span className="flex items-baseline gap-1.5">
          <span
            className={cx(
              'min-w-0 truncate text-xs font-medium',
              e.severity === 'danger'
                ? 'text-danger'
                : e.severity === 'warning'
                  ? 'text-warning'
                  : 'text-fg'
            )}
          >
            {entryTitle(e)}
          </span>
          {e.count && e.count > 1 && (
            <span className="shrink-0 text-[11px] text-faint tabular-nums">×{e.count}</span>
          )}
          {e.recorded && (
            <span title={t('From the history kept on this computer')} className="text-faint">
              <History size={11} />
            </span>
          )}
        </span>
        {detail && (
          <span
            className={cx(
              'mt-0.5 block text-[11.5px] leading-snug break-words text-muted',
              !open && 'line-clamp-2'
            )}
          >
            {detail}
          </span>
        )}
      </button>
    </li>
  )
}

/**
 * Tab Timeline của workload: mọi thứ đã đổi theo thời gian (rollout, pod, config, node, event) trên
 * một trục — trả lời "lúc 14:05 cái gì đổi trước khi app chết?". Lọc theo làn, khoảng thời gian;
 * "Trước lần chết" chỉ còn 30 phút trước lần container chết gần nhất.
 */
export function TimelineOf({
  kindId,
  obj,
  request
}: {
  kindId: string
  obj: K8sObject
  request: Request
}): React.JSX.Element {
  const refresh = useRefreshTick()
  const [data, setData] = useState<(TimelineResult & { fetchedAt: number }) | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [range, setRange] = useState<Range>('24h')
  const [lanes, setLanes] = useState<ReadonlySet<TimelineLane>>(new Set(TIMELINE_LANES))
  const [focus, setFocus] = useState<TimelineEntry | null>(null)
  const [reload, setReload] = useState(0)
  const ns = obj.metadata.namespace ?? ''
  const name = obj.metadata.name

  useEffect(() => {
    let cancelled = false
    request<TimelineResult>({
      op: 'timeline',
      kind: kindId as 'deployments.apps',
      namespace: ns,
      name
    }).then(
      (r) => {
        if (cancelled) return
        setData({ ...r, fetchedAt: Date.now() })
        setError(null)
      },
      (e: unknown) => {
        if (!cancelled) setError(cleanError(e))
      }
    )
    return () => {
      cancelled = true
    }
  }, [request, kindId, ns, name, refresh, reload])

  const crash = useMemo(() => (data ? lastCrash(data.entries) : null), [data])
  const inRange = useMemo(() => {
    if (!data) return []
    const from = focus ? focus.at - BEFORE_MS : data.fetchedAt - RANGE_MS[range]
    const to = focus ? focus.at + 60_000 : Number.POSITIVE_INFINITY
    return data.entries.filter((e) => e.at >= from && e.at <= to)
  }, [data, range, focus])
  const counts = useMemo(() => {
    const c = Object.fromEntries(TIMELINE_LANES.map((l) => [l, 0])) as Record<TimelineLane, number>
    for (const e of inRange) c[e.lane]++
    return c
  }, [inRange])
  const shown = inRange.filter((e) => lanes.has(e.lane))
  const toggleLane = useCallback((lane: TimelineLane) => {
    setLanes((cur) => {
      // Đang hiện hết → bấm một làn = chỉ làn đó; bấm lại làn duy nhất = hiện hết.
      if (cur.size === TIMELINE_LANES.length) return new Set([lane])
      const next = new Set(cur)
      if (next.has(lane)) next.delete(lane)
      else next.add(lane)
      return next.size === 0 ? new Set(TIMELINE_LANES) : next
    })
  }, [])

  if (error && !data)
    return (
      <Notice tone="danger" testId="k8s-timeline-error">
        {t('Could not build the timeline: {error}', { error })}
      </Notice>
    )
  if (!data) return <p className="text-xs text-faint">{t('Loading…')}</p>

  return (
    <div className="flex flex-col gap-2.5 text-xs" data-testid="k8s-timeline">
      <div className="flex flex-wrap items-center gap-2">
        {focus ? (
          <span
            className="inline-flex h-7 items-center gap-1.5 rounded-md bg-danger-soft px-2 text-danger"
            data-testid="k8s-timeline-focus"
          >
            {t('30 min before {time}', { time: formatTime(focus.at, false) })}
            <button
              type="button"
              aria-label={t('Show everything')}
              className="rounded p-0.5 hover:bg-danger/10"
              onClick={() => {
                setFocus(null)
              }}
            >
              <X size={12} />
            </button>
          </span>
        ) : (
          <Segmented<Range>
            value={range}
            onChange={setRange}
            options={[
              { value: '1h', label: t('1 hour') },
              { value: '24h', label: t('24 hours') },
              { value: '7d', label: t('7 days') }
            ]}
            testIdPrefix="k8s-timeline-range"
          />
        )}
        <span className="flex-1" />
        <button
          type="button"
          aria-label={t('Refresh')}
          title={t('Refresh')}
          className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-fg"
          onClick={() => {
            setReload((n) => n + 1)
          }}
        >
          <RefreshCw size={13} />
        </button>
      </div>

      <div className="flex flex-wrap gap-1" role="group" aria-label={t('Show')}>
        {TIMELINE_LANES.map((lane) => {
          const on = lanes.has(lane)
          const Icon = LANE_ICON[lane]
          return (
            <button
              key={lane}
              type="button"
              aria-pressed={on}
              data-testid={`k8s-timeline-lane-${lane}`}
              className={cx(
                'inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11px] transition-colors',
                on
                  ? 'border-line-strong bg-subtle text-fg'
                  : 'border-line text-faint hover:text-muted'
              )}
              onClick={() => {
                toggleLane(lane)
              }}
            >
              <Icon size={11} />
              {LANE_LABEL[lane]()}
              <span className="text-faint tabular-nums">{counts[lane]}</span>
            </button>
          )
        })}
      </div>

      {crash && !focus && (
        <div
          className="flex items-center gap-2 rounded-md border border-danger/30 bg-danger-soft/50 px-2.5 py-2"
          data-testid="k8s-timeline-crash"
        >
          <span className="min-w-0 flex-1 text-danger">
            <span className="font-medium">{t('Last crash')}</span>{' '}
            <span className="text-muted" title={formatDateTimeSeconds(crash.at)}>
              {sameDay(crash.at, data.fetchedAt)
                ? formatTime(crash.at, false)
                : `${formatDate(crash.at)} ${formatTime(crash.at, false)}`}{' '}
              · {entryTitle(crash)}
            </span>
          </span>
          <button
            type="button"
            className="shrink-0 rounded-md border border-line bg-surface px-2 py-1 font-medium text-fg hover:bg-hover"
            data-testid="k8s-timeline-before"
            onClick={() => {
              setFocus(crash)
              setLanes(new Set(TIMELINE_LANES))
            }}
          >
            {t('What changed before?')}
          </button>
        </div>
      )}

      {shown.length === 0 ? (
        <p className="py-2 text-faint">
          {inRange.length === 0
            ? t('Nothing happened in this period.')
            : t('Nothing in the lanes you picked.')}
        </p>
      ) : (
        <ol className="relative">
          {/* Trục dọc chạy sau các chấm. */}
          <span
            aria-hidden
            className="absolute top-2 bottom-2 left-[calc(4rem+0.75rem+0.625rem)] w-px bg-line"
          />
          {shown.map((e, i) => {
            const prev = shown[i - 1]
            const header = !prev || dayKey(prev.at) !== dayKey(e.at)
            return (
              <Fragment
                key={`${e.uid ?? ''}|${e.type}|${e.object.name}|${String(e.at)}|${String(i)}`}
              >
                {header && (
                  <li
                    role="presentation"
                    className="relative z-10 mt-1 mb-0.5 w-fit bg-surface py-0.5 pr-2 text-[11px] font-semibold text-muted"
                  >
                    {formatDate(e.at)}
                  </li>
                )}
                <Row e={e} focus={focus === e} />
              </Fragment>
            )
          })}
        </ol>
      )}

      <p
        className="flex items-start gap-1.5 border-t border-line pt-2 text-[11px] text-faint"
        data-testid="k8s-timeline-history"
      >
        <History size={12} className="mt-px shrink-0" />
        {data.recording
          ? t(
              'Events are kept on this computer for 7 days while this cluster is monitored on Home.'
            )
          : t(
              'The cluster keeps events for about an hour. Monitor this cluster on Home to keep 7 days of history.'
            )}
        {data.entries.some((e) => e.recorded) &&
          ` ${tn(
            data.entries.filter((e) => e.recorded).length,
            '{n} older event from history.',
            '{n} older events from history.'
          )}`}
      </p>
    </div>
  )
}
