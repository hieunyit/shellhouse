import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Thư mục `--config` tạm cho một lần đăng nhập registry. Chỉ thông tin đăng nhập nằm riêng ở đây;
 * builder của buildx (`buildx/`) và docker context (`contexts/` + `currentContext`) trỏ về cấu hình
 * thật của người dùng — không thì `--config` rỗng làm mất builder tự tạo ("no builder … found") và
 * context đang dùng (Docker Desktop: `desktop-linux`), lệnh chạy nhầm engine.
 */

/** Tên context hợp lệ của Docker (cũng là điều kiện để chép an toàn). */
const CONTEXT_NAME = /^[A-Za-z0-9][\w.+-]*$/

/** Phần dùng chung (liên kết tới cấu hình thật). */
const SHARED = ['buildx', 'contexts'] as const

export interface TempConfig {
  path: string
  remove(): Promise<void>
}

/** Máy này: `DOCKER_CONFIG` hoặc ~/.docker. */
export async function localTempConfig(
  env: NodeJS.ProcessEnv = process.env,
  base: string = tmpdir()
): Promise<TempConfig> {
  const real = env['DOCKER_CONFIG'] || join(homedir(), '.docker')
  const path = await mkdtemp(join(base, 'shellhouse-docker-'))
  const links: string[] = []
  for (const name of SHARED) {
    const target = join(real, name)
    if (!existsSync(target)) continue
    const link = join(path, name)
    try {
      // Windows: junction không cần quyền admin như symlink thư mục.
      await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
      links.push(link)
    } catch {
      // Không tạo được liên kết → vẫn đăng nhập được, chỉ thiếu builder / context riêng.
    }
  }
  try {
    const cfg = JSON.parse(await readFile(join(real, 'config.json'), 'utf8')) as {
      currentContext?: unknown
    }
    if (typeof cfg.currentContext === 'string' && CONTEXT_NAME.test(cfg.currentContext))
      await writeFile(
        join(path, 'config.json'),
        `${JSON.stringify({ currentContext: cfg.currentContext })}\n`,
        { mode: 0o600 }
      )
  } catch {
    // Không có / hỏng config.json → context mặc định.
  }
  return {
    path,
    remove: async () => {
      // Gỡ liên kết trước: xoá đệ quy không bao giờ được đi vào cấu hình thật.
      for (const link of links) await unlink(link).catch(() => undefined)
      await rm(path, { recursive: true, force: true })
    }
  }
}

/** Cùng việc trên máy khác (server SSH, WSL) bằng `sh` — in đường dẫn thư mục ở dòng cuối. */
export const REMOTE_TEMP_CONFIG_SCRIPT = [
  'd=$(mktemp -d) || exit 1',
  'c=${DOCKER_CONFIG:-$HOME/.docker}',
  `for x in ${SHARED.join(' ')}; do if [ -e "$c/$x" ]; then ln -s "$c/$x" "$d/$x"; fi; done`,
  `ctx=$(sed -n 's/.*"currentContext"[[:space:]]*:[[:space:]]*"\\([A-Za-z0-9][A-Za-z0-9_.+-]*\\)".*/\\1/p' "$c/config.json" 2>/dev/null | head -n 1)`,
  `if [ -n "$ctx" ]; then printf '{"currentContext":"%s"}\\n' "$ctx" > "$d/config.json"; fi`,
  `printf '%s\\n' "$d"`
].join('\n')

/** Xoá thư mục trên máy khác: gỡ liên kết trước, rồi mới xoá đệ quy. */
export const REMOTE_REMOVE_SCRIPT = `rm -f -- "$1/buildx" "$1/contexts"; rm -rf -- "$1"`

export async function remoteTempConfig(
  exec: (argv: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>
): Promise<TempConfig> {
  const r = await exec(['sh', '-c', REMOTE_TEMP_CONFIG_SCRIPT])
  const path = r.stdout.trim().split('\n').pop() ?? ''
  if (r.code !== 0 || !/^\/[\w./-]+$/.test(path))
    throw new Error(`mktemp failed: ${r.stderr.trim() || path}`)
  return {
    path,
    remove: async () => {
      await exec(['sh', '-c', REMOTE_REMOVE_SCRIPT, 'sh', path])
    }
  }
}
