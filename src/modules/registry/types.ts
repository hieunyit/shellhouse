import { t } from '@shared/i18n'
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
  | 'docker'
  | 'kubectl'
  | 'aws'
  | 'gcloud'
  | 'kubelogin'
  | 'gke-gcloud-auth-plugin'
  /** Quét lỗ hổng image / cấu hình manifest — chỉ gọi, không tự viết engine quét. */
  | 'trivy'
  /** Windows: chạy lệnh trong một bản phân phối WSL (`wsl.exe -d <distro> -e …`). */
  | 'wsl'

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
  /** Sửa file trên máy (xoá context khỏi kubeconfig…) — luôn ghi an toàn (file tạm → đổi tên). */
  | { kind: 'write-file'; path: string }
  | { kind: 'network'; hosts: string }
  | { kind: 'secrets'; detail: string }
  /** Đọc file người dùng tự chọn trong hộp thoại của hệ điều hành (và file chúng trỏ tới). */
  | { kind: 'pick-file'; detail: string }

export type ModuleDetector =
  | { on: 'ssh-connected'; probe: 'unix-socket'; path: string }
  | { on: 'ssh-connected'; probe: 'command'; command: 'systemctl' | 'kubectl' | 'docker' }
  | { on: 'startup'; probe: 'local-file'; path: string }
  | { on: 'startup'; probe: 'local-socket'; path: string }
  /** Windows: file (đường dẫn Linux) có trong một distro WSL đang chạy. */
  | { on: 'startup'; probe: 'wsl-file'; path: string }

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
      // Câu `detail` viết sẵn trong manifest — bản dịch nằm trong src/shared/i18n/vi/core.ts.
      return t(p.detail)
    case 'ssh-socket':
      return t('Connects to {path} on SSH hosts you open it for', { path: p.path })
    case 'ssh-tunnel':
      return t('Opens tunnels through SSH hosts you choose')
    case 'local-socket':
      return p.path === '$DOCKER_HOST'
        ? t('Connects to the Docker socket set in DOCKER_HOST')
        : t('Connects to {path} on this computer', { path: p.path })
    case 'run-program':
      return p.binary === 'wsl'
        ? t('May run commands inside your WSL distributions (Windows) — asks first')
        : t('May run `{program}` on this computer — asks first', { program: p.binary })
    case 'read-file':
      return p.path === '$KUBECONFIG'
        ? t('Reads the files listed in KUBECONFIG')
        : t('Reads {path}', { path: p.path.replace(/\/\*\*$/, '/') })
    case 'write-file':
      return p.path === '$KUBECONFIG'
        ? t('Changes the files listed in KUBECONFIG when you ask it to (a backup is kept)')
        : t('Changes files in {path} when you ask it to (a backup is kept)', {
            path: p.path.replace(/\/\*\*$/, '/')
          })
    case 'network':
      return t('Connects to {hosts}', { hosts: t(p.hosts) })
    case 'secrets':
    case 'pick-file':
      return t(p.detail)
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
