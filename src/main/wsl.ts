import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

/** Một bản phân phối WSL (Ubuntu, Debian…) trên máy Windows này. */
export interface WslDistro {
  name: string
  running: boolean
  /** 1 hoặc 2 (WSL 2: cổng mở trong distro dùng được qua localhost). */
  version: number
}

/**
 * Đầu ra của `wsl.exe -l -v`: UTF-16LE khi gọi từ Windows (UTF-8 khi WSL_UTF8=1 / gọi từ trong
 * WSL). Bỏ distro nội bộ của Docker Desktop (docker-desktop, docker-desktop-data).
 */
export function parseWslList(out: Buffer): WslDistro[] {
  const text = out.includes(0) ? out.toString('utf16le') : out.toString('utf8')
  const rows: WslDistro[] = []
  for (const raw of text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .slice(1)) {
    const parts = raw
      .replace(/^\s*\*?\s*/, '')
      .trim()
      .split(/\s+/)
    const [name, state, version] = parts
    if (!name || !state || !/^[\w.-]{1,64}$/.test(name)) continue
    if (name.startsWith('docker-desktop')) continue
    rows.push({ name, running: state.toLowerCase() === 'running', version: Number(version) || 2 })
  }
  return rows
}

let cache: { at: number; list: Promise<WslDistro[]> } | null = null

/** Distro WSL (nhớ 5 giây). Không phải Windows / không có WSL → []. Không khởi động distro nào. */
export function listWslDistros(): Promise<WslDistro[]> {
  if (process.platform !== 'win32') return Promise.resolve([])
  if (cache && Date.now() - cache.at < 5000) return cache.list
  const list = new Promise<WslDistro[]>((resolve) => {
    execFile(
      'wsl.exe',
      ['-l', '-v'],
      { encoding: 'buffer', windowsHide: true, timeout: 5000 },
      (error, stdout) => {
        resolve(error ? [] : parseWslList(stdout))
      }
    )
  })
  cache = { at: Date.now(), list }
  return list
}

/** File trong distro (đường dẫn Linux) có tồn tại không — chỉ hỏi distro đang chạy. */
export function wslFileExists(distro: string, path: string): boolean {
  return existsSync(`\\\\wsl$\\${distro}${path.replace(/\//g, '\\')}`)
}
