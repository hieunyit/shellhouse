import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'

/**
 * Dựng ma trận server SSH thật bằng Docker (docker-compose.yml) cho `pnpm test:compat`.
 * Key thử nghiệm tạo mới mỗi lần bằng ssh-keygen (ed25519 + RSA 3072) — không lưu vào repo.
 * KEEP_COMPAT=1: giữ container sau khi chạy xong (để gỡ lỗi / chạy lại nhanh).
 */
const DIR = join(__dirname)
const RUN = join(DIR, '.run')
export const PORTS = [22741, 22821, 22961, 22991, 22201, 22101, 22301, 22401]

function compose(...args: string[]): void {
  execFileSync('docker', ['compose', '-f', join(DIR, 'docker-compose.yml'), ...args], {
    // Không chia stdin với vitest (docker compose có thể đóng / chiếm nó → vitest thoát lặng lẽ).
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: 20 * 60_000
  })
}

function banner(port: number): Promise<string> {
  return new Promise((resolve) => {
    const sock = connect(port, '127.0.0.1')
    let data = ''
    const done = (v: string): void => {
      sock.destroy()
      resolve(v)
    }
    sock.setTimeout(2_000, () => {
      done('')
    })
    sock.on('data', (c: Buffer) => {
      data += c.toString()
      if (data.includes('\n')) done(data.trim())
    })
    sock.on('error', () => {
      done('')
    })
    // docker-proxy nhận kết nối rồi đóng ngay khi sshd chưa sẵn sàng. Không bắt 'close' thì
    // Promise treo, event loop rỗng → Node (và vitest) thoát lặng lẽ với mã 0.
    sock.on('close', () => {
      done(data.trim())
    })
  })
}

async function waitForServers(): Promise<void> {
  const deadline = Date.now() + 60_000
  for (const port of PORTS) {
    while (!(await banner(port)).startsWith('SSH-')) {
      if (Date.now() > deadline) throw new Error(`Server ở cổng ${port} không lên`)
      await new Promise((r) => setTimeout(r, 500))
    }
  }
}

/** COMPAT_EXTERNAL=1: dùng server + key đã có (.run/), ví dụ chạy trên Windows tới Docker trong WSL. */
const external = process.env['COMPAT_EXTERNAL'] === '1'

export async function setup(): Promise<void> {
  if (external) {
    await waitForServers()
    return
  }
  rmSync(RUN, { recursive: true, force: true })
  mkdirSync(RUN, { recursive: true })
  for (const [type, bits] of [
    ['ed25519', []],
    ['rsa', ['-b', '3072']]
  ] as const) {
    execFileSync('ssh-keygen', [
      '-q',
      '-t',
      type,
      ...bits,
      '-N',
      '',
      '-C',
      `compat-${type}`,
      '-f',
      join(RUN, `id_${type}`)
    ])
  }
  writeFileSync(
    join(RUN, 'authorized_keys'),
    ['ed25519', 'rsa'].map((t) => readFileSync(join(RUN, `id_${t}.pub`), 'utf8')).join('')
  )
  compose('up', '-d', '--build', '--force-recreate', '--remove-orphans')
  await waitForServers()
}

export function teardown(): void {
  if (!external && process.env['KEEP_COMPAT'] !== '1') compose('down', '--remove-orphans')
}
