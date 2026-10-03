import { existsSync, globSync, readFileSync } from 'node:fs'
import { isAbsolute, join, normalize } from 'node:path'
// Chỉ dùng named export: gói này có cả bản ESM lẫn CJS, và default export của hai bản KHÁC nhau
// (bản CJS mà Electron nạp trả về namespace) → `SSHConfig.DIRECTIVE` sẽ là undefined.
import { LineType, parse, type SSHConfig } from 'ssh-config'
import { Hostname, Username, type ImportCandidate } from '@shared/hosts'
import { t } from '@shared/i18n'

const MAX_INCLUDE_DEPTH = 5

function expandHome(path: string, home: string): string {
  const expanded = path.replace(/^~(?=$|[\\/])/, home).replace(/%d/g, home)
  // Chuẩn hoá sau khi ghép: trên Windows `~/.ssh/id` thành `C:\Users\me\.ssh\id`, không lẫn `/`.
  return expanded === path ? path : normalize(expanded)
}

/**
 * Thay mỗi dòng `Include` bằng nội dung file tương ứng (có glob, đường dẫn tương đối tính từ
 * ~/.ssh như OpenSSH). Đủ cho cách dùng phổ biến; Include nằm trong khối Host được chèn tại chỗ.
 */
export function expandIncludes(text: string, home: string, depth = 0): string {
  if (depth >= MAX_INCLUDE_DEPTH) return text
  return text
    .split(/\r?\n/)
    .map((line) => {
      const match = /^\s*Include\s+(.+?)\s*$/i.exec(line)
      if (!match?.[1]) return line
      const parts = match[1].split(/\s+/)
      const contents: string[] = []
      for (const raw of parts) {
        const pattern = expandHome(raw.replace(/^"|"$/g, ''), home)
        const absolute = isAbsolute(pattern) ? pattern : join(home, '.ssh', pattern)
        for (const file of globSync(absolute).sort()) {
          try {
            contents.push(expandIncludes(readFileSync(file, 'utf8'), home, depth + 1))
          } catch {
            // File không đọc được — bỏ qua như OpenSSH.
          }
        }
      }
      return contents.join('\n')
    })
    .join('\n')
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function hostAliases(config: SSHConfig): string[] {
  const aliases: string[] = []
  for (const line of config) {
    if (line.type !== LineType.DIRECTIVE || line.param.toLowerCase() !== 'host') continue
    // Dòng "Host" trống hoặc lạ: thư viện có thể trả mảng chứa phần tử undefined (fuzz tìm ra).
    const raw: unknown = line.value
    const values = Array.isArray(raw)
      ? raw.map((v: unknown) =>
          typeof v === 'object' && v !== null && 'val' in v ? String(v.val) : ''
        )
      : typeof raw === 'string'
        ? raw.split(/\s+/)
        : []
    for (const v of values) {
      // Bỏ pattern (không phải host cụ thể) và phủ định.
      if (v && !/[*?!]/.test(v) && !aliases.includes(v)) aliases.push(v)
    }
  }
  return aliases
}

export interface ScanOptions {
  home: string
  existingLabels: readonly string[]
  defaultUser: string
}

/** Đọc cấu hình, trả về danh sách host để người dùng xem trước. Không chạy bất kỳ lệnh nào. */
export function scanSshConfig(text: string, options: ScanOptions): ImportCandidate[] {
  // Thư viện ssh-config crash khi một từ khoá không có giá trị (ví dụ dòng "Host" trống — fuzz tìm ra).
  // OpenSSH cũng coi dòng như vậy là lỗi → bỏ đi trước khi parse.
  const cleaned = expandIncludes(text, options.home)
    .split(/\r?\n/)
    .filter((line) => !/^\s*[A-Za-z]+\s*=?\s*$/.test(line))
    .join('\n')
  let config: SSHConfig
  try {
    config = parse(cleaned)
  } catch (error) {
    throw new Error(
      t('Could not read ~/.ssh/config: {error}', {
        error: error instanceof Error ? error.message : String(error)
      }),
      {
        cause: error
      }
    )
  }
  const existing = new Set(options.existingLabels.map((l) => l.toLowerCase()))

  return hostAliases(config).map((alias): ImportCandidate => {
    // matchExec: false — KHÔNG thực thi `Match exec "..."` trong file cấu hình.
    let computed: Record<string, string | string[]>
    try {
      computed = config.compute(alias, { ignoreCase: true, matchExec: false })
    } catch {
      return {
        alias,
        hostname: alias,
        port: 22,
        username: null,
        keyFile: null,
        proxyJump: null,
        duplicate: false,
        problem: t('Could not read this entry')
      }
    }
    const hostname = first(computed['hostname']) ?? alias
    const portRaw = first(computed['port'])
    const port = portRaw ? Number(portRaw) : 22
    const username = first(computed['user']) ?? options.defaultUser
    const identity = first(computed['identityfile'])
    const keyFile = identity ? expandHome(identity, options.home) : null
    const proxyJump = first(computed['proxyjump']) ?? null

    let problem: string | null = null
    if (!Hostname.safeParse(hostname).success)
      problem = t('Invalid hostname: {value}', { value: hostname })
    else if (!Number.isInteger(port) || port < 1 || port > 65535)
      problem = t('Invalid port: {value}', { value: portRaw ?? '' })
    else if (!Username.safeParse(username).success)
      problem = t('Invalid username: {value}', { value: username })
    else if (keyFile && !existsSync(keyFile))
      problem = t('IdentityFile not found: {path}', { path: keyFile })

    return {
      alias,
      hostname,
      port: Number.isInteger(port) ? port : 22,
      username,
      keyFile,
      proxyJump: proxyJump && proxyJump.toLowerCase() !== 'none' ? proxyJump : null,
      duplicate: existing.has(alias.toLowerCase()),
      problem
    }
  })
}
