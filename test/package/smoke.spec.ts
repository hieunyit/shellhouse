import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { chromium, expect, test, type Browser } from '@playwright/test'

/**
 * Smoke test trên bản ĐÃ ĐÓNG GÓI (dist/*-unpacked): fuses, asar, native module unpack, CSP.
 * Fuse EnableNodeCliInspectArguments tắt `--inspect` nên không dùng được _electron.launch —
 * điều khiển renderer qua Chrome DevTools Protocol.
 *   pnpm package:dir && pnpm test:package
 */

function packagedBinary(): string | null {
  const candidates =
    process.platform === 'linux'
      ? ['dist/linux-unpacked/shellhouse']
      : process.platform === 'win32'
        ? ['dist/win-unpacked/Shellhouse.exe']
        : [
            'dist/mac-arm64/Shellhouse.app/Contents/MacOS/Shellhouse',
            'dist/mac/Shellhouse.app/Contents/MacOS/Shellhouse'
          ]
  return candidates.map((c) => resolve(c)).find((c) => existsSync(c)) ?? null
}

let child: ChildProcess | null = null
let browser: Browser | null = null
let home: string | null = null
test.afterEach(async () => {
  await browser?.close().catch(() => undefined)
  child?.kill()
  if (child && child.exitCode === null)
    await new Promise((r) => {
      child?.once('exit', r)
    })
  if (home) rmSync(home, { recursive: true, force: true })
  child = null
  browser = null
  home = null
})

test('bản đóng gói: khởi động, tạo vault, native module + Session Host chạy, không có test hook', async () => {
  const binary = packagedBinary()
  test.skip(!binary, 'Chưa có bản đóng gói — chạy pnpm package:dir trước')
  home = mkdtempSync(join(tmpdir(), 'shellhouse-pkg-'))
  const env = {
    ...process.env,
    // Bản phát hành bỏ qua SHELLHOUSE_USER_DATA — cô lập bằng HOME / thư mục cấu hình.
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    APPDATA: join(home, 'appdata'),
    SHELLHOUSE_TEST_HOOKS: '1' // phải bị bỏ qua trên bản đóng gói
  }
  // --user-data-dir: cách cô lập dữ liệu có hiệu lực trên mọi OS (Windows bỏ qua biến APPDATA —
  // không có nó, test sẽ mở vault THẬT của người dùng).
  const userData = join(home, 'userdata')
  child = spawn(binary ?? '', ['--remote-debugging-port=0', `--user-data-dir=${userData}`], {
    env,
    stdio: 'pipe'
  })
  const wsUrl = await new Promise<string>((ok, fail) => {
    let err = ''
    const timer = setTimeout(() => {
      fail(new Error(`Không thấy DevTools endpoint:\n${err}`))
    }, 30_000)
    child?.stderr?.on('data', (c: Buffer) => {
      err += c.toString()
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err)
      if (m?.[1]) {
        clearTimeout(timer)
        ok(m[1])
      }
    })
    child?.once('exit', (code) => {
      clearTimeout(timer)
      fail(new Error(`App thoát sớm (code ${code}):\n${err}`))
    })
  })
  browser = await chromium.connectOverCDP(wsUrl)
  await expect.poll(() => browser?.contexts()[0]?.pages().length ?? 0).toBeGreaterThan(0)
  const page = browser.contexts()[0]?.pages()[0]
  if (!page) throw new Error('no page')
  await page.waitForFunction(() => 'shellhouse' in window)

  expect(await page.evaluate(() => '__shellhouseTest' in window)).toBe(false)
  expect(
    await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')
  ).toContain("script-src 'self'")

  const created = await page.evaluate(() => window.shellhouse.createVault('smoke-test-password'))
  expect(created.ok).toBe(true)
  await expect(page.getByTestId('vault-gate')).toHaveCount(0)
  await expect(page.getByTestId('tab')).toHaveCount(1)

  const modules = await page.evaluate(() => window.shellhouse.checkNativeModules())
  expect(modules.filter((m) => !m.ok)).toEqual([])
  expect(modules.map((m) => m.name)).toEqual(
    expect.arrayContaining(['better-sqlite3', 'sodium-native', 'node-pty'])
  )
  const status = await page.evaluate(() => window.shellhouse.getSessionHostStatus())
  expect(status.state).toBe('running')

  // Mở rồi đóng một tab terminal local. Trên Windows, node-pty dùng child_process.fork() khi đóng
  // ConPTY — với fuse RunAsNode tắt, fork có thể khởi động cả một app thứ hai.
  const mainProcesses = (): number => {
    if (process.platform !== 'win32') return 1
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "Name='${basename(binary ?? '')}'" | Where-Object { $_.CommandLine -notmatch '--type=' }).Count`
      ],
      { encoding: 'utf8' }
    )
    return Number(out.trim()) || 0
  }
  const before = mainProcesses()
  await page.getByTestId('new-tab').click()
  await expect(page.getByTestId('tab')).toHaveCount(2)
  await page.waitForTimeout(1_500)
  const closedAt = Date.now()
  await page.getByTestId('tab-close').last().click()
  await expect(page.getByTestId('tab')).toHaveCount(1)
  // Đếm liên tục ~3 giây: một app thứ hai (nếu có) sẽ tự thoát nhanh vì khoá single-instance.
  let most = 0
  while (Date.now() - closedAt < 3_000) {
    most = Math.max(most, mainProcesses())
    await new Promise((r) => setTimeout(r, 150))
  }
  expect(most).toBe(before) // không có app thứ hai bật lên
  expect(Date.now() - closedAt).toBeLessThan(4_500)

  const info = await page.evaluate(() => window.shellhouse.getInfo())
  expect(info.version).toMatch(/^\d+\.\d+\.\d+/)
  // Dữ liệu phải nằm trong thư mục tạm của test, không phải hồ sơ thật của người dùng.
  expect(readdirSync(userData)).toContain('shellhouse.db')
})
