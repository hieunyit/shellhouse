import type { Client } from 'ssh2'
import {
  isWindowsSshServer,
  OS_DETECT_SCRIPT,
  osFromDetectOutput,
  osFromWindowsVer,
  type HostOs
} from '@shared/host-os'

/** Dò lâu hơn thế này → bỏ (server chậm / shell lạ treo) — không bao giờ chặn phiên. */
export const OS_DETECT_TIMEOUT_MS = 5000
/** os-release + uname chỉ vài trăm byte; output lạ lớn dần → dừng. */
const MAX_OUTPUT = 16 * 1024

/** Chạy một lệnh qua kênh exec riêng, gom stdout (giới hạn cỡ / thời gian). null = lỗi / hết giờ. */
function run(client: Client, command: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false
    let output = ''
    let channel: { close: () => void } | null = null
    const finish = (value: string | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        channel?.close()
      } catch {
        // Kênh đã đóng.
      }
      resolve(value)
    }
    const timer = setTimeout(() => {
      finish(null)
    }, timeoutMs)
    try {
      client.exec(command, (error, ch) => {
        if (error) {
          finish(null)
          return
        }
        if (done) {
          ch.close()
          return
        }
        channel = ch
        ch.on('data', (chunk: Buffer) => {
          output += chunk.toString('utf8')
          if (output.length > MAX_OUTPUT) finish(output.slice(0, MAX_OUTPUT))
        })
        // Không đọc stderr thì cửa sổ kênh có thể đầy → lệnh treo.
        ch.stderr.on('data', () => undefined)
        ch.on('close', () => {
          finish(output)
        })
      })
    } catch {
      // Kết nối vừa đóng.
      finish(null)
    }
  })
}

/**
 * Nhận diện hệ điều hành server qua MỘT kênh exec riêng (không đụng shell của người dùng, không hỏi
 * gì, không cần quyền). Gọi song song với shell; lỗi / hết giờ / không nhận ra → null.
 */
export async function detectServerOs(
  client: Client,
  timeoutMs = OS_DETECT_TIMEOUT_MS
): Promise<HostOs | null> {
  // ssh2: chuỗi phiên bản phần mềm của server ("OpenSSH_for_Windows_9.5").
  const software = (client as unknown as { _remoteVer?: string })._remoteVer
  if (isWindowsSshServer(software)) {
    // Shell mặc định là cmd hoặc PowerShell — `cmd /c ver` chạy được ở cả hai.
    const ver = await run(client, 'cmd /c ver', timeoutMs)
    return osFromWindowsVer(ver ?? '')
  }
  // Bọc trong sh -c: shell đăng nhập có thể là csh / fish (cú pháp chuyển hướng khác).
  const output = await run(client, `sh -c '${OS_DETECT_SCRIPT}'`, timeoutMs)
  if (output === null) return null
  return osFromDetectOutput(output)
}
