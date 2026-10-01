import { Client } from 'ssh2'
import { afterEach, describe, expect, it } from 'vitest'
import { LatencyMonitor, measureRtt } from '../../src/session-host/ssh/latency'
import { startTestSshServer, type TestSshServer } from './ssh-test-server'

let server: TestSshServer | null = null
let client: Client | null = null
afterEach(async () => {
  client?.end()
  client = null
  await server?.close()
  server = null
})

async function connected(): Promise<Client> {
  server = await startTestSshServer([{ username: 'u', password: 'p' }])
  const c = new Client()
  client = c
  await new Promise<void>((resolve, reject) => {
    c.once('ready', () => {
      resolve()
    })
    c.once('error', reject)
    c.connect({ host: '127.0.0.1', port: server?.port ?? 0, username: 'u', password: 'p' })
  })
  return c
}

describe('độ trễ SSH (keepalive có chờ trả lời)', () => {
  it('đo được RTT tới server, không chạy lệnh nào', async () => {
    const c = await connected()
    const ms = await measureRtt(c)
    expect(ms).not.toBeNull()
    expect(ms).toBeGreaterThanOrEqual(0)
    expect(ms).toBeLessThan(2000)
    // Hai lần đo liền nhau vẫn đúng thứ tự hàng đợi (không lấy nhầm phản hồi của nhau).
    const [a, b] = await Promise.all([measureRtt(c), measureRtt(c)])
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
  })

  it('theo dõi định kỳ; dừng thì không báo nữa; client không có phần bên trong ssh2 → null', async () => {
    const c = await connected()
    const seen: (number | null)[] = []
    const m = new LatencyMonitor(c, (ms) => seen.push(ms), 50)
    m.start()
    await new Promise((r) => setTimeout(r, 300))
    m.stop()
    const count = seen.length
    expect(count).toBeGreaterThanOrEqual(2)
    expect(seen.every((x) => typeof x === 'number')).toBe(true)
    await new Promise((r) => setTimeout(r, 150))
    expect(seen.length).toBe(count)
    expect(await measureRtt({} as Client)).toBeNull()
  })
})
