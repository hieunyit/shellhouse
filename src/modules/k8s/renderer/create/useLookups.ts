import { useEffect, useState } from 'react'
import type { K8sObject } from '../../shared/resources'
import type { Request } from './model'

export interface Lookups {
  configMaps: string[]
  secrets: string[]
  pvcs: string[]
  services: { name: string; ports: string[] }[]
  deployments: string[]
  statefulSets: string[]
  storageClasses: string[]
  ingressClasses: string[]
}

export const NO_LOOKUPS: Lookups = {
  configMaps: [],
  secrets: [],
  pvcs: [],
  services: [],
  deployments: [],
  statefulSets: [],
  storageClasses: [],
  ingressClasses: []
}

/** Tên đã tải theo phiên (request) + namespace — mở lại form không hỏi lại cluster. */
export const LOOKUP_TTL_MS = 60_000

export const lookupCache = new WeakMap<
  Request,
  Map<string, { at: number; data: Promise<Lookups> }>
>()

export function fetchLookups(request: Request, namespace: string): Promise<Lookups> {
  const list = (kind: string, ns?: string): Promise<K8sObject[]> =>
    request<{ items: K8sObject[] }>({
      op: 'list',
      kind,
      ...(ns ? { namespace: ns } : {}),
      limit: 500
    }).then(
      (r) => r.items,
      () => []
    )
  const names = (items: K8sObject[]): string[] =>
    items.map((x) => x.metadata.name).sort((a, b) => a.localeCompare(b))
  return Promise.all([
    namespace ? list('configmaps', namespace) : [],
    // Session Host đã bỏ giá trị của Secret khi list — ở đây chỉ dùng tên.
    namespace ? list('secrets', namespace) : [],
    namespace ? list('persistentvolumeclaims', namespace) : [],
    namespace ? list('services', namespace) : [],
    namespace ? list('deployments.apps', namespace) : [],
    namespace ? list('statefulsets.apps', namespace) : [],
    list('storageclasses.storage.k8s.io'),
    list('ingressclasses.networking.k8s.io')
  ]).then(([cm, sec, pvc, svc, dep, sts, sc, ic]) => ({
    configMaps: names(cm).filter((n) => n !== 'kube-root-ca.crt'),
    secrets: names(sec),
    pvcs: names(pvc),
    services: svc
      .map((s) => ({
        name: s.metadata.name,
        ports: ((s.spec?.['ports'] as { port?: number; name?: string }[] | undefined) ?? []).map(
          (p) => String(p.port ?? p.name ?? '')
        )
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    deployments: names(dep),
    statefulSets: names(sts),
    storageClasses: names(sc),
    ingressClasses: names(ic)
  }))
}

export function cachedLookups(request: Request, namespace: string): Promise<Lookups> {
  let byNs = lookupCache.get(request)
  if (!byNs) {
    byNs = new Map()
    lookupCache.set(request, byNs)
  }
  const hit = byNs.get(namespace)
  if (hit && Date.now() - hit.at < LOOKUP_TTL_MS) return hit.data
  const data = fetchLookups(request, namespace)
  byNs.set(namespace, { at: Date.now(), data })
  return data
}

/** Tên đối tượng trong namespace (cho ô chọn) — lỗi / không có quyền → rỗng. */
export function useLookups(request: Request, namespace: string): Lookups {
  const [data, setData] = useState<{ ns: string; lookups: Lookups } | null>(null)
  useEffect(() => {
    let cancelled = false
    void cachedLookups(request, namespace).then((lookups) => {
      if (!cancelled) setData({ ns: namespace, lookups })
    })
    return () => {
      cancelled = true
    }
  }, [request, namespace])
  // Đổi namespace → không hiện tên của namespace cũ trong lúc tải.
  return data?.ns === namespace ? data.lookups : NO_LOOKUPS
}

/** Id loại (kiểu kubectl) theo `kind` của manifest do form sinh ra — kiểm tra trùng tên. */
export const DOC_KIND_ID: Record<string, string> = {
  Deployment: 'deployments.apps',
  StatefulSet: 'statefulsets.apps',
  DaemonSet: 'daemonsets.apps',
  Job: 'jobs.batch',
  CronJob: 'cronjobs.batch',
  Service: 'services',
  Ingress: 'ingresses.networking.k8s.io',
  ConfigMap: 'configmaps',
  Secret: 'secrets',
  PersistentVolumeClaim: 'persistentvolumeclaims',
  HorizontalPodAutoscaler: 'horizontalpodautoscalers.autoscaling',
  Namespace: 'namespaces'
}

/**
 * Đối tượng nào trong các manifest đã có trên cluster ("Service shop/api"). Server-side apply sẽ
 * sửa đè đối tượng cùng tên — hỏi trước. Không đọc được (403…) → coi như chưa có.
 */
export async function existingObjects(
  request: Request,
  docs: readonly Record<string, unknown>[],
  defaultNamespace: string
): Promise<string[]> {
  const found = await Promise.all(
    docs.map(async (d) => {
      const kind = typeof d['kind'] === 'string' ? d['kind'] : ''
      const meta = (d['metadata'] ?? {}) as { name?: string; namespace?: string }
      const id = DOC_KIND_ID[kind]
      if (!id || !meta.name) return null
      const ns = kind === 'Namespace' ? undefined : (meta.namespace ?? defaultNamespace)
      try {
        await request({
          op: 'get',
          kind: id,
          ...(ns ? { namespace: ns } : {}),
          name: meta.name,
          format: 'json'
        })
        return `${kind} ${ns ? `${ns}/` : ''}${meta.name}`
      } catch {
        return null
      }
    })
  )
  return found.filter((x): x is string => x !== null)
}
