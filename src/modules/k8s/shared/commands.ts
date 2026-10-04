import type { ContextRef } from './ops'

/**
 * "Copy as command" (thiết kế v0.7): lệnh kubectl tương đương cho một tài nguyên / một bộ lọc —
 * đúng context, namespace, kubeconfig. Hàm thuần (test được, không phụ thuộc giao diện).
 */
export interface KubectlLine {
  /** Khoá nhãn (giao diện dịch): get, describe, logs… */
  id: string
  command: string
}

/** Trích dẫn cho shell POSIX khi cần (tên có ký tự lạ). */
export function q(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

/** Cờ chọn cluster: --context, và --kubeconfig khi context nằm trong file khác ~/.kube/config. */
export function contextFlags(ref: ContextRef): string {
  const flags = [`--context ${q(ref.context)}`]
  if (ref.source.startsWith('file:')) {
    const path = ref.source.slice('file:'.length)
    if (!/[\\/]\.kube[\\/]config$/.test(path)) flags.push(`--kubeconfig ${q(path)}`)
  }
  return flags.join(' ')
}

/** Tên tài nguyên cho kubectl: loại có sẵn bỏ nhóm API ("deployments.apps" → "deployment"). */
export function kubectlResource(kindId: string): string {
  const known: Record<string, string> = {
    pods: 'pod',
    services: 'service',
    'deployments.apps': 'deployment',
    'statefulsets.apps': 'statefulset',
    'daemonsets.apps': 'daemonset',
    'replicasets.apps': 'replicaset',
    'jobs.batch': 'job',
    'cronjobs.batch': 'cronjob',
    configmaps: 'configmap',
    secrets: 'secret',
    nodes: 'node',
    namespaces: 'namespace',
    persistentvolumeclaims: 'pvc',
    persistentvolumes: 'pv',
    'ingresses.networking.k8s.io': 'ingress',
    serviceaccounts: 'serviceaccount',
    events: 'event'
  }
  return known[kindId] ?? kindId
}

const WORKLOADS = new Set(['deployments.apps', 'statefulsets.apps', 'daemonsets.apps'])
const SCALABLE = new Set(['deployments.apps', 'statefulsets.apps', 'replicasets.apps'])

/** Lệnh cho MỘT tài nguyên. `namespace` undefined = tài nguyên cấp cluster (node, namespace…). */
export function resourceCommands(input: {
  ref: ContextRef
  kindId: string
  name: string
  namespace?: string | undefined
  containers?: readonly string[]
  replicas?: number | undefined
}): KubectlLine[] {
  const res = kubectlResource(input.kindId)
  const ns = input.namespace ? ` -n ${q(input.namespace)}` : ''
  const tail = `${ns} ${contextFlags(input.ref)}`
  const target = `${res} ${q(input.name)}`
  const out: KubectlLine[] = [
    { id: 'get', command: `kubectl get ${target}${tail} -o yaml` },
    { id: 'describe', command: `kubectl describe ${target}${tail}` }
  ]
  if (input.kindId === 'pods') {
    const containers = input.containers ?? []
    const container = containers.length > 1 ? ` -c ${q(containers[0] ?? '')}` : ''
    out.push(
      { id: 'logs', command: `kubectl logs ${q(input.name)}${container}${tail} -f` },
      {
        id: 'logs-previous',
        command: `kubectl logs ${q(input.name)}${container}${tail} --previous`
      },
      { id: 'exec', command: `kubectl exec -it ${q(input.name)}${container}${tail} -- sh` }
    )
  }
  if (WORKLOADS.has(input.kindId)) {
    out.push(
      { id: 'logs', command: `kubectl logs ${res}/${q(input.name)}${tail} --all-containers -f` },
      { id: 'rollout-status', command: `kubectl rollout status ${res}/${q(input.name)}${tail}` },
      { id: 'restart', command: `kubectl rollout restart ${res}/${q(input.name)}${tail}` }
    )
  }
  if (SCALABLE.has(input.kindId))
    out.push({
      id: 'scale',
      command: `kubectl scale ${res}/${q(input.name)}${tail} --replicas=${String(input.replicas ?? 1)}`
    })
  if (input.kindId === 'nodes')
    out.push(
      { id: 'cordon', command: `kubectl cordon ${q(input.name)} ${contextFlags(input.ref)}` },
      {
        id: 'drain',
        command: `kubectl drain ${q(input.name)} ${contextFlags(input.ref)} --ignore-daemonsets --delete-emptydir-data`
      }
    )
  out.push({ id: 'delete', command: `kubectl delete ${target}${tail}` })
  return out
}

/**
 * `kubectl get` cho danh sách đang xem (theo bộ lọc): mỗi namespace một lệnh; label selector giữ
 * nguyên; lọc "failing" không có field-selector tương đương (CrashLoop vẫn là phase Running) → nối
 * `grep -v` theo cột STATUS.
 */
export function listCommands(input: {
  ref: ContextRef
  kindId: string
  namespaces: readonly string[] | null
  selector?: string | undefined
  failing?: boolean
}): string[] {
  const res = kubectlResource(input.kindId)
  const selector = input.selector ? ` -l ${q(input.selector)}` : ''
  const grep = input.failing && input.kindId === 'pods' ? ` | grep -vE 'Running|Completed'` : ''
  const flags = contextFlags(input.ref)
  if (!input.namespaces || input.namespaces.length === 0)
    return [`kubectl get ${res}${selector} -A ${flags}${grep}`]
  return input.namespaces.map((ns) => `kubectl get ${res}${selector} -n ${q(ns)} ${flags}${grep}`)
}

/**
 * Log nhiều pod (trang Logs / thanh hàng loạt): theo selector thì một lệnh (--prefix ghi tên pod
 * ở đầu dòng); danh sách pod rời thì mỗi pod một lệnh (kubectl logs chỉ nhận một pod).
 */
export function logsCommands(input: {
  ref: ContextRef
  namespace: string
  selector?: string | undefined
  pods?: readonly string[]
  since?: string | undefined
  previous?: boolean
  follow?: boolean
}): string[] {
  const rest = [
    '--all-containers --prefix',
    input.since ? `--since=${input.since}` : '',
    input.previous ? '--previous' : input.follow ? '-f' : '',
    `-n ${q(input.namespace)}`,
    contextFlags(input.ref)
  ]
    .filter(Boolean)
    .join(' ')
  if (input.selector) return [`kubectl logs -l ${q(input.selector)} ${rest}`]
  return (input.pods ?? []).map((p) => `kubectl logs ${q(p)} ${rest}`)
}
