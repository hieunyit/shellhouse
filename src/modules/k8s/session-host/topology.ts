import type {
  RbacGrant,
  RbacReach,
  TopologyEdge,
  TopologyEdgeType,
  TopologyNode,
  TopologyResult
} from '../shared/ops'
import { t, tn } from '@shared/i18n'
import { selectorMatches } from '../shared/map'
import { rbacRisk } from '../shared/security'
import { type K8sObject } from '../shared/resources'
import { KubeError, type KubeClient } from './client'
import { listPaged } from './operations'
import {
  KIND_LABEL,
  backendServices,
  podRefs,
  podSummary,
  podTemplate,
  podTone,
  routeBackends,
  serviceSummary,
  workloadSummary
} from './related'

/**
 * Object Topology: đồ thị quan hệ quanh một đối tượng — owner (Deployment → ReplicaSet → Pod),
 * scheduling (Pod → Node), traffic (Gateway → Route / Ingress → Service → workload), phụ thuộc
 * (ConfigMap / Secret / PVC → PV), chính sách (HPA / PDB / NetworkPolicy) và danh tính
 * (ServiceAccount → RoleBinding → Role). Đối tượng dùng chung (Node, ServiceAccount, ConfigMap…)
 * không tự bung ra — renderer mở rộng khi người dùng chọn. Không bao giờ trả giá trị Secret.
 */

type Obj = Record<string, unknown>
const o = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {})
const a = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(o) : [])
const s = (v: unknown): string => (typeof v === 'string' ? v : '')
const txt = (v: unknown): string =>
  typeof v === 'string' || typeof v === 'number' ? String(v) : ''

/** Pod tối đa mỗi owner trước khi gộp "+N pods". */
const PODS_PER_OWNER = 8
/** ReplicaSet / Job cũ tối đa (mới nhất trước). */
const MAX_GENERATIONS = 4
const MAX_NODES = 12
const MAX_USERS = 40

interface KindInfo {
  api: string
  plural: string
  label: string
  namespaced: boolean
}

const KINDS: Record<string, KindInfo> = {
  pods: { api: '/api/v1', plural: 'pods', label: 'Pod', namespaced: true },
  services: { api: '/api/v1', plural: 'services', label: 'Service', namespaced: true },
  configmaps: { api: '/api/v1', plural: 'configmaps', label: 'ConfigMap', namespaced: true },
  secrets: { api: '/api/v1', plural: 'secrets', label: 'Secret', namespaced: true },
  persistentvolumeclaims: {
    api: '/api/v1',
    plural: 'persistentvolumeclaims',
    label: 'PersistentVolumeClaim',
    namespaced: true
  },
  serviceaccounts: {
    api: '/api/v1',
    plural: 'serviceaccounts',
    label: 'ServiceAccount',
    namespaced: true
  },
  nodes: { api: '/api/v1', plural: 'nodes', label: 'Node', namespaced: false },
  persistentvolumes: {
    api: '/api/v1',
    plural: 'persistentvolumes',
    label: 'PersistentVolume',
    namespaced: false
  },
  'deployments.apps': {
    api: '/apis/apps/v1',
    plural: 'deployments',
    label: 'Deployment',
    namespaced: true
  },
  'statefulsets.apps': {
    api: '/apis/apps/v1',
    plural: 'statefulsets',
    label: 'StatefulSet',
    namespaced: true
  },
  'daemonsets.apps': {
    api: '/apis/apps/v1',
    plural: 'daemonsets',
    label: 'DaemonSet',
    namespaced: true
  },
  'replicasets.apps': {
    api: '/apis/apps/v1',
    plural: 'replicasets',
    label: 'ReplicaSet',
    namespaced: true
  },
  'jobs.batch': { api: '/apis/batch/v1', plural: 'jobs', label: 'Job', namespaced: true },
  'cronjobs.batch': {
    api: '/apis/batch/v1',
    plural: 'cronjobs',
    label: 'CronJob',
    namespaced: true
  },
  'ingresses.networking.k8s.io': {
    api: '/apis/networking.k8s.io/v1',
    plural: 'ingresses',
    label: 'Ingress',
    namespaced: true
  },
  'networkpolicies.networking.k8s.io': {
    api: '/apis/networking.k8s.io/v1',
    plural: 'networkpolicies',
    label: 'NetworkPolicy',
    namespaced: true
  },
  'horizontalpodautoscalers.autoscaling': {
    api: '/apis/autoscaling/v2',
    plural: 'horizontalpodautoscalers',
    label: 'HPA',
    namespaced: true
  },
  'poddisruptionbudgets.policy': {
    api: '/apis/policy/v1',
    plural: 'poddisruptionbudgets',
    label: 'PDB',
    namespaced: true
  },
  'gateways.gateway.networking.k8s.io': {
    api: '/apis/gateway.networking.k8s.io/v1',
    plural: 'gateways',
    label: 'Gateway',
    namespaced: true
  },
  'httproutes.gateway.networking.k8s.io': {
    api: '/apis/gateway.networking.k8s.io/v1',
    plural: 'httproutes',
    label: 'HTTPRoute',
    namespaced: true
  },
  'grpcroutes.gateway.networking.k8s.io': {
    api: '/apis/gateway.networking.k8s.io/v1',
    plural: 'grpcroutes',
    label: 'GRPCRoute',
    namespaced: true
  },
  'rolebindings.rbac.authorization.k8s.io': {
    api: '/apis/rbac.authorization.k8s.io/v1',
    plural: 'rolebindings',
    label: 'RoleBinding',
    namespaced: true
  },
  'clusterrolebindings.rbac.authorization.k8s.io': {
    api: '/apis/rbac.authorization.k8s.io/v1',
    plural: 'clusterrolebindings',
    label: 'ClusterRoleBinding',
    namespaced: false
  },
  'roles.rbac.authorization.k8s.io': {
    api: '/apis/rbac.authorization.k8s.io/v1',
    plural: 'roles',
    label: 'Role',
    namespaced: true
  },
  'clusterroles.rbac.authorization.k8s.io': {
    api: '/apis/rbac.authorization.k8s.io/v1',
    plural: 'clusterroles',
    label: 'ClusterRole',
    namespaced: false
  }
}

/** Kind trong ownerReferences / scaleTargetRef → id loại. */
const BY_KIND: Record<string, string> = Object.fromEntries(
  Object.entries(KINDS).map(([id, k]) => [
    id === 'horizontalpodautoscalers.autoscaling'
      ? 'HorizontalPodAutoscaler'
      : id === 'poddisruptionbudgets.policy'
        ? 'PodDisruptionBudget'
        : k.label,
    id
  ])
)

const WORKLOAD_IDS = [
  'deployments.apps',
  'statefulsets.apps',
  'daemonsets.apps',
  'cronjobs.batch',
  'jobs.batch'
] as const

export const TOPOLOGY_KINDS = [
  'pods',
  ...WORKLOAD_IDS,
  'replicasets.apps',
  'services',
  'ingresses.networking.k8s.io',
  'gateways.gateway.networking.k8s.io',
  'httproutes.gateway.networking.k8s.io',
  'grpcroutes.gateway.networking.k8s.io',
  'configmaps',
  'secrets',
  'persistentvolumeclaims',
  'serviceaccounts',
  'nodes'
]

export const nodeId = (kind: string, ns: string | undefined, name: string): string =>
  `${kind}|${ns ?? ''}|${name}`

type Listed = { items: K8sObject[] } | { error: string }
/** Kết quả tra một đối tượng theo tên: có / không tồn tại / không biết (thiếu quyền, lỗi). */
type Lookup = { obj: K8sObject } | { missing: true } | { unknown: string }

/** List mỗi loại tối đa chừng này đối tượng (quá → ghi chú, không kết luận "missing"). */
const LIST_MAX = 20_000

/** Một lượt dựng đồ thị: cache list / get, gom node + cạnh + ghi chú. */
class Builder {
  readonly nodes = new Map<string, TopologyNode>()
  readonly edges = new Map<string, TopologyEdge>()
  readonly notes = new Set<string>()
  private readonly lists = new Map<string, Promise<Listed>>()
  private readonly gets = new Map<string, Promise<K8sObject | null>>()
  private readonly lookups = new Map<string, Promise<Lookup>>()

  constructor(
    private readonly client: KubeClient,
    private readonly signal?: AbortSignal
  ) {}

  private path(kind: string, ns?: string, name?: string): string {
    const k = KINDS[kind]
    if (!k) throw new Error(`Unknown kind ${kind}`)
    return `${k.api}${k.namespaced && ns ? `/namespaces/${encodeURIComponent(ns)}` : ''}/${k.plural}${name ? `/${encodeURIComponent(name)}` : ''}`
  }

  list(kind: string, ns?: string, query?: Record<string, string>): Promise<Listed> {
    const key = `${kind}|${ns ?? ''}|${JSON.stringify(query ?? {})}`
    let p = this.lists.get(key)
    if (!p) {
      const label = KINDS[kind]?.label ?? kind
      p = listPaged(this.client, this.path(kind, ns), {
        ...(query ? { query } : {}),
        signal: this.signal,
        max: LIST_MAX
      }).then(
        (r): Listed => {
          if (!r.truncated) return { items: r.items }
          // Quá nhiều để đọc hết: không kết luận "không tồn tại" từ danh sách thiếu.
          const msg = ns
            ? t('Too many {kind} objects in {ns} — only the first {max} were read', {
                kind: label,
                ns,
                max: LIST_MAX
              })
            : t('Too many {kind} objects — only the first {max} were read', {
                kind: label,
                max: LIST_MAX
              })
          this.notes.add(msg)
          return { error: msg }
        },
        (error: unknown): Listed => {
          if (error instanceof KubeError && error.status === 404) return { items: [] }
          const msg =
            error instanceof KubeError && error.status === 403
              ? ns
                ? t('Not allowed to list {kind} in {ns}', { kind: label, ns })
                : t('Not allowed to list {kind}', { kind: label })
              : `${label}s: ${error instanceof Error ? error.message : String(error)}`
          this.notes.add(msg)
          return { error: msg }
        }
      )
      this.lists.set(key, p)
    }
    return p
  }

  async items(kind: string, ns?: string, query?: Record<string, string>): Promise<K8sObject[]> {
    const l = await this.list(kind, ns, query)
    return 'error' in l ? [] : l.items
  }

  get(kind: string, ns: string | undefined, name: string): Promise<K8sObject | null> {
    const key = nodeId(kind, ns, name)
    let p = this.gets.get(key)
    if (!p) {
      p = this.client
        .json<K8sObject>(
          'GET',
          this.path(kind, ns, name),
          this.signal ? { signal: this.signal } : {}
        )
        .catch(() => null)
      this.gets.set(key, p)
    }
    return p
  }

  /**
   * Tra một đối tượng theo tên (GET, nhớ trong lượt): không list cả loại chỉ để tìm vài cái tên
   * (list Secret của một namespace có thể hàng chục MB — release Helm).
   */
  lookup(kind: string, ns: string | undefined, name: string): Promise<Lookup> {
    const key = nodeId(kind, ns, name)
    let p = this.lookups.get(key)
    if (!p) {
      p = this.client
        .json<K8sObject>(
          'GET',
          this.path(kind, ns, name),
          this.signal ? { signal: this.signal } : {}
        )
        .then(
          (obj): Lookup => ({ obj }),
          (error: unknown): Lookup => {
            if (error instanceof KubeError && error.status === 404) return { missing: true }
            const label = KINDS[kind]?.label ?? kind
            return {
              unknown:
                error instanceof KubeError && error.status === 403
                  ? ns
                    ? t('Not allowed to read {kind} in {ns}', { kind: label, ns })
                    : t('Not allowed to read {kind}', { kind: label })
                  : `${label} ${name}: ${error instanceof Error ? error.message : String(error)}`
            }
          }
        )
      this.lookups.set(key, p)
    }
    return p
  }

  /**
   * Node cho đối tượng được tham chiếu theo tên: có → node thật; không tồn tại → "missing"; không
   * biết (thiếu quyền) → node mờ, không kết luận missing.
   */
  async ref(
    kind: string,
    ns: string | undefined,
    name: string
  ): Promise<{ id: string; obj?: K8sObject }> {
    const r = await this.lookup(kind, ns, name)
    if ('obj' in r) return { id: this.add(kind, r.obj), obj: r.obj }
    if ('missing' in r) return { id: this.missing(kind, ns, name) }
    this.notes.add(r.unknown)
    const id = this.missing(kind, ns, name, t('Unknown (not allowed to read)'))
    const n = this.nodes.get(id)
    if (n) {
      n.tone = 'muted'
      delete n.missing
    }
    return { id }
  }

  /** Thêm node cho đối tượng có thật (tóm tắt theo loại). */
  add(kind: string, obj: K8sObject, expandable = true): string {
    const ns = KINDS[kind]?.namespaced === false ? undefined : obj.metadata.namespace
    const id = nodeId(kind, ns, obj.metadata.name)
    if (!this.nodes.has(id)) {
      const { summary, tone } = describe(kind, obj)
      this.nodes.set(id, {
        id,
        kind,
        kindLabel: KINDS[kind]?.label ?? obj.kind ?? kind,
        name: obj.metadata.name,
        ...(ns ? { namespace: ns } : {}),
        summary,
        tone,
        ...(expandable ? { expandable: true } : {})
      })
    }
    return id
  }

  /** Được tham chiếu nhưng không tìm thấy. */
  missing(kind: string, ns: string | undefined, name: string, why = t('Not found')): string {
    const id = nodeId(kind, ns, name)
    if (!this.nodes.has(id))
      this.nodes.set(id, {
        id,
        kind,
        kindLabel: KINDS[kind]?.label ?? kind,
        name,
        ...(ns ? { namespace: ns } : {}),
        summary: why,
        tone: 'bad',
        missing: true
      })
    return id
  }

  /** Nhóm gộp ("+12 pods"). */
  more(parent: string, count: number, label: string): string {
    const id = `more|${parent}|${label}`
    this.nodes.set(id, {
      id,
      kind: '',
      kindLabel: label,
      name: tn(count, '+{n} more', '+{n} more'),
      summary: tn(count, '{n} not shown', '{n} not shown'),
      tone: 'muted'
    })
    return id
  }

  link(from: string, to: string, type: TopologyEdgeType, label?: string): void {
    if (from === to) return
    const key = `${from}>${to}>${type}`
    const prev = this.edges.get(key)
    if (prev) {
      if (label && prev.label && !prev.label.split(', ').includes(label))
        prev.label = `${prev.label}, ${label}`
      return
    }
    this.edges.set(key, { from, to, type, ...(label ? { label } : {}) })
  }

  result(root: string): TopologyResult {
    return {
      root,
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
      notes: [...this.notes]
    }
  }
}

function describe(kind: string, obj: K8sObject): { summary: string; tone: TopologyNode['tone'] } {
  const spec = o(obj.spec)
  const st = o(obj.status)
  const keys = Object.keys(o(obj.data)).length + Object.keys(o(o(obj)['binaryData'])).length
  switch (kind) {
    case 'pods':
      return {
        summary: `${podSummary(obj)}${spec['nodeName'] ? '' : ` · ${t('unscheduled')}`}`,
        tone: podTone(obj)
      }
    case 'deployments.apps':
    case 'statefulsets.apps':
    case 'daemonsets.apps':
    case 'jobs.batch':
    case 'cronjobs.batch':
      return workloadSummary(kind, obj)
    case 'replicasets.apps': {
      const want = Number(spec['replicas'] ?? 0)
      const ready = Number(st['readyReplicas'] ?? 0)
      const rev = obj.metadata.annotations?.['deployment.kubernetes.io/revision']
      return {
        summary: `${rev ? `rev ${rev} · ` : ''}${t('{ready}/{desired} ready', { ready, desired: want })}`,
        tone: want === 0 ? 'muted' : ready >= want ? 'ok' : ready ? 'warn' : 'bad'
      }
    }
    case 'services':
      return { summary: serviceSummary(obj), tone: 'ok' }
    case 'ingresses.networking.k8s.io': {
      const hosts = a(spec['rules'])
        .map((r) => s(r['host']))
        .filter(Boolean)
      return { summary: hosts.length ? hosts.join(', ') : t('any host'), tone: 'ok' }
    }
    case 'httproutes.gateway.networking.k8s.io':
    case 'grpcroutes.gateway.networking.k8s.io': {
      const hosts = (Array.isArray(spec['hostnames']) ? (spec['hostnames'] as unknown[]) : [])
        .map(s)
        .filter(Boolean)
      return { summary: hosts.length ? hosts.join(', ') : t('any host'), tone: 'ok' }
    }
    case 'gateways.gateway.networking.k8s.io': {
      const listeners = a(spec['listeners'])
        .map((l) => `${s(l['protocol'])}:${txt(l['port'])}`)
        .join(', ')
      return {
        summary: [s(spec['gatewayClassName']), listeners].filter(Boolean).join(' · '),
        tone: 'ok'
      }
    }
    case 'configmaps':
      return { summary: tn(keys, '{n} key', '{n} keys'), tone: 'ok' }
    case 'secrets':
      return {
        summary: `${s(o(obj)['type']) || 'Opaque'} · ${tn(keys, '{n} key', '{n} keys')}`,
        tone: 'ok'
      }
    case 'persistentvolumeclaims': {
      const phase = s(st['phase'])
      return {
        summary: [phase, s(o(st['capacity'])['storage']), s(spec['storageClassName'])]
          .filter(Boolean)
          .join(' · '),
        tone: phase === 'Bound' ? 'ok' : phase === 'Lost' ? 'bad' : 'warn'
      }
    }
    case 'persistentvolumes': {
      const phase = s(st['phase'])
      return {
        summary: [
          phase,
          s(o(spec['capacity'])['storage']),
          s(spec['storageClassName']),
          s(spec['persistentVolumeReclaimPolicy'])
        ]
          .filter(Boolean)
          .join(' · '),
        tone: phase === 'Bound' ? 'ok' : phase === 'Failed' ? 'bad' : 'warn'
      }
    }
    case 'nodes': {
      const ready = a(st['conditions']).find((c) => c['type'] === 'Ready')
      const ok = s(ready?.['status']) === 'True'
      const cordoned = spec['unschedulable'] === true
      return {
        summary: [
          ok ? 'Ready' : 'NotReady',
          cordoned ? t('cordoned') : '',
          s(o(st['nodeInfo'])['kubeletVersion'])
        ]
          .filter(Boolean)
          .join(' · '),
        tone: !ok ? 'bad' : cordoned ? 'warn' : 'ok'
      }
    }
    case 'horizontalpodautoscalers.autoscaling':
      return {
        summary: t('{min}–{max} replicas, now {current}', {
          min: txt(spec['minReplicas']) || '1',
          max: txt(spec['maxReplicas']),
          current: txt(st['currentReplicas']) || '0'
        }),
        tone: 'ok'
      }
    case 'poddisruptionbudgets.policy': {
      const allowed = Number(st['disruptionsAllowed'])
      return {
        summary: `${spec['minAvailable'] !== undefined ? t('min available {n}', { n: txt(spec['minAvailable']) }) : t('max unavailable {n}', { n: txt(spec['maxUnavailable']) })}${Number.isFinite(allowed) ? ` · ${tn(allowed, '{n} disruption allowed', '{n} disruptions allowed')}` : ''}`,
        tone: allowed === 0 ? 'warn' : 'ok'
      }
    }
    case 'networkpolicies.networking.k8s.io': {
      const types = (
        Array.isArray(spec['policyTypes']) ? (spec['policyTypes'] as unknown[]) : ['Ingress']
      )
        .map(s)
        .filter(Boolean)
      return {
        summary: `${types.join(' + ')} · ${t('{in} in / {out} out rules', { in: a(spec['ingress']).length, out: a(spec['egress']).length })}`,
        tone: 'ok'
      }
    }
    case 'serviceaccounts':
      return { summary: t('Identity of the pods'), tone: 'muted' }
    case 'rolebindings.rbac.authorization.k8s.io':
    case 'clusterrolebindings.rbac.authorization.k8s.io': {
      const ref = o(o(obj)['roleRef'])
      return { summary: `→ ${s(ref['kind'])}/${s(ref['name'])}`, tone: 'muted' }
    }
    case 'roles.rbac.authorization.k8s.io':
    case 'clusterroles.rbac.authorization.k8s.io': {
      const grants = grantsOf(obj, '', '')
      const high = grants.filter((g) => g.risk === 'high')
      const medium = grants.filter((g) => g.risk === 'medium')
      return {
        summary:
          high[0]?.reason ??
          medium[0]?.reason ??
          tn(grants.length, '{n} permission', '{n} permissions'),
        tone: high.length ? 'bad' : medium.length ? 'warn' : 'ok'
      }
    }
    default:
      return { summary: obj.kind ?? kind, tone: 'muted' }
  }
}

// ——— RBAC ———

/** Quyền trong rules của một Role / ClusterRole. */
function grantsOf(role: K8sObject, scope: string, via: string): RbacGrant[] {
  const out: RbacGrant[] = []
  for (const r of a(o(role)['rules'])) {
    const verbs = (Array.isArray(r['verbs']) ? (r['verbs'] as unknown[]) : [])
      .map(s)
      .filter(Boolean)
    const groups = (Array.isArray(r['apiGroups']) ? (r['apiGroups'] as unknown[]) : ['']).map(s)
    const resources = (Array.isArray(r['resources']) ? (r['resources'] as unknown[]) : []).map(s)
    const names = (Array.isArray(r['resourceNames']) ? (r['resourceNames'] as unknown[]) : []).map(
      s
    )
    for (const res of resources)
      for (const g of groups.length ? groups : ['']) {
        const resource = !g || res === '*' ? res : g === '*' ? `${res}.*` : `${res}.${g}`
        const risk = rbacRisk(resource, verbs)
        out.push({
          resource,
          verbs,
          names,
          scope,
          via,
          risk: names.length && risk.risk === 'high' ? 'medium' : risk.risk,
          ...(risk.reason ? { reason: risk.reason } : {})
        })
      }
    for (const url of (Array.isArray(r['nonResourceURLs'])
      ? (r['nonResourceURLs'] as unknown[])
      : []
    ).map(s))
      out.push({ resource: `URL ${url}`, verbs, names: [], scope: '*', via, risk: 'low' })
  }
  return out
}

interface Binding {
  binding: K8sObject
  kind: 'rolebindings.rbac.authorization.k8s.io' | 'clusterrolebindings.rbac.authorization.k8s.io'
  roleKind: 'roles.rbac.authorization.k8s.io' | 'clusterroles.rbac.authorization.k8s.io'
  roleName: string
  role: K8sObject | null
}

/** Binding áp lên ServiceAccount (trực tiếp hoặc qua nhóm system:serviceaccounts…). */
async function bindingsOf(b: Builder, ns: string, sa: string): Promise<Binding[]> {
  const applies = (binding: K8sObject, bindingNs: string): boolean =>
    a(o(binding)['subjects']).some((x) => {
      const kind = s(x['kind'])
      const name = s(x['name'])
      if (kind === 'ServiceAccount') return name === sa && (s(x['namespace']) || bindingNs) === ns
      if (kind === 'Group')
        return (
          name === 'system:serviceaccounts' ||
          name === `system:serviceaccounts:${ns}` ||
          name === 'system:authenticated'
        )
      return false
    })
  const [rbs, crbs] = await Promise.all([
    b.items('rolebindings.rbac.authorization.k8s.io', ns),
    b.items('clusterrolebindings.rbac.authorization.k8s.io')
  ])
  const picked = [
    ...rbs
      .filter((x) => applies(x, ns))
      .map((binding) => ({ binding, kind: 'rolebindings.rbac.authorization.k8s.io' as const })),
    ...crbs
      .filter((x) => applies(x, ''))
      // Nhóm system:authenticated / discovery: ai cũng có — bỏ cho đỡ nhiễu.
      .filter((x) => !/^system:(basic-user|discovery|public-info-viewer)$/.test(x.metadata.name))
      .map((binding) => ({
        binding,
        kind: 'clusterrolebindings.rbac.authorization.k8s.io' as const
      }))
  ]
  return Promise.all(
    picked.map(async ({ binding, kind }) => {
      const ref = o(o(binding)['roleRef'])
      const roleKind =
        s(ref['kind']) === 'Role'
          ? ('roles.rbac.authorization.k8s.io' as const)
          : ('clusterroles.rbac.authorization.k8s.io' as const)
      const roleName = s(ref['name'])
      const role = await b.get(
        roleKind,
        roleKind === 'roles.rbac.authorization.k8s.io' ? ns : undefined,
        roleName
      )
      return { binding, kind, roleKind, roleName, role }
    })
  )
}

export async function rbacReach(
  client: KubeClient,
  ns: string,
  sa: string,
  signal?: AbortSignal
): Promise<RbacReach> {
  const b = new Builder(client, signal)
  const bindings = await bindingsOf(b, ns, sa)
  const grants: RbacGrant[] = []
  for (const x of bindings) {
    if (!x.role) continue
    const scope = x.kind === 'rolebindings.rbac.authorization.k8s.io' ? ns : '*'
    grants.push(
      ...grantsOf(
        x.role,
        scope,
        `${KINDS[x.kind]?.label ?? ''} ${x.binding.metadata.name} → ${KINDS[x.roleKind]?.label ?? ''} ${x.roleName}`
      )
    )
  }
  const rank = { high: 0, medium: 1, low: 2 }
  grants.sort((p, q) => rank[p.risk] - rank[q.risk] || p.resource.localeCompare(q.resource))
  const notes = [...b.notes]
  return {
    serviceAccount: sa,
    namespace: ns,
    bindings: bindings.map((x) => ({
      kind: KINDS[x.kind]?.label ?? '',
      name: x.binding.metadata.name,
      ...(x.kind === 'rolebindings.rbac.authorization.k8s.io' ? { namespace: ns } : {}),
      role: x.roleName,
      roleKind: KINDS[x.roleKind]?.label ?? ''
    })),
    grants,
    ...(notes.length ? { error: notes.join('; ') } : {})
  }
}

// ——— Dựng đồ thị ———

/** ServiceAccount → binding → role. */
async function wireIdentity(b: Builder, from: string, ns: string, sa: string): Promise<void> {
  const obj = await b.get('serviceaccounts', ns, sa)
  const saId = obj ? b.add('serviceaccounts', obj) : b.missing('serviceaccounts', ns, sa)
  b.link(from, saId, 'identity')
  for (const x of await bindingsOf(b, ns, sa)) {
    const bid = b.add(x.kind, x.binding, false)
    b.link(saId, bid, 'subject', t('bound by'))
    const rid = x.role
      ? b.add(x.roleKind, x.role, false)
      : b.missing(
          x.roleKind,
          x.roleKind === 'roles.rbac.authorization.k8s.io' ? ns : undefined,
          x.roleName
        )
    b.link(bid, rid, 'grants')
  }
}

/** ConfigMap / Secret / PVC (→ PV) / ServiceAccount mà pod spec dùng. */
async function wireDependencies(
  b: Builder,
  from: string,
  ns: string,
  spec: Obj,
  claims: string[] = []
): Promise<void> {
  const refs = podRefs(spec)
  // Tra theo tên (vài GET nhỏ) thay vì list cả loại trong namespace.
  const pick = async (
    kind: string,
    names: Iterable<string>,
    type: TopologyEdgeType,
    label: (n: string) => string
  ): Promise<K8sObject[]> => {
    const found = await Promise.all(
      [...names].map(async (name) => {
        const r = await b.ref(kind, ns, name)
        b.link(from, r.id, type, label(name))
        return r.obj
      })
    )
    return found.filter((x): x is K8sObject => x !== undefined)
  }
  const [, , bound] = await Promise.all([
    pick('configmaps', refs.configMaps, 'uses', () => t('config')),
    pick('secrets', new Set([...refs.secrets, ...refs.pullSecrets]), 'uses', (n) =>
      refs.pullSecrets.has(n) && !refs.secrets.has(n) ? t('image pull') : t('secret')
    ),
    pick('persistentvolumeclaims', new Set([...refs.pvcs, ...claims]), 'mounts', () => t('volume'))
  ])
  await Promise.all(
    bound.map(async (pvc) => {
      const pvName = s(o(pvc.spec)['volumeName'])
      if (!pvName) return
      const pv = await b.get('persistentvolumes', undefined, pvName)
      const pvcId = nodeId('persistentvolumeclaims', ns, pvc.metadata.name)
      b.link(
        pvcId,
        pv
          ? b.add('persistentvolumes', pv, false)
          : b.missing('persistentvolumes', undefined, pvName),
        'bound'
      )
    })
  )
  // podRefs trả '' khi không khai báo — ServiceAccount mặc định là "default".
  await wireIdentity(b, from, ns, refs.serviceAccount || 'default')
}

/** Phía trước workload / pod: Service chọn nó, Ingress / Route / Gateway tới Service đó. */
async function wireFront(
  b: Builder,
  target: string,
  ns: string,
  labels: Record<string, string>
): Promise<void> {
  const services = (await b.items('services', ns)).filter((x) =>
    selectorMatches(o(x.spec)['selector'], labels)
  )
  const svcIds = new Map<string, string>()
  for (const svc of services) {
    const id = b.add('services', svc)
    svcIds.set(svc.metadata.name, id)
    const ports = a(o(svc.spec)['ports'])
      .map((p) => `${txt(p['port'])}→${txt(p['targetPort']) || txt(p['port'])}`)
      .join(', ')
    b.link(id, target, 'selects', ports || undefined)
  }
  await wireServiceFront(b, ns, svcIds)
}

/** Ingress / HTTPRoute / GRPCRoute → Service, Gateway → Route. */
async function wireServiceFront(
  b: Builder,
  ns: string,
  svcIds: Map<string, string>
): Promise<void> {
  if (!svcIds.size) return
  const [ingresses, http, grpc] = await Promise.all([
    b.items('ingresses.networking.k8s.io', ns),
    b.items('httproutes.gateway.networking.k8s.io', ns),
    b.items('grpcroutes.gateway.networking.k8s.io', ns)
  ])
  for (const ing of ingresses)
    for (const name of backendServices(ing)) {
      const sid = svcIds.get(name)
      if (sid) b.link(b.add('ingresses.networking.k8s.io', ing), sid, 'routes')
    }
  const routes = [
    ...http.map((r) => ({ r, kind: 'httproutes.gateway.networking.k8s.io' })),
    ...grpc.map((r) => ({ r, kind: 'grpcroutes.gateway.networking.k8s.io' }))
  ]
  for (const { r, kind } of routes) {
    const hits = [...routeBackends(r)].filter((n) => svcIds.has(n))
    if (!hits.length) continue
    const rid = b.add(kind, r)
    for (const n of hits) b.link(rid, svcIds.get(n) ?? '', 'routes')
    await wireGateways(b, rid, r)
  }
}

async function wireGateways(b: Builder, routeId: string, route: K8sObject): Promise<void> {
  for (const p of a(o(route.spec)['parentRefs'])) {
    if ((s(p['kind']) || 'Gateway') !== 'Gateway') continue
    const gns = s(p['namespace']) || (route.metadata.namespace ?? '')
    const name = s(p['name'])
    if (!name) continue
    const gw = await b.get('gateways.gateway.networking.k8s.io', gns, name)
    const gid = gw
      ? b.add('gateways.gateway.networking.k8s.io', gw)
      : b.missing('gateways.gateway.networking.k8s.io', gns, name)
    b.link(gid, routeId, 'attaches', s(p['sectionName']) || undefined)
  }
}

/** HPA / PDB / NetworkPolicy áp lên workload. */
async function wirePolicies(
  b: Builder,
  target: string,
  ns: string,
  labels: Record<string, string>,
  scaleTarget?: { kind: string; name: string }
): Promise<void> {
  const [hpas, pdbs, netpols] = await Promise.all([
    scaleTarget ? b.items('horizontalpodautoscalers.autoscaling', ns) : Promise.resolve([]),
    b.items('poddisruptionbudgets.policy', ns),
    b.items('networkpolicies.networking.k8s.io', ns)
  ])
  for (const h of hpas) {
    const ref = o(o(h.spec)['scaleTargetRef'])
    if (s(ref['kind']) === scaleTarget?.kind && s(ref['name']) === scaleTarget.name)
      b.link(b.add('horizontalpodautoscalers.autoscaling', h, false), target, 'scales')
  }
  for (const p of pdbs)
    if (selectorMatches(o(p.spec)['selector'], labels))
      b.link(b.add('poddisruptionbudgets.policy', p, false), target, 'protects')
  for (const p of netpols)
    if (selectorMatches(o(p.spec)['podSelector'], labels, true))
      b.link(b.add('networkpolicies.networking.k8s.io', p, false), target, 'isolates')
}

const owned = (x: K8sObject, kind: string, name: string): boolean =>
  (x.metadata.ownerReferences ?? []).some((r) => r.kind === kind && r.name === name)

/** Pod của owner (giới hạn, gộp phần dư) + node chúng chạy. */
function wirePods(b: Builder, owner: string, pods: K8sObject[], nodes: Set<string>): void {
  const sorted = [...pods].sort((p, q) => {
    // Pod lỗi trước — thấy ngay pod cần xem.
    const rank = { bad: 0, warn: 1, ok: 2, muted: 3 }
    return rank[podTone(p)] - rank[podTone(q)] || p.metadata.name.localeCompare(q.metadata.name)
  })
  for (const p of sorted.slice(0, PODS_PER_OWNER)) {
    const pid = b.add('pods', p)
    b.link(owner, pid, 'owns')
    const node = s(o(p.spec)['nodeName'])
    if (node) nodes.add(`${pid}\n${node}`)
  }
  if (sorted.length > PODS_PER_OWNER)
    b.link(owner, b.more(owner, sorted.length - PODS_PER_OWNER, 'Pods'), 'owns')
}

/** Pod → Node (mỗi node một lần get; quá nhiều node → chỉ vài node đầu). */
async function wireNodes(b: Builder, pairs: Set<string>): Promise<void> {
  const names = [...new Set([...pairs].map((x) => x.split('\n')[1] ?? ''))].filter(Boolean)
  const shown = new Set(names.slice(0, MAX_NODES))
  if (names.length > MAX_NODES)
    b.notes.add(t('Pods run on {n} nodes — showing {max}', { n: names.length, max: MAX_NODES }))
  const objs = new Map(
    await Promise.all([...shown].map(async (n) => [n, await b.get('nodes', undefined, n)] as const))
  )
  for (const pair of pairs) {
    const [pid, name] = pair.split('\n')
    if (!pid || !name || !shown.has(name)) continue
    const node = objs.get(name)
    b.link(pid, node ? b.add('nodes', node) : b.missing('nodes', undefined, name), 'runs-on')
  }
}

/** Workload (Deployment / StatefulSet / DaemonSet / Job / CronJob / ReplicaSet) làm gốc. */
async function workloadGraph(b: Builder, kind: string, w: K8sObject): Promise<string> {
  const ns = w.metadata.namespace ?? ''
  const root = b.add(kind, w)
  const tpl = podTemplate(kind === 'replicasets.apps' ? 'deployments.apps' : kind, w)
  const nodes = new Set<string>()
  const pods = await b.items('pods', ns)
  const label = KINDS[kind]?.label ?? ''

  // Sở hữu đi xuống.
  if (kind === 'deployments.apps' || kind === 'cronjobs.batch') {
    const childKind = kind === 'deployments.apps' ? 'replicasets.apps' : 'jobs.batch'
    const children = (await b.items(childKind, ns))
      .filter((x) => owned(x, label, w.metadata.name))
      .sort((p, q) =>
        (q.metadata.creationTimestamp ?? '').localeCompare(p.metadata.creationTimestamp ?? '')
      )
    // Thế hệ còn pod luôn hiện; thế hệ cũ (0 pod) chỉ vài cái mới nhất — xem rollout.
    const live = children.filter((x) =>
      pods.some((p) => owned(p, KINDS[childKind]?.label ?? '', x.metadata.name))
    )
    const old = children
      .filter((x) => !live.includes(x))
      .slice(0, Math.max(0, MAX_GENERATIONS - live.length))
    for (const c of [...live, ...old]) {
      const cid = b.add(childKind, c)
      b.link(root, cid, 'owns')
      wirePods(
        b,
        cid,
        pods.filter((p) => owned(p, KINDS[childKind]?.label ?? '', c.metadata.name)),
        nodes
      )
    }
    const hidden = children.length - live.length - old.length
    if (hidden > 0)
      b.link(
        root,
        b.more(root, hidden, childKind === 'jobs.batch' ? 'Jobs' : 'ReplicaSets'),
        'owns'
      )
  } else {
    wirePods(
      b,
      root,
      pods.filter((p) => owned(p, label, w.metadata.name)),
      nodes
    )
  }
  // ReplicaSet / Job gốc: owner đi lên.
  if (kind === 'replicasets.apps' || kind === 'jobs.batch') await wireOwners(b, root, w)
  await wireNodes(b, nodes)

  if (tpl) {
    const claims =
      kind === 'statefulsets.apps'
        ? (await b.items('persistentvolumeclaims', ns))
            .map((p) => p.metadata.name)
            .filter((n) =>
              a(o(w.spec)['volumeClaimTemplates']).some((t) => {
                const prefix = `${s(o(t['metadata'])['name'])}-${w.metadata.name}-`
                return n.startsWith(prefix) && /^\d+$/.test(n.slice(prefix.length))
              })
            )
        : []
    await Promise.all([
      wireDependencies(b, root, ns, tpl.spec, claims),
      kind === 'cronjobs.batch' || kind === 'jobs.batch'
        ? Promise.resolve()
        : wireFront(b, root, ns, tpl.labels),
      wirePolicies(b, root, ns, tpl.labels, { kind: label, name: w.metadata.name })
    ])
  }
  return root
}

/** Owner đi lên (Pod → ReplicaSet → Deployment, Job → CronJob), tối đa 3 cấp. */
async function wireOwners(b: Builder, childId: string, obj: K8sObject): Promise<void> {
  let current: K8sObject | null = obj
  let child = childId
  for (let depth = 0; current && depth < 3; depth++) {
    const ref = (current.metadata.ownerReferences ?? []).find((r) => r.controller !== false)
    if (!ref) return
    const kind = BY_KIND[ref.kind]
    if (!kind) return
    const parent: K8sObject | null = await b.get(kind, obj.metadata.namespace, ref.name)
    const pid = parent ? b.add(kind, parent) : b.missing(kind, obj.metadata.namespace, ref.name)
    b.link(pid, child, 'owns')
    child = pid
    current = parent
  }
}

async function podGraph(b: Builder, pod: K8sObject): Promise<string> {
  const ns = pod.metadata.namespace ?? ''
  const root = b.add('pods', pod)
  await wireOwners(b, root, pod)
  const nodes = new Set<string>()
  const node = s(o(pod.spec)['nodeName'])
  if (node) nodes.add(`${root}\n${node}`)
  await Promise.all([
    wireNodes(b, nodes),
    wireDependencies(b, root, ns, o(pod.spec)),
    wireFront(b, root, ns, pod.metadata.labels ?? {}),
    wirePolicies(b, root, ns, pod.metadata.labels ?? {})
  ])
  return root
}

/** Workload cấp trên (không phải Job của CronJob) có pod template khớp `test`. */
async function workloadsWhere(
  b: Builder,
  ns: string,
  test: (spec: Obj, labels: Record<string, string>) => boolean
): Promise<{ kind: string; obj: K8sObject }[]> {
  const lists = await Promise.all(WORKLOAD_IDS.map((k) => b.items(k, ns)))
  const out: { kind: string; obj: K8sObject }[] = []
  WORKLOAD_IDS.forEach((k, i) => {
    for (const x of lists[i] ?? []) {
      if (
        k === 'jobs.batch' &&
        (x.metadata.ownerReferences ?? []).some((r) => r.kind === 'CronJob')
      )
        continue
      const tpl = podTemplate(k, x)
      if (tpl && test(tpl.spec, tpl.labels)) out.push({ kind: k, obj: x })
    }
  })
  return out
}

async function serviceGraph(b: Builder, svc: K8sObject): Promise<string> {
  const ns = svc.metadata.namespace ?? ''
  const root = b.add('services', svc)
  await wireServiceFront(b, ns, new Map([[svc.metadata.name, root]]))
  const selector = o(o(svc.spec)['selector'])
  if (!Object.keys(selector).length) {
    b.notes.add(t('This service has no selector — endpoints are managed manually'))
    return root
  }
  const ports = a(o(svc.spec)['ports'])
    .map((p) => `${txt(p['port'])}→${txt(p['targetPort']) || txt(p['port'])}`)
    .join(', ')
  const workloads = await workloadsWhere(b, ns, (_spec, labels) =>
    selectorMatches(selector, labels)
  )
  const pods = (await b.items('pods', ns)).filter((p) =>
    selectorMatches(selector, p.metadata.labels ?? {})
  )
  for (const w of workloads) {
    const wid = b.add(w.kind, w.obj)
    b.link(root, wid, 'selects', ports || undefined)
    const n = pods.filter((p) => topOwnerName(p) === w.obj.metadata.name).length
    const node = b.nodes.get(wid)
    if (node && n) node.summary = `${node.summary} · ${tn(n, '{n} endpoint', '{n} endpoints')}`
  }
  // Pod không thuộc workload nào ở trên (pod lẻ / owner lạ).
  const covered = new Set(workloads.map((w) => w.obj.metadata.name))
  const loose = pods.filter((p) => !covered.has(topOwnerName(p) ?? ''))
  for (const p of loose.slice(0, PODS_PER_OWNER))
    b.link(root, b.add('pods', p), 'selects', ports || undefined)
  if (loose.length > PODS_PER_OWNER)
    b.link(root, b.more(root, loose.length - PODS_PER_OWNER, 'Pods'), 'selects')
  if (!workloads.length && !pods.length)
    b.notes.add(t('No pods match the selector — the service has no endpoints'))
  return root
}

/** Tên workload gốc theo quy ước tên (ReplicaSet "<deploy>-<hash>"). */
function topOwnerName(p: K8sObject): string | null {
  const ref = (p.metadata.ownerReferences ?? []).find((r) => r.controller !== false)
  if (!ref) return null
  const hash = p.metadata.labels?.['pod-template-hash']
  if (ref.kind === 'ReplicaSet' && hash && ref.name.endsWith(`-${hash}`))
    return ref.name.slice(0, -hash.length - 1)
  if (ref.kind === 'Job') {
    // Job của CronJob: "<cronjob>-<số>".
    const m = /^(.*)-\d+$/.exec(ref.name)
    return m?.[1] ?? ref.name
  }
  return ref.name
}

/** Service phía sau (Ingress / Route) → workload chọn bởi service. */
async function wireBackends(
  b: Builder,
  from: string,
  ns: string,
  names: Iterable<string>
): Promise<void> {
  for (const name of names) {
    const { id: sid, obj: svc } = await b.ref('services', ns, name)
    b.link(from, sid, 'routes')
    if (!svc) continue
    const selector = o(o(svc.spec)['selector'])
    if (!Object.keys(selector).length) continue
    for (const w of await workloadsWhere(b, ns, (_s, labels) => selectorMatches(selector, labels)))
      b.link(sid, b.add(w.kind, w.obj), 'selects')
  }
}

/** ConfigMap / Secret / PVC / ServiceAccount: ai đang dùng. */
async function usersGraph(b: Builder, kind: string, obj: K8sObject): Promise<string> {
  const ns = obj.metadata.namespace ?? ''
  const name = obj.metadata.name
  const root = b.add(kind, obj)
  const test = (spec: Obj): boolean => {
    const r = podRefs(spec)
    if (kind === 'configmaps') return r.configMaps.has(name)
    if (kind === 'secrets') return r.secrets.has(name) || r.pullSecrets.has(name)
    if (kind === 'serviceaccounts') return (r.serviceAccount || 'default') === name
    return r.pvcs.has(name)
  }
  const edge: TopologyEdgeType =
    kind === 'persistentvolumeclaims' ? 'mounts' : kind === 'serviceaccounts' ? 'identity' : 'uses'
  const users = await workloadsWhere(b, ns, (spec) => test(spec))
  // StatefulSet tạo PVC từ volumeClaimTemplates.
  if (kind === 'persistentvolumeclaims')
    for (const w of await b.items('statefulsets.apps', ns))
      if (
        a(o(w.spec)['volumeClaimTemplates']).some((t) => {
          const prefix = `${s(o(t['metadata'])['name'])}-${w.metadata.name}-`
          return name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length))
        }) &&
        !users.some((u) => u.obj === w)
      )
        users.push({ kind: 'statefulsets.apps', obj: w })
  for (const u of users.slice(0, MAX_USERS)) b.link(b.add(u.kind, u.obj), root, edge)
  if (users.length > MAX_USERS)
    b.link(b.more(root, users.length - MAX_USERS, 'Workloads'), root, edge)
  const pods = await b.items('pods', ns)
  const bare = pods.filter((p) => !(p.metadata.ownerReferences ?? []).length && test(o(p.spec)))
  for (const p of bare.slice(0, MAX_USERS)) b.link(b.add('pods', p), root, edge)
  if (kind === 'persistentvolumeclaims') {
    const pvName = s(o(obj.spec)['volumeName'])
    if (pvName) {
      const pv = await b.get('persistentvolumes', undefined, pvName)
      b.link(
        root,
        pv
          ? b.add('persistentvolumes', pv, false)
          : b.missing('persistentvolumes', undefined, pvName),
        'bound'
      )
    }
    // Pod đang gắn volume → node (volume RWO bám theo node).
    const nodes = new Set<string>()
    for (const p of pods
      .filter((x) => podRefs(o(x.spec)).pvcs.has(name))
      .slice(0, PODS_PER_OWNER)) {
      const pid = b.add('pods', p)
      b.link(pid, root, 'mounts')
      const node = s(o(p.spec)['nodeName'])
      if (node) nodes.add(`${pid}\n${node}`)
    }
    await wireNodes(b, nodes)
  }
  if (kind === 'secrets')
    for (const ing of await b.items('ingresses.networking.k8s.io', ns))
      if (a(o(ing.spec)['tls']).some((t) => s(t['secretName']) === name))
        b.link(b.add('ingresses.networking.k8s.io', ing), root, 'uses', 'tls')
  if (kind === 'serviceaccounts') {
    for (const x of await bindingsOf(b, ns, name)) {
      const bid = b.add(x.kind, x.binding, false)
      b.link(root, bid, 'subject', 'bound by')
      const rid = x.role
        ? b.add(x.roleKind, x.role, false)
        : b.missing(
            x.roleKind,
            x.roleKind === 'roles.rbac.authorization.k8s.io' ? ns : undefined,
            x.roleName
          )
      b.link(bid, rid, 'grants')
    }
  }
  if (!users.length && !bare.length && kind !== 'serviceaccounts')
    b.notes.add(t('Nothing in this namespace uses it — safe to change'))
  return root
}

/** Node: workload có pod trên node (gộp theo workload) + pod lẻ. */
async function nodeGraph(b: Builder, node: K8sObject): Promise<string> {
  const root = b.add('nodes', node)
  const pods = await b.items('pods', undefined, {
    fieldSelector: `spec.nodeName=${node.metadata.name}`
  })
  const groups = new Map<string, { kind: string; ns: string; name: string; pods: K8sObject[] }>()
  const loose: K8sObject[] = []
  for (const p of pods) {
    const ref = (p.metadata.ownerReferences ?? []).find((r) => r.controller !== false)
    const owner = topOwnerName(p)
    if (!ref || !owner) {
      loose.push(p)
      continue
    }
    const kind =
      ref.kind === 'ReplicaSet' && owner !== ref.name
        ? 'deployments.apps'
        : ref.kind === 'Job' && owner !== ref.name
          ? 'cronjobs.batch'
          : (BY_KIND[ref.kind] ?? '')
    if (!kind) {
      loose.push(p)
      continue
    }
    const key = nodeId(kind, p.metadata.namespace, owner)
    const g = groups.get(key) ?? { kind, ns: p.metadata.namespace ?? '', name: owner, pods: [] }
    g.pods.push(p)
    groups.set(key, g)
  }
  const list = [...groups.values()].sort((x, y) => y.pods.length - x.pods.length)
  for (const g of list.slice(0, MAX_USERS)) {
    const id = nodeId(g.kind, g.ns, g.name)
    const tones = g.pods.map(podTone)
    b.nodes.set(id, {
      id,
      kind: g.kind,
      kindLabel: KIND_LABEL[g.kind] ?? KINDS[g.kind]?.label ?? g.kind,
      name: g.name,
      namespace: g.ns,
      summary: `${tn(g.pods.length, '{n} pod here', '{n} pods here')} · ${g.ns}`,
      tone: tones.includes('bad') ? 'bad' : tones.includes('warn') ? 'warn' : 'ok',
      expandable: true
    })
    b.link(id, root, 'runs-on', tn(g.pods.length, '{n} pod', '{n} pods'))
  }
  if (list.length > MAX_USERS)
    b.link(b.more(root, list.length - MAX_USERS, 'Workloads'), root, 'runs-on')
  for (const p of loose.slice(0, MAX_USERS)) b.link(b.add('pods', p), root, 'runs-on')
  return root
}

export async function topology(
  client: KubeClient,
  kind: string,
  obj: K8sObject,
  signal?: AbortSignal
): Promise<TopologyResult> {
  const b = new Builder(client, signal)
  let root: string
  switch (kind) {
    case 'pods':
      root = await podGraph(b, obj)
      break
    case 'deployments.apps':
    case 'statefulsets.apps':
    case 'daemonsets.apps':
    case 'replicasets.apps':
    case 'jobs.batch':
    case 'cronjobs.batch':
      root = await workloadGraph(b, kind, obj)
      break
    case 'services':
      root = await serviceGraph(b, obj)
      break
    case 'ingresses.networking.k8s.io': {
      root = b.add(kind, obj)
      const ns = obj.metadata.namespace ?? ''
      await wireBackends(b, root, ns, backendServices(obj))
      for (const t of a(o(obj.spec)['tls'])) {
        const name = s(t['secretName'])
        if (!name) continue
        b.link(root, (await b.ref('secrets', ns, name)).id, 'uses', 'tls')
      }
      break
    }
    case 'httproutes.gateway.networking.k8s.io':
    case 'grpcroutes.gateway.networking.k8s.io':
      root = b.add(kind, obj)
      await wireGateways(b, root, obj)
      await wireBackends(b, root, obj.metadata.namespace ?? '', routeBackends(obj))
      break
    case 'gateways.gateway.networking.k8s.io': {
      root = b.add(kind, obj)
      const ns = obj.metadata.namespace ?? ''
      for (const rk of [
        'httproutes.gateway.networking.k8s.io',
        'grpcroutes.gateway.networking.k8s.io'
      ])
        for (const r of await b.items(rk, ns))
          if (a(o(r.spec)['parentRefs']).some((p) => s(p['name']) === obj.metadata.name)) {
            const rid = b.add(rk, r)
            b.link(root, rid, 'attaches')
            await wireBackends(b, rid, ns, routeBackends(r))
          }
      b.notes.add(t('Only routes in the same namespace are shown'))
      break
    }
    case 'configmaps':
    case 'secrets':
    case 'persistentvolumeclaims':
    case 'serviceaccounts':
      root = await usersGraph(b, kind, obj)
      break
    case 'nodes':
      root = await nodeGraph(b, obj)
      break
    default:
      throw new Error(`No topology for ${kind}`)
  }
  // Gốc: không cần nút mở rộng.
  const r = b.nodes.get(root)
  if (r) delete r.expandable
  return b.result(root)
}
