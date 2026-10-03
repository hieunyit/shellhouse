import { useEffect, useMemo, useState } from 'react'
import { Search, X } from 'lucide-react'
import { cx, Notice, Segmented, Select } from '../../../renderer/src/components/ui'
import {
  formatDateTime,
  formatDuration,
  formatNumber,
  formatRelative,
  t,
  tn
} from '../../registry/renderer-kit'
import type { K8sOp } from '../shared/ops'
import type { K8sObject } from '../shared/resources'
import {
  aggregateEvents,
  filterEvents,
  reasonsOf,
  type EventFilter,
  type EventInfo
} from '../shared/events'
import { useResourceList, type EventBus } from './useResourceList'

/**
 * Sự kiện sống (watch — không hỏi lại định kỳ, không nháy): gộp như `kubectl describe`
 * ("×12 trong 5m"), lọc theo loại / lý do / chữ, cảnh báo nổi màu. Dùng cho trang Events và tab
 * Events của bảng chi tiết.
 */

/** Đối tượng trong sự kiện ("Pod") → id loại để mở. */
export const EVENT_KIND_IDS: Record<string, string> = {
  Pod: 'pods',
  Node: 'nodes',
  Service: 'services',
  Deployment: 'deployments.apps',
  StatefulSet: 'statefulsets.apps',
  DaemonSet: 'daemonsets.apps',
  ReplicaSet: 'replicasets.apps',
  Job: 'jobs.batch',
  CronJob: 'cronjobs.batch',
  PersistentVolumeClaim: 'persistentvolumeclaims',
  PersistentVolume: 'persistentvolumes',
  Ingress: 'ingresses.networking.k8s.io',
  HorizontalPodAutoscaler: 'horizontalpodautoscalers.autoscaling',
  ConfigMap: 'configmaps',
  Secret: 'secrets',
  Namespace: 'namespaces'
}

/** Vẽ lại mỗi 30 giây để "5 phút trước" luôn đúng (không tải lại gì). */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now())
    }, 30_000)
    return () => {
      clearInterval(timer)
    }
  }, [])
  return now
}

function EventRow({
  e,
  now,
  showObject,
  onOpen
}: {
  e: EventInfo
  now: number
  showObject: boolean
  onOpen?: ((kind: string, ns: string | undefined, name: string) => void) | undefined
}): React.JSX.Element {
  const warn = e.type === 'Warning'
  const kindId = EVENT_KIND_IDS[e.object.kind]
  const objectLabel = `${e.object.kind.toLowerCase()}/${e.object.name}`
  const span = e.count > 1 && e.first && e.last > e.first ? e.last - e.first : 0
  return (
    <div
      className={cx('flex gap-2 px-3 py-1.5', warn && 'bg-warning-soft/40')}
      data-testid="k8s-event"
      data-type={e.type}
    >
      <span
        className={cx(
          'mt-1.5 size-1.5 shrink-0 rounded-full',
          warn ? 'bg-warning' : 'bg-line-strong'
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className={cx('shrink-0 font-medium', warn ? 'text-warning' : 'text-muted')}>
            {e.reason || '—'}
          </span>
          {showObject &&
            (kindId && onOpen ? (
              <button
                type="button"
                className="min-w-0 truncate font-mono text-[11px] text-accent hover:underline"
                title={t('Open {object}', { object: objectLabel })}
                onClick={() => {
                  onOpen(
                    kindId,
                    kindId === 'nodes' ? undefined : (e.object.namespace ?? e.namespace),
                    e.object.name
                  )
                }}
              >
                {e.namespace ? `${e.namespace}/` : ''}
                {objectLabel}
              </button>
            ) : (
              <span className="min-w-0 truncate font-mono text-[11px] text-muted">
                {e.namespace ? `${e.namespace}/` : ''}
                {objectLabel}
              </span>
            ))}
          {e.count > 1 && (
            <span
              className="shrink-0 rounded bg-subtle px-1 text-[11px] text-muted tabular-nums"
              title={
                span
                  ? t('{n} times over {duration}', {
                      n: formatNumber(e.count),
                      duration: formatDuration(span)
                    })
                  : tn(e.count, '{n} time', '{n} times')
              }
            >
              ×{formatNumber(e.count)}
            </span>
          )}
          <span
            className="ml-auto shrink-0 text-[11px] text-faint tabular-nums"
            title={e.last ? formatDateTime(e.last) : undefined}
          >
            {e.last ? formatRelative(e.last, now) : ''}
          </span>
        </div>
        <div className="text-fg break-words select-text">{e.message}</div>
        {e.source && <div className="text-[11px] text-faint">{e.source}</div>}
      </div>
    </div>
  )
}

/** Danh sách + bộ lọc (loại, lý do, chữ). */
export function EventsList({
  objects,
  error,
  showObject,
  onOpen,
  compact,
  testId = 'k8s-events'
}: {
  /** null = đang tải. */
  objects: Map<string, K8sObject> | null
  error: string | null
  showObject: boolean
  onOpen?: (kind: string, ns: string | undefined, name: string) => void
  /** Bảng chi tiết: gọn (không ô tìm). */
  compact?: boolean
  testId?: string
}): React.JSX.Element {
  const now = useNow()
  const [filter, setFilter] = useState<EventFilter>({ type: 'all', reasons: [], text: '' })
  const all = useMemo(() => (objects ? aggregateEvents(objects.values()) : []), [objects])
  const reasons = useMemo(() => reasonsOf(all), [all])
  const warnings = all.filter((e) => e.type === 'Warning').length
  const shown = filterEvents(all, filter)
  const filtered = filter.type !== 'all' || filter.reasons.length > 0 || filter.text.trim() !== ''

  if (error && !objects)
    return (
      <div className="p-3">
        <Notice tone="danger" testId="k8s-events-error">
          {t('Could not read events: {error}', { error })}
        </Notice>
      </div>
    )
  if (!objects) return <p className="p-3 text-xs text-faint">{t('Loading…')}</p>
  return (
    <div className="flex min-h-0 flex-1 flex-col text-xs" data-testid={testId}>
      {all.length > 0 && (
        <div
          className={cx(
            'flex shrink-0 flex-wrap items-center gap-2 border-b border-line py-1.5',
            compact ? 'px-0 pb-2' : 'px-3'
          )}
        >
          <Segmented<EventFilter['type']>
            value={filter.type}
            onChange={(type) => {
              setFilter((f) => ({ ...f, type }))
            }}
            options={[
              { value: 'all', label: t('All ({n})', { n: formatNumber(all.length) }) },
              { value: 'Warning', label: t('Warnings ({n})', { n: formatNumber(warnings) }) },
              { value: 'Normal', label: t('Normal') }
            ]}
            testIdPrefix="k8s-events-type"
          />
          {reasons.length > 1 && (
            <Select
              aria-label={t('Reason')}
              className="h-7 w-auto max-w-48 text-xs"
              data-testid="k8s-events-reason"
              value={filter.reasons[0] ?? ''}
              onChange={(e) => {
                const v = e.target.value
                setFilter((f) => ({ ...f, reasons: v ? [v] : [] }))
              }}
            >
              <option value="">{t('All reasons')}</option>
              {reasons.map((r) => (
                <option key={r.reason} value={r.reason}>
                  {`${r.warning ? '⚠ ' : ''}${r.reason} (${formatNumber(r.count)})`}
                </option>
              ))}
            </Select>
          )}
          {!compact && (
            <label className="flex h-7 min-w-40 flex-1 items-center gap-1.5 rounded-md border border-line bg-subtle px-2">
              <Search size={12} className="text-faint" />
              <input
                type="search"
                spellCheck={false}
                placeholder={t('Search reason, message or object…')}
                aria-label={t('Search events')}
                data-testid="k8s-events-search"
                className="min-w-0 flex-1 bg-transparent text-xs text-fg outline-none placeholder:text-faint"
                value={filter.text}
                onChange={(e) => {
                  const text = e.target.value
                  setFilter((f) => ({ ...f, text }))
                }}
              />
            </label>
          )}
          {filtered && (
            <button
              type="button"
              className="flex items-center gap-1 text-faint hover:text-fg"
              onClick={() => {
                setFilter({ type: 'all', reasons: [], text: '' })
              }}
            >
              <X size={12} />
              {t('Clear filters')}
            </button>
          )}
        </div>
      )}
      {error && (
        <div className="px-3 py-1.5">
          <Notice tone="warning">{t('Live updates paused: {error}', { error })}</Notice>
        </div>
      )}
      {all.length === 0 ? (
        <p className={cx('text-faint', compact ? 'py-2' : 'p-3')}>{t('No recent events.')}</p>
      ) : shown.length === 0 ? (
        <p className={cx('text-faint', compact ? 'py-2' : 'p-3')}>
          {t('No events match the filters.')}
        </p>
      ) : (
        <div
          className={cx('min-h-0 flex-1 divide-y divide-line overflow-auto', compact && '-mx-3')}
        >
          {shown.map((e) => (
            <EventRow key={e.key} e={e} now={now} showObject={showObject} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  )
}

/** Tab Events của bảng chi tiết: watch sự kiện của đúng đối tượng này. */
export function ObjectEvents({
  obj,
  request,
  bus
}: {
  obj: K8sObject
  request: <T>(op: K8sOp) => Promise<T>
  bus: EventBus
}): React.JSX.Element {
  const ns = obj.metadata.namespace
  const field = `involvedObject.name=${obj.metadata.name}${obj.kind ? `,involvedObject.kind=${obj.kind}` : ''}`
  const list = useResourceList(
    true,
    request,
    bus,
    { kind: 'events', namespaced: true, namespaces: ns ? [ns] : [], fieldSelector: field },
    0
  )
  return <EventsList objects={list.objects} error={list.error} showObject={false} compact />
}

/** Trang Events (thay bảng chung): gộp, lọc, cảnh báo nổi; bấm đối tượng để mở. */
export function EventsView({
  objects,
  error,
  onOpen
}: {
  objects: Map<string, K8sObject> | null
  error: string | null
  onOpen: (kind: string, ns: string | undefined, name: string) => void
}): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="k8s-events-view">
      <EventsList objects={objects} error={error} showObject onOpen={onOpen} testId="k8s-events" />
    </div>
  )
}
