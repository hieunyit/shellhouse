import { t, tn } from '@shared/i18n'
import type { RelatedGroup, RelatedItem, RelatedResult } from '../shared/ops'
import { selectorString, type K8sObject } from '../shared/resources'
import { selectorMatches } from '../shared/map'
import { KubeError, type KubeClient } from './client'

/**
 * Tài nguyên liên quan của một đối tượng (kiểu Rancher): workload → pod, service, ingress,
 * ConfigMap / Secret / PVC nó dùng (báo thiếu nếu không tồn tại), HPA, PDB, ServiceAccount, owner;
 * ConfigMap / Secret / PVC → workload đang dùng; Service → pod, workload, ingress. Chỉ trả tên +
 * tóm tắt — không bao giờ trả giá trị Secret.
 */

type Obj = Record<string, unknown>
type List = { items: K8sObject[] }

const o = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {})
const a = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(o) : [])
const s = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
/** Số / chuỗi → chữ (giá trị khác → ''). */
const txt = (v: unknown): string =>
  typeof v === 'string' || typeof v === 'number' ? String(v) : ''
const nsPath = (n: string): string => `/namespaces/${encodeURIComponent(n)}`

const WORKLOADS = [
  { id: 'deployments.apps', path: '/apis/apps/v1', plural: 'deployments' },
  { id: 'statefulsets.apps', path: '/apis/apps/v1', plural: 'statefulsets' },
  { id: 'daemonsets.apps', path: '/apis/apps/v1', plural: 'daemonsets' },
  { id: 'cronjobs.batch', path: '/apis/batch/v1', plural: 'cronjobs' },
  { id: 'jobs.batch', path: '/apis/batch/v1', plural: 'jobs' }
] as const

/** Pod template (spec + nhãn) của workload / pod. */
export function podTemplate(
  kindId: string,
  obj: K8sObject
): { spec: Obj; labels: Record<string, string> } | null {
  const spec = o(obj.spec)
  if (kindId === 'pods') return { spec, labels: obj.metadata.labels ?? {} }
  const tpl =
    kindId === 'cronjobs.batch'
      ? o(o(o(spec['jobTemplate'])['spec'])['template'])
      : o(spec['template'])
  if (!Object.keys(tpl).length) return null
  return {
    spec: o(tpl['spec']),
    labels: (o(tpl['metadata'])['labels'] ?? {}) as Record<string, string>
  }
}

export interface PodRefs {
  configMaps: Set<string>
  secrets: Set<string>
  /** Secret dùng để kéo image (hiện riêng chú thích). */
  pullSecrets: Set<string>
  pvcs: Set<string>
  serviceAccount: string | null
}

/** ConfigMap / Secret / PVC / ServiceAccount mà pod spec tham chiếu (env, envFrom, volume…). */
export function podRefs(spec: Obj): PodRefs {
  const r: PodRefs = {
    configMaps: new Set(),
    secrets: new Set(),
    pullSecrets: new Set(),
    pvcs: new Set(),
    serviceAccount: s(spec['serviceAccountName']) ?? s(spec['serviceAccount']) ?? null
  }
  const add = (set: Set<string>, v: unknown): void => {
    const name = s(v)
    if (name) set.add(name)
  }
  for (const v of a(spec['volumes'])) {
    add(r.configMaps, o(v['configMap'])['name'])
    add(r.secrets, o(v['secret'])['secretName'])
    add(r.pvcs, o(v['persistentVolumeClaim'])['claimName'])
    for (const src of a(o(v['projected'])['sources'])) {
      add(r.configMaps, o(src['configMap'])['name'])
      add(r.secrets, o(src['secret'])['name'])
    }
  }
  const containers = [
    ...a(spec['initContainers']),
    ...a(spec['containers']),
    ...a(spec['ephemeralContainers'])
  ]
  for (const c of containers) {
    for (const e of a(c['env'])) {
      const from = o(e['valueFrom'])
      add(r.configMaps, o(from['configMapKeyRef'])['name'])
      add(r.secrets, o(from['secretKeyRef'])['name'])
    }
    for (const e of a(c['envFrom'])) {
      add(r.configMaps, o(e['configMapRef'])['name'])
      add(r.secrets, o(e['secretRef'])['name'])
    }
  }
  for (const p of a(spec['imagePullSecrets'])) add(r.pullSecrets, p['name'])
  return r
}

export const podTone = (p: K8sObject): RelatedItem['tone'] => {
  const phase = s(o(p.status)['phase'])
  if (phase === 'Succeeded') return 'muted'
  const statuses = a(o(p.status)['containerStatuses'])
  if (phase === 'Running' && statuses.every((c) => c['ready'] === true)) return 'ok'
  if (statuses.some((c) => o(c['state'])['waiting'] || o(c['state'])['terminated'])) return 'bad'
  return phase === 'Failed' ? 'bad' : 'warn'
}

export function podSummary(p: K8sObject): string {
  const statuses = a(o(p.status)['containerStatuses'])
  const ready = statuses.filter((c) => c['ready'] === true).length
  const waiting = statuses
    .map((c) => s(o(o(c['state'])['waiting'])['reason']))
    .find((r) => r !== undefined)
  const phase = waiting ?? s(o(p.status)['phase']) ?? 'Pending'
  const restarts = statuses.reduce((n, c) => n + (Number(c['restartCount']) || 0), 0)
  const total = statuses.length || a(o(p.spec)['containers']).length
  const base = `${phase} · ${t('{ready}/{total} ready', { ready, total })}`
  return restarts ? `${base} · ${t('{n} restarts', { n: restarts })}` : base
}

export function serviceSummary(svc: K8sObject): string {
  const spec = o(svc.spec)
  const ports = a(spec['ports'])
    .map(
      (p) =>
        `${txt(p['port'])}${p['nodePort'] ? `:${txt(p['nodePort'])}` : ''}/${s(p['protocol']) ?? 'TCP'}`
    )
    .join(', ')
  return [s(spec['type']) ?? 'ClusterIP', s(spec['clusterIP']), ports].filter(Boolean).join(' · ')
}

export function workloadSummary(
  kindId: string,
  w: K8sObject
): { summary: string; tone: RelatedItem['tone'] } {
  const st = o(w.status)
  const spec = o(w.spec)
  if (kindId === 'cronjobs.batch')
    return {
      summary: `${s(spec['schedule']) ?? ''}${spec['suspend'] === true ? ` · ${t('suspended')}` : ''}`,
      tone: 'muted'
    }
  if (kindId === 'jobs.batch') {
    const ok = Number(st['succeeded']) || 0
    const want = Number(spec['completions']) || 1
    return {
      summary: t('{done}/{total} completed', { done: ok, total: want }),
      tone: ok >= want ? 'ok' : Number(st['failed']) ? 'bad' : 'warn'
    }
  }
  const want =
    kindId === 'daemonsets.apps'
      ? Number(st['desiredNumberScheduled']) || 0
      : Number(spec['replicas'] ?? 1)
  const ready = Number(kindId === 'daemonsets.apps' ? st['numberReady'] : st['readyReplicas']) || 0
  return {
    summary: t('{ready}/{total} ready', { ready, total: want }),
    tone: ready >= want ? 'ok' : ready ? 'warn' : 'bad'
  }
}

export const KIND_LABEL: Record<string, string> = {
  'deployments.apps': 'Deployment',
  'statefulsets.apps': 'StatefulSet',
  'daemonsets.apps': 'DaemonSet',
  'cronjobs.batch': 'CronJob',
  'jobs.batch': 'Job'
}

/** Liệt kê một loại trong namespace; không có quyền / API không có → null (nhóm báo lỗi riêng). */
export async function listOr(
  client: KubeClient,
  path: string,
  signal?: AbortSignal
): Promise<{ items: K8sObject[] } | { error: string }> {
  try {
    return { items: (await client.json<List>('GET', path, signal ? { signal } : {})).items }
  } catch (error) {
    if (error instanceof KubeError && error.status === 403)
      return { error: t('You are not allowed to list these') }
    if (error instanceof KubeError && error.status === 404) return { items: [] }
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Đối tượng được tham chiếu theo tên: GET từng cái (vài request nhỏ) thay vì list cả loại trong
 * namespace — list Secret có thể hàng chục MB (release Helm). Cùng dạng kết quả với listOr: thiếu
 * quyền → error; không tồn tại → không có trong items.
 */
export async function getNamed(
  client: KubeClient,
  path: string,
  names: Iterable<string>,
  signal?: AbortSignal
): Promise<{ items: K8sObject[] } | { error: string }> {
  const results = await Promise.all(
    [...names].map(async (name): Promise<K8sObject | null | { error: string }> => {
      try {
        return await client.json<K8sObject>(
          'GET',
          `${path}/${encodeURIComponent(name)}`,
          signal ? { signal } : {}
        )
      } catch (error) {
        if (error instanceof KubeError && error.status === 404) return null
        if (error instanceof KubeError && error.status === 403)
          return { error: t('You are not allowed to read these') }
        return { error: error instanceof Error ? error.message : String(error) }
      }
    })
  )
  const failed = results.find((r): r is { error: string } => r !== null && 'error' in r)
  if (failed) return failed
  return { items: results.filter((r): r is K8sObject => r !== null && !('error' in r)) }
}

function group(
  id: string,
  title: string,
  kind: string,
  items: RelatedItem[],
  error?: string
): RelatedGroup {
  return { id, title, kind, items, ...(error ? { error } : {}) }
}

/** Tài nguyên được tham chiếu theo tên: có → tóm tắt; không có → "missing" (lỗi đỏ). */
function byName(
  names: Iterable<string>,
  list: { items: K8sObject[] } | { error: string },
  kind: string,
  summary: (x: K8sObject) => string,
  note?: (name: string) => string | undefined
): { items: RelatedItem[]; error?: string } {
  if ('error' in list)
    return {
      items: [...names].map((name) => ({ kind, name, summary: note?.(name) ?? '', tone: 'muted' })),
      error: list.error
    }
  const found = new Map(list.items.map((x) => [x.metadata.name, x]))
  return {
    items: [...names].sort().map((name) => {
      const x = found.get(name)
      const extra = note?.(name)
      return x
        ? { kind, name, summary: [summary(x), extra].filter(Boolean).join(' · '), tone: 'ok' }
        : { kind, name, summary: t('Not found in this namespace'), tone: 'bad', missing: true }
    })
  }
}

const keysOf = (x: K8sObject): number =>
  Object.keys(o((x as Obj)['data'])).length + Object.keys(o((x as Obj)['binaryData'])).length

/** Workload (và pod không có owner) trong namespace dùng tài nguyên `test`. */
async function usersOf(
  client: KubeClient,
  namespace: string,
  test: (refs: PodRefs) => boolean,
  signal?: AbortSignal
): Promise<RelatedGroup> {
  const items: RelatedItem[] = []
  const errors: string[] = []
  await Promise.all(
    WORKLOADS.map(async (w) => {
      const list = await listOr(client, `${w.path}${nsPath(namespace)}/${w.plural}`, signal)
      if ('error' in list) {
        errors.push(list.error)
        return
      }
      for (const x of list.items) {
        // Job của CronJob đã tính qua CronJob.
        if (
          w.id === 'jobs.batch' &&
          (x.metadata.ownerReferences ?? []).some((r) => r.kind === 'CronJob')
        )
          continue
        const tpl = podTemplate(w.id, x)
        if (!tpl || !test(podRefs(tpl.spec))) continue
        const sum = workloadSummary(w.id, x)
        items.push({
          kind: w.id,
          name: x.metadata.name,
          summary: `${KIND_LABEL[w.id] ?? ''} · ${sum.summary}`,
          tone: sum.tone
        })
      }
    })
  )
  const pods = await listOr(client, `/api/v1${nsPath(namespace)}/pods`, signal)
  if (!('error' in pods))
    for (const p of pods.items)
      if (!(p.metadata.ownerReferences ?? []).length && test(podRefs(o(p.spec))))
        items.push({
          kind: 'pods',
          name: p.metadata.name,
          summary: `Pod · ${podSummary(p)}`,
          tone: podTone(p)
        })
  items.sort((x, y) => x.name.localeCompare(y.name))
  return group('used-by', t('Used by'), 'workloads', items, errors[0])
}

const GATEWAY_API = '/apis/gateway.networking.k8s.io/v1'
const ROUTE_KINDS = [
  { id: 'httproutes.gateway.networking.k8s.io', plural: 'httproutes', label: 'HTTPRoute' },
  { id: 'grpcroutes.gateway.networking.k8s.io', plural: 'grpcroutes', label: 'GRPCRoute' }
] as const

/** Service phía sau một route (rules[].backendRefs, kind mặc định Service). */
export function routeBackends(route: K8sObject): Set<string> {
  const names = new Set<string>()
  for (const r of a(o(route.spec)['rules']))
    for (const b of a(r['backendRefs']))
      if ((s(b['kind']) ?? 'Service') === 'Service' && s(b['name'])) names.add(s(b['name']) ?? '')
  return names
}

/** Route (HTTP / gRPC) cùng namespace thoả `test` — Gateway API chưa cài → []. */
async function routesWhere(
  client: KubeClient,
  namespace: string,
  test: (route: K8sObject) => boolean,
  signal?: AbortSignal
): Promise<RelatedItem[]> {
  const lists = await Promise.all(
    ROUTE_KINDS.map((k) => listOr(client, `${GATEWAY_API}${nsPath(namespace)}/${k.plural}`, signal))
  )
  const items: RelatedItem[] = []
  ROUTE_KINDS.forEach((k, i) => {
    const list = lists[i]
    if (!list || 'error' in list) return
    for (const r of list.items) {
      if (!test(r)) continue
      const hosts = (
        Array.isArray(o(r.spec)['hostnames']) ? (o(r.spec)['hostnames'] as unknown[]) : []
      )
        .map(s)
        .filter(Boolean)
      items.push({
        kind: k.id,
        name: r.metadata.name,
        summary: `${k.label}${hosts.length ? ` · ${hosts.join(', ')}` : ''}`,
        tone: 'ok'
      })
    }
  })
  return items
}

export async function related(
  client: KubeClient,
  kindId: string,
  obj: K8sObject,
  signal?: AbortSignal
): Promise<RelatedResult> {
  const namespace = obj.metadata.namespace
  if (!namespace) return { groups: [] }
  const base = (api: string, plural: string): string => `${api}${nsPath(namespace)}/${plural}`
  const groups: RelatedGroup[] = []

  if (kindId === 'configmaps' || kindId === 'secrets' || kindId === 'persistentvolumeclaims') {
    const name = obj.metadata.name
    groups.push(
      await usersOf(
        client,
        namespace,
        (r) =>
          kindId === 'configmaps'
            ? r.configMaps.has(name)
            : kindId === 'secrets'
              ? r.secrets.has(name) || r.pullSecrets.has(name)
              : r.pvcs.has(name),
        signal
      )
    )
    return { groups }
  }

  if (kindId === 'services') {
    const selector = o(o(obj.spec)['selector'])
    const [pods, ingresses, ...workloadLists] = await Promise.all([
      Object.keys(selector).length
        ? listOr(
            client,
            `${base('/api/v1', 'pods')}?labelSelector=${encodeURIComponent(selectorString({ matchLabels: selector }) ?? '')}`,
            signal
          )
        : Promise.resolve({ items: [] as K8sObject[] }),
      listOr(client, base('/apis/networking.k8s.io/v1', 'ingresses'), signal),
      ...WORKLOADS.filter((w) => w.id !== 'jobs.batch').map((w) =>
        listOr(client, base(w.path, w.plural), signal)
      )
    ])
    groups.push(
      group(
        'pods',
        'Pods',
        'pods',
        'error' in pods
          ? []
          : pods.items.map((p) => ({
              kind: 'pods',
              name: p.metadata.name,
              summary: podSummary(p),
              tone: podTone(p)
            })),
        'error' in pods ? pods.error : undefined
      )
    )
    const workloads: RelatedItem[] = []
    WORKLOADS.filter((w) => w.id !== 'jobs.batch').forEach((w, i) => {
      const list = workloadLists[i]
      if (!list || 'error' in list) return
      for (const x of list.items) {
        const tpl = podTemplate(w.id, x)
        if (!tpl || !selectorMatches(selector, tpl.labels)) continue
        const sum = workloadSummary(w.id, x)
        workloads.push({
          kind: w.id,
          name: x.metadata.name,
          summary: `${KIND_LABEL[w.id] ?? ''} · ${sum.summary}`,
          tone: sum.tone
        })
      }
    })
    groups.push(group('workloads', t('Workloads'), 'workloads', workloads))
    groups.push(ingressGroup(ingresses, new Set([obj.metadata.name])))
    const routes = await routesWhere(
      client,
      namespace,
      (r) => routeBackends(r).has(obj.metadata.name),
      signal
    )
    if (routes.length) groups.push(group('routes', t('Routes (Gateway API)'), 'routes', routes))
    return { groups }
  }

  if (kindId === 'gateways.gateway.networking.k8s.io') {
    const routes = await routesWhere(
      client,
      namespace,
      (r) => a(o(r.spec)['parentRefs']).some((p) => s(p['name']) === obj.metadata.name),
      signal
    )
    groups.push(group('routes', t('Routes'), 'routes', routes))
    return { groups }
  }

  if (ROUTE_KINDS.some((k) => k.id === kindId)) {
    const gateways = a(o(obj.spec)['parentRefs'])
      .map((p) => s(p['name']))
      .filter((n): n is string => Boolean(n))
    const gwList = await listOr(client, `${GATEWAY_API}${nsPath(namespace)}/gateways`, signal)
    const gw = byName(
      gateways,
      gwList,
      'gateways.gateway.networking.k8s.io',
      (g) => s(o(g.spec)['gatewayClassName']) ?? ''
    )
    groups.push(
      group('gateways', 'Gateways', 'gateways.gateway.networking.k8s.io', gw.items, gw.error)
    )
    const services = await listOr(client, base('/api/v1', 'services'), signal)
    const svc = byName(routeBackends(obj), services, 'services', serviceSummary)
    groups.push(group('services', 'Services', 'services', svc.items, svc.error))
    return { groups }
  }

  if (kindId === 'ingresses.networking.k8s.io') {
    const names = backendServices(obj)
    const services = await listOr(client, base('/api/v1', 'services'), signal)
    const r = byName(names, services, 'services', serviceSummary)
    groups.push(group('services', 'Services', 'services', r.items, r.error))
    return { groups }
  }

  const tpl = podTemplate(kindId, obj)
  if (!tpl) return { groups }
  const refs = podRefs(tpl.spec)
  const selector = kindId === 'pods' ? null : selectorString(o(obj.spec)['selector'])
  const [pods, services, ingresses, configMaps, secrets, pvcs, hpas, pdbs, owners] =
    await Promise.all([
      selector
        ? listOr(
            client,
            `${base('/api/v1', 'pods')}?labelSelector=${encodeURIComponent(selector)}`,
            signal
          )
        : Promise.resolve(null),
      listOr(client, base('/api/v1', 'services'), signal),
      listOr(client, base('/apis/networking.k8s.io/v1', 'ingresses'), signal),
      getNamed(client, base('/api/v1', 'configmaps'), refs.configMaps, signal),
      getNamed(
        client,
        base('/api/v1', 'secrets'),
        new Set([...refs.secrets, ...refs.pullSecrets]),
        signal
      ),
      refs.pvcs.size || kindId === 'statefulsets.apps'
        ? listOr(client, base('/api/v1', 'persistentvolumeclaims'), signal)
        : Promise.resolve({ items: [] }),
      kindId === 'pods'
        ? Promise.resolve({ items: [] })
        : listOr(client, base('/apis/autoscaling/v2', 'horizontalpodautoscalers'), signal),
      listOr(client, base('/apis/policy/v1', 'poddisruptionbudgets'), signal),
      ownerChain(client, namespace, obj, signal)
    ])

  if (owners.length) groups.push(group('owners', t('Owned by'), 'owners', owners))
  if (pods)
    groups.push(
      group(
        'pods',
        'Pods',
        'pods',
        'error' in pods
          ? []
          : pods.items.map((p) => ({
              kind: 'pods',
              name: p.metadata.name,
              summary: podSummary(p),
              tone: podTone(p)
            })),
        'error' in pods ? pods.error : undefined
      )
    )
  const matchedServices =
    'error' in services
      ? []
      : services.items.filter((x) => selectorMatches(o(x.spec)['selector'], tpl.labels))
  groups.push(
    group(
      'services',
      'Services',
      'services',
      matchedServices.map((x) => ({
        kind: 'services',
        name: x.metadata.name,
        summary: serviceSummary(x),
        tone: 'ok' as const
      })),
      'error' in services ? services.error : undefined
    )
  )
  groups.push(ingressGroup(ingresses, new Set(matchedServices.map((x) => x.metadata.name))))
  const cm = byName(refs.configMaps, configMaps, 'configmaps', (x) =>
    tn(keysOf(x), '{n} key', '{n} keys')
  )
  groups.push(group('configmaps', 'ConfigMaps', 'configmaps', cm.items, cm.error))
  const secretNames = new Set([...refs.secrets, ...refs.pullSecrets])
  const sec = byName(
    secretNames,
    secrets,
    'secrets',
    (x) => `${s((x as Obj)['type']) ?? 'Opaque'} · ${tn(keysOf(x), '{n} key', '{n} keys')}`,
    (name) => (refs.pullSecrets.has(name) && !refs.secrets.has(name) ? t('image pull') : undefined)
  )
  groups.push(group('secrets', 'Secrets', 'secrets', sec.items, sec.error))
  // StatefulSet: PVC từ volumeClaimTemplates tên "<template>-<statefulset>-<số>".
  const claimTemplates = a(o(obj.spec)['volumeClaimTemplates'])
    .map((tmpl) => s(o(tmpl['metadata'])['name']))
    .filter(Boolean) as string[]
  const pvcNames = new Set(refs.pvcs)
  if (claimTemplates.length && !('error' in pvcs))
    for (const p of pvcs.items)
      if (
        claimTemplates.some((tmpl) =>
          new RegExp(`^${tmpl}-${obj.metadata.name}-\\d+$`).test(p.metadata.name)
        )
      )
        pvcNames.add(p.metadata.name)
  const pv = byName(pvcNames, pvcs, 'persistentvolumeclaims', (x) => {
    const st = o((x as Obj)['status'])
    const cap = s(o(st['capacity'])['storage'])
    return [s(st['phase']), cap, s(o(x.spec)['storageClassName'])].filter(Boolean).join(' · ')
  })
  groups.push(
    group('pvcs', t('Persistent volume claims'), 'persistentvolumeclaims', pv.items, pv.error)
  )
  if (!('error' in hpas)) {
    const target = obj.kind ?? ''
    const items = hpas.items
      .filter((h) => {
        const ref = o(o(h.spec)['scaleTargetRef'])
        return ref['kind'] === target && ref['name'] === obj.metadata.name
      })
      .map((h) => {
        const spec = o(h.spec)
        const cur = Number(o(h.status)['currentReplicas']) || 0
        return {
          kind: 'horizontalpodautoscalers.autoscaling',
          name: h.metadata.name,
          summary: t('{min}–{max} replicas · now {current}', {
            min: txt(spec['minReplicas']) || '1',
            max: txt(spec['maxReplicas']),
            current: cur
          }),
          tone: 'ok' as const
        }
      })
    if (items.length)
      groups.push(group('hpas', t('Autoscalers'), 'horizontalpodautoscalers.autoscaling', items))
  }
  if (!('error' in pdbs)) {
    const items = pdbs.items
      .filter((p) => selectorMatches(o(p.spec)['selector'], tpl.labels))
      .map((p) => {
        const spec = o(p.spec)
        const allowed = Number(o(p.status)['disruptionsAllowed'])
        return {
          kind: 'poddisruptionbudgets.policy',
          name: p.metadata.name,
          summary: [
            spec['minAvailable'] !== undefined
              ? t('min available {n}', { n: txt(spec['minAvailable']) })
              : t('max unavailable {n}', { n: txt(spec['maxUnavailable']) }),
            Number.isFinite(allowed) ? t('{n} disruptions allowed', { n: allowed }) : ''
          ]
            .filter(Boolean)
            .join(' · '),
          tone: allowed === 0 ? ('warn' as const) : ('ok' as const)
        }
      })
    if (items.length)
      groups.push(group('pdbs', t('Disruption budgets'), 'poddisruptionbudgets.policy', items))
  }
  if (refs.serviceAccount && refs.serviceAccount !== 'default')
    groups.push(
      group('sa', t('Service account'), 'serviceaccounts', [
        {
          kind: 'serviceaccounts',
          name: refs.serviceAccount,
          summary: t('Identity of the pods in the cluster'),
          tone: 'muted'
        }
      ])
    )
  return { groups }
}

/** Tên Service mà Ingress chuyển tới (rules + defaultBackend). */
export function backendServices(ing: K8sObject): Set<string> {
  const spec = o(ing.spec)
  const names = new Set<string>()
  const add = (b: unknown): void => {
    const n = s(o(o(b)['service'])['name'])
    if (n) names.add(n)
  }
  add(spec['defaultBackend'])
  for (const r of a(spec['rules'])) for (const p of a(o(r['http'])['paths'])) add(p['backend'])
  return names
}

function ingressGroup(
  list: { items: K8sObject[] } | { error: string },
  services: Set<string>
): RelatedGroup {
  if ('error' in list)
    return group('ingresses', 'Ingresses', 'ingresses.networking.k8s.io', [], list.error)
  const items = list.items
    .filter((i) => [...backendServices(i)].some((n) => services.has(n)))
    .map((i) => {
      const hosts = a(o(i.spec)['rules'])
        .map((r) => s(r['host']))
        .filter(Boolean)
      return {
        kind: 'ingresses.networking.k8s.io',
        name: i.metadata.name,
        summary: hosts.length ? hosts.join(', ') : t('any host'),
        tone: 'ok' as const
      }
    })
  return group('ingresses', 'Ingresses', 'ingresses.networking.k8s.io', items)
}

const OWNER_KINDS: Record<string, { id: string; path: string; plural: string } | undefined> = {
  ReplicaSet: { id: 'replicasets.apps', path: '/apis/apps/v1', plural: 'replicasets' },
  Deployment: { id: 'deployments.apps', path: '/apis/apps/v1', plural: 'deployments' },
  StatefulSet: { id: 'statefulsets.apps', path: '/apis/apps/v1', plural: 'statefulsets' },
  DaemonSet: { id: 'daemonsets.apps', path: '/apis/apps/v1', plural: 'daemonsets' },
  Job: { id: 'jobs.batch', path: '/apis/batch/v1', plural: 'jobs' },
  CronJob: { id: 'cronjobs.batch', path: '/apis/batch/v1', plural: 'cronjobs' }
}

/** Chuỗi owner (Pod → ReplicaSet → Deployment, Job → CronJob…), tối đa 3 cấp. */
async function ownerChain(
  client: KubeClient,
  namespace: string,
  obj: K8sObject,
  signal?: AbortSignal
): Promise<RelatedItem[]> {
  const out: RelatedItem[] = []
  let current: K8sObject | null = obj
  for (let depth = 0; current && depth < 3; depth++) {
    const owners: { kind: string; name: string; controller?: boolean }[] =
      current.metadata.ownerReferences ?? []
    const ref = owners.find((r) => r.controller !== false)
    if (!ref) break
    const k = OWNER_KINDS[ref.kind]
    if (!k) {
      out.push({ kind: '', name: ref.name, summary: ref.kind, tone: 'muted' })
      break
    }
    const next: K8sObject | null = await client
      .json<K8sObject>(
        'GET',
        `${k.path}${nsPath(namespace)}/${k.plural}/${encodeURIComponent(ref.name)}`,
        signal ? { signal } : {}
      )
      .catch(() => null)
    const sum = next ? workloadSummary(k.id, next) : null
    out.push({
      kind: k.id,
      name: ref.name,
      summary: sum ? `${ref.kind} · ${sum.summary}` : `${ref.kind} · ${t('not found')}`,
      tone: sum ? sum.tone : 'bad',
      ...(sum ? {} : { missing: true })
    })
    current = next
  }
  return out
}
