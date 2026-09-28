import { expect, test } from './fixtures'

test('renderer bị sandbox, không có quyền Node', async ({ page }) => {
  await page.getByTestId('toggle-diagnostics').click()
  await expect(page.getByTestId('app-info')).toContainText('Electron')
  const leaks = await page.evaluate(() => ({
    require: typeof (globalThis as Record<string, unknown>)['require'],
    process: typeof (globalThis as Record<string, unknown>)['process'],
    ipc: typeof (window.shellhouse as unknown as Record<string, unknown>)['invoke']
  }))
  expect(leaks).toEqual({ require: 'undefined', process: 'undefined', ipc: 'undefined' })
})

test('Session Host khởi động và tự phục hồi sau khi bị giết', async ({ page }) => {
  await page.getByTestId('toggle-diagnostics').click()
  const state = page.getByTestId('host-state')
  await expect(state).toHaveAttribute('data-state', 'running')

  const started = Date.now()
  await page.getByTestId('crash-host').click()
  await expect(page.getByTestId('host-restarts')).toContainText('1')
  await expect(state).toHaveAttribute('data-state', 'running')
  expect(Date.now() - started).toBeLessThan(2_000)
})

test('native modules nạp được trong đúng process', async ({ page }) => {
  await page.getByTestId('toggle-diagnostics').click()
  await expect(page.getByTestId('host-state')).toHaveAttribute('data-state', 'running')
  await page.getByTestId('run-selfcheck').click()
  for (const name of ['better-sqlite3', 'sodium-native', 'node-pty', 'ssh2']) {
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
