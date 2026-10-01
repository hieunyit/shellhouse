import { delimiter, resolve, win32 } from 'node:path'
import { matchPathPattern, type ModuleManifest } from './types'

/**
 * Kiểm đường dẫn trên máy theo quyền `read-file` / `local-socket` của manifest (dùng ở main và
 * Session Host). Đường dẫn được chuẩn hoá trước (`~/.kube/../.ssh/id_rsa` không lọt qua `~/.kube/**`).
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
}

export function expandHome(path: string, home: string): string {
  return path === '~' ? home : path.startsWith('~/') ? `${home}${path.slice(1)}` : path
}

function normalize(path: string, platform: NodeJS.Platform): string {
  // Named pipe Windows (\\.\pipe\…) giữ nguyên.
  if (platform === 'win32') return path.startsWith('\\\\.\\') ? path : win32.resolve(path)
  return resolve(path)
}

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

export function localPathAllowed(
  manifest: ModuleManifest,
  kind: 'read-file' | 'write-file' | 'local-socket',
  path: string,
  ctx: PathContext
): boolean {
  const full = normalize(expandHome(path, ctx.home), ctx.platform)
  return manifest.permissions.some((p) => {
    if (p.kind !== kind) return false
    const targets = envTargets(p.path, ctx)
    if (targets)
      return targets.some((t) => normalize(expandHome(t, ctx.home), ctx.platform) === full)
    const pattern = expandHome(p.path, ctx.home)
    if (pattern.endsWith('/**')) {
      const dir = normalize(pattern.slice(0, -3), ctx.platform)
      const sep = ctx.platform === 'win32' ? '\\' : '/'
      return full.startsWith(dir + sep)
    }
    return matchPathPattern(pattern, full)
  })
}
