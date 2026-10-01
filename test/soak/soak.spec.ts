import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { connect, createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { startChaosProxy } from '../integration/chaos-proxy'
import { startTestSshServer } from '../integration/ssh-test-server'
import { launchApp } from '../e2e/fixtures'

const MINUTES = Number(process.env['SOAK_MINUTES'] ?? 5)
const SAMPLE_EVERY_MS = Number(process.env['SOAK_SAMPLE_MS'] ?? 20_000)
/** Ngưỡng tăng trưởng (KE-HOACH-MOI.md 8.4): so trung vị giai đoạn đầu (sau khởi động) với cuối. */
const LIMITS = { pssGrowth: 0.1, heapGrowth: 0.25, fdGrowthAbs: 25 }

test.setTimeout((MINUTES + 5) * 60_000)

interface Sample {
  t: number
  pssMb: number
  byType: Record<string, number>
  sessionHostFds: number | null
  heapMb: number | null
  tabs: number
}

function pssKb(pid: number): number | null {
  try {
    const m = /^Pss:\s+(\d+) kB/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'))
    return m?.[1] ? Number(m[1]) : null
  } catch {
    return null
  }
}

function fdCount(pid: number): number | null {
  try {
    return readdirSync(`/proc/${pid}/fd`).length
  } catch {
    return null
  }
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)] ?? NaN
}

test('soak: tải hỗn hợp liên tục, không rò rỉ bộ nhớ / handle', async () => {
  test.skip(process.platform !== 'linux', 'Đo PSS / fd qua /proc — chỉ Linux')

  const work = mkdtempSync(join(tmpdir(), 'shellhouse-soak-'))
  const remote = join(work, 'remote')
  const local = join(work, 'local')
  mkdirSync(remote)
  mkdirSync(local)
  writeFileSync(join(local, 'payload.bin'), randomBytes(5 * 1024 * 1024))

  const server = await startTestSshServer([{ username: 'u', password: 'p' }], { sftpRoot: remote })
  const lossy = await startChaosProxy(server.port, { latencyMs: 20, jitterMs: 10 })
  const echo = createServer((s) => s.pipe(s))
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r))
  const echoPort = (echo.address() as AddressInfo).port
  const launched = await launchApp()
  const { app, page } = launched
  const samples: Sample[] = []
  const errors: string[] = []
  // Heap chính xác qua DevTools Protocol: performance.memory của Chromium bị làm tròn và rất lâu
  // mới cập nhật (chống fingerprinting) — đứng 33 MB 20 phút rồi nhảy thẳng 93 MB, không dùng được.
  const cdp = await page.context().newCDPSession(page)

  try {
    // Host đã lưu (qua proxy có trễ), tin host key sẵn.
    const saved = await page.evaluate(
      (port) =>
        window.shellhouse.saveHost({
          groupId: null,
          label: 'soak',
          hostname: '127.0.0.1',
          port,
          username: 'u',
          auth: 'password',
          password: 'p',
          keyId: null,
          keyFile: null,
          proxyJump: null,
          jumpHostIds: [],
          mode: 'builtin',
          tags: [],
          color: null
        }),
      lossy.port
    )
    if (!saved.ok) throw new Error(saved.message)
    const openSsh = async (): Promise<string> => {
      await page.locator('[data-testid="host-row"][data-host-label="soak"]').dblclick()
      const id = (await page.evaluate(() => window.__shellhouseTest.activeTabId())) ?? ''
      const accept = page.getByTestId('hostkey-accept')
      await Promise.race([
        accept.click({ timeout: 5_000 }).catch(() => undefined),
        page.waitForFunction((tab) => window.__shellhouseTest.state(tab) === 'connected', id, {
          timeout: 15_000
        })
      ])
      await page.waitForFunction((tab) => window.__shellhouseTest.state(tab) === 'connected', id, {
        timeout: 20_000
      })
      return id
    }

    const localTab = (await page.evaluate(() => window.__shellhouseTest.activeTabId())) ?? ''
    await page.evaluate((id) => {
      window.__shellhouseTest.sendInput(id, 'while true; do date; ls -la /; sleep 0.2; done\r')
    }, localTab)
    const sshTabs = [await openSsh(), await openSsh(), await openSsh()]
    const sftpTab = sshTabs[0] ?? ''
    const forwardPort = await freePort()
    await page.evaluate(
      ([id, bind, dest]) => {
        window.__shellhouseTest.startForward(id, {
          id: 'soak-l',
          kind: 'L',
          bindAddr: '127.0.0.1',
          bindPort: bind,
          destHost: '127.0.0.1',
          destPort: dest
        })
      },
      [sshTabs[1] ?? '', forwardPort, echoPort] as const
    )
    await page.waitForTimeout(1_000)

    const deadline = Date.now() + MINUTES * 60_000
    let nextSample = Date.now()
    let round = 0
    while (Date.now() < deadline) {
      round++
      // 1) Output nhiều trên các tab SSH.
      for (const id of sshTabs) {
        await page.evaluate((tab) => {
          window.__shellhouseTest.sendInput(tab, 'flood 200000\r')
        }, id)
      }
      // 2) SFTP: tải lên rồi tải xuống 5 MB, đè file cũ.
      try {
        await page.evaluate(
          ([tab, from, to]) =>
            window.__shellhouseTest.sftp(tab, {
              op: 'upload',
              localPath: from,
              remotePath: to,
              overwrite: true
            }),
          [sftpTab, join(local, 'payload.bin'), join(remote, 'payload.bin')] as const
        )
        await page.evaluate(
          ([tab, from, to]) =>
            window.__shellhouseTest.sftp(tab, {
              op: 'download',
              remotePath: from,
              localPath: to,
              overwrite: true
            }),
          [sftpTab, join(remote, 'payload.bin'), join(local, `copy-${round % 3}.bin`)] as const
        )
        if (round % 5 === 0)
          await page.evaluate(
            (tab) => window.__shellhouseTest.sftp(tab, { op: 'clearDone' }),
            sftpTab
          )
      } catch (error) {
        errors.push(`sftp: ${String(error)}`)
      }
      // 4) Mở/đóng tab liên tục (bắt rò rỉ theo vòng đời).
      if (round % 3 === 0) {
        const churn = await openSsh()
        await page.evaluate((tab) => {
          window.__shellhouseTest.sendInput(tab, 'flood 50000\r')
        }, churn)
        await page.waitForTimeout(300)
        await page
          .locator(`[data-testid="tab"][data-tab-id="${churn}"] [data-testid="tab-close"]`)
          .click({ force: true })
      }
      await page.waitForTimeout(1_000)

      if (Date.now() >= nextSample) {
        nextSample = Date.now() + SAMPLE_EVERY_MS
        const metrics = await app.evaluate(({ app: a }) =>
          a.getAppMetrics().map((m) => ({
            pid: m.pid,
            type: m.type,
            name: `${m.name ?? ''} ${m.serviceName ?? ''}`
          }))
        )
        const byType: Record<string, number> = {}
        let total = 0
        let hostPid: number | null = null
        for (const m of metrics) {
          const kb = pssKb(m.pid) ?? 0
          const key = m.name.includes('Session Host') ? 'SessionHost' : m.type
          if (key === 'SessionHost') hostPid = m.pid
          byType[key] = (byType[key] ?? 0) + kb / 1024
          total += kb / 1024
        }
        // Dọn rác trước khi đo: heap dao động răng cưa 20–47 MB giữa các lần GC — chỉ phần còn giữ
        // lại sau GC mới cho biết có rò rỉ hay không.
        await cdp.send('HeapProfiler.collectGarbage').catch(() => undefined)
        const heap =
          (
            (await cdp.send('Runtime.getHeapUsage').catch(() => null)) as {
              usedSize: number
            } | null
          )?.usedSize ?? null
        const tabs = await page.evaluate(() => window.__shellhouseTest.tabIds().length)
        samples.push({
          t: Date.now(),
          pssMb: Math.round(total),
          byType: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, Math.round(v)])),
          sessionHostFds: hostPid === null ? null : fdCount(hostPid),
          heapMb: heap === null ? null : Math.round(heap / 1024 / 1024),
          tabs
        })
        const last = samples.at(-1)
        process.stdout.write(
          `  [${((Date.now() - (deadline - MINUTES * 60_000)) / 60_000).toFixed(1)} min] PSS ${last?.pssMb} MB · host fds ${last?.sessionHostFds} · heap ${last?.heapMb} MB · tabs ${last?.tabs}\n`
        )
      }
      // 3) Port forward: gửi 64 KB qua tunnel, phải nhận lại đủ.
      try {
        await throughTunnel(forwardPort, randomBytes(64 * 1024))
      } catch (error) {
        errors.push(`forward: ${String(error)}`)
      }
    }

    // Phân tích: bỏ 1/3 đầu (khởi động — scrollback, cache, heap V8 còn đang lớn dần tới mức
    // ổn định), so trung vị cửa sổ giữa (33–55%) với cửa sổ cuối (78–100%). Cửa sổ rộng để răng
    // cưa của Session Host (GC sau mỗi lần truyền SFTP 5 MB) không làm lệch kết quả.
    expect(samples.length).toBeGreaterThanOrEqual(5)
    const n = samples.length
    const early = samples.slice(
      Math.floor(n * 0.33),
      Math.max(Math.floor(n * 0.55), Math.floor(n * 0.33) + 1)
    )
    const late = samples.slice(Math.floor(n * 0.78))
    const growth = (pick: (s: Sample) => number | null): number | null => {
      const a = early.map(pick).filter((x): x is number => x !== null)
      const b = late.map(pick).filter((x): x is number => x !== null)
      if (!a.length || !b.length) return null
      return median(b) / median(a) - 1
    }
    const pss = growth((s) => s.pssMb)
    const heap = growth((s) => s.heapMb)
    const fdEarly = median(early.map((s) => s.sessionHostFds ?? 0))
    const fdLate = median(late.map((s) => s.sessionHostFds ?? 0))
    const summary = {
      minutes: MINUTES,
      samples: n,
      pssEarlyMb: median(early.map((s) => s.pssMb)),
      pssLateMb: median(late.map((s) => s.pssMb)),
      pssGrowth: pss,
      heapGrowth: heap,
      fdEarly,
      fdLate,
      // Tăng theo từng tiến trình (Tab = renderer, Browser = main, SessionHost…) — biết ngay ai tăng.
      byType: Object.fromEntries(
        Object.keys(samples.at(-1)?.byType ?? {}).map((k) => [
          k,
          growth((s) => s.byType[k] ?? null)
        ])
      ),
      errors
    }
    process.stdout.write(`\nSOAK SUMMARY ${JSON.stringify(summary)}\n`)
    mkdirSync('soak-results', { recursive: true })
    const csv = join('soak-results', `soak-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`)
    if (!existsSync(csv)) appendFileSync(csv, 't,pssMb,sessionHostFds,heapMb,tabs,byType\n')
    for (const s of samples)
      appendFileSync(
        csv,
        `${s.t},${s.pssMb},${s.sessionHostFds ?? ''},${s.heapMb ?? ''},${s.tabs},"${JSON.stringify(s.byType).replace(/"/g, "'")}"\n`
      )

    expect(errors).toEqual([])
    if (pss !== null) expect(pss).toBeLessThan(LIMITS.pssGrowth)
    if (heap !== null) expect(heap).toBeLessThan(LIMITS.heapGrowth)
    expect(fdLate - fdEarly).toBeLessThan(LIMITS.fdGrowthAbs)
  } finally {
    await launched.close()
    await lossy.close()
    await server.close()
    await new Promise<void>((r) =>
      echo.close(() => {
        r()
      })
    )
    rmSync(work, { recursive: true, force: true })
  }
})

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((r) =>
    probe.close(() => {
      r()
    })
  )
  return port
}

function throughTunnel(port: number, payload: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    let got = 0
    const sock = connect(port, '127.0.0.1')
    const timer = setTimeout(() => {
      sock.destroy()
      reject(new Error(`forward: received ${got}/${payload.length} bytes`))
    }, 10_000)
    sock.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    sock.on('data', (d: Buffer) => {
      got += d.length
      if (got >= payload.length) {
        clearTimeout(timer)
        sock.end()
        resolve()
      }
    })
    sock.on('connect', () => sock.write(payload))
  })
}
