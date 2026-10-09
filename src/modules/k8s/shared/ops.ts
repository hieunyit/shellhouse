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
  /** Cột `additionalPrinterColumns` của CRD (kubectl get <crd>) cho một loại; [] nếu không có / không đọc được. */
  z.object({ op: z.literal('crd.columns'), kind: Kind }),
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
  /**
   * Lịch sử CPU / RAM của các pod (Prometheus trong cluster nếu có — xem session-host/prometheus).
   * Không có Prometheus → source 'none'.
   */
  z.object({
    op: z.literal('metrics.range'),
    namespace: Namespace,
    pods: z.array(Name).min(1).max(200),
    minutes: z
      .number()
      .int()
      .min(5)
      .max(7 * 24 * 60)
  }),
  /** Số liệu tổng quan cluster (kiểu Lens). */
  z.object({ op: z.literal('overview'), namespaces: z.array(Namespace).max(64) }),
  /** Bản đồ cluster: workload, pod, service, route, PVC, HPA, policy — gọn để vẽ. */
  z.object({ op: z.literal('map'), namespaces: z.array(Namespace).max(64) }),
  /**
   * Điểm đến khai báo của workload (host:port trong env, args, ConfigMap, Secret được tham chiếu) —
   * Map › Topology / Outbound. Không trả giá trị Secret, chỉ host / cổng.
   */
  z.object({
    op: z.literal('egress'),
    namespaces: z.array(Namespace).max(64),
    /** Đọc Secret mà workload tham chiếu (GET từng cái). Tắt → chỉ env / args / ConfigMap. */
    secrets: z.boolean(),
    /**
     * Chỉ một workload (chi tiết của nó): cần đúng một namespace; kết quả kèm danh sách Service để
     * phân loại điểm đến mà không cần dữ liệu Map.
     */
    workload: z.object({ kind: z.string().min(1).max(64), name: Name }).optional()
  }),
  /**
   * Phân giải tên máy công khai → IP trên máy này (để đối chiếu Connections với kết nối quan sát
   * được). Tên nội bộ (.internal / .corp / .svc…) bị bỏ, không gửi tới DNS.
   */
  z.object({
    op: z.literal('resolve'),
    hosts: z.array(z.string().min(1).max(253)).max(64),
    /** Cho phép cả tên nội bộ (.corp / .internal…) — người dùng chấp nhận gửi chúng tới DNS của máy này. */
    internal: z.boolean().optional()
  }),
  /** Helm 3 releases (đọc Secret owner=helm — không cần cài helm). */
  z.object({ op: z.literal('helm.releases'), namespaces: z.array(Namespace).max(64) }),
  /** Chi tiết một release: values, notes, manifest, lịch sử revision. */
  z.object({ op: z.literal('helm.release'), namespace: Namespace, name: Name }),
  /** Một revision của release (values người dùng + values gộp với chart, manifest) — để xem / so sánh. */
  z.object({
    op: z.literal('helm.revision'),
    namespace: Namespace,
    name: Name,
    revision: z.number().int().min(1)
  }),
  /**
   * Như `helm rollback --no-hooks`: tạo revision mới từ manifest của revision đích, server-side apply
   * (field manager "helm"), xoá tài nguyên không còn trong revision đích (trừ resource-policy keep).
   */
  z.object({
    op: z.literal('helm.rollback'),
    namespace: Namespace,
    name: Name,
    revision: z.number().int().min(1)
  }),
  /** Như `helm uninstall --no-hooks [--keep-history]`. */
  z.object({
    op: z.literal('helm.uninstall'),
    namespace: Namespace,
    name: Name,
    keepHistory: z.boolean()
  }),
  /**
   * Xem trước thay đổi (dry run phía server, không ghi gì): `replace` = PUT như lưu YAML đã sửa;
   * `apply` = server-side apply (tạo / cập nhật, nhiều tài liệu). Trả bản trên cluster và kết quả.
   */
  z.object({
    op: z.literal('diff'),
    mode: z.enum(['replace', 'apply']),
    yaml: z.string().max(4 * 1024 * 1024),
    namespace: Namespace.optional()
  }),
  /** Container debug tạm thời (ephemeral) trong pod — như `kubectl debug -it --image … --target …`. */
  z.object({
    op: z.literal('debug.ephemeral'),
    namespace: Namespace,
    pod: Name,
    image: z.string().min(1).max(512),
    target: z.string().max(253).optional()
  }),
  /** Pod debug đặc quyền trên node (hostPID / hostNetwork, / của node ở /host) — `kubectl debug node/…`. */
  z.object({
    op: z.literal('debug.node'),
    node: Name,
    image: z.string().min(1).max(512),
    namespace: Namespace
  }),
  /** Số đối tượng mỗi loại (số trên thanh điều hướng, như Rancher). null = không đếm được. */
  z.object({
    op: z.literal('counts'),
    kinds: z.array(Kind).max(200),
    namespaces: z.array(Namespace).max(64)
  }),
  /** Số pod / deployment lỗi theo namespace (Explorer: "2 failing"), cả cluster. */
  z.object({ op: z.literal('health') }),
  /** Vấn đề cần xem cả cluster (Home › Needs attention): pod lỗi, node, PVC — không metrics. */
  z.object({ op: z.literal('problems') }),
  /** Tóm tắt cho bảng theo dõi ở Home: phiên bản, node, vấn đề, hạn chứng chỉ. */
  z.object({ op: z.literal('fleet') }),
  /** Ghi event của cả cluster về máy (7 ngày, cho tab Timeline) — bật / tắt. */
  z.object({ op: z.literal('events.record'), on: z.boolean() }),
  /** Lịch sử qua Prometheus: Prometheus có metric traffic / event nào. */
  z.object({ op: z.literal('history.probe') }),
  /** Tốc độ trung bình từng cặp traffic trong [start, end] (ms) — từ Prometheus. */
  z.object({
    op: z.literal('traffic.range'),
    start: z.number().int().min(0),
    end: z.number().int().min(0)
  }),
  /** Vào / ra của một workload theo thời gian — từ Prometheus. */
  z.object({
    op: z.literal('traffic.series'),
    kind: z.enum(['deployments.apps', 'statefulsets.apps', 'daemonsets.apps']),
    namespace: Namespace,
    name: Name,
    start: z.number().int().min(0),
    end: z.number().int().min(0)
  }),
  /** Dòng thời gian của Deployment / StatefulSet / DaemonSet (tab Timeline). */
  z.object({
    op: z.literal('timeline'),
    kind: z.enum(['deployments.apps', 'statefulsets.apps', 'daemonsets.apps']),
    namespace: Namespace,
    name: Name
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
  /** Traffic live từ Caretta (đọc agent qua API proxy) — byte tích luỹ, renderer tính tốc độ. */
  z.object({ op: z.literal('traffic') }),
  z.object({ op: z.literal('rolloutHistory'), namespace: Namespace, name: Name }),
  z.object({
    op: z.literal('rollback'),
    namespace: Namespace,
    name: Name,
    revision: z.number().int().min(1)
  }),
  z.object({ op: z.literal('cordon'), node: Name, unschedulable: z.boolean() }),
  /**
   * Cordon + evict mọi pod (trừ DaemonSet / static pod) — như `kubectl drain --ignore-daemonsets`.
   * Pod không có controller / dùng emptyDir → không evict gì cả (báo trong `failed`) trừ khi bật
   * `force` / `deleteEmptyDirData`. PDB chặn (429) → thử lại tới `timeoutSeconds` (mặc định 300).
   */
  z.object({
    op: z.literal('drain'),
    node: Name,
    /** Thời gian dừng pod (giây); không đặt = theo pod. */
    gracePeriodSeconds: z.number().int().min(0).max(3600).optional(),
    /** Evict cả pod dùng emptyDir (dữ liệu emptyDir mất). */
    deleteEmptyDirData: z.boolean().optional(),
    /** Evict cả pod không có controller (sẽ không được tạo lại). */
    force: z.boolean().optional(),
    timeoutSeconds: z.number().int().min(1).max(3600).optional()
  }),
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
    /** Các pod đã chọn (thanh thao tác hàng loạt). */
    pods: z.array(Name).min(1).max(20).optional(),
    container: z.string().max(253).optional(),
    allContainers: z.boolean().optional(),
    previous: z.boolean(),
    tail: z.number().int().min(0).max(100_000),
    timestamps: z.boolean(),
    /** Chỉ log trong khoảng này (giây, như kubectl --since). */
    sinceSeconds: z
      .number()
      .int()
      .min(1)
      .max(30 * 86_400)
      .optional()
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
  /** Tắt tạm (đóng cổng trên máy, giữ cấu hình) / bật lại đúng cổng cũ. */
  z.object({ op: z.literal('portForward.pause'), id: z.string().max(64) }),
  z.object({ op: z.literal('portForward.resume'), id: z.string().max(64) }),
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

/**
 * Thao tác bị chặn ở chế độ chỉ đọc: thay đổi cluster, và mở đường vào trong cluster làm thay đổi
 * được (port-forward — tới DB…; shell vào pod chặn ở openTerminal). Xem giá trị Secret
 * (`secret.reveal`) vẫn được — chỉ đọc, quyền do RBAC quyết.
 */
export function isMutating(op: K8sOp): boolean {
  return [
    'portForward',
    'portForward.resume',
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
    'argoRefresh',
    'helm.rollback',
    'helm.uninstall',
    'debug.ephemeral',
    'debug.node'
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
  /** true: API server không trả lời (dữ liệu có thể cũ); false: nối lại được. */
  stale?: boolean
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

/** Một revision (helm get values / values --all / manifest --revision N). */
export interface HelmRevisionDetail {
  revision: number
  status: string
  chart: string
  chartVersion: string
  appVersion: string
  updated: number
  description: string
  /** Values người dùng đặt — YAML ('' nếu không có). */
  values: string
  /** Values của chart gộp với values người dùng (như `helm get values --all`) — YAML. */
  computedValues: string
  manifest: string
  notes: string
  /** Hook của revision (tên + sự kiện) — không chạy khi rollback / uninstall từ Shellhouse. */
  hooks: { name: string; kind: string; events: string[] }[]
}

/** Kết quả rollback / uninstall: đối tượng "kind/tên" (kèm namespace nếu có). */
export interface HelmActionResult {
  /** Revision mới (rollback); 0 với uninstall. */
  revision: number
  applied: string[]
  deleted: string[]
  /** Giữ lại do `helm.sh/resource-policy: keep`. */
  kept: string[]
  /** "đối tượng: lỗi". */
  failed: string[]
  /** Số hook bỏ qua (không chạy). */
  hooksSkipped: number
}

/** Một tài liệu trong xem trước thay đổi (YAML đã bỏ managedFields / status / resourceVersion…). */
export interface DiffItem {
  /** "ns/kind/tên". */
  object: string
  /** null = chưa có trên cluster (sẽ tạo). */
  live: string | null
  /** null = lỗi (xem `error`). */
  result: string | null
  error?: string
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
  /** Traffic thật (Caretta): client → server. */
  | 'calls'

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
  /** `known: false` — tài khoản không list được node (số liệu node và dung lượng không có). */
  nodes: { total: number; ready: number; cordoned: number; known?: boolean }
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
  /** Cluster quá lớn — số liệu chỉ tính trên phần đầu (thiếu ở bản cũ). */
  truncated?: boolean
  /** Vấn đề cần xem, theo nhóm (thiếu ở bản cũ). */
  problems?: Record<ProblemGroup, { total: number; items: OverviewProblem[] }>
}

/** Kết quả `fleet` (Home › Infrastructure). */
export interface FleetResult {
  /** gitVersion của API server (v1.34.2-eks-…). */
  version: string
  nodes: { total: number; ready: number }
  problems: Record<ProblemGroup, { total: number; items: OverviewProblem[] }>
  /** Loại tài khoản không đọc được toàn cluster (thiếu quyền) — số liệu tương ứng là "không biết". */
  limited?: ('nodes' | 'pods' | 'pvcs')[]
  /** Hạn chứng chỉ (ISO): của API server và của client-certificate trong kubeconfig. */
  serverCertExpiry?: string
  clientCertExpiry?: string
}

/** Kết quả `health`: namespace → số pod lỗi (crash / kéo image hỏng / Failed), deployment chưa đủ. */
export interface HealthResult {
  pods: Record<string, number>
  deployments: Record<string, number>
}

/** Nhóm vấn đề của trang tổng quan. */
export type ProblemGroup = 'failing' | 'imagePull' | 'pending' | 'nodes' | 'pvcs'

export interface OverviewProblem {
  /** Id loại để mở (pods, nodes, persistentvolumeclaims). */
  kind: string
  namespace?: string
  name: string
  /** CrashLoopBackOff, ImagePullBackOff, Unschedulable, NotReady… */
  reason: string
  message: string
  /** Thời điểm bắt đầu (ISO) nếu biết — '' nếu không. */
  since: string
  /** Số lần khởi động lại (pod). */
  restarts?: number
}

/**
 * Kết quả `counts`: id loại → số (null = không đếm được). Loại có quá nhiều đối tượng để đếm hết
 * có thêm khoá `${COUNT_CAPPED}${id}` = 1 — số khi đó là mức tối thiểu (hiện "10000+").
 */
export const COUNT_CAPPED = 'capped:'

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
  /** "ns/pod" bỏ qua (DaemonSet, static pod, đã xong). */
  skipped: string[]
  /** "ns/pod: lý do" — không evict được (PDB tới hết giờ, lỗi…) hoặc chặn cả lượt drain. */
  failed: string[]
  /**
   * Pod chặn drain (không có controller / dùng emptyDir) khi chưa bật force / deleteEmptyDirData:
   * không pod nào bị evict (như kubectl). Thiếu ở bản cũ.
   */
  blocked?: string[]
}

export interface ApplyResult {
  object: string
  action: 'configured' | 'error'
  error?: string
}

/** Một đường theo pod: [thời điểm ms, giá trị] — CPU millicore, RAM byte. */
export interface MetricsSeries {
  pod: string
  points: [number, number][]
}

export type MetricsRange =
  | {
      source: 'prometheus'
      /** "namespace/service" của Prometheus đang dùng. */
      via: string
      start: number
      end: number
      step: number
      cpu: MetricsSeries[]
      memory: MetricsSeries[]
    }
  | { source: 'none'; reason: string }

export interface PortForwardInfo {
  id: string
  namespace: string
  target: string
  localPort: number
  remotePort: number
  connections: number
  error: string | null
  /** active = đang nghe; paused = tắt tạm; error = lần kết nối gần nhất hỏng (vẫn nghe, thử lại). */
  state: 'active' | 'paused' | 'error'
  /** Pod đang nhận kết nối (service → pod hiện tại). */
  pod: string
  /** Thời gian mở kênh tới pod của kết nối gần nhất (ms). */
  latencyMs: number | null
  /** Số lần tự chuyển sang pod mới (pod cũ bị thay / khởi động lại). */
  reconnects: number
}

/** Tham số tab cluster. */
export const K8sClusterParams = z.object({
  ref: ContextRef,
  /** Tên hiển thị. */
  label: z.string().max(253),
  /** Host SSH làm bastion (API server nằm sau nó). */
  bastionHostId: z.string().min(1).max(64).optional(),
  namespace: z.string().max(63).optional(),
  /** Mở tab rồi tới thẳng đối tượng này (từ Home › Needs attention). Dùng xong thì bỏ. */
  reveal: z.object({ kind: Kind, namespace: Namespace.optional(), name: Name }).optional()
})
export type K8sClusterParams = z.infer<typeof K8sClusterParams>

export const K8sLogsParams = z.object({
  ref: ContextRef,
  bastionHostId: z.string().min(1).max(64).optional(),
  namespace: Namespace,
  /** Một pod; hoặc `selector` = mọi pod của workload; hoặc `pods` = các pod đã chọn. */
  pod: Name.optional(),
  selector: Selector.optional(),
  pods: z.array(Name).min(1).max(20).optional(),
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
  command: z.array(z.string().max(1024)).max(32).optional(),
  /** Gắn vào tiến trình chính của container (attach — container debug) thay vì chạy lệnh mới. */
  attach: z.boolean().optional(),
  /** Dòng hướng dẫn in ra đầu terminal (pod debug node: "chroot /host"…). */
  banner: z.string().max(1024).optional()
})
export type K8sTerminalParams = z.infer<typeof K8sTerminalParams>
