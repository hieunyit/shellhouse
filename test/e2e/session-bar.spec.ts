import { startTestSshServer, type TestSshServer } from '../integration/ssh-test-server'
import { activeTab, expect, sendLine, test, waitForText } from './fixtures'

let server: TestSshServer | null = null
test.afterEach(async () => {
  await server?.close()
  server = null
})

test('thanh phiên: độ trễ, bảng mã của host (giải mã output), chỉnh nhanh cỡ chữ / font / theme', async ({
  page
}) => {
  server = await startTestSshServer([{ username: 'u', password: 'p' }])
  await page.getByTestId('add-host').click()
  const form = page.getByTestId('host-form')
  await form.getByTestId('host-hostname').fill('127.0.0.1')
  await form.getByTestId('host-port').fill(String(server.port))
  await form.getByTestId('host-username').fill('u')
  await form.getByTestId('host-label').fill('old-device')
  await form.getByTestId('host-auth-password').check()
  await form.getByTestId('host-password').fill('p')
  await form.getByTestId('host-advanced').click()
  await form.getByTestId('host-encoding').selectOption('windows-1252')
  await form.getByTestId('host-save').click()

  const row = page.locator('[data-testid="host-row"][data-host-label="old-device"]')
  await row.dblclick()
  await page
    .getByTestId('hostkey-accept')
    .click({ timeout: 5000 })
    .catch(() => undefined)
  const tab = await activeTab(page)
  await waitForText(page, tab, 'welcome to test server')

  // Server in UTF-8 nhưng host đặt Windows-1252 → "é" (C3 A9) hiện thành "Ã©": đã giải mã theo host.
  await sendLine(page, tab, 'echo café')
  await waitForText(page, tab, 'cafÃ©')
  await expect(page.getByTestId('session-encoding')).toHaveText('windows-1252')

  // Độ trễ đo bằng keepalive SSH.
  await expect(page.getByTestId('session-latency')).toHaveText(/^\d+ ms$/, { timeout: 15_000 })

  // Bảng "Aa": cỡ chữ, font, theme — lưu vào cài đặt.
  await page.getByTestId('terminal-look').click()
  const menu = page.getByTestId('terminal-look-menu')
  await expect(menu.getByTestId('terminal-look-size')).toHaveText('14')
  await menu.getByTestId('terminal-look-bigger').click()
  await expect(menu.getByTestId('terminal-look-size')).toHaveText('15')
  await expect(
    menu.locator('[data-testid="terminal-look-font"][data-font="JetBrains Mono"]')
  ).toBeVisible()
  await menu.locator('[data-testid="terminal-look-theme"][data-theme="dracula"]').click()
  const settings = await page.evaluate(() => window.shellhouse.getSettings())
  expect(settings.terminal).toMatchObject({ fontSize: 15, themeId: 'dracula' })
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
})
