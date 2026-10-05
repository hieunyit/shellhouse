import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startTestSshServer, type TestSshServer } from '../integration/ssh-test-server'
import { activeTab, expect, test, waitForText } from './fixtures'

let server: TestSshServer | null = null
let home: string | null = null
test.afterEach(async () => {
  await server?.close()
  server = null
  if (home) rmSync(home, { recursive: true, force: true })
  home = null
})

// Server thử chạy lệnh bằng /bin/sh của máy test — chỉ Linux có /proc.
test.skip(process.platform !== 'linux', 'Cần /proc (Linux)')

test('thanh số liệu server: hiện dưới terminal SSH, tắt được trong cài đặt', async ({ page }) => {
  home = mkdtempSync(join(tmpdir(), 'sh-exec-'))
  server = await startTestSshServer([{ username: 'u', password: 'p' }], { execHome: home })

  await page.getByTestId('titlebar-connect').click()
  await page.getByTestId('quick-connect').fill(`u@127.0.0.1:${server.port}`)
  await page.getByTestId('quick-connect').press('Enter')
  const tab = await activeTab(page)
  await page.getByTestId('hostkey-accept').click()
  await page.getByTestId('prompt-input').fill('p')
  await page.getByTestId('prompt-submit').click()
  await waitForText(page, tab, 'welcome to test server')

  const bar = page.getByTestId('server-stats')
  await expect(bar).toBeVisible({ timeout: 15_000 })
  // Trên thanh phiên: % dùng; dung lượng còn trống ở tooltip.
  await expect(bar.getByTestId('stats-mem')).toContainText(/\d+%/)
  await expect(bar.getByTestId('stats-mem')).toHaveAttribute('title', /(MB|GB) available/)
  // Lần đo thứ hai: có CPU %.
  await expect(bar.getByTestId('stats-cpu')).toContainText(/\d+%/, { timeout: 15_000 })

  await page.evaluate(() => window.shellhouse.updateSettings({ terminal: { serverStats: false } }))
  await expect(bar).toHaveCount(0)
})
