import { existsSync } from 'node:fs'
import { posix, win32 } from 'node:path'

/** Tìm file thực thi trong PATH (như `which`). Dùng chung cho main và Session Host. */
export function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean = existsSync
): string | null {
  const pathVar = env['PATH'] ?? env['Path'] ?? ''
  const path = platform === 'win32' ? win32 : posix
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    if (exists(candidate)) return candidate
  }
  return null
}
