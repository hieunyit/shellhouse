/**
 * Đánh giá bảo mật thuần (Session Host, renderer và test dùng chung): cấu hình pod template
 * (privileged, host namespace, chạy root…) và mức rủi ro của một quyền RBAC.
 */

type Obj = Record<string, unknown>
const o = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const a = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(o) : [])
const s = (v: unknown): string => (typeof v === 'string' ? v : '')

export type Severity = 'high' | 'medium' | 'low'

export interface SecurityFinding {
  severity: Severity
  /** Mã ổn định (để test / lọc). */
  id: string
  title: string
  detail: string
  /** Container liên quan; không có = cấp pod. */
  container?: string
}

const CRITICAL_CAPS = new Set(['SYS_ADMIN', 'NET_ADMIN', 'SYS_PTRACE', 'SYS_MODULE', 'ALL'])
const SENSITIVE_HOST_PATHS =
  /^\/(var\/run\/docker\.sock|run\/containerd|proc|sys|etc|root|var\/lib\/kubelet)?\/?$/

/**
 * Phát hiện cấu hình rủi ro trong pod spec (như Pod Security Standards "restricted" + vài kiểm
 * tra thực dụng: image :latest, thiếu limit, thiếu probe). Sắp theo mức độ.
 */
export function securityFindings(podSpec: unknown): SecurityFinding[] {
  const spec = o(podSpec)
  const out: SecurityFinding[] = []
  const podSc = o(spec['securityContext'])
  if (spec['hostNetwork'] === true)
    out.push({
      severity: 'high',
      id: 'host-network',
      title: 'Uses the host network',
      detail: 'Pods see every interface of the node and can bind to its ports.'
    })
  if (spec['hostPID'] === true)
    out.push({
      severity: 'high',
      id: 'host-pid',
      title: 'Shares the host process namespace',
      detail: 'Containers can see and signal every process on the node.'
    })
  if (spec['hostIPC'] === true)
    out.push({
      severity: 'medium',
      id: 'host-ipc',
      title: 'Shares the host IPC namespace',
      detail: 'Containers can read shared memory of other processes on the node.'
    })
  for (const v of a(spec['volumes'])) {
    const hp = o(v['hostPath'])
    if (!Object.keys(hp).length) continue
    const path = s(hp['path'])
    out.push({
      severity: SENSITIVE_HOST_PATHS.test(path) ? 'high' : 'medium',
      id: 'host-path',
      title: `Mounts host path ${path || '(unknown)'}`,
      detail: `Volume "${s(v['name'])}" exposes the node file system to the pod.`
    })
  }
  if (spec['automountServiceAccountToken'] !== false)
    out.push({
      severity: 'low',
      id: 'sa-token',
      title: 'Service account token is mounted',
      detail:
        'The API token is available inside every container. Set automountServiceAccountToken: false if the app does not call the Kubernetes API.'
    })

  const containers = [
    ...a(spec['initContainers']).map((c) => ({ c, init: true })),
    ...a(spec['containers']).map((c) => ({ c, init: false }))
  ]
  for (const { c, init } of containers) {
    const name = s(c['name'])
    const sc = o(c['securityContext'])
    const caps = o(sc['capabilities'])
    if (sc['privileged'] === true)
      out.push({
        severity: 'high',
        id: 'privileged',
        title: 'Privileged container',
        detail: 'Full access to the node devices and kernel — equivalent to root on the node.',
        container: name
      })
    const added = (Array.isArray(caps['add']) ? (caps['add'] as unknown[]) : []).map(s)
    const critical = added.filter((x) => CRITICAL_CAPS.has(x.toUpperCase()))
    if (critical.length)
      out.push({
        severity: 'high',
        id: 'capabilities',
        title: `Adds capabilities ${critical.join(', ')}`,
        detail: 'These Linux capabilities allow escaping or controlling the node.',
        container: name
      })
    else if (added.length)
      out.push({
        severity: 'low',
        id: 'capabilities',
        title: `Adds capabilities ${added.join(', ')}`,
        detail: 'Extra Linux capabilities widen what a compromised process can do.',
        container: name
      })
    const runAsNonRoot = sc['runAsNonRoot'] ?? podSc['runAsNonRoot']
    const runAsUser = sc['runAsUser'] ?? podSc['runAsUser']
    if (runAsUser === 0)
      out.push({
        severity: 'medium',
        id: 'root',
        title: 'Runs as root (UID 0)',
        detail: 'A process escaping the container would be root.',
        container: name
      })
    else if (runAsNonRoot !== true && runAsUser === undefined)
      out.push({
        severity: 'low',
        id: 'root',
        title: 'May run as root',
        detail: 'Neither runAsNonRoot nor runAsUser is set — the image decides (often root).',
        container: name
      })
    if (sc['allowPrivilegeEscalation'] !== false && sc['privileged'] !== true)
      out.push({
        severity: 'low',
        id: 'privilege-escalation',
        title: 'Privilege escalation allowed',
        detail: 'Set allowPrivilegeEscalation: false so setuid binaries cannot gain privileges.',
        container: name
      })
    if (sc['readOnlyRootFilesystem'] !== true)
      out.push({
        severity: 'low',
        id: 'writable-root',
        title: 'Writable root file system',
        detail: 'An attacker can modify binaries inside the container.',
        container: name
      })
    const image = s(c['image'])
    const tag = image.includes('@') ? 'digest' : (image.split('/').pop() ?? '').split(':')[1]
    if (!tag || tag === 'latest')
      out.push({
        severity: 'medium',
        id: 'latest-tag',
        title: tag ? 'Image uses the :latest tag' : 'Image has no tag',
        detail: `${image} — a restart can silently pull a different image.`,
        container: name
      })
    if (init) continue
    const limits = o(o(c['resources'])['limits'])
    if (limits['memory'] === undefined)
      out.push({
        severity: 'medium',
        id: 'no-memory-limit',
        title: 'No memory limit',
        detail: 'One leaking container can push the whole node into memory pressure.',
        container: name
      })
    if (o(o(c['resources'])['requests'])['cpu'] === undefined)
      out.push({
        severity: 'low',
        id: 'no-cpu-request',
        title: 'No CPU request',
        detail: 'The scheduler cannot reserve CPU — the pod is first to be throttled.',
        container: name
      })
    if (c['readinessProbe'] === undefined)
      out.push({
        severity: 'low',
        id: 'no-readiness',
        title: 'No readiness probe',
        detail: 'Traffic is sent as soon as the container starts, before the app is ready.',
        container: name
      })
  }
  const rank: Record<Severity, number> = { high: 0, medium: 1, low: 2 }
  return out.sort((x, y) => rank[x.severity] - rank[y.severity])
}

const READ = new Set(['get', 'list', 'watch'])
const ESCALATE = new Set(['escalate', 'bind', 'impersonate'])

/** Mức rủi ro của một quyền RBAC (resource = "secrets", "pods/exec", "*", "deployments.apps"…). */
export function rbacRisk(
  resource: string,
  verbs: readonly string[]
): { risk: Severity; reason?: string } {
  const v = new Set(verbs.map((x) => x.toLowerCase()))
  const any = v.has('*')
  const writes = any || [...v].some((x) => !READ.has(x))
  const base = resource.split('.')[0] ?? resource
  if (resource === '*' && any) return { risk: 'high', reason: 'Full control (like cluster-admin)' }
  if (
    [...v].some((x) => ESCALATE.has(x)) ||
    (any && /roles|rolebindings|serviceaccounts/.test(base))
  )
    return { risk: 'high', reason: 'Can grant itself more permissions' }
  if (
    (base === 'secrets' || resource === '*') &&
    (any || v.has('get') || v.has('list') || v.has('watch'))
  )
    return { risk: 'high', reason: 'Can read secrets (tokens, passwords)' }
  if (/^pods\/(exec|attach|portforward)$/.test(base) || base === 'pods/ephemeralcontainers')
    return { risk: 'high', reason: 'Can run commands inside other pods' }
  if (base === 'nodes/proxy' || base === 'serviceaccounts/token')
    return { risk: 'high', reason: 'Can act as the node or mint tokens' }
  if (
    writes &&
    /^(pods|deployments|daemonsets|statefulsets|replicasets|jobs|cronjobs|\*)$/.test(base)
  )
    return { risk: 'medium', reason: 'Can create or change workloads' }
  if (
    writes &&
    /^(configmaps|services|ingresses|networkpolicies|persistentvolumeclaims)$/.test(base)
  )
    return { risk: 'medium', reason: 'Can change cluster configuration' }
  return { risk: 'low' }
}
