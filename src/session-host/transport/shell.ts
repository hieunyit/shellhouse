import { existsSync } from 'node:fs'
import { findOnPath } from '../../node-shared/find-on-path'

export { findOnPath }

export interface ShellLaunch {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

interface ShellContext {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  homedir: string
  userShell: string | null
  appVersion: string
  exists?: (path: string) => boolean
}

/** Biến môi trường của app/Electron không được lọt sang shell người dùng. */
const STRIPPED_ENV =
  /^(ELECTRON_|VITE_|SHELLHOUSE_)|^(NODE_OPTIONS|NODE_ENV|CHROME_DESKTOP|GOOGLE_API_KEY)$/

/** Môi trường của app sau khi bỏ biến riêng của app/Electron (và giá trị undefined). */
export function appFreeEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && !STRIPPED_ENV.test(key)) env[key] = value
  }
  return env
}

export function buildShellEnv(ctx: ShellContext): Record<string, string> {
  const env = appFreeEnv(ctx.env)
  env['TERM'] = 'xterm-256color'
  env['COLORTERM'] = 'truecolor'
  env['TERM_PROGRAM'] = 'Shellhouse'
  env['TERM_PROGRAM_VERSION'] = ctx.appVersion
  if (ctx.platform !== 'win32') {
    env['LANG'] ??= 'en_US.UTF-8'
  }
  return env
}

/**
 * Chọn shell mặc định:
 * - Windows: pwsh (PowerShell 7) nếu có, không thì Windows PowerShell.
 * - macOS: $SHELL dạng login shell (giống Terminal.app).
 * - Linux: $SHELL → shell trong passwd → /bin/bash → /bin/sh.
 */
export function defaultShell(ctx: ShellContext): ShellLaunch {
  const exists = ctx.exists ?? existsSync
  const env = buildShellEnv(ctx)

  if (ctx.platform === 'win32') {
    const pwsh = findOnPath('pwsh.exe', ctx.env, 'win32', exists)
    return { file: pwsh ?? 'powershell.exe', args: ['-NoLogo'], cwd: ctx.homedir, env }
  }

  const candidates = [ctx.env['SHELL'], ctx.userShell, '/bin/bash', '/bin/sh']
  const file = candidates.find((c): c is string => !!c && exists(c)) ?? '/bin/sh'
  const args = ctx.platform === 'darwin' ? ['-l'] : []
  return { file, args, cwd: ctx.homedir, env }
}
