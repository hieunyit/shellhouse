import type { Client } from 'ssh2'

/**
 * Tương đương ssh-copy-id. Câu lệnh cố định; public key đi qua STDIN, không bao giờ ghép vào lệnh.
 * - không thêm trùng (grep -qxF)
 * - thêm dòng mới trước nếu authorized_keys không kết thúc bằng xuống dòng
 * - quyền 700/600 (umask 077)
 */
export const DEPLOY_SCRIPT = [
  'umask 077',
  'mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh" && touch "$HOME/.ssh/authorized_keys" || exit 2',
  'f="$HOME/.ssh/authorized_keys"',
  'IFS= read -r key || [ -n "$key" ] || exit 3',
  'if grep -qxF -- "$key" "$f"; then echo SHELLHOUSE_KEY_EXISTS; exit 0; fi',
  'if [ -s "$f" ] && [ "$(tail -c 1 "$f" | od -An -c | tr -d " ")" != "\\\\n" ]; then echo >> "$f"; fi',
  'printf "%s\\n" "$key" >> "$f" && chmod 600 "$f" && echo SHELLHOUSE_KEY_ADDED'
].join('; ')

export type DeployResult = { status: 'added' | 'exists' } | { status: 'error'; message: string }

export function deployPublicKey(
  client: Client,
  publicKey: string,
  timeoutMs = 15_000
): Promise<DeployResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ status: 'error', message: 'The server did not respond' })
    }, timeoutMs)
    client.exec(`sh -c '${DEPLOY_SCRIPT.replace(/'/g, `'\\''`)}'`, (error, stream) => {
      if (error) {
        clearTimeout(timer)
        resolve({
          status: 'error',
          message: `Could not run a command on the server: ${error.message}`
        })
        return
      }
      let out = ''
      let err = ''
      stream.on('data', (d: Buffer) => (out += d.toString()))
      stream.stderr.on('data', (d: Buffer) => (err += d.toString()))
      stream.on('close', (code: number | null) => {
        clearTimeout(timer)
        if (out.includes('SHELLHOUSE_KEY_ADDED')) resolve({ status: 'added' })
        else if (out.includes('SHELLHOUSE_KEY_EXISTS')) resolve({ status: 'exists' })
        else
          resolve({
            status: 'error',
            message: `Adding the key failed (code ${String(code)})${err ? `: ${err.trim().slice(0, 300)}` : ' — does the server use a POSIX shell?'}`
          })
      })
      stream.end(`${publicKey}\n`)
    })
  })
}
