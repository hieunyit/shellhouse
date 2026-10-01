import { z } from 'zod'

/** Giao thức của module Kubernetes (ADR-014 mục 7.5). */

const Name = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/, 'Invalid name')
const Namespace = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, 'Invalid namespace')
/** "pods", "deployments.apps", "widgets.example.com" (CRD). */
const Kind = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/, 'Invalid resource kind')
const Selector = z.string().max(1024)
const Subscription = z.string().min(1).max(64)

/** Tham chiếu context: file kubeconfig (hoặc bản import) + tên context. */
export const ContextRef = z.object({
  /** `file:<đường dẫn>` hoặc `imported:<id>`. */
  source: z.string().min(1).max(4200),
  context: z.string().min(1).max(253)
})
export type ContextRef = z.infer<typeof ContextRef>

export function contextKey(ref: ContextRef): string {
  return `${ref.source}#${ref.context}`
}

export const K8sOp = z.discriminatedUnion('op', [
  /** Kết nối tới cluster của context (qua bastion nếu phiên gắn vào SSH). */
  z.object({ op: z.literal('connect'), ref: ContextRef, readOnly: z.boolean() }),
  z.object({ op: z.literal('namespaces') }),
  /** Loại tài nguyên cluster có (gồm CRD) + loại người dùng không được list. */
  /** refresh = bỏ danh mục / quyền đã nhớ (nút Reload — thấy CRD vừa cài). */
  z.object({
    op: z.literal('discover'),
    namespace: Namespace.optional(),
    refresh: z.boolean().optional()
  }),
  z.object({
    op: z.literal('list'),
    kind: Kind,
    namespace: Namespace.optional(),
    labelSelector: Selector.optional(),
    fieldSelector: Selector.optional(),
    limit: z.number().int().min(1).max(5000),
    continue: z.string().max(4096).optional()
  }),
  /** → sự kiện 'watch' (theo lô ≤ 10 lần / giây). */
  z.object({
    op: z.literal('watch'),
    kind: Kind,
    namespace: Namespace.optional(),
    labelSelector: Selector.optional(),
    fieldSelector: Selector.optional(),
    resourceVersion: z.string().max(64)
  }),
  z.object({
    op: z.literal('get'),
    kind: Kind,
    namespace: Namespace.optional(),
    name: Name,
    format: z.enum(['json', 'yaml'])
  }),
  /** Ghi đè (replace) có kiểm resourceVersion — xung đột → báo, không ghi đè. */
  z.object({ op: z.literal('apply'), yaml: z.string().max(4 * 1024 * 1024) }),
  /** force = xoá ngay (grace period 0) — "kill" của k9s. */
  z.object({
    op: z.literal('delete'),
    kind: Kind,
    namespace: Namespace.optional(),
    name: Name,
    force: z.boolean().optional()
  }),
  /** Tạo / cập nhật bằng server-side apply (nhiều tài liệu YAML, ngăn bởi ---). */
  z.object({
    op: z.literal('serverApply'),
    yaml: z.string().max(4 * 1024 * 1024),
    namespace: Namespace.optional()
  }),
  /** CPU / RAM từ metrics-server (null nếu cluster không có). */
  z.object({
    op: z.literal('metrics'),
    scope: z.enum(['pods', 'nodes']),
    namespace: Namespace.optional()
  }),
  /** Số liệu tổng quan cluster (kiểu Lens). */
  z.object({ op: z.literal('overview'), namespaces: z.array(Namespace).max(64) }),
  /** Bản đồ cluster: workload, pod, service, route, PVC, HPA, policy — gọn để vẽ. */
  z.object({ op: z.literal('map'), namespaces: z.array(Namespace).max(64) }),
  /** Helm 3 releases (đọc Secret owner=helm — không cần cài helm). */
  z.object({ op: z.literal('helm.releases'), namespaces: z.array(Namespace).max(64) }),
  /** Chi tiết một release: values, notes, manifest, lịch sử revision. */
  z.object({ op: z.literal('helm.release'), namespace: Namespace, name: Name }),
  /** Số đối tượng mỗi loại (số trên thanh điều hướng, như Rancher). null = không đếm được. */
  z.object({
    op: z.literal('counts'),
    kinds: z.array(Kind).max(200),
    namespaces: z.array(Namespace).max(64)
  }),
  /** Tài nguyên liên quan (kiểu Rancher): service, ConfigMap, Secret, PVC, HPA… / "Used by". */
  z.object({ op: z.literal('related'), kind: Kind, namespace: Namespace, name: Name }),
  /**
   * Đồ thị quan hệ của một đối tượng (Object Topology): owner, pod, node, service / route,
   * ConfigMap / Secret / PVC / PV, HPA / PDB / NetworkPolicy, ServiceAccount → RBAC.
   */
  z.object({
    op: z.literal('topology'),
    kind: Kind,
    namespace: Namespace.optional(),
    name: Name
  }),
  /** ServiceAccount với tới được gì (gộp mọi RoleBinding / ClusterRoleBinding của nó). */
  z.object({ op: z.literal('rbacReach'), namespace: Namespace, serviceAccount: Name }),
  z.object({ op: z.literal('rolloutHistory'), namespace: Namespace, name: Name }),
  z.object({
    op: z.literal('rollback'),
    namespace: Namespace,
    name: Name,
    revision: z.number().int().min(1)
  }),
  z.object({ op: z.literal('cordon'), node: Name, unschedulable: z.boolean() }),
  /** Cordon + evict mọi pod (trừ DaemonSet / static pod). */
  z.object({ op: z.literal('drain'), node: Name }),
  z.object({ op: z.literal('cronTrigger'), namespace: Namespace, name: Name }),
  z.object({
    op: z.literal('cronSuspend'),
    namespace: Namespace,
    name: Name,
    suspend: z.boolean()
  }),
  /** Argo CD: đồng bộ Application (như nút Sync), prune = xoá tài nguyên không còn trong Git. */
  z.object({ op: z.literal('argoSync'), namespace: Namespace, name: Name, prune: z.boolean() }),
  /** Argo CD: so lại với Git (hard = bỏ cache manifest). */
  z.object({ op: z.literal('argoRefresh'), namespace: Namespace, name: Name, hard: z.boolean() }),
  z.object({
    op: z.literal('scale'),
    kind: z.enum(['deployments.apps', 'statefulsets.apps', 'replicasets.apps']),
    namespace: Namespace,
    name: Name,
    replicas: z.number().int().min(0).max(10_000)
  }),
  z.object({
    op: z.literal('rolloutRestart'),
    kind: z.enum(['deployments.apps', 'statefulsets.apps', 'daemonsets.apps']),
    namespace: Namespace,
    name: Name
  }),
  z.object({
    op: z.literal('rolloutPause'),
    namespace: Namespace,
    name: Name,
    paused: z.boolean()
  }),
  /**
   * Log theo luồng. Một pod + container; hoặc mọi container của pod (`allContainers`); hoặc mọi
   * pod khớp `selector` (log cả workload) — dòng có tiền tố pod/container.
   */
  z.object({
    op: z.literal('logs.subscribe'),
    namespace: Namespace,
    pod: Name.optional(),
    selector: Selector.optional(),
    container: z.string().max(253).optional(),
    allContainers: z.boolean().optional(),
    previous: z.boolean(),
    tail: z.number().int().min(0).max(100_000),
    timestamps: z.boolean()
  }),
  z.object({
    op: z.literal('portForward'),
    namespace: Namespace,
    /** "pod/name" hoặc "service/name". */
    target: z.string().regex(/^(pod|service)\/[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/),
    /** [cổng trên máy (0 = tự chọn), cổng đích]. */
    ports: z
      .array(z.tuple([z.number().int().min(0).max(65535), z.number().int().min(1).max(65535)]))
      .min(1)
      .max(16)
  }),
  z.object({ op: z.literal('portForward.stop'), id: z.string().max(64) }),
  z.object({ op: z.literal('portForwards') }),
  z.object({
    op: z.literal('secret.reveal'),
    namespace: Namespace,
    name: Name,
    key: z.string().max(253)
  }),
  /** Sửa YAML bằng editor trên máy: ghi ra file tạm, theo dõi, lưu → replace. */
  z.object({
    op: z.literal('edit'),
    kind: Kind,
    namespace: Namespace.optional(),
    name: Name,
    localPath: z.string().min(1).max(4096)
  }),
  z.object({ op: z.literal('unsubscribe'), subscription: Subscription })
])
export type K8sOp = z.infer<typeof K8sOp>

/** Thao tác thay đổi (bị chặn ở chế độ chỉ đọc). */
export function isMutating(op: K8sOp): boolean {
  return [
    'apply',
    'serverApply',
    'delete',
    'scale',
    'rolloutRestart',
    'rolloutPause',
    'edit',
    'rollback',
    'cordon',
    'drain',
    'cronTrigger',
    'cronSuspend',
    'argoSync',
    'argoRefresh'
  ].includes(op.op)
}

// ——— Kết quả / sự kiện ———

export interface ContextInfo {
  ref: ContextRef
  /** Tên hiển thị (tên context). */
  name: string
  cluster: string
  server: string
  user: string
  namespace: string | null
  /** Nguồn: "~/.kube/config", "Imported: prod"… */
  sourceLabel: string
  /** Xác thực bằng chương trình ngoài (aws, gcloud…) — sẽ hỏi trước khi chạy. */
  execPlugin: string | null
}

export interface DiscoveredKind {
  id: string
  group: string
  version: string
  plural: string
  kind: string
  namespaced: boolean
  /** true = không có quyền list trong namespace đang xem (ẩn khỏi điều hướng). */
  forbidden: boolean
}

export interface WatchEvent {
  subscription: string
  events: { type: 'ADDED' | 'MODIFIED' | 'DELETED'; object: unknown }[]
  /** Server trả 410 Gone → renderer list lại từ đầu. */
  relist?: boolean
}

/** Mức dùng (millicore CPU, byte RAM). */
export interface Usage {
  cpu: number
  memory: number
}

export interface MetricsResult {
  /** false = cluster không có metrics-server. */
  available: boolean
  /** "ns/pod" hoặc tên node → mức dùng. */
  items: Record<string, Usage>
}

export interface HelmRelease {
  name: string
  namespace: string
  revision: number
  /** deployed, failed, pending-install, pending-upgrade, superseded, uninstalling… */
  status: string
  chart: string
  chartVersion: string
  appVersion: string
  /** ms, 0 = không rõ. */
  updated: number
  description: string
}

export interface HelmReleaseDetail extends HelmRelease {
  /** Giá trị người dùng đặt (helm get values) — YAML. */
  values: string
  notes: string
  manifest: string
  history: Omit<HelmRelease, 'name' | 'namespace'>[]
}

/** Một tài nguyên liên quan; `missing` = được tham chiếu nhưng không tồn tại. */
export interface RelatedItem {
  /** Id loại (services, configmaps…) để mở; '' = loại không mở được. */
  kind: string
  name: string
  summary: string
  tone: 'ok' | 'warn' | 'bad' | 'muted'
  missing?: boolean
}

export interface RelatedGroup {
  id: string
  title: string
  kind: string
  items: RelatedItem[]
  /** Không liệt kê được (thiếu quyền…). */
  error?: string
}

export interface RelatedResult {
  groups: RelatedGroup[]
}

/** Quan hệ trong đồ thị topology (đọc theo chiều mũi tên: from → to). */
export type TopologyEdgeType =
  | 'owns'
  | 'selects'
  | 'routes'
  | 'attaches'
  | 'uses'
  | 'mounts'
  | 'runs-on'
  | 'bound'
  | 'scales'
  | 'protects'
  | 'isolates'
  | 'identity'
  | 'grants'
  | 'subject'

export interface TopologyNode {
  /** `${kind}|${namespace}|${name}` (namespace rỗng với loại cluster). */
  id: string
  /** Id loại kiểu kubectl (pods, deployments.apps…); '' = nhóm gộp ("+12 pods"). */
  kind: string
  /** Pod, Deployment… */
  kindLabel: string
  name: string
  namespace?: string
  summary: string
  tone: 'ok' | 'warn' | 'bad' | 'muted'
  /** Được tham chiếu nhưng không tồn tại. */
  missing?: boolean
  /** Có thể mở rộng (xem quan hệ của chính nó) — đối tượng dùng chung không tự bung ra. */
  expandable?: boolean
}

export interface TopologyEdge {
  from: string
  to: string
  type: TopologyEdgeType
  /** Chi tiết: "env", "volume", "image pull", "80→8080"… */
  label?: string
}

export interface TopologyResult {
  root: string
  nodes: TopologyNode[]
  edges: TopologyEdge[]
  /** Phần không xem được (thiếu quyền…) / đã rút gọn. */
  notes: string[]
}

/** Một quyền RBAC đã gộp: tài nguyên + động từ + nguồn (binding → role). */
export interface RbacGrant {
  /** "secrets", "pods/exec", "*"… (kèm apiGroup nếu khác core: "deployments.apps"). */
  resource: string
  verbs: string[]
  /** Giới hạn theo tên (resourceNames) — rỗng = mọi đối tượng. */
  names: string[]
  /** Namespace áp dụng; '*' = toàn cluster. */
  scope: string
  via: string
  risk: 'high' | 'medium' | 'low'
  reason?: string
}

export interface RbacReach {
  serviceAccount: string
  namespace: string
  bindings: { kind: string; name: string; namespace?: string; role: string; roleKind: string }[]
  grants: RbacGrant[]
  /** Không đọc được binding / role (thiếu quyền). */
  error?: string
}

export interface OverviewResult {
  version: string
  nodes: { total: number; ready: number; cordoned: number }
  /** Tổng allocatable của các node (millicore / byte). */
  capacity: Usage
  /** Tổng requests của pod đang chạy. */
  requests: Usage
  /** Mức dùng thật (metrics-server), null nếu không có. */
  usage: Usage | null
  pods: { running: number; pending: number; failed: number; succeeded: number; restarting: number }
  workloads: { kind: string; total: number; ready: number }[]
  warnings: {
    namespace: string
    object: string
    reason: string
    message: string
    count: number
    last: string
  }[]
}

export interface RolloutRevision {
  revision: number
  replicaSet: string
  images: string[]
  created: string
  replicas: number
  current: boolean
}

export interface DrainResult {
  evicted: string[]
  skipped: string[]
  failed: string[]
}

export interface ApplyResult {
  object: string
  action: 'configured' | 'error'
  error?: string
}

export interface PortForwardInfo {
  id: string
  namespace: string
  target: string
  localPort: number
  remotePort: number
  connections: number
  error: string | null
}

/** Tham số tab cluster. */
export const K8sClusterParams = z.object({
  ref: ContextRef,
  /** Tên hiển thị. */
  label: z.string().max(253),
  /** Host SSH làm bastion (API server nằm sau nó). */
  bastionHostId: z.string().min(1).max(64).optional(),
  namespace: z.string().max(63).optional()
})
export type K8sClusterParams = z.infer<typeof K8sClusterParams>

export const K8sLogsParams = z.object({
  ref: ContextRef,
  bastionHostId: z.string().min(1).max(64).optional(),
  namespace: Namespace,
  /** Một pod; hoặc `selector` = mọi pod của workload. */
  pod: Name.optional(),
  selector: Selector.optional(),
  container: z.string().max(253).optional(),
  allContainers: z.boolean().optional(),
  /** Tiêu đề tab khi xem log workload ("deployment/web"). */
  title: z.string().max(253).optional()
})
export type K8sLogsParams = z.infer<typeof K8sLogsParams>

/** Shell vào pod (tab terminal của module). */
export const K8sTerminalParams = z.object({
  ref: ContextRef,
  namespace: Namespace,
  pod: Name,
  container: z.string().max(253).optional(),
  command: z.array(z.string().max(1024)).max(32).optional()
})
export type K8sTerminalParams = z.infer<typeof K8sTerminalParams>
