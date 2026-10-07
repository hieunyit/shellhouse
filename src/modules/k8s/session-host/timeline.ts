import type { EventCount } from '../shared/history'
import {
  EVENT_RETENTION_MS,
  ownedNamePattern,
  slimEvent,
  type QueryEvents,
  type RecordedEvent,
  type TimelineEntry,
  type TimelineResult
} from '../shared/timeline'
import { selectorString, type K8sObject } from '../shared/resources'
import { KubeError, type KubeClient } from './client'
import { listPaged } from './operations'
import { escapeRe } from './prometheus'
import { templateRefs } from './map'

type Obj = Record<string, unknown>
const o = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {})
const a = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(o) : [])
const s = (v: unknown): string => (typeof v === 'string' ? v : '')
const at = (v: unknown): number => {
  const t = Date.parse(s(v))
  return Number.isNaN(t) ? 0 : t
}

/** Chỉ metadata của một đối tượng (managedFields để biết lần sửa cuối). */
const METADATA_ONE = 'application/json;as=PartialObjectMetadata;g=meta.k8s.io;v=v1,application/json'

const PLURAL: Record<string, string> = {
  'deployments.apps': 'deployments',
  'statefulsets.apps': 'statefulsets',
  'daemonsets.apps': 'daemonsets'
}

/** Tối đa số ConfigMap / Secret / node đọc riêng (workload dùng rất nhiều — bỏ phần sau). */
const MAX_REFS = 30
const MAX_NODES = 20
/** Tối đa số mục trả về (mới nhất trước). */
const MAX_ENTRIES = 600

const ns = (n: string): string => `/namespaces/${encodeURIComponent(n)}`

/** Image theo thứ tự container của pod template. */
function imagesOf(template: Obj): string[] {
  return a(o(template['spec'])['containers']).map((c) => s(c['image']))
}

/** Lần sửa cuối của đối tượng: thời điểm mới nhất trong managedFields (không có → lúc tạo). */
function lastChange(meta: Obj): number {
  let last = at(meta['creationTimestamp'])
  for (const f of a(meta['managedFields'])) last = Math.max(last, at(f['time']))
  return last
}

function eventEntry(e: RecordedEvent, recorded: boolean): TimelineEntry {
  const warn = e.type === 'Warning'
  return {
    at: e.last,
    lane: 'events',
    type: 'event',
    severity: warn
      ? /BackOff|Failed|Unhealthy|OOM|Evicted|Killing/i.test(e.reason)
        ? 'danger'
        : 'warning'
      : 'info',
    object: { kind: e.kind, name: e.name, ...(e.namespace ? { namespace: e.namespace } : {}) },
    reason: e.reason,
    message: e.message,
    count: e.count,
    uid: e.uid,
    ...(recorded ? { recorded: true } : {})
  }
}

/**
 * Dòng thời gian của Deployment / StatefulSet / DaemonSet: rollout (ReplicaSet / ControllerRevision
 * + image đổi), pod tạo / container chết lần trước, ConfigMap / Secret sửa lần cuối, node đổi trạng
 * thái, event (sống trên cluster + bản đã ghi trên máy). Trong 7 ngày gần nhất.
 */
export async function workloadTimeline(
  client: KubeClient,
  kindId: string,
  namespace: string,
  name: string,
  /** Event đã ghi trên máy (main) + cluster có đang được ghi không. */
  recorded: (
    q: Omit<QueryEvents, 'cluster'>
  ) => Promise<{ events: RecordedEvent[]; recording: boolean }>,
  signal?: AbortSignal,
  now = Date.now(),
  /** Số event theo lý do từ Prometheus (event exporter) — lấp phần cluster / máy không còn giữ. */
  promEvents?: (namePattern: string, start: number, end: number) => Promise<EventCount[]>
): Promise<TimelineResult> {
  const plural = PLURAL[kindId]
  if (!plural) throw new Error(`No timeline for ${kindId}`)
  const opt = signal ? { signal } : {}
  const since = now - EVENT_RETENTION_MS
  const w = await client.json<K8sObject>(
    'GET',
    `/apis/apps/v1${ns(namespace)}/${plural}/${encodeURIComponent(name)}`,
    opt
  )
  const uid = w.metadata.uid ?? ''
  const spec = o(w.spec)
  const template = o(spec['template'])
  const selector = selectorString(spec['selector']) ?? ''
  const owned = ownedNamePattern(kindId, name)
  /** Có ownerReference tới một trong các uid (thiếu uid — dữ liệu cũ / proxy — thì so tên). */
  const ownedBy = (x: K8sObject, uids: ReadonlySet<string>, names: ReadonlySet<string>): boolean =>
    (x.metadata.ownerReferences ?? []).some((r) => {
      const ref = r as { uid?: string; name?: string }
      return ref.uid ? uids.has(ref.uid) : names.has(ref.name ?? '')
    })
  const none = { items: [] as K8sObject[], truncated: false }
  const query = selector ? { labelSelector: selector } : undefined
  const [revisions, pods, liveEvents] = await Promise.all([
    kindId === 'deployments.apps'
      ? listPaged(client, `/apis/apps/v1${ns(namespace)}/replicasets`, {
          signal,
          max: 500,
          ...(query ? { query } : {})
        }).catch(() => none)
      : listPaged(client, `/apis/apps/v1${ns(namespace)}/controllerrevisions`, {
          signal,
          max: 500,
          ...(query ? { query } : {})
        }).catch(() => none),
    listPaged(client, `/api/v1${ns(namespace)}/pods`, {
      signal,
      max: 2000,
      ...(query ? { query } : {})
    }).catch(() => none),
    listPaged(client, `/api/v1${ns(namespace)}/events`, { signal, max: 5000 }).catch(() => none)
  ])
  const entries: TimelineEntry[] = []

  // ——— Rollout ———
  const self = { uids: new Set([uid]), names: new Set([name]) }
  const revs = revisions.items
    .filter((r) => ownedBy(r, self.uids, self.names))
    .map((r) => {
      const rev =
        kindId === 'deployments.apps'
          ? s(r.metadata.annotations?.['deployment.kubernetes.io/revision'])
          : String(typeof r['revision'] === 'number' ? r['revision'] : '')
      const tpl =
        kindId === 'deployments.apps'
          ? o(o(r.spec)['template'])
          : o(o(o(r['data'])['spec'])['template'])
      return {
        obj: r,
        rev: Number(rev) || 0,
        images: imagesOf(tpl),
        at: at(r.metadata.creationTimestamp)
      }
    })
    .sort((x, y) => x.rev - y.rev || x.at - y.at)
  revs.forEach((r, i) => {
    const prev = revs[i - 1]
    entries.push({
      at: r.at,
      lane: 'rollout',
      type: 'rollout',
      severity: 'info',
      object: {
        kind: kindId === 'deployments.apps' ? 'ReplicaSet' : 'ControllerRevision',
        name: r.obj.metadata.name,
        namespace
      },
      revision: String(r.rev),
      images: r.images,
      ...(prev ? { previousImages: prev.images } : {})
    })
  })

  // ——— Pod + container chết lần trước ———
  const nodeNames = new Set<string>()
  const podNames: string[] = []
  // Pod của Deployment thuộc ReplicaSet (không thuộc thẳng Deployment); pod lấy theo selector —
  // có owner thì phải là workload / ReplicaSet của nó (selector trùng với workload khác).
  const podOwners = {
    uids: new Set([uid, ...revs.map((r) => r.obj.metadata.uid ?? '')]),
    names: new Set([name, ...revs.map((r) => r.obj.metadata.name)])
  }
  for (const p of pods.items) {
    const hasOwner = (p.metadata.ownerReferences ?? []).length > 0
    if (hasOwner && !ownedBy(p, podOwners.uids, podOwners.names)) continue
    podNames.push(p.metadata.name)
    const pst = o(p.status)
    const node = s(o(p.spec)['nodeName'])
    if (node) nodeNames.add(node)
    entries.push({
      at: at(p.metadata.creationTimestamp),
      lane: 'pods',
      type: 'pod-created',
      severity: 'info',
      object: { kind: 'Pod', name: p.metadata.name, namespace }
    })
    for (const c of a(pst['containerStatuses'])) {
      const term = o(o(c['lastState'])['terminated'])
      const finished = at(term['finishedAt'])
      if (!finished) continue
      const code = typeof term['exitCode'] === 'number' ? term['exitCode'] : 0
      const reason = s(term['reason'])
      entries.push({
        at: finished,
        lane: 'pods',
        type: 'container-terminated',
        severity: reason === 'OOMKilled' || code !== 0 ? 'danger' : 'info',
        object: { kind: 'Pod', name: p.metadata.name, namespace },
        container: s(c['name']),
        exitCode: code,
        ...(reason ? { reason } : {}),
        ...(s(term['message']) ? { message: s(term['message']).slice(0, 500) } : {})
      })
    }
  }

  // ——— ConfigMap / Secret: lần sửa cuối ———
  const refs = templateRefs(template)
  const configs = [
    ...refs.configMaps.map((n) => ({ kind: 'ConfigMap', plural: 'configmaps', name: n })),
    ...refs.secrets.map((n) => ({ kind: 'Secret', plural: 'secrets', name: n }))
  ].slice(0, MAX_REFS)
  const metas = await Promise.all(
    configs.map((c) =>
      client
        .json<K8sObject>(
          'GET',
          `/api/v1${ns(namespace)}/${c.plural}/${encodeURIComponent(c.name)}`,
          {
            ...opt,
            accept: METADATA_ONE
          }
        )
        .then((x) => ({ ...c, meta: x.metadata as unknown as Obj }))
        .catch((error: unknown) => {
          if (error instanceof KubeError) return null
          throw error
        })
    )
  )
  for (const m of metas) {
    if (!m) continue
    const changed = lastChange(m.meta)
    if (!changed) continue
    entries.push({
      at: changed,
      lane: 'config',
      type: 'config-changed',
      severity: 'info',
      object: { kind: m.kind, name: m.name, namespace }
    })
  }

  // ——— Node của các pod: lần đổi trạng thái Ready gần nhất ———
  const nodes = [...nodeNames].slice(0, MAX_NODES)
  const nodeObjs = await Promise.all(
    nodes.map((n) =>
      client
        .json<K8sObject>('GET', `/api/v1/nodes/${encodeURIComponent(n)}`, opt)
        .catch((error: unknown) => {
          if (error instanceof KubeError) return null
          throw error
        })
    )
  )
  for (const n of nodeObjs) {
    if (!n) continue
    const ready = a(o(n.status)['conditions']).find((c) => c['type'] === 'Ready')
    const changed = at(ready?.['lastTransitionTime'])
    if (!ready || !changed) continue
    const ok = ready['status'] === 'True'
    entries.push({
      at: changed,
      lane: 'nodes',
      type: ok ? 'node-ready' : 'node-not-ready',
      severity: ok ? 'info' : 'danger',
      object: { kind: 'Node', name: n.metadata.name },
      ...(s(ready['reason']) ? { reason: s(ready['reason']) } : {}),
      ...(s(ready['message']) ? { message: s(ready['message']).slice(0, 500) } : {})
    })
  }

  // ——— Event: sống trên cluster + đã ghi trên máy ———
  // Tên đang có (workload, ReplicaSet / ControllerRevision, pod, config) + mẫu tên của bản đã xoá.
  const exact = new Set([
    name,
    ...configs.map((c) => c.name),
    ...revs.map((r) => r.obj.metadata.name),
    ...podNames
  ])
  const mine = (e: RecordedEvent): boolean =>
    e.kind === 'Node'
      ? nodeNames.has(e.name)
      : e.namespace === namespace && (exact.has(e.name) || owned.test(e.name))
  const live = liveEvents.items
    .map((e) => slimEvent(e))
    .filter((e): e is RecordedEvent => e !== null)
  const liveSince = live.length ? Math.min(...live.map((e) => e.first)) : undefined
  const nodeEvents = await Promise.all(
    nodes.map((n) =>
      listPaged(client, '/api/v1/events', {
        signal,
        max: 200,
        query: { fieldSelector: `involvedObject.kind=Node,involvedObject.name=${n}` }
      }).catch(() => none)
    )
  )
  for (const list of nodeEvents)
    for (const e of list.items) {
      const x = slimEvent(e)
      if (x) live.push(x)
    }
  const seen = new Set<string>()
  for (const e of live)
    if (mine(e) && !seen.has(e.uid)) {
      seen.add(e.uid)
      entries.push(eventEntry(e, false))
    }
  const stored = await recorded({
    namespace,
    names: [...exact],
    prefixes: [`${name}-`],
    nodes,
    since
  }).catch(() => ({ events: [], recording: false }))
  for (const e of stored.events)
    if (mine(e) && !seen.has(e.uid)) {
      seen.add(e.uid)
      entries.push(eventEntry(e, true))
    }

  // Prometheus (event exporter): chỉ có số lượng theo lý do — dùng cho khoảng TRƯỚC event cũ nhất
  // còn đọc được (sống / đã ghi), không trùng với event có nội dung.
  if (promEvents) {
    const detailed = entries.filter((e) => e.lane === 'events').map((e) => e.at)
    const until = detailed.length ? Math.min(...detailed) : now
    // Workload + mọi tên con (ReplicaSet / pod, kể cả đã xoá) + ConfigMap / Secret nó dùng.
    const pattern = [`${escapeRe(name)}(-.*)?`, ...configs.map((c) => escapeRe(c.name))].join('|')
    const counts = await promEvents(pattern, since, until).catch(() => [])
    for (const c of counts)
      if (c.at < until)
        entries.push({
          at: c.at,
          lane: 'events',
          type: 'event',
          severity:
            c.type === 'Warning'
              ? /BackOff|Failed|Unhealthy|OOM|Evicted|Killing/i.test(c.reason)
                ? 'danger'
                : 'warning'
              : 'info',
          object: { kind: c.kind, name: c.name ?? '', namespace },
          reason: c.reason,
          count: c.count,
          fromPrometheus: true
        })
  }

  return {
    entries: entries
      .filter((e) => e.at >= since && e.at <= now + 60_000)
      .sort((x, y) => y.at - x.at)
      .slice(0, MAX_ENTRIES),
    recording: stored.recording,
    ...(liveSince ? { liveEventsSince: liveSince } : {})
  }
}
