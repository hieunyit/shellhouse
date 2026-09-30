import { expect, test } from './fixtures'

test('màn chào + thẻ bắt đầu ở thanh bên: mở đúng hộp thoại, quick connect, terminal', async ({
  page
}) => {
  // Thanh bên khi chưa có host: thẻ "Add your servers".
  const card = page.getByTestId('sidebar-get-started')
  await expect(card).toBeVisible()
  await card.getByTestId('empty-add-host').click()
  await expect(page.getByTestId('host-form')).toBeVisible()
  await page.keyboard.press('Escape')
  await card.getByTestId('empty-import').click()
  await expect(page.getByTestId('import-dialog')).toBeVisible()
  await page.keyboard.press('Escape')

  // Đóng tab cuối → màn chào.
  await page.getByTestId('tab-close').first().click()
  const welcome = page.getByTestId('welcome')
  await expect(welcome).toContainText('Welcome to Shellhouse')
  await welcome.getByTestId('welcome-add-host').click()
  await expect(page.getByTestId('host-form')).toBeVisible()
  await page.keyboard.press('Escape')
  await welcome.getByTestId('welcome-import').click()
  await expect(page.getByTestId('import-dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await welcome.getByTestId('welcome-quick-connect').click()
  await expect(page.getByTestId('quick-connect')).toBeFocused()

  // Thanh bên đang ẩn: "Add a host" vẫn mở được (tự hiện thanh bên).
  await page.getByTestId('toggle-sidebar').click()
  await expect(page.getByTestId('sidebar-get-started')).toHaveCount(0)
  await welcome.getByTestId('welcome-add-host').click()
  await expect(page.getByTestId('host-form')).toBeVisible()
  await page.keyboard.press('Escape')

  await welcome.getByTestId('welcome-new-terminal').click()
  await expect(page.getByTestId('tab')).toHaveCount(1)
})

test('thanh công cụ: menu Layout chia màn hình; About hiện phiên bản', async ({ page }) => {
  await page.getByTestId('layout-menu').click()
  await page.getByTestId('menu-split-below').click()
  await expect(page.getByTestId('tab')).toHaveCount(2)

  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-nav-about').click()
  const version = await page.evaluate(() => window.shellhouse.getInfo().then((i) => i.version))
  await expect(page.getByTestId('about-version')).toHaveText(`Version ${version}`)
})
