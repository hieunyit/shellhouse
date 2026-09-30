/**
 * Loại tài nguyên Kubernetes có bảng riêng (ADR-014 mục 7.4) và cách chuyển đối tượng → dòng bảng.
 * Thuần (không phụ thuộc tiến trình) — Session Host, renderer và test dùng chung.
 */

export interface ResourceKind {
  /** Tên như kubectl: "pods", "deployments.apps", "ingresses.networking.k8s.io". */
  id: string
  group: string
  version: string
  plural: string
  kind: string
  namespaced: boolean
  title: string
  /** Nhóm trên thanh điều hướng. */
  section: 'Workloads' | 'Network' | 'Config' | 'Storage' | 'Cluster' | 'Custom resources'
}

const k = (
  group: string,
  version: string,
  plural: string,
  kind: string,
  title: string,
  section: ResourceKind['section'],
  namespaced = true
): ResourceKind => ({
  id: group ? `${plural}.${group}` : plural,
  group,
  version,
  plural,
  kind,
  namespaced,
  title,
  section
})

export const BUILTIN_KINDS: readonly ResourceKind[] = [
  k('', 'v1', 'pods', 'Pod', 'Pods', 'Workloads'),
  k('apps', 'v1', 'deployments', 'Deployment', 'Deployments', 'Workloads'),
  k('apps', 'v1', 'statefulsets', 'StatefulSet', 'StatefulSets', 'Workloads'),
  k('apps', 'v1', 'daemonsets', 'DaemonSet', 'DaemonSets', 'Workloads'),
  k('apps', 'v1', 'replicasets', 'ReplicaSet', 'ReplicaSets', 'Workloads'),
  k('batch', 'v1', 'jobs', 'Job', 'Jobs', 'Workloads'),
  k('batch', 'v1', 'cronjobs', 'CronJob', 'CronJobs', 'Workloads'),
  k('', 'v1', 'services', 'Service', 'Services', 'Network'),
  k('networking.k8s.io', 'v1', 'ingresses', 'Ingress', 'Ingresses', 'Network'),
  k('', 'v1', 'configmaps', 'ConfigMap', 'ConfigMaps', 'Config'),
  k('', 'v1', 'secrets', 'Secret', 'Secrets', 'Config'),
  k('', 'v1', 'persistentvolumeclaims', 'PersistentVolumeClaim', 'PVCs', 'Storage'),
  k('', 'v1', 'nodes', 'Node', 'Nodes', 'Cluster', false),
  k('', 'v1', 'events', 'Event', 'Events', 'Cluster'),
  k('', 'v1', 'namespaces', 'Namespace', 'Namespaces', 'Cluster', false)
]

export function builtinKind(id: string): ResourceKind | undefined {
  return BUILTIN_KINDS.find((x) => x.id === id)
}

/** Đường dẫn API của một loại (và một đối tượng / subresource nếu có). */
export function resourcePath(
  kind: Pick<ResourceKind, 'group' | 'version' | 'plural' | 'namespaced'>,
  namespace?: string,
  name?: string,
  sub?: string
): string {
  const base = kind.group ? `/apis/${kind.group}/${kind.version}` : `/api/${kind.version}`
  const ns = kind.namespaced && namespace ? `/namespaces/${encodeURIComponent(namespace)}` : ''
  const obj = name ? `/${encodeURIComponent(name)}` : ''
  return `${base}${ns}/${kind.plural}${obj}${sub ? `/${sub}` : ''}`
}

// ——— Đối tượng → dòng ———

export interface K8sObject {
  apiVersion?: string
  kind?: string
  metadata: {
    name: string
    namespace?: string
    uid?: string
    resourceVersion?: string
    creationTimestamp?: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
    ownerReferences?: { kind: string; name: string }[]
    deletionTimestamp?: string
  }
  spec?: Record<string, unknown>
  status?: Record<string, unknown>
  data?: Record<string, string>
  [key: string]: unknown
}

export interface ResourceRow {
  /** namespace/name (khoá duy nhất trong bảng). */
  key: string
  name: string
  namespace: string
  /** Ô theo cột (chuỗi đã định dạng). */
  cells: Record<string, string>
  /** Tô màu trạng thái. */
  tone: 'ok' | 'warn' | 'bad' | 'muted'
  created: number
}

export interface Column {
  id: string
  label: string
}

/** Cột theo loại; loại khác (CRD) chỉ có tên / namespace / tuổi. */
export const COLUMNS: Record<string, Column[]> = {
  pods: [
    { id: 'ready', label: 'Ready' },
    { id: 'status', label: 'Status' },
    { id: 'restarts', label: 'Restarts' },
    { id: 'node', label: 'Node' }
  ],
  'deployments.apps': [
    { id: 'ready', label: 'Ready' },
    { id: 'upToDate', label: 'Up to date' },
    { id: 'available', label: 'Available' }
  ],
  'statefulsets.apps': [{ id: 'ready', label: 'Ready' }],
  'daemonsets.apps': [
    { id: 'desired', label: 'Desired' },
    { id: 'ready', label: 'Ready' }
  ],
  'replicasets.apps': [
    { id: 'desired', label: 'Desired' },
    { id: 'ready', label: 'Ready' },
    { id: 'owner', label: 'Owner' }
  ],
  'jobs.batch': [
    { id: 'completions', label: 'Completions' },
    { id: 'status', label: 'Status' }
  ],
  'cronjobs.batch': [
    { id: 'schedule', label: 'Schedule' },
    { id: 'suspend', label: 'Suspend' },
    { id: 'last', label: 'Last run' }
  ],
  services: [
    { id: 'type', label: 'Type' },
    { id: 'clusterIP', label: 'Cluster IP' },
    { id: 'ports', label: 'Ports' }
  ],
  'ingresses.networking.k8s.io': [
    { id: 'hosts', label: 'Hosts' },
    { id: 'address', label: 'Address' }
  ],
  configmaps: [{ id: 'keys', label: 'Keys' }],
  secrets: [
    { id: 'type', label: 'Type' },
    { id: 'keys', label: 'Keys' }
  ],
  persistentvolumeclaims: [
    { id: 'status', label: 'Status' },
    { id: 'capacity', label: 'Capacity' },
    { id: 'storageClass', label: 'Storage class' }
  ],
  nodes: [
    { id: 'status', label: 'Status' },
    { id: 'roles', label: 'Roles' },
    { id: 'version', label: 'Version' }
  ],
  events: [
    { id: 'type', label: 'Type' },
    { id: 'reason', label: 'Reason' },
    { id: 'object', label: 'Object' },
    { id: 'message', label: 'Message' }
  ],
  namespaces: [{ id: 'status', label: 'Status' }]
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null ? (v as Obj) : {})
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]).map(obj) : [])
const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
const str = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''

/** Trạng thái pod như `kubectl get pods` (CrashLoopBackOff, Terminating, Completed…). */
export function podStatus(o: K8sObject): { text: string; tone: ResourceRow['tone'] } {
  if (o.metadata.deletionTimestamp) return { text: 'Terminating', tone: 'warn' }
  const status = obj(o.status)
  let reason = str(status['reason']) || str(status['phase']) || 'Unknown'
  for (const c of arr(status['initContainerStatuses'])) {
    const state = obj(c['state'])
    const waiting = obj(state['waiting'])
    const term = obj(state['terminated'])
    if (str(waiting['reason'])) reason = `Init:${str(waiting['reason'])}`
    else if (Object.keys(term).length && num(term['exitCode']) !== 0) reason = `Init:Error`
  }
  for (const c of arr(status['containerStatuses'])) {
    const state = obj(c['state'])
    const waiting = obj(state['waiting'])
    const term = obj(state['terminated'])
    if (str(waiting['reason'])) reason = str(waiting['reason'])
    else if (str(term['reason']) && reason !== 'Running') reason = str(term['reason'])
  }
  const tone: ResourceRow['tone'] =
    reason === 'Running'
      ? 'ok'
      : reason === 'Succeeded' || reason === 'Completed'
        ? 'muted'
        : /Pending|ContainerCreating|PodInitializing|Init:/.test(reason)
          ? 'warn'
          : 'bad'
  return { text: reason, tone }
}

export function age(created: number, now = Date.now()): string {
  if (!created) return ''
  const s = Math.max(0, Math.floor((now - created) / 1000))
  if (s < 120) return `${s}s`
  if (s < 7200) return `${Math.floor(s / 60)}m`
  if (s < 172_800) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

export function toRow(kindId: string, o: K8sObject): ResourceRow {
  const spec = obj(o.spec)
  const status = obj(o.status)
  const name = o.metadata.name
  const namespace = o.metadata.namespace ?? ''
  const created = Date.parse(o.metadata.creationTimestamp ?? '') || 0
  const cells: Record<string, string> = {}
  let tone: ResourceRow['tone'] = 'ok'
  switch (kindId) {
    case 'pods': {
      const statuses = arr(status['containerStatuses'])
      const total = arr(spec['containers']).length
      const ready = statuses.filter((c) => c['ready'] === true).length
      const s = podStatus(o)
      cells['ready'] = `${ready}/${total}`
      cells['status'] = s.text
      cells['restarts'] = String(statuses.reduce((n, c) => n + num(c['restartCount']), 0))
      cells['node'] = str(spec['nodeName'])
      tone = s.tone
      break
    }
    case 'deployments.apps':
    case 'statefulsets.apps': {
      const want = num(spec['replicas'])
      const ready = num(status['readyReplicas'])
      cells['ready'] = `${ready}/${want}`
      cells['upToDate'] = String(num(status['updatedReplicas']))
      cells['available'] = String(num(status['availableReplicas']))
      tone = ready >= want ? 'ok' : 'warn'
      break
    }
    case 'daemonsets.apps': {
      const want = num(status['desiredNumberScheduled'])
      const ready = num(status['numberReady'])
      cells['desired'] = String(want)
      cells['ready'] = String(ready)
      tone = ready >= want ? 'ok' : 'warn'
      break
    }
    case 'replicasets.apps': {
      cells['desired'] = String(num(spec['replicas']))
      cells['ready'] = String(num(status['readyReplicas']))
      cells['owner'] = o.metadata.ownerReferences?.[0]?.name ?? ''
      tone = num(spec['replicas']) === 0 ? 'muted' : 'ok'
      break
    }
    case 'jobs.batch': {
      const want = num(spec['completions']) || 1
      const done = num(status['succeeded'])
      const failed = num(status['failed'])
      cells['completions'] = `${done}/${want}`
      cells['status'] = done >= want ? 'Complete' : failed > 0 ? 'Failed' : 'Running'
      tone = done >= want ? 'muted' : failed > 0 ? 'bad' : 'warn'
      break
    }
    case 'cronjobs.batch':
      cells['schedule'] = str(spec['schedule'])
      cells['suspend'] = spec['suspend'] === true ? 'Yes' : 'No'
      cells['last'] = status['lastScheduleTime']
        ? age(Date.parse(str(status['lastScheduleTime'])))
        : '—'
      tone = spec['suspend'] === true ? 'muted' : 'ok'
      break
    case 'services':
      cells['type'] = str(spec['type'])
      cells['clusterIP'] = str(spec['clusterIP'])
      cells['ports'] = arr(spec['ports'])
        .map(
          (p) =>
            `${str(p['port'])}${p['nodePort'] ? `:${str(p['nodePort'])}` : ''}/${str(p['protocol']) || 'TCP'}`
        )
        .join(', ')
      break
    case 'ingresses.networking.k8s.io':
      cells['hosts'] = arr(spec['rules'])
        .map((r) => str(r['host']))
        .filter(Boolean)
        .join(', ')
      cells['address'] = arr(obj(obj(status['loadBalancer']))['ingress'])
        .map((i) => str(i['ip']) || str(i['hostname']))
        .join(', ')
      break
    case 'configmaps':
      cells['keys'] = String(
        Object.keys(obj(o['data'])).length + Object.keys(obj(o['binaryData'])).length
      )
      break
    case 'secrets':
      cells['type'] = str(o['type'])
      cells['keys'] = String(Object.keys(obj(o.data)).length)
      break
    case 'persistentvolumeclaims':
      cells['status'] = str(status['phase'])
      cells['capacity'] = str(obj(status['capacity'])['storage'])
      cells['storageClass'] = str(spec['storageClassName'])
      tone = str(status['phase']) === 'Bound' ? 'ok' : 'warn'
      break
    case 'nodes': {
      const readyCond = arr(status['conditions']).find((c) => c['type'] === 'Ready')
      const ready = readyCond?.['status'] === 'True'
      cells['status'] =
        `${ready ? 'Ready' : 'NotReady'}${spec['unschedulable'] === true ? ',SchedulingDisabled' : ''}`
      cells['roles'] =
        Object.keys(o.metadata.labels ?? {})
          .filter((l) => l.startsWith('node-role.kubernetes.io/'))
          .map((l) => l.slice('node-role.kubernetes.io/'.length))
          .join(',') || '<none>'
      cells['version'] = str(obj(status['nodeInfo'])['kubeletVersion'])
      tone = ready ? 'ok' : 'bad'
      break
    }
    case 'events': {
      const involved = obj(o['involvedObject'])
      cells['type'] = str(o['type'])
      cells['reason'] = str(o['reason'])
      cells['object'] = `${str(involved['kind']).toLowerCase()}/${str(involved['name'])}`
      cells['message'] = str(o['message'])
      tone = str(o['type']) === 'Warning' ? 'warn' : 'muted'
      break
    }
    case 'namespaces':
      cells['status'] = str(status['phase'])
      tone = str(status['phase']) === 'Active' ? 'ok' : 'warn'
      break
  }
  cells['age'] = age(created)
  return { key: namespace ? `${namespace}/${name}` : name, name, namespace, cells, tone, created }
}

/** Bỏ trường nặng không cần hiện (managedFields, last-applied) — gửi ít dữ liệu hơn. */
export function slim<T extends K8sObject>(o: T): T {
  const metadata = { ...o.metadata } as K8sObject['metadata'] & { managedFields?: unknown }
  delete metadata.managedFields
  if (metadata.annotations?.['kubectl.kubernetes.io/last-applied-configuration']) {
    const annotations = { ...metadata.annotations }
    delete annotations['kubectl.kubernetes.io/last-applied-configuration']
    metadata.annotations = annotations
  }
  return { ...o, metadata }
}

/** Secret trong danh sách: giữ tên khoá, bỏ giá trị (bấm mới hiện — không lưu đĩa). */
export function hideSecretValues(o: K8sObject): K8sObject {
  if (!o.data && !o['stringData']) return o
  const keys = [...Object.keys(o.data ?? {}), ...Object.keys(obj(o['stringData']))]
  const rest: K8sObject = { ...o }
  delete rest['stringData']
  return { ...rest, data: Object.fromEntries(keys.map((key) => [key, ''])) }
}
