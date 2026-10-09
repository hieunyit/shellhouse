import { posix, win32 } from 'node:path'

export type LocalAccess = 'read' | 'write'

interface Grant {
  path: string
  /** true = cả cây thư mục (thư mục chọn trong hộp thoại, mục kéo thả); false = đúng đường dẫn. */
  tree: boolean
  access: readonly LocalAccess[]
  at: number
}

export interface LocalPathGrantOptions {
  /** Số lượt chọn nhớ tối đa (cũ nhất bị bỏ trước). */
  max?: number
  /** Lượt chọn hết hiệu lực sau chừng này (ms). */
  ttlMs?: number
  now?: () => number
  platform?: NodeJS.Platform
}

/**
 * Đường dẫn trên máy này mà NGƯỜI DÙNG đã chọn — qua hộp thoại của main (mở file, chọn thư mục,
 * lưu file) hoặc kéo thả (preload báo đường dẫn của File thật). Module trong Session Host (S3,
 * Docker) chỉ đọc / ghi đường dẫn đã được cấp ở đây: renderer bị chiếm không tự đặt được
 * `~/.bashrc` hay `~/.ssh/id_rsa` làm đích tải về / nguồn tải lên.
 */
export class LocalPathGrants {
  private grants: Grant[] = []
  private readonly max: number
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly path: typeof posix
  private readonly foldCase: boolean

  constructor(options: LocalPathGrantOptions = {}) {
    this.max = options.max ?? 500
    this.ttlMs = options.ttlMs ?? 12 * 60 * 60 * 1000
    this.now = options.now ?? Date.now
    const platform = options.platform ?? process.platform
    this.path = platform === 'win32' ? win32 : posix
    this.foldCase = platform === 'win32' || platform === 'darwin'
  }

  private normalize(path: string): string | null {
    if (!path || path.includes('\0') || !this.path.isAbsolute(path)) return null
    const resolved = this.path.resolve(path)
    return this.foldCase ? resolved.toLowerCase() : resolved
  }

  grant(path: string, access: readonly LocalAccess[], tree: boolean): void {
    const normalized = this.normalize(path)
    if (normalized === null || access.length === 0) return
    this.grants = this.grants.filter(
      (g) => !(g.path === normalized && g.tree === tree && sameAccess(g.access, access))
    )
    this.grants.push({ path: normalized, tree, access: [...access], at: this.now() })
    if (this.grants.length > this.max) this.grants.splice(0, this.grants.length - this.max)
  }

  allows(path: string, access: LocalAccess): boolean {
    const target = this.normalize(path)
    if (target === null) return false
    const now = this.now()
    this.grants = this.grants.filter((g) => now - g.at < this.ttlMs)
    return this.grants.some((g) => {
      if (!g.access.includes(access)) return false
      if (target === g.path) return true
      if (!g.tree) return false
      const prefix = g.path.endsWith(this.path.sep) ? g.path : g.path + this.path.sep
      return target.startsWith(prefix)
    })
  }
}

function sameAccess(a: readonly LocalAccess[], b: readonly LocalAccess[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x))
}
