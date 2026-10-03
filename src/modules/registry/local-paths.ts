import { realpathSync } from 'node:fs'
import { delimiter, posix, resolve, win32 } from 'node:path'
import type { ModuleManifest } from './types'

/**
 * Kiểm đường dẫn trên máy theo quyền `read-file` / `local-socket` của manifest (dùng ở main và
 * Session Host). Đường dẫn được chuẩn hoá trước (`~/.kube/../.ssh/id_rsa` không lọt qua `~/.kube/**`).
 * Symlink: đường dẫn như viết phải khớp manifest; đích thật được phép nằm ở đâu cũng được
 * (stow / chezmoi / home-manager trỏ ~/.kube/config vào /nix/store, WSL trỏ sang /mnt/c/Users/…,
 * Rancher Desktop /var/run/docker.sock → ~/.rd/docker.sock) — TRỪ vùng nhạy cảm (sensitivePath):
 * `~/.kube/link → ~/.ssh/id_rsa` vẫn bị chặn.
 *
 * Mẫu:
 * - `~/…` = thư mục home; `*` = một đoạn không có "/"; kết thúc `/**` = mọi thứ bên trong
 * - `$DOCKER_HOST` = socket trong biến môi trường DOCKER_HOST (unix:// hoặc npipe://)
 * - `$KUBECONFIG` = các file liệt kê trong biến môi trường KUBECONFIG
 */

export interface PathContext {
  home: string
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  /** Cho test; mặc định fs.realpathSync.native. */
  realpath?: (path: string) => string
  /** Thư mục dữ liệu của app (userData) — không module nào được đọc qua symlink. */
  appData?: string
}

export function expandHome(path: string, home: string): string {
  return path === '~' ? home : path.startsWith('~/') ? `${home}${path.slice(1)}` : path
}

/** Named pipe Windows (\\.\pipe\…). */
const isPipe = (path: string): boolean => path.startsWith('\\\\.\\')

function normalize(path: string, platform: NodeJS.Platform): string {
  // Named pipe giữ nguyên.
  if (platform === 'win32') return isPipe(path) ? path : win32.resolve(path)
  return resolve(path)
}

/**
 * Đường dẫn thật (giải mọi symlink). Chưa tồn tại (file sắp ghi) → giải phần cha gần nhất có thật
 * rồi nối phần còn lại: `~/.kube/link-dir/new` với link-dir → ~/.ssh vẫn bị nhận ra.
 */
function real(path: string, ctx: PathContext): string {
  // Đường dẫn của hệ khác (test giả lập Windows trên Linux) hoặc named pipe: không giải được.
  if (isPipe(path) || (!ctx.realpath && ctx.platform !== process.platform)) return path
  const p = ctx.platform === 'win32' ? win32 : posix
  const realpath = ctx.realpath ?? ((x: string) => realpathSync.native(x))
  const tail: string[] = []
  let current = path
  for (;;) {
    try {
      const resolved = realpath(current)
      return tail.length ? p.join(resolved, ...tail.reverse()) : resolved
    } catch {
      const parent = p.dirname(current)
      if (parent === current) return path
      tail.push(p.basename(current))
      current = parent
    }
  }
}

/** Như matchPathPattern nhưng hiểu cả "\" của Windows (và không phân biệt hoa thường ở đó). */
function matchPattern(pattern: string, path: string, platform: NodeJS.Platform): boolean {
  const win = platform === 'win32'
  const re = new RegExp(
    `^${pattern
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join(win ? '[^\\\\/]*' : '[^/]*')}$`,
    win ? 'i' : ''
  )
  return re.test(path)
}

const samePath = (a: string, b: string, platform: NodeJS.Platform): boolean =>
  platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b

function envTargets(pattern: string, ctx: PathContext): string[] | null {
  if (pattern === '$DOCKER_HOST') {
    const value = ctx.env['DOCKER_HOST'] ?? ''
    if (!value) return []
    const target = value.replace(/^unix:\/\//, '').replace(/^npipe:\/\//, '')
    return [ctx.platform === 'win32' ? target.replace(/\//g, '\\') : target]
  }
  if (pattern === '$KUBECONFIG')
    return (ctx.env['KUBECONFIG'] ?? '')
      .split(ctx.platform === 'win32' ? ';' : delimiter)
      .filter(Boolean)
  return null
}

/** `full` (đã chuẩn hoá) có khớp mẫu không. `resolveLinks` = so với đường dẫn thật của mẫu. */
function matches(pattern: string, full: string, ctx: PathContext, resolveLinks: boolean): boolean {
  const fix = (path: string): string => {
    const n = normalize(expandHome(path, ctx.home), ctx.platform)
    return resolveLinks ? real(n, ctx) : n
  }
  const targets = envTargets(pattern, ctx)
  if (targets) return targets.some((t) => samePath(fix(t), full, ctx.platform))
  const expanded = expandHome(pattern, ctx.home)
  if (expanded.endsWith('/**')) {
    const dir = fix(expanded.slice(0, -3))
    const sep = ctx.platform === 'win32' ? '\\' : '/'
    const prefix = dir.endsWith(sep) ? dir : dir + sep
    return ctx.platform === 'win32'
      ? full.toLowerCase().startsWith(prefix.toLowerCase())
      : full.startsWith(prefix)
  }
  const star = expanded.indexOf('*')
  if (star === -1) return samePath(fix(expanded), full, ctx.platform)
  // Mẫu có `*`: chuẩn hoá (dấu "\" trên Windows), chỉ giải symlink phần thư mục trước `*`.
  const normalized = normalize(expanded, ctx.platform)
  const sep = ctx.platform === 'win32' ? '\\' : '/'
  const cut = normalized.lastIndexOf(sep, normalized.indexOf('*'))
  const head = cut > 0 ? normalized.slice(0, cut) : ''
  const withRealHead = resolveLinks && head ? real(head, ctx) + normalized.slice(cut) : normalized
  return matchPattern(withRealHead, full, ctx.platform)
}

/** Vùng bí mật trong home (khoá, mật khẩu, token đám mây, hồ sơ trình duyệt…). */
const SENSITIVE_IN_HOME = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.config/gcloud',
  '.docker/config.json',
  '.password-store',
  '.local/share/keyrings',
  '.netrc',
  '.git-credentials',
  '.pgpass',
  '.mozilla',
  '.config/google-chrome',
  '.config/chromium',
  '.config/BraveSoftware',
  '.config/microsoft-edge',
  'snap/firefox',
  'Library/Keychains',
  'Library/Application Support/Google/Chrome',
  'Library/Application Support/Firefox',
  'Library/Application Support/BraveSoftware',
  'Library/Application Support/Microsoft Edge',
  'AppData/Local/Google/Chrome/User Data',
  'AppData/Local/Microsoft/Edge/User Data',
  'AppData/Local/BraveSoftware',
  'AppData/Roaming/Mozilla',
  // userData của chính app (vault, CSDL) — tên theo electron-builder / package.json.
  '.config/Shellhouse',
  '.config/shellhouse',
  'Library/Application Support/Shellhouse',
  'AppData/Roaming/Shellhouse'
]
const SENSITIVE_ABSOLUTE = ['/etc/shadow', '/etc/gshadow', '/etc/sudoers', '/etc/sudoers.d']

/** `path` là `dir` hoặc nằm trong `dir` (đã chuẩn hoá cùng kiểu). */
function within(dir: string, path: string, platform: NodeJS.Platform): boolean {
  const win = platform === 'win32'
  const sep = win ? '\\' : '/'
  const a = win ? dir.toLowerCase() : dir
  const b = win ? path.toLowerCase() : path
  return b === a || b.startsWith(a.endsWith(sep) ? a : a + sep)
}

/**
 * Đường dẫn (đã chuẩn hoá) có nằm trong vùng bí mật không: khoá SSH/GPG, thông tin đăng nhập đám
 * mây, kho mật khẩu, hồ sơ trình duyệt, /etc/shadow, sudoers, userData của app. So cả dạng như
 * viết lẫn dạng đã giải symlink của từng vùng (home có thể là symlink, vd. /home → /usr/home);
 * WSL: cũng chặn /mnt/<ổ>/Users/<ai>/… tương ứng (home Windows nhìn từ Linux).
 */
export function sensitivePath(path: string, ctx: PathContext): boolean {
  const p = ctx.platform === 'win32' ? win32 : posix
  const roots = [ctx.home]
  const dirs: string[] = []
  if (ctx.platform !== 'win32') {
    const wsl = /^\/mnt\/[a-zA-Z]\/Users\/[^/]+/.exec(path)
    if (wsl) roots.push(wsl[0])
    dirs.push(...SENSITIVE_ABSOLUTE)
  }
  for (const root of roots)
    for (const rel of SENSITIVE_IN_HOME) dirs.push(p.join(root, ...rel.split('/')))
  const xdg = ctx.env['XDG_CONFIG_HOME']
  if (xdg) dirs.push(p.join(xdg, 'Shellhouse'), p.join(xdg, 'shellhouse'))
  const override = ctx.env['SHELLHOUSE_USER_DATA']
  if (override) dirs.push(override)
  if (ctx.appData) dirs.push(ctx.appData)
  return dirs.some((d) => {
    const n = normalize(d, ctx.platform)
    return within(n, path, ctx.platform) || within(real(n, ctx), path, ctx.platform)
  })
}

/** Như sensitivePath nhưng theo đường dẫn thật (đã giải symlink) của `path`. */
export function sensitiveTarget(path: string, ctx: PathContext): boolean {
  const full = normalize(expandHome(path, ctx.home), ctx.platform)
  return sensitivePath(full, ctx) || sensitivePath(real(full, ctx), ctx)
}

export function localPathAllowed(
  manifest: ModuleManifest,
  kind: 'read-file' | 'write-file' | 'local-socket',
  path: string,
  ctx: PathContext
): boolean {
  const full = normalize(expandHome(path, ctx.home), ctx.platform)
  const allowed = (target: string, resolveLinks: boolean): boolean =>
    manifest.permissions.some((p) => p.kind === kind && matches(p.path, target, ctx, resolveLinks))
  if (!allowed(full, false)) return false
  const resolved = real(full, ctx)
  // Symlink trỏ ra ngoài thư mục đã khai báo vẫn được (dotfiles manager, WSL, Rancher/Podman
  // Desktop) — chỉ chặn khi đích thật rơi vào vùng bí mật mà manifest không khai báo thẳng.
  if (resolved === full || allowed(resolved, true)) return true
  return !sensitivePath(resolved, ctx)
}
