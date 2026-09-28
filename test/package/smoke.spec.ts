import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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
  child = spawn(binary ?? '', ['--remote-debugging-port=0'], { env, stdio: 'pipe' })
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

  const info = await page.evaluate(() => window.shellhouse.getInfo())
  expect(info.version).toMatch(/^\d+\.\d+\.\d+/)
  if (process.platform === 'linux')
    expect(readdirSync(join(home, 'config')).some((d) => /shellhouse/i.test(d))).toBe(true)
})
