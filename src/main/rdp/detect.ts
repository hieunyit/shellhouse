import { posix, win32 } from 'node:path'
import { t } from '@shared/i18n'
import type { RdpClientKind } from '@shared/rdp'
import type { FreeRdpMajor } from './argv'

/** Client RDP tìm thấy trên máy. */
export interface DetectedClient {
  kind: RdpClientKind
  /** Tên hiển thị ("mstsc", "xfreerdp3", "Windows App"…). */
  name: string
  /** Đường dẫn chương trình (macOS: thư mục .app). */
  path: string
  /** Chỉ có với FreeRDP. */
  freerdpMajor?: FreeRdpMajor
  /** Windows: cmdkey.exe đi kèm (để cấp mật khẩu cho mstsc). */
  cmdkey?: string
}

export interface DetectDeps {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  home: string
  /** File / thư mục có tồn tại (và chạy được, với file). */
  exists(path: string): boolean
  /** Chạy một lệnh ngắn, trả stdout (null = lỗi / quá giờ). */
  output(file: string, args: string[]): Promise<string | null>
}

/** Quy tắc đường dẫn theo nền tảng ĐÍCH (không theo máy đang chạy — test giả lập OS khác). */
function pathsFor(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix
}

/** Tìm chương trình trong PATH (không qua shell, không dùng `which`). */
export function findInPath(
  name: string,
  deps: Pick<DetectDeps, 'env' | 'exists'> & { platform?: NodeJS.Platform }
): string | null {
  const paths = pathsFor(deps.platform ?? process.platform)
  for (const dir of (deps.env['PATH'] ?? '').split(paths.delimiter)) {
    if (!dir) continue
    const full = paths.join(dir, name)
    if (deps.exists(full)) return full
  }
  return null
}

/** "This is FreeRDP version 3.5.1 (…)" → 3. */
export function parseFreeRdpMajor(text: string | null, fallback: FreeRdpMajor): FreeRdpMajor {
  const m = text ? /version\s+(\d+)\./i.exec(text) : null
  if (!m) return fallback
  return Number(m[1]) >= 3 ? 3 : 2
}

const MAC_APPS = [
  { name: 'Windows App', bundle: 'Windows App.app' },
  { name: 'Microsoft Remote Desktop', bundle: 'Microsoft Remote Desktop.app' }
] as const

/** Client RDP tốt nhất có trên máy; null = chưa cài. */
export async function detectRdpClient(deps: DetectDeps): Promise<DetectedClient | null> {
  const paths = pathsFor(deps.platform)
  if (deps.platform === 'win32') {
    const root = deps.env['SystemRoot'] ?? deps.env['windir'] ?? 'C:\\Windows'
    // Đường dẫn tuyệt đối trong System32 — không tra PATH (chống chương trình giả mạo cùng tên).
    const mstsc = paths.join(root, 'System32', 'mstsc.exe')
    if (!deps.exists(mstsc)) return null
    const cmdkey = paths.join(root, 'System32', 'cmdkey.exe')
    return {
      kind: 'mstsc',
      name: 'mstsc',
      path: mstsc,
      ...(deps.exists(cmdkey) ? { cmdkey } : {})
    }
  }
  if (deps.platform === 'darwin') {
    for (const dir of ['/Applications', paths.join(deps.home, 'Applications')]) {
      for (const app of MAC_APPS) {
        const path = paths.join(dir, app.bundle)
        if (deps.exists(path)) return { kind: 'windows-app', name: app.name, path }
      }
    }
    return null
  }
  for (const [bin, fallback] of [
    ['xfreerdp3', 3],
    ['xfreerdp', 2]
  ] as const) {
    const path = findInPath(bin, deps)
    if (!path) continue
    const major = parseFreeRdpMajor(await deps.output(path, ['--version']), fallback)
    return { kind: 'xfreerdp', name: bin, path, freerdpMajor: major }
  }
  const remmina = findInPath('remmina', deps)
  if (remmina) return { kind: 'remmina', name: 'Remmina', path: remmina }
  return null
}

/** Hướng dẫn cài client khi chưa có. */
export function installHint(platform: NodeJS.Platform): string {
  if (platform === 'win32')
    return t(
      'Remote Desktop Connection (mstsc) ships with Windows. If it was removed, add it back in Settings → System → Optional features.'
    )
  if (platform === 'darwin')
    return t('Install “Windows App” (formerly Microsoft Remote Desktop) from the Mac App Store.')
  return t(
    'Install FreeRDP (for example: sudo apt install freerdp3-x11, sudo dnf install freerdp) or Remmina.'
  )
}
