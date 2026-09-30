import type { Client } from 'ssh2'
import { shellQuote } from '../../node-shared/shell-quote'
import type { ModuleDetector } from '../../modules/registry/types'

/**
 * Dò dấu hiệu của module trên server vừa kết nối (ADR-014 mục 3.12.4): một lệnh sh nhẹ, chỉ đọc
 * (`test -S`, `command -v`), in id module có dấu hiệu. Không ghi gì lên server.
 */
export function probeCommand(
  targets: readonly { id: string; detect: readonly ModuleDetector[] }[]
): string | null {
  const parts: string[] = []
  for (const t of targets)
    for (const d of t.detect) {
      if (d.on !== 'ssh-connected') continue
      const check =
        d.probe === 'unix-socket'
          ? shellQuote(['test', '-S', d.path])
          : `${shellQuote(['command', '-v', d.command])} >/dev/null 2>&1`
      parts.push(`${check} && echo ${shellQuote([t.id])}`)
    }
  return parts.length ? `${parts.join('; ')}; true` : null
}

export function runProbe(client: Client, command: string, timeoutMs = 10_000): Promise<string[]> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve([])
    }, timeoutMs)
    client.exec(command, (error, stream) => {
      if (error) {
        clearTimeout(timer)
        resolve([])
        return
      }
      let out = ''
      stream.on('data', (chunk: Buffer) => {
        if (out.length < 4096) out += chunk.toString('utf8')
      })
      stream.stderr.on('data', () => undefined)
      stream.on('close', () => {
        clearTimeout(timer)
        resolve([
          ...new Set(
            out
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
          )
        ])
      })
      stream.end()
    })
  })
}
