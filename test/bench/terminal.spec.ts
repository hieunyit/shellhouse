import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import '../e2e/fixtures' // khai báo window.__shellhouseTest

/** Ngưỡng tiêu chí thành công (KE-HOACH-MOI.md mục 10). */
const TARGET = {
  startupMs: 2_000,
  cat100MbMs: 5_000,
  longTaskMs: 200,
  keyP95Ms: 30,
  ram10TabsMb: 500
}

const RESULTS = 'bench/results.csv'
const HEADER =
  'date,platform,arch,renderer,startup_ms,cat100mb_ms,cat_longtask_ms,key_p50_ms,key_p95_ms,ram_10tabs_mb\n'

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? NaN
}

const round = (n: number): number => Math.round(n * 10) / 10

/**
 * PSS (KB) của một process trên Linux: phần bộ nhớ dùng chung được chia đều cho các process
 * dùng nó, nên cộng PSS của mọi process mới ra tổng RAM thật. RSS/workingSet đếm trùng.
 */
function linuxPssKb(pid: number): number | null {
  try {
    const match = /^Pss:\s+(\d+) kB/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'))
    return match?.[1] ? Number(match[1]) : null
  } catch {
    return null
  }
}

test('benchmark terminal', async () => {
  const isWindows = process.platform === 'win32'

  const workDir = mkdtempSync(join(tmpdir(), 'shellhouse-bench-'))
  const bigFile = join(workDir, 'big.txt')
  // 100 MB văn bản, dòng 100 byte.
  const line = `${'0123456789'.repeat(9)}abcdefghi\n`
  const block = line.repeat(10_000) // 1 MB
  writeFileSync(bigFile, block.repeat(100))

  // ---- Khởi động lạnh (process → tab đầu tiên có prompt) ----
  const launchedAt = Date.now()
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      SHELLHOUSE_TEST_HOOKS: '1',
      SHELLHOUSE_FAST_KDF: '1',
      SHELLHOUSE_USER_DATA: join(workDir, 'userdata')
    }
  })
  try {
    const page = await app.firstWindow()
    // Khởi động lạnh = tới lúc màn hình master password sẵn sàng nhận nhập liệu.
    await page.getByTestId('vault-password').waitFor({ state: 'visible', timeout: 20_000 })
    const startupMs = Date.now() - launchedAt
    await page.evaluate(() => window.shellhouse.createVault('bench-master-password'))
    // Không để vault tự khoá giữa chừng khi máy chạy benchmark mà không ai chạm chuột.
    await page.evaluate(() =>
      window.shellhouse.updateSettings({ security: { autoLockMinutes: 0 } })
    )
    await page.waitForFunction(
      () => {
        if (!('__shellhouseTest' in window)) return false
        const h = window.__shellhouseTest
        const id = h.activeTabId()
        return !!id && h.state(id) === 'connected' && h.bufferText(id).trim().length > 0
      },
      undefined,
      { polling: 10, timeout: 20_000 }
    )
    const tab = (await page.evaluate(() => window.__shellhouseTest.activeTabId())) ?? ''
    const renderer = await page.evaluate((id) => window.__shellhouseTest.renderer(id), tab)

    // ---- Độ trễ phím (echo của shell local) ----
    await page.waitForTimeout(500)
    const samples = await page.evaluate(
      (id) => window.__shellhouseTest.measureEchoLatency(id, 200),
      tab
    )
    const keyP50 = percentile(samples, 50)
    const keyP95 = percentile(samples, 95)

    // ---- cat 100 MB ----
    await page.evaluate(() => window.__shellhouseTest.maxLongTaskMs(true))
    const catStart = Date.now()
    await page.evaluate(
      ([id, file, win]) => {
        window.__shellhouseTest.sendInput(
          id,
          win
            ? // PowerShell: ghi thẳng ra console (đi qua ConPTY như output thật).
              `Clear-Host; [Console]::Out.Write([IO.File]::ReadAllText('${file}')); Write-Output ('__BENCH_' + (40+2) + '__')\r`
            : `clear; cat '${file}'; echo __BENCH_$((40+2))__\r`
        )
      },
      [tab, bigFile, isWindows] as const
    )
    await page.waitForFunction(
      (id) => window.__shellhouseTest.bufferText(id, 5).includes('__BENCH_42__'),
      tab,
      { polling: 50, timeout: 120_000 }
    )
    const catMs = Date.now() - catStart
    const longTask = await page.evaluate(() => window.__shellhouseTest.maxLongTaskMs())

    // ---- RAM với 10 tab ----
    for (let i = 0; i < 9; i++) await page.getByTestId('new-tab').click()
    await page.waitForFunction(
      () => {
        const h = window.__shellhouseTest
        const ids = h.tabIds()
        return ids.length === 10 && ids.every((id) => h.state(id) === 'connected')
      },
      undefined,
      { timeout: 30_000 }
    )
    await page.waitForTimeout(2_000)
    const metrics = await app.evaluate(({ app: electronApp }) =>
      electronApp.getAppMetrics().map((m) => ({
        pid: m.pid,
        type: m.type,
        workingSetKb: m.memory.workingSetSize,
        // Chỉ có trên Windows: bộ nhớ riêng của process (không đếm trùng DLL / bộ nhớ dùng chung).
        privateKb: m.memory.privateBytes ?? null
      }))
    )
    const perProcess = metrics.map((m) => ({
      ...m,
      kb:
        (process.platform === 'linux' ? linuxPssKb(m.pid) : null) ??
        (isWindows ? m.privateKb : null) ??
        m.workingSetKb
    }))
    const ramKb = perProcess.reduce((sum, m) => sum + m.kb, 0)
    const ramBreakdown = perProcess.map((m) => `${m.type} ${Math.round(m.kb / 1024)}`).join(', ')
    const ramMb = ramKb / 1024

    const row = {
      date: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      renderer: renderer ?? '?',
      startupMs,
      catMs,
      longTask: round(longTask),
      keyP50: round(keyP50),
      keyP95: round(keyP95),
      ramMb: round(ramMb)
    }
    if (!existsSync(RESULTS)) writeFileSync(RESULTS, HEADER)
    appendFileSync(RESULTS, `${Object.values(row).join(',')}\n`)

    const verdict = (value: number, target: number): string =>
      value <= target ? 'ĐẠT' : 'CHƯA ĐẠT'
    console.log(
      [
        '',
        `Renderer xterm: ${row.renderer}${row.renderer === 'dom' ? ' (không có WebGL — máy không có GPU, số liệu thấp hơn máy thật)' : ''}`,
        `Khởi động:          ${startupMs} ms   (mục tiêu < ${TARGET.startupMs})   ${verdict(startupMs, TARGET.startupMs)}`,
        `cat 100 MB:         ${catMs} ms   (mục tiêu < ${TARGET.cat100MbMs})   ${verdict(catMs, TARGET.cat100MbMs)}`,
        `  UI bị chặn lâu nhất: ${row.longTask} ms (mục tiêu < ${TARGET.longTaskMs})   ${verdict(longTask, TARGET.longTaskMs)}`,
        `Độ trễ phím p50/p95: ${row.keyP50} / ${row.keyP95} ms (mục tiêu p95 < ${TARGET.keyP95Ms})   ${verdict(keyP95, TARGET.keyP95Ms)}`,
        `RAM 10 tab local:   ${row.ramMb} MB ${process.platform === 'linux' ? 'PSS' : isWindows ? 'private' : 'working set'}   (mục tiêu < ${TARGET.ram10TabsMb})   ${verdict(ramMb, TARGET.ram10TabsMb)}`,
        `  theo process (MB): ${ramBreakdown}`,
        ''
      ].join('\n')
    )

    // Benchmark chỉ báo cáo; riêng output lớn làm treo UI thì coi là lỗi.
    expect(longTask).toBeLessThan(1_000)
  } finally {
    await app.close()
    rmSync(workDir, { recursive: true, force: true })
  }
})
