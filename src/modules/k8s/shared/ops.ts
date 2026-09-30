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
  z.object({ op: z.literal('discover'), namespace: Namespace.optional() }),
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
  z.object({ op: z.literal('delete'), kind: Kind, namespace: Namespace.optional(), name: Name }),
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
  z.object({
    op: z.literal('logs.subscribe'),
    namespace: Namespace,
    pod: Name,
    container: z.string().max(253).optional(),
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
  return ['apply', 'delete', 'scale', 'rolloutRestart', 'rolloutPause', 'edit'].includes(op.op)
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
  pod: Name,
  container: z.string().max(253).optional()
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
