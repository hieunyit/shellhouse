/** Dựng lệnh `ssh` tương đương một host đã lưu (menu "Copy SSH command"). */

export interface SshEndpoint {
  username: string | null
  hostname: string
  port: number
}

/** Bọc nháy đơn nếu cần (POSIX shell); chuỗi an toàn thì giữ nguyên cho dễ đọc. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9@%_+=:,./-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function endpoint(e: SshEndpoint, withPort: boolean): string {
  const target = `${e.username ? `${e.username}@` : ''}${e.hostname}`
  return withPort && e.port !== 22 ? `${target}:${e.port}` : target
}

export function sshCommand(
  host: SshEndpoint,
  options: {
    jumps?: readonly SshEndpoint[]
    proxyJump?: string | null
    keyFile?: string | null
  } = {}
): string {
  const args = ['ssh']
  if (options.keyFile) args.push('-i', shellQuote(options.keyFile))
  const jump =
    options.jumps && options.jumps.length > 0
      ? options.jumps.map((j) => endpoint(j, true)).join(',')
      : (options.proxyJump ?? '')
  if (jump) args.push('-J', shellQuote(jump))
  if (host.port !== 22) args.push('-p', String(host.port))
  args.push(shellQuote(endpoint(host, false)))
  return args.join(' ')
}
