import { spawn as spawnChild } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { findOnPath } from '../../node-shared/find-on-path'
import type { RunningProgram } from '../../modules/registry/host-types'
import type { Transport, TransportCallbacks } from '../transport/types'
import { LocalPty } from '../transport/local-pty'
import { appFreeEnv } from '../transport/shell'

/**
 * Chạy chương trình trên máy cho module (ADR-014 mục 3.6): tìm theo tên trong PATH (và vài chỗ cài
 * quen thuộc — app mở từ Dock / Start không có PATH của shell), không qua shell, args là mảng.
 */

/** Chỗ cài hay gặp mà PATH của app GUI thường thiếu. */
const EXTRA_DIRS: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  darwin: [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/Applications/Docker.app/Contents/Resources/bin'
  ],
  linux: ['/usr/local/bin', '/usr/bin', '/snap/bin'],
  win32: ['C:\\Program Files\\Docker\\Docker\\resources\\bin', 'C:\\Windows\\System32']
}

export function findProgram(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const platform = process.platform
  const file = platform === 'win32' ? `${name}.exe` : name
  const found = findOnPath(file, env, platform)
  if (found) return found
  const sep = platform === 'win32' ? '\\' : '/'
  for (const dir of EXTRA_DIRS[platform] ?? []) {
    const candidate = `${dir}${sep}${file}`
    if (existsSync(candidate)) return candidate
  }
  return null
}

const hashCache = new Map<string, Promise<string>>()

/**
 * SHA-256 của file chương trình (nhớ lựa chọn "cho phép" theo hash — 3.6). Nhớ theo đường dẫn +
 * kích thước + thời điểm sửa: không băm lại file 100 MB mỗi lần chạy.
 */
export async function sha256File(path: string): Promise<string> {
  const info = await stat(path)
  const key = `${path}|${info.size}|${info.mtimeMs}`
  let hash = hashCache.get(key)
  if (!hash) {
    hash = hashFile(path)
    hashCache.set(key, hash)
    hash.catch(() => hashCache.delete(key))
  }
  return hash
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => {
        resolve(hash.digest('hex'))
      })
  })
}

/**
 * Biến môi trường cho phép chèn code vào tiến trình (thư viện nạp trước, tuỳ chọn trình thông dịch,
 * file khởi động của shell). Env do module truyền vào có thể đến từ file cấu hình người khác gửi
 * (ví dụ `exec.env` trong kubeconfig) → bỏ những biến này. Biến thường (BROWSER, AWS_PROFILE…) giữ.
 */
const INJECTION_ENV =
  /^(LD_|DYLD_)|^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|PYTHONSTARTUP|PYTHONPATH|PYTHONHOME|PYTHONINSPECT|PERL5OPT|PERL5LIB|PERLLIB|RUBYOPT|RUBYLIB|BASH_ENV|ENV|SHELLOPTS|BASHOPTS|PS4|GCONV_PATH|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS)$/

/** Env cho chương trình của module: env của app (đã bỏ biến của app/Electron) + env an toàn của module. */
export function programEnv(
  extra?: Readonly<Record<string, string>>,
  base: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const env = appFreeEnv(base)
  for (const [key, value] of Object.entries(extra ?? {})) {
    // Windows không phân biệt hoa thường tên biến.
    if (typeof value === 'string' && !INJECTION_ENV.test(key.toUpperCase())) env[key] = value
  }
  return env
}

export function spawnProgram(
  path: string,
  args: readonly string[],
  signal?: AbortSignal,
  env?: Record<string, string>
): { program: RunningProgram; stdin: NodeJS.WritableStream } {
  const child = spawnChild(path, [...args], {
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: programEnv(env)
  })
  const exitListeners: ((code: number | null) => void)[] = []
  let exited = false
  let exitCode: number | null = null
  const onAbort = (): void => {
    child.kill()
  }
  const finish = (code: number | null): void => {
    if (exited) return
    exited = true
    signal?.removeEventListener('abort', onAbort)
    exitCode = code
    for (const l of exitListeners) l(code)
  }
  child.on('error', () => {
    finish(null)
  })
  child.on('close', (code) => {
    finish(code)
  })
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  // Chương trình thoát trước khi đọc hết stdin → EPIPE; không để thành lỗi không bắt.
  child.stdin.on('error', () => undefined)
  const program: RunningProgram = {
    onStdout: (l) => child.stdout.on('data', l),
    onStderr: (l) => child.stderr.on('data', l),
    onExit: (l) => {
      if (exited) l(exitCode)
      else exitListeners.push(l)
    },
    kill: () => {
      if (!exited) child.kill()
    }
  }
  return { program, stdin: child.stdin }
}

export function openProgramPty(
  path: string,
  args: readonly string[],
  size: { cols: number; rows: number },
  cb: TransportCallbacks
): Transport {
  return new LocalPty(
    {
      file: path,
      args: [...args],
      cwd: homedir(),
      env: { ...programEnv(), TERM: 'xterm-256color' }
    },
    size.cols,
    size.rows,
    {
      onData: (data) => {
        cb.onData(data)
      },
      onExit: (exit) => {
        cb.onExit(exit)
      }
    }
  )
}
