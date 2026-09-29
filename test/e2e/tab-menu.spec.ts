import { activeTab, echoComputed, expect, sendLine, test, waitForText } from './fixtures'

test('chuột phải tiêu đề tab: Restart shell / Duplicate / Close other tabs; phím tắt kết nối lại', async ({
  page
}) => {
  const tab = await activeTab(page)
  const header = page.locator(`[data-testid="tab"][data-tab-id="${tab}"]`)

  await header.click({ button: 'right' })
  await expect(page.getByTestId('context-menu')).toBeVisible()
  await page.getByTestId('menu-tab-reconnect').click()
  await waitForText(page, tab, '— new session —')
  const { command, expected } = echoComputed('after-restart')
  await sendLine(page, tab, command)
  await waitForText(page, tab, expected)

  await header.click({ button: 'right' })
  await page.getByTestId('menu-tab-duplicate').click()
  await expect(page.getByTestId('tab')).toHaveCount(2)
  await page.getByTestId('new-tab').click()
  await expect(page.getByTestId('tab')).toHaveCount(3)

  await header.click({ button: 'right' })
  await page.getByTestId('menu-tab-close-others').click()
  await expect(page.getByTestId('tab')).toHaveCount(1)

  // Phím tắt kết nối lại tab đang chọn.
  await page.getByTestId(`terminal-${tab}`).click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+R' : 'Control+Shift+R')
  await expect
    .poll(() =>
      page.evaluate(
        (id) => window.__shellhouseTest.bufferText(id).split('— new session —').length - 1,
        tab
      )
    )
    .toBe(2)
})

test('ẩn / hiện thanh bên bằng nút và phím tắt; tìm host thì tự hiện lại', async ({ page }) => {
  const search = page.getByPlaceholder('Search hosts…')
  await expect(search).toBeVisible()
  await page.getByTestId('toggle-sidebar').click()
  await expect(search).toHaveCount(0)
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+B' : 'Control+Shift+B')
  await expect(search).toBeVisible()
  await page.getByTestId('toggle-sidebar').click()
  await expect(search).toHaveCount(0)
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+Shift+K')
  await expect(search).toBeFocused()
})
