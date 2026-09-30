/**
 * Kiểu dùng chung cho khuôn module (ADR-014). File này chỉ chứa dữ liệu tĩnh / kiểu — dùng được ở
 * mọi tiến trình (main, Session Host, renderer) mà không kéo code nặng của module nào.
 *
 * Kiểu riêng từng tiến trình: `main-types.ts`, `host-types.ts`, `renderer-types.ts`.
 */

export type ModuleCategory = 'cloud' | 'containers' | 'servers' | 'databases' | 'network' | 'other'

export const MODULE_CATEGORIES: readonly { id: ModuleCategory; title: string }[] = [
  { id: 'cloud', title: 'Cloud' },
  { id: 'containers', title: 'Containers' },
  { id: 'servers', title: 'Servers' },
  { id: 'databases', title: 'Databases' },
  { id: 'network', title: 'Network' },
  { id: 'other', title: 'Other' }
]

/** Chương trình bên ngoài module được phép gọi (3.6). */
export type ModuleBinary =
  'docker' | 'kubectl' | 'aws' | 'gcloud' | 'kubelogin' | 'gke-gcloud-auth-plugin'

/**
 * Quyền hiển thị cho người dùng (3.12.3). Phải khớp năng lực module thật sự dùng — registry kiểm
 * khi chạy (dùng năng lực không khai báo → lỗi).
 */
export type ModulePermission =
  | { kind: 'ssh-exec'; detail: string }
  /** Đường dẫn có thể chứa `*` (một đoạn bất kỳ không có "/"). */
  | { kind: 'ssh-socket'; path: string }
  | { kind: 'ssh-tunnel' }
  | { kind: 'local-socket'; path: string }
  | { kind: 'run-program'; binary: ModuleBinary }
  | { kind: 'read-file'; path: string }
  | { kind: 'network'; hosts: string }
  | { kind: 'secrets'; detail: string }

export type ModuleDetector =
  | { on: 'ssh-connected'; probe: 'unix-socket'; path: string }
  | { on: 'ssh-connected'; probe: 'command'; command: 'systemctl' | 'kubectl' | 'docker' }
  | { on: 'startup'; probe: 'local-file'; path: string }
  | { on: 'startup'; probe: 'local-socket'; path: string }

export interface ModuleManifest {
  /** Chữ thường, [a-z0-9-]; cũng là tiền tố bảng DB (`<id>_`, '-' đổi thành '_'). */
  id: string
  name: string
  /** Một dòng, hiện trên thẻ ở trang Modules (≤ 80 ký tự). */
  summary: string
  /** Mô tả dài (đoạn văn cách nhau bằng dòng trống) ở trang chi tiết. */
  description: string
  category: ModuleCategory
  /** Từ khoá tìm kiếm (tiếng Anh, chữ thường) — cả từ đồng nghĩa. */
  keywords: readonly string[]
  source: 'builtin' | 'official-download' | 'community'
  /** Phiên bản app đầu tiên có module — để gắn nhãn NEW. */
  since: string
  permissions: readonly ModulePermission[]
  detect?: readonly ModuleDetector[]
  /** Tăng khi đổi định dạng dữ liệu / giao thức của module. */
  version: number
  /** Tên icon lucide (renderer tra ra component). */
  icon: string
  enabledByDefault: boolean
  binaries?: readonly ModuleBinary[]
  contributes: {
    sidebarSection?: boolean
    tabKinds?: readonly string[]
    hostActions?: readonly string[]
    commands?: readonly { id: string; title: string }[]
    settings?: boolean
    sessionKinds?: readonly string[]
    attachToSsh?: boolean
    syncRecordTypes?: readonly string[]
  }
}

/** Tiền tố bảng DB của module. */
export function tablePrefix(moduleId: string): string {
  return `${moduleId.replace(/-/g, '_')}_`
}

/** Câu dễ hiểu cho từng quyền (trang chi tiết, hộp xác nhận khi bật lần đầu). */
export function describePermission(p: ModulePermission): string {
  switch (p.kind) {
    case 'ssh-exec':
      return p.detail
    case 'ssh-socket':
      return `Connects to ${p.path} on SSH hosts you open it for`
    case 'ssh-tunnel':
      return 'Opens tunnels through SSH hosts you choose'
    case 'local-socket':
      return `Connects to ${p.path} on this computer`
    case 'run-program':
      return `May run \`${p.binary}\` on this computer — asks first`
    case 'read-file':
      return `Reads ${p.path}`
    case 'network':
      return `Connects to ${p.hosts}`
    case 'secrets':
      return p.detail
  }
}

/** Khớp đường dẫn với mẫu có `*` (một đoạn không chứa "/"). */
export function matchPathPattern(pattern: string, path: string): boolean {
  const re = new RegExp(
    `^${pattern
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^/]*')}$`
  )
  return re.test(path)
}

/** Trạng thái của một module (main → renderer). */
export interface ModuleState {
  id: string
  enabled: boolean
  /** Người dùng đã mở thẻ / trang chi tiết (bỏ nhãn NEW). */
  seen: boolean
}
