import { startTestSshServer, type TestSshServer } from '../integration/ssh-test-server'
import { activeTab, expect, openArea, setWindowSize, test, waitForText } from './fixtures'

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

  // Hàng host một dòng; nút Connect hiện khi rê chuột.
  const row = page.locator('[data-testid="host-row"][data-host-label="web-01 production"]')
  await expect(row).toContainText('web-01 production')
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

  // Home: một tab duy nhất dù vào nhiều lần; kết nối gần đây có host vừa dùng.
  await page.getByTestId('open-home').click()
  const tabCount = (): Promise<number> =>
    page.evaluate(() => window.__shellhouseTest.tabIds().length)
  const once = await tabCount()
  await openArea(page, 'hosts')
  await page.getByTestId('open-home').click()
  expect(await tabCount()).toBe(once)
  const home = page.getByTestId('welcome')
  const card = home
    .getByTestId('home-recent')
    .locator('[data-testid="home-host-card"][data-name="web-01 production"]')
  await expect(card).toContainText('just now')

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

test('Home: co giãn theo cửa sổ — nhỏ rồi phóng to thì lưới giãn ra, nội dung căn giữa', async ({
  launched,
  page
}) => {
  await setWindowSize(launched, 720, 640)
  await page.getByTestId('open-home').click()
  const home = page.locator('[data-testid="welcome"]:visible')
  const grid = home.getByTestId('welcome-add-host').locator('..')
  const columns = (): Promise<number> =>
    grid.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length)
  await expect.poll(columns).toBeLessThanOrEqual(2)
  // Đổi cỡ cửa sổ xong thì bố cục còn chạy vài khung hình — đợi độ rộng đứng yên rồi mới đo.
  const headerWidth = (): Promise<number> =>
    home.locator('header').evaluate((el) => Math.round(el.getBoundingClientRect().width))
  const settled = async (): Promise<number> => {
    let last = -1
    await expect
      .poll(
        async () => {
          const now = await headerWidth()
          const same = now === last
          last = now
          return same
        },
        { intervals: [250] }
      )
      .toBe(true)
    return last
  }
  const small = await settled()

  await setWindowSize(launched, 1600, 900)
  await expect.poll(columns).toBe(4)
  await expect.poll(headerWidth).toBeGreaterThan(small + 300)
  const content = await home.locator('header').evaluate((el) => {
    const box = el.getBoundingClientRect()
    const area = el.closest('[data-testid="welcome"]')?.getBoundingClientRect()
    return {
      width: box.width,
      left: box.left - (area?.left ?? 0),
      right: (area?.right ?? 0) - box.right
    }
  })
  expect(content.width).toBeGreaterThan(small + 300)
  // Căn giữa (lề hai bên gần bằng nhau).
  expect(Math.abs(content.left - content.right)).toBeLessThan(24)

  // Thu nhỏ lại → về một / hai cột.
  await setWindowSize(launched, 720, 640)
  await expect.poll(columns).toBeLessThanOrEqual(2)
})
