export interface QuickTarget {
  host: string
  port: number
  username: string
  /** `-J <jump>` của lệnh ssh: tên / địa chỉ jump host (app tra trong host đã lưu). */
  jump?: string
}

/**
 * Đọc chuỗi kết nối nhanh: `user@host`, `user@host:2222`, `user@[::1]:2222`, hoặc nguyên lệnh
 * `ssh -p 2222 -J bastion user@host` (cờ -p / -J ở trước hoặc sau đích).
 * Trả về null nếu không hợp lệ (validate lại ở main bằng zod).
 */
export function parseQuickConnect(raw: string, defaultUser?: string): QuickTarget | null {
  const words = raw.trim().split(/\s+/).filter(Boolean)
  if (words[0] === 'ssh') words.shift()
  let port = 22
  let jump: string | undefined
  const rest: string[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i] ?? ''
    const flag = /^-(p|J)(.*)$/.exec(w)
    if (!flag) {
      rest.push(w)
      continue
    }
    const value = flag[2] || words[++i]
    if (!value) return null
    if (flag[1] === 'p') {
      if (!/^\d+$/.test(value)) return null
      port = Number(value)
    } else {
      if (value.startsWith('-') || jump !== undefined) return null
      jump = value
    }
  }
  if (rest.length !== 1) return null
  let text = rest[0] ?? ''
  if (!text) return null

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
  return { host, port, username, ...(jump ? { jump } : {}) }
}
