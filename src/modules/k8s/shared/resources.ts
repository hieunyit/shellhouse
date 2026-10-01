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
  section: ResourceSection
}

/** Nhóm trên thanh điều hướng — như Rancher (Service Discovery, Storage, Policy…). */
export type ResourceSection =
  | 'Workloads'
  | 'Service Discovery'
  | 'Storage'
  | 'Policy'
  | 'Access Control'
  | 'Cluster'
  | 'Custom resources'

/** Nhóm API có sẵn của Kubernetes (không phải CRD — kể cả nhóm đuôi .k8s.io như Gateway API). */
export const BUILTIN_GROUPS = new Set([
  '',
  'apps',
  'batch',
  'autoscaling',
  'policy',
  'extensions',
  'events.k8s.io',
  'networking.k8s.io',
  'storage.k8s.io',
  'rbac.authorization.k8s.io',
  'admissionregistration.k8s.io',
  'apiextensions.k8s.io',
  'apiregistration.k8s.io',
  'authentication.k8s.io',
  'authorization.k8s.io',
  'certificates.k8s.io',
  'coordination.k8s.io',
  'discovery.k8s.io',
  'flowcontrol.apiserver.k8s.io',
  'node.k8s.io',
  'scheduling.k8s.io',
  'resource.k8s.io',
  'storagemigration.k8s.io',
  'internal.apiserver.k8s.io',
  'metrics.k8s.io'
])

/** Nhóm CRD có mục riêng trên thanh điều hướng (như Lens). */
export const CRD_SECTIONS: Record<string, string> = {
  'gateway.networking.k8s.io': 'Gateway API',
  'argoproj.io': 'Argo CD'
}

const k = (
  group: string,
  version: string,
  plural: string,
  kind: string,
  title: string,
  section: ResourceSection,
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
  k(
    'autoscaling',
    'v2',
    'horizontalpodautoscalers',
    'HorizontalPodAutoscaler',
    'HorizontalPodAutoscalers',
    'Service Discovery'
  ),
  k('networking.k8s.io', 'v1', 'ingresses', 'Ingress', 'Ingresses', 'Service Discovery'),
  k(
    'networking.k8s.io',
    'v1',
    'ingressclasses',
    'IngressClass',
    'IngressClasses',
    'Service Discovery',
    false
  ),
  k(
    'networking.k8s.io',
    'v1',
    'networkpolicies',
    'NetworkPolicy',
    'NetworkPolicies',
    'Service Discovery'
  ),
  k('', 'v1', 'services', 'Service', 'Services', 'Service Discovery'),
  k('', 'v1', 'persistentvolumes', 'PersistentVolume', 'PersistentVolumes', 'Storage', false),
  k('storage.k8s.io', 'v1', 'storageclasses', 'StorageClass', 'StorageClasses', 'Storage', false),
  k('', 'v1', 'configmaps', 'ConfigMap', 'ConfigMaps', 'Storage'),
  k(
    '',
    'v1',
    'persistentvolumeclaims',
    'PersistentVolumeClaim',
    'PersistentVolumeClaims',
    'Storage'
  ),
  k('', 'v1', 'secrets', 'Secret', 'Secrets', 'Storage'),
  k(
    'policy',
    'v1',
    'poddisruptionbudgets',
    'PodDisruptionBudget',
    'PodDisruptionBudgets',
    'Policy'
  ),
  k('', 'v1', 'resourcequotas', 'ResourceQuota', 'ResourceQuotas', 'Policy'),
  k('', 'v1', 'limitranges', 'LimitRange', 'LimitRanges', 'Policy'),
  k(
    'scheduling.k8s.io',
    'v1',
    'priorityclasses',
    'PriorityClass',
    'PriorityClasses',
    'Policy',
    false
  ),
  k(
    'admissionregistration.k8s.io',
    'v1',
    'validatingadmissionpolicies',
    'ValidatingAdmissionPolicy',
    'ValidatingAdmissionPolicies',
    'Policy',
    false
  ),
  k(
    'admissionregistration.k8s.io',
    'v1',
    'validatingwebhookconfigurations',
    'ValidatingWebhookConfiguration',
    'ValidatingWebhooks',
    'Policy',
    false
  ),
  k(
    'admissionregistration.k8s.io',
    'v1',
    'mutatingwebhookconfigurations',
    'MutatingWebhookConfiguration',
    'MutatingWebhooks',
    'Policy',
    false
  ),
  k('', 'v1', 'serviceaccounts', 'ServiceAccount', 'ServiceAccounts', 'Access Control'),
  k('rbac.authorization.k8s.io', 'v1', 'roles', 'Role', 'Roles', 'Access Control'),
  k(
    'rbac.authorization.k8s.io',
    'v1',
    'rolebindings',
    'RoleBinding',
    'RoleBindings',
    'Access Control'
  ),
  k(
    'rbac.authorization.k8s.io',
    'v1',
    'clusterroles',
    'ClusterRole',
    'ClusterRoles',
    'Access Control',
    false
  ),
  k(
    'rbac.authorization.k8s.io',
    'v1',
    'clusterrolebindings',
    'ClusterRoleBinding',
    'ClusterRoleBindings',
    'Access Control',
    false
  ),
  k('', 'v1', 'nodes', 'Node', 'Nodes', 'Cluster', false),
  k('', 'v1', 'namespaces', 'Namespace', 'Namespaces', 'Cluster', false),
  k('', 'v1', 'events', 'Event', 'Events', 'Cluster')
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
    ownerReferences?: { kind: string; name: string; controller?: boolean }[]
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
  'horizontalpodautoscalers.autoscaling': [
    { id: 'reference', label: 'Reference' },
    { id: 'targets', label: 'Targets' },
    { id: 'minmax', label: 'Min / max' },
    { id: 'replicas', label: 'Replicas' }
  ],
  'ingressclasses.networking.k8s.io': [
    { id: 'controller', label: 'Controller' },
    { id: 'default', label: 'Default' }
  ],
  'networkpolicies.networking.k8s.io': [
    { id: 'podSelector', label: 'Pod selector' },
    { id: 'policyTypes', label: 'Policy types' }
  ],
  persistentvolumes: [
    { id: 'status', label: 'Status' },
    { id: 'capacity', label: 'Capacity' },
    { id: 'claim', label: 'Claim' },
    { id: 'storageClass', label: 'Storage class' },
    { id: 'reclaim', label: 'Reclaim' }
  ],
  'storageclasses.storage.k8s.io': [
    { id: 'provisioner', label: 'Provisioner' },
    { id: 'reclaim', label: 'Reclaim' },
    { id: 'default', label: 'Default' }
  ],
  'poddisruptionbudgets.policy': [
    { id: 'minmax', label: 'Min available / max unavailable' },
    { id: 'disruptions', label: 'Allowed disruptions' }
  ],
  resourcequotas: [{ id: 'usage', label: 'Usage' }],
  limitranges: [{ id: 'types', label: 'Types' }],
  'priorityclasses.scheduling.k8s.io': [
    { id: 'value', label: 'Value' },
    { id: 'default', label: 'Global default' }
  ],
  'validatingadmissionpolicies.admissionregistration.k8s.io': [
    { id: 'validations', label: 'Validations' },
    { id: 'failurePolicy', label: 'Failure policy' }
  ],
  'validatingwebhookconfigurations.admissionregistration.k8s.io': [
    { id: 'webhooks', label: 'Webhooks' }
  ],
  'mutatingwebhookconfigurations.admissionregistration.k8s.io': [
    { id: 'webhooks', label: 'Webhooks' }
  ],
  'roles.rbac.authorization.k8s.io': [{ id: 'rules', label: 'Rules' }],
  'clusterroles.rbac.authorization.k8s.io': [{ id: 'rules', label: 'Rules' }],
  'rolebindings.rbac.authorization.k8s.io': [
    { id: 'role', label: 'Role' },
    { id: 'subjects', label: 'Subjects' }
  ],
  'clusterrolebindings.rbac.authorization.k8s.io': [
    { id: 'role', label: 'Role' },
    { id: 'subjects', label: 'Subjects' }
  ],
  // Argo CD (CRD)
  'applications.argoproj.io': [
    { id: 'project', label: 'Project' },
    { id: 'sync', label: 'Sync' },
    { id: 'health', label: 'Health' },
    { id: 'repo', label: 'Source' }
  ],
  'applicationsets.argoproj.io': [{ id: 'generators', label: 'Generators' }],
  'appprojects.argoproj.io': [{ id: 'destinations', label: 'Destinations' }],
  // Gateway API (CRD)
  'gatewayclasses.gateway.networking.k8s.io': [
    { id: 'controller', label: 'Controller' },
    { id: 'status', label: 'Accepted' }
  ],
  'gateways.gateway.networking.k8s.io': [
    { id: 'class', label: 'Class' },
    { id: 'address', label: 'Address' },
    { id: 'status', label: 'Programmed' }
  ],
  'httproutes.gateway.networking.k8s.io': [
    { id: 'hosts', label: 'Hostnames' },
    { id: 'parents', label: 'Gateways' }
  ],
  'grpcroutes.gateway.networking.k8s.io': [
    { id: 'hosts', label: 'Hostnames' },
    { id: 'parents', label: 'Gateways' }
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
    case 'horizontalpodautoscalers.autoscaling': {
      const ref = obj(spec['scaleTargetRef'])
      cells['reference'] = `${str(ref['kind'])}/${str(ref['name'])}`
      cells['targets'] = arr(status['currentMetrics'])
        .map((m) => {
          const r = obj(m['resource'])
          const cur = obj(r['current'])
          const target = arr(spec['metrics']).find(
            (x) => str(obj(x['resource'])['name']) === str(r['name'])
          )
          const want = str(obj(obj(target?.['resource'])['target'])['averageUtilization'])
          const have = str(cur['averageUtilization'])
          return r['name'] ? `${str(r['name'])} ${have || '?'}%/${want || '?'}%` : ''
        })
        .filter(Boolean)
        .join(', ')
      cells['minmax'] = `${str(spec['minReplicas']) || '1'}–${str(spec['maxReplicas'])}`
      cells['replicas'] = str(status['currentReplicas'])
      tone = num(status['currentReplicas']) >= num(spec['maxReplicas']) ? 'warn' : 'ok'
      break
    }
    case 'ingressclasses.networking.k8s.io':
    case 'storageclasses.storage.k8s.io': {
      const anns = o.metadata.annotations ?? {}
      cells['controller'] = str(spec['controller'])
      cells['provisioner'] = str(o['provisioner'])
      cells['reclaim'] = str(o['reclaimPolicy'])
      cells['default'] =
        anns['ingressclass.kubernetes.io/is-default-class'] === 'true' ||
        anns['storageclass.kubernetes.io/is-default-class'] === 'true'
          ? 'Yes'
          : ''
      break
    }
    case 'networkpolicies.networking.k8s.io': {
      const sel = obj(obj(spec['podSelector'])['matchLabels'])
      cells['podSelector'] =
        Object.entries(sel)
          .map(([k, v]) => `${k}=${str(v)}`)
          .join(', ') || 'all pods'
      cells['policyTypes'] = (Array.isArray(spec['policyTypes']) ? spec['policyTypes'] : [])
        .map(str)
        .join(', ')
      break
    }
    case 'persistentvolumes': {
      const ref = obj(spec['claimRef'])
      cells['status'] = str(status['phase'])
      cells['capacity'] = str(obj(spec['capacity'])['storage'])
      cells['claim'] = ref['name'] ? `${str(ref['namespace'])}/${str(ref['name'])}` : ''
      cells['storageClass'] = str(spec['storageClassName'])
      cells['reclaim'] = str(spec['persistentVolumeReclaimPolicy'])
      tone =
        str(status['phase']) === 'Bound'
          ? 'ok'
          : str(status['phase']) === 'Failed'
            ? 'bad'
            : 'muted'
      break
    }
    case 'poddisruptionbudgets.policy':
      cells['minmax'] =
        spec['minAvailable'] !== undefined
          ? `min ${str(spec['minAvailable'])}`
          : `max ${str(spec['maxUnavailable'])}`
      cells['disruptions'] = str(status['disruptionsAllowed'])
      tone = num(status['disruptionsAllowed']) === 0 ? 'warn' : 'ok'
      break
    case 'resourcequotas': {
      const hard = obj(status['hard'])
      const used = obj(status['used'])
      const full = Object.keys(hard).filter((k) => str(used[k]) === str(hard[k]))
      cells['usage'] = Object.keys(hard)
        .slice(0, 3)
        .map((k) => `${k} ${str(used[k]) || '0'}/${str(hard[k])}`)
        .join(', ')
      tone = full.length ? 'warn' : 'ok'
      break
    }
    case 'limitranges':
      cells['types'] = arr(spec['limits'])
        .map((l) => str(l['type']))
        .join(', ')
      break
    case 'priorityclasses.scheduling.k8s.io':
      cells['value'] = str(o['value'])
      cells['default'] = o['globalDefault'] === true ? 'Yes' : ''
      break
    case 'validatingadmissionpolicies.admissionregistration.k8s.io':
      cells['validations'] = String(arr(spec['validations']).length)
      cells['failurePolicy'] = str(spec['failurePolicy']) || 'Fail'
      break
    case 'validatingwebhookconfigurations.admissionregistration.k8s.io':
    case 'mutatingwebhookconfigurations.admissionregistration.k8s.io':
      cells['webhooks'] = arr(o['webhooks'])
        .map((w) => str(w['name']))
        .join(', ')
      break
    case 'roles.rbac.authorization.k8s.io':
    case 'clusterroles.rbac.authorization.k8s.io':
      cells['rules'] = String(arr(o['rules']).length)
      break
    case 'rolebindings.rbac.authorization.k8s.io':
    case 'clusterrolebindings.rbac.authorization.k8s.io': {
      const ref = obj(o['roleRef'])
      cells['role'] = `${str(ref['kind'])}/${str(ref['name'])}`
      cells['subjects'] = arr(o['subjects'])
        .map((x) => `${str(x['kind'])}:${str(x['name'])}`)
        .join(', ')
      break
    }
    case 'applications.argoproj.io': {
      const src = obj(spec['source'])
      const sync = str(obj(status['sync'])['status']) || 'Unknown'
      const health = str(obj(status['health'])['status']) || 'Unknown'
      cells['project'] = str(spec['project'])
      cells['sync'] = sync
      cells['health'] = health
      cells['status'] = health
      cells['repo'] = [
        str(src['repoURL']).replace(/^https?:\/\//, ''),
        str(src['path'] || src['chart'])
      ]
        .filter(Boolean)
        .join(' · ')
      tone =
        health === 'Degraded' || health === 'Missing'
          ? 'bad'
          : health === 'Progressing' || sync === 'OutOfSync'
            ? 'warn'
            : health === 'Healthy'
              ? 'ok'
              : 'muted'
      break
    }
    case 'applicationsets.argoproj.io':
      cells['generators'] = arr(spec['generators'])
        .map((g) => Object.keys(g)[0] ?? '')
        .join(', ')
      break
    case 'appprojects.argoproj.io':
      cells['destinations'] = arr(spec['destinations'])
        .map((d) => `${str(d['server'] || d['name'])}/${str(d['namespace'])}`)
        .join(', ')
      break
    case 'gatewayclasses.gateway.networking.k8s.io':
    case 'gateways.gateway.networking.k8s.io': {
      const want = kindId.startsWith('gatewayclasses') ? 'Accepted' : 'Programmed'
      const cond = arr(status['conditions']).find((c) => c['type'] === want)
      cells['controller'] = str(spec['controllerName'])
      cells['class'] = str(spec['gatewayClassName'])
      cells['address'] = arr(status['addresses'])
        .map((a) => str(a['value']))
        .join(', ')
      cells['status'] = cond ? str(cond['status']) : 'Unknown'
      tone = cond?.['status'] === 'True' ? 'ok' : cond ? 'bad' : 'muted'
      break
    }
    case 'httproutes.gateway.networking.k8s.io':
    case 'grpcroutes.gateway.networking.k8s.io':
      cells['hosts'] = (Array.isArray(spec['hostnames']) ? spec['hostnames'] : [])
        .map(str)
        .join(', ')
      cells['parents'] = arr(spec['parentRefs'])
        .map((p) => str(p['name']))
        .join(', ')
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

// ——— Quantity (CPU / bộ nhớ) ———

/** "250m" / "1" / "1500000n" / "2u" → millicore. */
export function parseCpu(q: unknown): number {
  const s = typeof q === 'number' ? String(q) : typeof q === 'string' ? q.trim() : ''
  const m = /^([\d.]+)([numk]?)$/.exec(s)
  if (!m) return 0
  const n = Number(m[1])
  switch (m[2]) {
    case 'n':
      return n / 1e6
    case 'u':
      return n / 1e3
    case 'm':
      return n
    case 'k':
      return n * 1e6
    default:
      return n * 1000
  }
}

const MEM_UNITS: Record<string, number> = {
  '': 1,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  m: 1e-3
}

/** "128Mi" / "1G" / "123456" / "1e3" → byte. */
export function parseMemory(q: unknown): number {
  const s = typeof q === 'number' ? String(q) : typeof q === 'string' ? q.trim() : ''
  const m = /^([\d.]+(?:e[+-]?\d+)?)([a-zA-Z]*)$/.exec(s)
  if (!m) return 0
  const unit = MEM_UNITS[m[2] ?? '']
  return unit === undefined ? 0 : Number(m[1]) * unit
}

export function formatCpu(milli: number): string {
  if (milli >= 1000) return (milli / 1000).toFixed(milli >= 10_000 ? 0 : 2).replace(/\.?0+$/, '')
  return `${Math.round(milli)}m`
}

export function formatMemory(bytes: number): string {
  const units = ['B', 'Ki', 'Mi', 'Gi', 'Ti']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : Number(v.toFixed(1))}${units[i] ?? ''}`
}

/** Tổng requests (CPU, RAM) của các container trong một pod. */
export function podRequests(o: K8sObject): { cpu: number; memory: number } {
  const containers =
    (o.spec?.['containers'] as
      { resources?: { requests?: Record<string, unknown> } }[] | undefined) ?? []
  let cpu = 0
  let memory = 0
  for (const c of containers) {
    cpu += parseCpu(c.resources?.requests?.['cpu'])
    memory += parseMemory(c.resources?.requests?.['memory'])
  }
  return { cpu, memory }
}

/** matchLabels của selector → chuỗi labelSelector ("a=b,c=d"); null nếu không có. */
export function selectorString(selector: unknown): string | null {
  const s = selector as
    | {
        matchLabels?: Record<string, string>
        matchExpressions?: { key: string; operator: string; values?: string[] }[]
      }
    | Record<string, string>
    | undefined
  if (!s || typeof s !== 'object') return null
  const labels =
    'matchLabels' in s || 'matchExpressions' in s
      ? ((s as { matchLabels?: Record<string, string> }).matchLabels ?? {})
      : (s as Record<string, string>)
  const parts = Object.entries(labels).map(([k, v]) => `${k}=${v}`)
  const exprs =
    (s as { matchExpressions?: { key: string; operator: string; values?: string[] }[] })
      .matchExpressions ?? []
  for (const e of exprs) {
    if (e.operator === 'In') parts.push(`${e.key} in (${(e.values ?? []).join(',')})`)
    else if (e.operator === 'NotIn') parts.push(`${e.key} notin (${(e.values ?? []).join(',')})`)
    else if (e.operator === 'Exists') parts.push(e.key)
    else if (e.operator === 'DoesNotExist') parts.push(`!${e.key}`)
  }
  return parts.length ? parts.join(',') : null
}
