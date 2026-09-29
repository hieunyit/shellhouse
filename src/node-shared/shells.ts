import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, win32 } from 'node:path'
import { findOnPath } from './find-on-path'

/**
 * Các shell local có trên máy, để mở tab terminal theo lựa chọn (PowerShell, Command Prompt, WSL,
 * Git Bash, zsh…). Main dò và giữ danh sách; renderer chỉ gửi `id` — main tra ra file + tham số,
 * nên renderer không thể chỉ định chương trình tuỳ ý để chạy.
 */
export interface ShellProfile {
  id: string
  name: string
  kind: 'powershell' | 'cmd' | 'wsl' | 'bash' | 'posix'
  file: string
  args: string[]
}

export interface DetectDeps {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  exists: (path: string) => boolean
  readFile: (path: string) => string
  /** Danh sách bản phân phối WSL (tên), rỗng nếu không có WSL. */
  wslDistros: () => Promise<string[]>
}

/** `wsl.exe --list --quiet` in ra UTF-16LE (thường kèm BOM / ký tự NUL). */
export function parseWslList(output: Buffer): string[] {
  const text = output.includes(0) ? output.toString('utf16le') : output.toString('utf8')
  return (
    text
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .map((l) => l.replace(/\0/g, '').trim())
      // Tên bản phân phối không có dấu cách → bỏ các dòng thông báo (ví dụ "... has no installed
      // distributions") mà wsl.exe in ra cùng luồng.
      .filter((l) => /^[\w.-]{1,64}$/.test(l))
  )
}

function defaultWslDistros(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      'wsl.exe',
      ['--list', '--quiet'],
      { encoding: 'buffer', timeout: 5_000, windowsHide: true },
      (error, stdout) => {
        resolve(error ? [] : parseWslList(stdout))
      }
    )
  })
}

export const realDeps: DetectDeps = {
  platform: process.platform,
  env: process.env,
  exists: existsSync,
  readFile: (p) => readFileSync(p, 'utf8'),
  wslDistros: defaultWslDistros
}

export async function detectShells(deps: DetectDeps = realDeps): Promise<ShellProfile[]> {
  return deps.platform === 'win32' ? detectWindows(deps) : detectPosix(deps)
}

async function detectWindows(deps: DetectDeps): Promise<ShellProfile[]> {
  const root = deps.env['SystemRoot'] ?? deps.env['SYSTEMROOT'] ?? 'C:\\Windows'
  const programFiles = deps.env['ProgramFiles'] ?? 'C:\\Program Files'
  const shells: ShellProfile[] = []

  const pwsh =
    findOnPath('pwsh.exe', deps.env, 'win32', deps.exists) ??
    [win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe')].find(deps.exists)
  if (pwsh)
    shells.push({
      id: 'pwsh',
      name: 'PowerShell 7',
      kind: 'powershell',
      file: pwsh,
      args: ['-NoLogo']
    })
  const winPs = win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  shells.push({
    id: 'powershell',
    name: 'Windows PowerShell',
    kind: 'powershell',
    file: deps.exists(winPs) ? winPs : 'powershell.exe',
    args: ['-NoLogo']
  })
  const cmd = win32.join(root, 'System32', 'cmd.exe')
  shells.push({
    id: 'cmd',
    name: 'Command Prompt',
    kind: 'cmd',
    file: deps.exists(cmd) ? cmd : 'cmd.exe',
    args: []
  })

  const wsl = win32.join(root, 'System32', 'wsl.exe')
  if (deps.exists(wsl)) {
    for (const distro of await deps.wslDistros()) {
      shells.push({
        id: `wsl:${distro}`,
        name: `${distro} (WSL)`,
        kind: 'wsl',
        file: wsl,
        // Bắt đầu ở thư mục home của Linux, không phải C:\Users\...
        args: ['-d', distro, '--cd', '~']
      })
    }
  }

  const gitBash = [
    win32.join(programFiles, 'Git', 'bin', 'bash.exe'),
    win32.join(deps.env['LOCALAPPDATA'] ?? '', 'Programs', 'Git', 'bin', 'bash.exe')
  ].find(deps.exists)
  if (gitBash)
    shells.push({
      id: 'git-bash',
      name: 'Git Bash',
      kind: 'bash',
      file: gitBash,
      args: ['--login', '-i']
    })
  return shells
}

function detectPosix(deps: DetectDeps): ShellProfile[] {
  let listed: string[] = []
  try {
    listed = deps
      .readFile('/etc/shells')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('/'))
  } catch {
    // Không có /etc/shells (hiếm) → chỉ dùng $SHELL.
  }
  const login = deps.env['SHELL']
  const paths = [...new Set([...(login ? [login] : []), ...listed])].filter(deps.exists)
  const shells: ShellProfile[] = []
  const seen = new Set<string>()
  for (const file of paths) {
    const name = basename(file)
    // /bin/bash và /usr/bin/bash thường là cùng một shell → chỉ giữ cái đầu tiên.
    if (seen.has(name) || name === 'nologin' || name === 'false') continue
    seen.add(name)
    shells.push({
      id: name,
      name: file === login ? `${name} (default)` : name,
      kind: name === 'bash' ? 'bash' : 'posix',
      file,
      // macOS: login shell như Terminal.app.
      args: deps.platform === 'darwin' ? ['-l'] : []
    })
  }
  return shells
}
