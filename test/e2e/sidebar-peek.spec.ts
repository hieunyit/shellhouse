import { tmpdir } from 'node:os'
import { startTestSshServer, type TestSshServer } from '../integration/ssh-test-server'
import { activeTab, expect, test, waitForText } from './fixtures'

let server: TestSshServer | null = null
test.afterEach(async () => {
  await server?.close()
  server = null
})

test('Thanh bên gọn: mở tab từ phần mở tạm thì phần mở tạm đóng; Esc / nhấp ra ngoài cũng đóng; icon hệ điều hành của host', async ({
  page
}) => {
  // execHome: server thử chạy lệnh thật bằng /bin/sh → dò được hệ điều hành của máy chạy test.
  server = await startTestSshServer([{ username: 'u', password: 'p' }], { execHome: tmpdir() })
  await page.getByTestId('add-host').click()
  const form = page.getByTestId('host-form')
  await form.getByTestId('host-hostname').fill('127.0.0.1')
  await form.getByTestId('host-port').fill(String(server.port))
  await form.getByTestId('host-username').fill('u')
  await form.getByTestId('host-label').fill('peek-target')
  await form.getByTestId('host-auth-password').check()
  await form.getByTestId('host-password').fill('p')
  await form.getByTestId('host-save').click()
  await expect(form).toHaveCount(0)

  // Thu gọn thanh bên (tab terminal) → thanh icon; rê chuột vào → mở tạm.
  await page.getByTestId('sidebar-collapse').click()
  const panel = page.getByTestId('sidebar-panel')
  await expect(panel).toHaveAttribute('data-peek', 'closed')
  await page.getByTestId('rail-search').hover()
  await expect(panel).toHaveAttribute('data-peek', 'open')

  // Esc → đóng.
  await page.keyboard.press('Escape')
  await expect(panel).toHaveAttribute('data-peek', 'closed')

  // Nhấp ra ngoài → đóng.
  await page.getByTestId('rail-search').click()
  await expect(panel).toHaveAttribute('data-peek', 'open')
  await page.mouse.click(900, 500)
  await expect(panel).toHaveAttribute('data-peek', 'closed')

  // Nhấp đúp host trong phần mở tạm → tab mới, phần mở tạm đóng ngay (không che nội dung tab).
  await page.getByTestId('rail-search').hover()
  await expect(panel).toHaveAttribute('data-peek', 'open')
  const row = panel.locator('[data-testid="host-row"][data-host-label="peek-target"]')
  await row.dblclick()
  await expect(panel).toHaveAttribute('data-peek', 'closed')
  await page
    .getByTestId('hostkey-accept')
    .click({ timeout: 5000 })
    .catch(() => undefined)
  await waitForText(page, await activeTab(page), 'welcome to test server')
  await expect(panel).toHaveAttribute('data-peek', 'closed')

  // Icon hệ điều hành (dò lúc kết nối) trên tab và trên hàng host.
  if (process.platform !== 'win32') {
    const expected = process.platform === 'darwin' ? 'macos' : /.+/
    await expect(
      page.locator('[data-testid="tab"] [data-testid="os-icon"]').first()
    ).toHaveAttribute('data-os', expected, { timeout: 10_000 })
    await page.getByTestId('sidebar-expand').click()
    await expect(
      page.locator(
        '[data-testid="host-row"][data-host-label="peek-target"] [data-testid="os-icon"]'
      )
    ).toHaveAttribute('data-os', expected)
    if (process.env['SHOTS_DIR'])
      await page.screenshot({ path: `${process.env['SHOTS_DIR']}/host-os.png` })
  }
})
