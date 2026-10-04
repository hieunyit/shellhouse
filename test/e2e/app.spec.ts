import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

/** Chẩn đoán: Settings → Diagnostics. */
async function openDiagnostics(page: Page): Promise<void> {
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-nav-diagnostics').click()
}

test('renderer bị sandbox, không có quyền Node', async ({ page }) => {
  await openDiagnostics(page)
  await expect(page.getByTestId('app-info')).toContainText('Electron')
  const leaks = await page.evaluate(() => ({
    require: typeof (globalThis as Record<string, unknown>)['require'],
    process: typeof (globalThis as Record<string, unknown>)['process'],
    ipc: typeof (window.shellhouse as unknown as Record<string, unknown>)['invoke']
  }))
  expect(leaks).toEqual({ require: 'undefined', process: 'undefined', ipc: 'undefined' })
})

test('Session Host khởi động và tự phục hồi sau khi bị giết', async ({ page }) => {
  await openDiagnostics(page)
  const state = page.getByTestId('host-state')
  await expect(state).toHaveAttribute('data-state', 'running')

  const started = Date.now()
  await page.getByTestId('crash-host').click()
  await expect(page.getByTestId('host-restarts')).toContainText('1')
  await expect(state).toHaveAttribute('data-state', 'running')
  // Backoff lần đầu 250 ms + khởi động process. 5 giây: vẫn bắt lỗi thật (treo, backoff sai) mà
  // không trượt khi máy test đang bận (vừa đóng gói, chạy song song).
  expect(Date.now() - started).toBeLessThan(5_000)
})

test('native modules nạp được trong đúng process', async ({ page }) => {
  await openDiagnostics(page)
  await expect(page.getByTestId('host-state')).toHaveAttribute('data-state', 'running')
  await page.getByTestId('run-selfcheck').click()
  for (const name of ['better-sqlite3', 'sodium-native', 'node-pty', 'ssh2', 'serialport']) {
    await expect(page.getByTestId(`module-${name}`)).toHaveAttribute('data-ok', 'true')
  }
})

test('chặn điều hướng ra ngoài app', async ({ page }) => {
  const before = page.url()
  await page.evaluate(() => {
    window.location.href = 'https://example.com'
  })
  await page.waitForTimeout(300)
  expect(page.url()).toBe(before)
})
