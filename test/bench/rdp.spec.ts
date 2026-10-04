import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { E2E_PASSWORD } from '../e2e/fixtures'

/**
 * Đo hiệu năng Remote Desktop trong tab với server RDP thật (mặc định bỏ qua):
 *
 *   docker run -d --name sh-xrdp -p 127.0.0.1:33890:3389 scottyhardy/docker-remote-desktop
 *   pnpm build
 *   SHELLHOUSE_TEST_RDP_SERVER=127.0.0.1:33890 SHELLHOUSE_TEST_RDP_USER=ubuntu \
 *     SHELLHOUSE_TEST_RDP_PASSWORD=ubuntu SHELLHOUSE_BENCH_RDP_DOCKER=sh-xrdp \
 *     [SHELLHOUSE_BENCH_RDP_DPR=1.5] [SHELLHOUSE_BENCH_RDP_HIDPI=1] \
 *     pnpm exec playwright test --project=bench test/bench/rdp.spec.ts
 *
 * Bộ đo gắn từ ngoài (bọc WebSocket + putImageData của trang) nên đo được cả bản cũ lẫn bản mới
 * như nhau. Kịch bản (cần container xrdp): terminal phóng to in liên tục (cuộn chữ toàn màn hình)
 * và rê chuột liên tục. In bảng kết quả ra console.
 */
const server = process.env['SHELLHOUSE_TEST_RDP_SERVER'] ?? ''
const [host = '', port = '3389'] = server.split(/:(?=\d+$)/)
const user = process.env['SHELLHOUSE_TEST_RDP_USER'] ?? 'ubuntu'
const password = process.env['SHELLHOUSE_TEST_RDP_PASSWORD'] ?? 'ubuntu'
const container = process.env['SHELLHOUSE_BENCH_RDP_DOCKER'] ?? ''
const dpr = process.env['SHELLHOUSE_BENCH_RDP_DPR'] ?? ''
const hidpi = process.env['SHELLHOUSE_BENCH_RDP_HIDPI'] === '1'
const seconds = Number(process.env['SHELLHOUSE_BENCH_RDP_SECONDS'] ?? '10')
const width = Number(process.env['SHELLHOUSE_BENCH_RDP_WIDTH'] ?? '1920')
const height = Number(process.env['SHELLHOUSE_BENCH_RDP_HEIGHT'] ?? '1080')

test.skip(
  !server || !container,
  'SHELLHOUSE_TEST_RDP_SERVER / SHELLHOUSE_BENCH_RDP_DOCKER chưa đặt'
)

interface Sample {
  inBytes: number
  outBytes: number
  inMsgs: number
  outMsgs: number
  puts: number
  pixels: number
  putMs: number
  frames: number
  busyMs: number
  longMs: number
}

/** Gắn bộ đếm vào trang (trước khi IronRDP mở WebSocket). */
async function instrument(page: Page): Promise<void> {
  await page.evaluate(() => {
    const s = {
      inBytes: 0,
      outBytes: 0,
      inMsgs: 0,
      outMsgs: 0,
      puts: 0,
      pixels: 0,
      putMs: 0,
      frames: 0,
      busyMs: 0,
      longMs: 0
    }
    const w = window as unknown as Record<string, unknown>
    w['__rdpBench'] = s
    const channel = new MessageChannel()
    const pending: number[] = []
    // Thời gian từ lúc nhận message tới khi task xử lý (giải mã + vẽ) xong; gộp phần chồng nhau.
    let lastEnd = 0
    channel.port1.onmessage = () => {
      const t0 = pending.shift()
      const now = performance.now()
      if (t0 !== undefined) s.busyMs += Math.max(0, now - Math.max(t0, lastEnd))
      lastEnd = now
    }
    const Orig = window.WebSocket
    class Counted extends Orig {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        if (String(url).includes('/rdcleanpath'))
          this.addEventListener('message', (e: MessageEvent) => {
            const data = e.data as ArrayBuffer | Blob
            s.inMsgs++
            s.inBytes += data instanceof ArrayBuffer ? data.byteLength : data.size
            pending.push(performance.now())
            channel.port2.postMessage(0)
          })
      }
      override send(data: Parameters<WebSocket['send']>[0]): void {
        s.outMsgs++
        s.outBytes +=
          typeof data === 'string'
            ? data.length
            : data instanceof Blob
              ? data.size
              : (data as ArrayBuffer).byteLength
        super.send(data)
      }
    }
    window.WebSocket = Counted
    const proto = CanvasRenderingContext2D.prototype
    const put = Reflect.get(proto, 'putImageData') as (...a: unknown[]) => void
    proto.putImageData = function (this: CanvasRenderingContext2D, ...args: unknown[]) {
      const t0 = performance.now()
      put.apply(this, args)
      s.putMs += performance.now() - t0
      s.puts++
      const img = args[0] as ImageData
      s.pixels += args.length >= 7 ? Number(args[5]) * Number(args[6]) : img.width * img.height
    }
    let lastPuts = 0
    const tick = (): void => {
      if (s.puts !== lastPuts) s.frames++
      lastPuts = s.puts
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) s.longMs += e.duration
    }).observe({ type: 'longtask', buffered: false })
  })
}

async function sample(page: Page): Promise<Sample> {
  return page.evaluate(() => ({
    ...((window as unknown as Record<string, unknown>)['__rdpBench'] as Sample)
  }))
}

/** Thời gian CPU (giây) của process trên Linux — % của MỘT nhân, không chia theo số nhân. */
function cpuSeconds(pid: number): number {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.split(' ') ?? []
    return (Number(fields[11]) + Number(fields[12])) / 100
  } catch {
    return 0
  }
}

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' })
}

test('benchmark Remote Desktop trong tab', async () => {
  test.setTimeout(300_000)
  const userData = mkdtempSync(join(tmpdir(), 'shellhouse-bench-rdp-'))
  const app = await electron.launch({
    args: ['.', ...(dpr ? [`--force-device-scale-factor=${dpr}`] : [])],
    env: {
      ...process.env,
      SHELLHOUSE_TEST_HOOKS: '1',
      SHELLHOUSE_FAST_KDF: '1',
      SHELLHOUSE_LANG: 'en',
      SHELLHOUSE_USER_DATA: userData
    }
  })
  try {
    const page = await app.firstWindow()
    await page.waitForFunction(() => 'shellhouse' in window)
    await page.evaluate((pw) => window.shellhouse.createVault(pw), E2E_PASSWORD)
    await page.evaluate(() =>
      window.shellhouse.updateSettings({
        security: { autoLockMinutes: 0 },
        moduleOptions: { suggest: false }
      })
    )
    await app.evaluate(
      ({ BrowserWindow }, size) => {
        const win = BrowserWindow.getAllWindows()[0]
        if (win?.isMaximized()) win.unmaximize()
        win?.setContentSize(size.width, size.height)
      },
      { width, height }
    )
    await page.waitForTimeout(500)
    await instrument(page)
    if (process.env['SHELLHOUSE_BENCH_RDP_DEBUG'])
      page.on('console', (m) => {
        if (m.type() === 'error' || m.type() === 'warning') console.log(`console ${m.text()}`)
      })

    await page.getByTestId('add-host').click()
    const form = page.getByTestId('host-form')
    await form.getByTestId('host-protocol-rdp').click()
    await form.getByTestId('host-hostname').fill(host)
    await form.getByTestId('host-port').fill(port)
    await form.getByTestId('host-username').fill(user)
    await form.getByTestId('host-password').fill(password)
    await form.getByTestId('host-label').fill('bench-rdp')
    if (hidpi) {
      const toggle = form.getByTestId('rdp-hidpi')
      if (await toggle.count()) await toggle.check()
    }
    await form.getByTestId('host-save').click()
    await page.locator('[data-testid="host-row"][data-host-label="bench-rdp"]').dblclick()
    const view = page.getByTestId('rdp-view')
    await view.getByTestId('rdp-view-cert-trust').click()
    await expect(view).toHaveAttribute('data-phase', 'connected', { timeout: 60_000 })
    const canvas = view.getByTestId('rdp-view-canvas')
    // Hộp đăng nhập riêng của xrdp (IronRDP không gửi cờ autologon).
    await page.waitForTimeout(3_000)
    if (process.env['SHELLHOUSE_BENCH_RDP_DEBUG']) console.log('before login', await sample(page))
    await canvas.click({ position: { x: 20, y: 20 } })
    if (process.env['SHELLHOUSE_BENCH_RDP_LOGIN'] !== 'auto') {
      // Ô mật khẩu của hộp đăng nhập xrdp (giữa màn hình, lệch +76,+65 pixel desktop).
      const b = await canvas.boundingBox()
      const [w, h] = await canvas.evaluate((el) => [
        (el as HTMLCanvasElement).width,
        (el as HTMLCanvasElement).height
      ])
      if (b)
        await page.mouse.click(
          b.x + ((w / 2 + 76) * b.width) / w,
          b.y + ((h / 2 + 65) * b.height) / h
        )
    }
    // xrdp điền sẵn tên đăng nhập, focus ở ô mật khẩu.
    if (process.env['SHELLHOUSE_BENCH_RDP_LOGIN'] !== 'auto') {
      await page.keyboard.type(password)
      await page.keyboard.press('Enter')
    }
    await page.waitForTimeout(8_000)
    if (process.env['SHELLHOUSE_BENCH_RDP_DEBUG']) console.log('after login', await sample(page))
    const info = await page.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>('[data-testid="rdp-view-canvas"]')
      const r = c?.getBoundingClientRect()
      return {
        dpr: window.devicePixelRatio,
        desktop: `${c?.width}×${c?.height}`,
        css: `${Math.round(r?.width ?? 0)}×${Math.round(r?.height ?? 0)}`
      }
    })

    const measure = async (label: string, during?: () => Promise<void>): Promise<void> => {
      const procs = await app.evaluate(({ app: a }) =>
        a.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type }))
      )
      const cpuAt = (): Map<number, number> => new Map(procs.map((m) => [m.pid, cpuSeconds(m.pid)]))
      const cpu0 = cpuAt()
      const a = await sample(page)
      const t0 = Date.now()
      // CPU của server (container) giữa kỳ đo — biết khi nào server là nút thắt.
      const serverCpu = new Promise<string>((resolve) => {
        execFile(
          'docker',
          ['stats', '--no-stream', '--format', '{{.CPUPerc}}', container],
          (_e, out) => {
            resolve(out.trim())
          }
        )
      })
      if (during) await during()
      else await page.waitForTimeout(seconds * 1000)
      const b = await sample(page)
      const secs = (Date.now() - t0) / 1000
      const cpu1 = cpuAt()
      const cpu = (type: string): number =>
        Math.round(
          (procs
            .filter((m) => m.type === type)
            .reduce((n, m) => n + (cpu1.get(m.pid) ?? 0) - (cpu0.get(m.pid) ?? 0), 0) /
            secs) *
            100
        )
      const d = (k: keyof Sample): number => (b[k] - a[k]) / secs
      const row = {
        scenario: label,
        dpr: info.dpr,
        desktop: info.desktop,
        fps: Math.round(d('frames') * 10) / 10,
        'puts/s': Math.round(d('puts')),
        'Mpx/s': Math.round(d('pixels') / 1e4) / 100,
        'in KB/s': Math.round(d('inBytes') / 1024),
        'in msg/s': Math.round(d('inMsgs')),
        'out KB/s': Math.round((d('outBytes') / 1024) * 10) / 10,
        'out msg/s': Math.round(d('outMsgs')),
        'busy %': Math.round(d('busyMs') / 10),
        'put %': Math.round(d('putMs') / 10),
        'longtask ms/s': Math.round(d('longMs')),
        'cpu renderer %': cpu('Tab'),
        'cpu gpu %': cpu('GPU'),
        'cpu utility %': cpu('Utility'),
        'cpu server': await serverCpu
      }
      console.log(`RDP-BENCH ${JSON.stringify(row)}`)
    }

    const shot = process.env['SHELLHOUSE_BENCH_RDP_SCREENSHOT']
    if (shot) await page.screenshot({ path: shot })
    // Display của phiên vừa đăng nhập (dòng cuối log sesman).
    const display = `:${
      /on display (\d+)/.exec(
        docker(
          'exec',
          container,
          'sh',
          '-c',
          'grep "Session started successfully" /var/log/xrdp-sesman.log | tail -1'
        )
      )?.[1] ?? '10'
    }`
    await measure('idle')
    const terminal = (script: string): void => {
      docker(
        'exec',
        '-d',
        '-u',
        user,
        '-e',
        `DISPLAY=${display}`,
        container,
        'xfce4-terminal',
        '--maximize',
        '--hide-menubar',
        '-x',
        'bash',
        '-c',
        script
      )
    }
    const killTerminal = (): void => {
      docker('exec', container, 'sh', '-c', 'pkill -f [x]fce4-terminal || true')
    }
    // Có nhịp: vẽ lại cả terminal 10 lần / giây — đo CPU / độ mượt khi client chưa bão hoà.
    terminal(
      'while :; do clear; ls -la --color=always /usr/lib/x86_64-linux-gnu | head -80; sleep 0.1; done'
    )
    await page.waitForTimeout(3_000)
    await measure('paced')
    killTerminal()
    await page.waitForTimeout(2_000)
    // Không nhịp: in liên tục — client bão hoà, đo thông lượng giải mã.
    terminal('while :; do ls -la --color=always /usr/lib/x86_64-linux-gnu /usr/share/doc; done')
    await page.waitForTimeout(3_000)
    // Bảng đo hiệu năng của app (Ctrl+Shift+Alt+P) — bật thì chụp lại khi cuộn xong.
    const overlayShot = process.env['SHELLHOUSE_BENCH_RDP_OVERLAY_SHOT']
    if (overlayShot) {
      await canvas.focus()
      await page.keyboard.press('Control+Shift+Alt+KeyP')
      await expect(view.getByTestId('rdp-view-perf')).toBeVisible()
    }
    // Hồ sơ CPU của renderer trong lúc cuộn (phân tích tay: node-sum theo hàm).
    const profilePath = process.env['SHELLHOUSE_BENCH_RDP_PROFILE']
    const cdp = profilePath ? await page.context().newCDPSession(page) : null
    if (cdp) {
      await cdp.send('Profiler.enable')
      await cdp.send('Profiler.start')
    }
    await measure('scroll')
    if (cdp && profilePath) {
      const { profile } = await cdp.send('Profiler.stop')
      writeFileSync(profilePath, JSON.stringify(profile))
    }
    if (overlayShot) {
      await canvas.click({ position: { x: 5, y: 5 } })
      await page.keyboard.type('x')
      await page.waitForTimeout(1_200)
      console.log(`RDP-OVERLAY ${await view.getByTestId('rdp-view-perf').innerText()}`)
      await page.screenshot({ path: overlayShot })
    }
    killTerminal()
    await page.waitForTimeout(2_000)
    const box = await canvas.boundingBox()
    if (box)
      await measure('mouse', async () => {
        const end = Date.now() + seconds * 1000
        let i = 0
        while (Date.now() < end) {
          const a = (i++ / 40) * Math.PI
          await page.mouse.move(
            box.x + box.width / 2 + Math.cos(a) * box.width * 0.3,
            box.y + box.height / 2 + Math.sin(a) * box.height * 0.3
          )
        }
      })
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true })
  }
})
