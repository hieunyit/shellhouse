export interface QuickTarget {
  host: string
  port: number
  username: string
}

/**
 * Đọc chuỗi kết nối nhanh: `user@host`, `user@host:2222`, `user@[::1]:2222`, `ssh user@host -p 2222`.
 * Trả về null nếu không hợp lệ (validate lại ở main bằng zod).
 */
export function parseQuickConnect(raw: string, defaultUser?: string): QuickTarget | null {
  let text = raw.trim().replace(/^ssh\s+/, '')
  let port = 22
  const flag = /\s+-p\s*(\d+)\s*$/.exec(text)
  if (flag?.[1]) {
    port = Number(flag[1])
    text = text.slice(0, flag.index).trim()
  }
  if (!text || /\s/.test(text)) return null

  let username = defaultUser ?? ''
  const at = text.lastIndexOf('@')
  if (at !== -1) {
    username = text.slice(0, at)
    text = text.slice(at + 1)
  }

  let host = text
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(text)
  if (bracket?.[1]) {
    host = bracket[1]
    if (bracket[2]) port = Number(bracket[2])
  } else if ((text.match(/:/g) ?? []).length === 1) {
    const [h, p] = text.split(':')
    host = h ?? ''
    port = Number(p)
  }

  if (!host || !username || host.startsWith('-') || username.startsWith('-')) return null
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host, port, username }
}
