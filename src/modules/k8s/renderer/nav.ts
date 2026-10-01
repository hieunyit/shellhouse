import type { DiscoveredKind } from '../shared/ops'
import { BUILTIN_KINDS } from '../shared/resources'

/**
 * Điều hướng kiểu k9s: alias ngắn cho thanh lệnh `:` (po, deploy, svc…), "overview" và lệnh đặc
 * biệt (ctx, ns).
 */

export const OVERVIEW = 'overview'
/** Trang Helm releases (đọc từ Secret của Helm 3). */
export const HELM = 'helm-releases'

const ALIASES: Record<string, string> = {
  po: 'pods',
  pod: 'pods',
  pods: 'pods',
  deploy: 'deployments.apps',
  dp: 'deployments.apps',
  deployment: 'deployments.apps',
  deployments: 'deployments.apps',
  sts: 'statefulsets.apps',
  statefulset: 'statefulsets.apps',
  statefulsets: 'statefulsets.apps',
  ds: 'daemonsets.apps',
  daemonset: 'daemonsets.apps',
  daemonsets: 'daemonsets.apps',
  rs: 'replicasets.apps',
  replicaset: 'replicasets.apps',
  replicasets: 'replicasets.apps',
  job: 'jobs.batch',
  jobs: 'jobs.batch',
  cj: 'cronjobs.batch',
  hpa: 'horizontalpodautoscalers.autoscaling',
  netpol: 'networkpolicies.networking.k8s.io',
  pv: 'persistentvolumes',
  sc: 'storageclasses.storage.k8s.io',
  pdb: 'poddisruptionbudgets.policy',
  quota: 'resourcequotas',
  sa: 'serviceaccounts',
  role: 'roles.rbac.authorization.k8s.io',
  rb: 'rolebindings.rbac.authorization.k8s.io',
  crole: 'clusterroles.rbac.authorization.k8s.io',
  crb: 'clusterrolebindings.rbac.authorization.k8s.io',
  app: 'applications.argoproj.io',
  apps: 'applications.argoproj.io',
  gw: 'gateways.gateway.networking.k8s.io',
  httproute: 'httproutes.gateway.networking.k8s.io',
  helm: 'helm-releases',
  cronjob: 'cronjobs.batch',
  cronjobs: 'cronjobs.batch',
  svc: 'services',
  service: 'services',
  services: 'services',
  ing: 'ingresses.networking.k8s.io',
  ingress: 'ingresses.networking.k8s.io',
  ingresses: 'ingresses.networking.k8s.io',
  cm: 'configmaps',
  configmap: 'configmaps',
  configmaps: 'configmaps',
  sec: 'secrets',
  secret: 'secrets',
  secrets: 'secrets',
  pvc: 'persistentvolumeclaims',
  pvcs: 'persistentvolumeclaims',
  no: 'nodes',
  node: 'nodes',
  nodes: 'nodes',
  ev: 'events',
  event: 'events',
  events: 'events',
  ns: 'namespaces',
  namespace: 'namespaces',
  namespaces: 'namespaces',
  ov: OVERVIEW,
  overview: OVERVIEW,
  pulse: OVERVIEW,
  cluster: OVERVIEW
}

export interface CommandSuggestion {
  /** Văn bản điền vào ô lệnh. */
  value: string
  label: string
  hint: string
}

export type Command =
  | { kind: 'view'; id: string }
  | { kind: 'namespace'; name: string | null }
  | { kind: 'context'; name: string }

/** Diễn giải một lệnh ("po", "deploy", "ns kube-system", "ctx prod", "widgets.example.com"). */
export function parseCommand(input: string, kinds: readonly DiscoveredKind[]): Command | null {
  const [head = '', ...rest] = input.trim().replace(/^:/, '').split(/\s+/)
  const word = head.toLowerCase()
  const arg = rest.join(' ')
  if ((word === 'ns' || word === 'namespace') && arg)
    return { kind: 'namespace', name: arg === 'all' ? null : arg }
  if ((word === 'ctx' || word === 'context') && arg) return { kind: 'context', name: arg }
  if (word === 'all' || word === '0') return { kind: 'namespace', name: null }
  const alias = ALIASES[word]
  if (alias) return { kind: 'view', id: alias }
  const match = kinds.find(
    (k) =>
      k.id === word ||
      k.plural === word ||
      k.kind.toLowerCase() === word ||
      `${k.plural}.${k.group}` === word
  )
  return match ? { kind: 'view', id: match.id } : null
}

/** Gợi ý cho thanh lệnh. */
export function suggest(
  input: string,
  kinds: readonly DiscoveredKind[],
  contexts: readonly string[],
  namespaces: readonly string[]
): CommandSuggestion[] {
  const q = input.trim().replace(/^:/, '').toLowerCase()
  const [head = '', ...rest] = q.split(/\s+/)
  const arg = rest.join(' ')
  if (head === 'ns' && q.includes(' '))
    return ['all', ...namespaces]
      .filter((n) => n.includes(arg))
      .slice(0, 12)
      .map((n) => ({ value: `ns ${n}`, label: n, hint: 'namespace' }))
  if (head === 'ctx' && q.includes(' '))
    return contexts
      .filter((c) => c.toLowerCase().includes(arg))
      .slice(0, 12)
      .map((c) => ({ value: `ctx ${c}`, label: c, hint: 'context' }))
  const views: CommandSuggestion[] = [
    { value: OVERVIEW, label: 'Overview', hint: 'ov' },
    ...kinds
      .filter((k) => !k.forbidden)
      .map((k) => {
        const builtin = BUILTIN_KINDS.find((b) => b.id === k.id)
        const short = Object.entries(ALIASES).find(([a, id]) => id === k.id && a.length <= 4)?.[0]
        return { value: short ?? k.id, label: builtin?.title ?? k.kind, hint: short ?? k.id }
      }),
    { value: 'ns ', label: 'Switch namespace…', hint: 'ns <name>' },
    { value: 'ctx ', label: 'Switch context…', hint: 'ctx <name>' }
  ]
  if (!q) return views.slice(0, 14)
  return views
    .filter((v) => v.value.startsWith(q) || v.label.toLowerCase().includes(q) || v.hint.includes(q))
    .slice(0, 14)
}
