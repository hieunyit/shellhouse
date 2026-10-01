import { startTestSshServer, type TestSshServer } from '../integration/ssh-test-server'
import { activeTab, expect, test, waitForText } from './fixtures'

let server: TestSshServer | null = null
test.afterEach(async () => {
  await server?.close()
  server = null
})

test('Home: mở bằng nút Home (một tab duy nhất), kết nối gần đây, nút nhanh trên host, quick connect, tuỳ chọn khởi động', async ({
  page
}) => {
  server = await startTestSshServer([{ username: 'u', password: 'p' }])
  // Thêm host (có mật khẩu) → toast "Added".
  await page.getByTestId('add-host').click()
  const form = page.getByTestId('host-form')
  await form.getByTestId('host-hostname').fill('127.0.0.1')
  await form.getByTestId('host-port').fill(String(server.port))
  await form.getByTestId('host-username').fill('u')
  await form.getByTestId('host-label').fill('web-01 production')
  await form.getByTestId('host-auth-password').check()
  await form.getByTestId('host-password').fill('p')
  await form.getByTestId('host-save').click()
  await expect(
    page.getByTestId('toast').filter({ hasText: 'Added web-01 production' })
  ).toBeVisible()

  // Ảnh đại diện chữ cái + nút Connect hiện khi rê chuột.
  const row = page.locator('[data-testid="host-row"][data-host-label="web-01 production"]')
  await expect(row).toContainText('WP')
  await row.hover()
  await row.getByTestId('host-connect').click()
  await page
    .getByTestId('hostkey-accept')
    .click({ timeout: 5000 })
    .catch(() => undefined)
  await waitForText(page, await activeTab(page), 'welcome to test server')
  // Thanh phiên: địa chỉ đích, đồng hồ phiên, nút Find mở thanh tìm trong terminal.
  await expect(page.getByTestId('session-address').last()).toContainText('u@127.0.0.1')
  await expect(page.getByTestId('session-clock').last()).toContainText('just now')
  await page.getByTestId('open-find').last().click()
  await expect(page.getByTestId('terminal-find-input')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('terminal-find')).toHaveCount(0)

  // Home: một tab duy nhất dù bấm hai lần; kết nối gần đây có host vừa dùng.
  await page.getByTestId('open-home').click()
  await page.getByTestId('open-home').click()
  await expect(page.locator('[data-testid="tab"]').filter({ hasText: 'Home' })).toHaveCount(1)
  const home = page.getByTestId('welcome')
  const card = home
    .getByTestId('home-recent')
    .locator('[data-testid="home-host-card"][data-name="web-01 production"]')
  await expect(card).toContainText('Connected just now')

  // Mở file (SFTP) từ thẻ → tab trình quản lý file.
  await card.getByTestId('home-sftp').click()
  await expect(page.getByTestId('tab').filter({ hasText: 'web-01 production (SFTP)' })).toHaveCount(
    1
  )

  // Quick connect sai cú pháp → báo ngay, không mở tab.
  await page.getByTestId('open-home').click()
  const tabs = await page.getByTestId('tab').count()
  await home.getByTestId('home-quick-connect').fill('not a target')
  await home.getByTestId('home-quick-connect').press('Enter')
  await expect(home).toContainText('Use user@host or user@host:port')
  await expect(page.getByTestId('tab')).toHaveCount(tabs)

  // Tuỳ chọn khởi động trong Settings → Appearance.
  await page.getByTestId('open-settings').click()
  await page.getByTestId('setting-startup-terminal').click()
  await expect(page.getByTestId('setting-startup-terminal')).toHaveAttribute('aria-checked', 'true')
})
