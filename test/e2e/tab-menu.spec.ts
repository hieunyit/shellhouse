import { activeTab, echoComputed, expect, sendLine, test, waitForText } from './fixtures'

test('chuột phải tiêu đề tab: Restart shell / Duplicate / Close other tabs; phím tắt kết nối lại', async ({
  page
}) => {
  const tab = await activeTab(page)
  const header = page.locator(`[data-testid="tab"][data-tab-id="${tab}"]`)

  await header.click({ button: 'right' })
  await expect(page.getByTestId('context-menu')).toBeVisible()
  // Menu không bị khung tab của dockview cắt: đủ 6 mục, nằm trọn trong cửa sổ.
  const box = await page.getByTestId('context-menu').boundingBox()
  expect(box?.height ?? 0).toBeGreaterThan(150)
  await expect(page.getByTestId('menu-tab-close-others')).toBeInViewport()
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

test('cửa sổ hẹp (chia đôi màn hình): không cuộn ngang, nút Settings vẫn bấm được', async ({
  app,
  page
}) => {
  for (const width of [900, 760]) {
    await app.evaluate(({ BrowserWindow }, w) => {
      BrowserWindow.getAllWindows()[0]?.setSize(w, 600)
    }, width)
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth
        )
      )
      .toBeLessThanOrEqual(0)
    await expect(page.getByTestId('open-settings')).toBeInViewport()
    await expect(page.getByTestId('quick-connect')).toBeVisible()
  }
})

test('ẩn mục Recent / Favorites ở thanh bên (chuột phải tiêu đề mục, hoặc trong cài đặt)', async ({
  page
}) => {
  // Một host đã dùng gần đây + yêu thích.
  const saved = await page.evaluate(() =>
    window.shellhouse.saveHost({
      groupId: null,
      label: 'web',
      hostname: 'web.example.com',
      port: 22,
      username: 'u',
      auth: 'auto',
      keyId: null,
      keyFile: null,
      proxyJump: null,
      jumpHostIds: [],
      mode: 'builtin',
      tags: [],
      color: null
    })
  )
  if (!saved.ok) throw new Error(saved.message)
  await page.evaluate((id) => window.shellhouse.setFavorite([id], true), saved.id)
  const favorites = page.getByTestId('section-favorite-row')
  await expect(favorites).toBeVisible()

  await favorites.getByRole('button').first().click({ button: 'right' })
  await page.getByTestId('menu-hide-favorite-row').click()
  await expect(favorites).toHaveCount(0)
  // Host vẫn còn trong danh sách chính.
  await expect(page.locator('[data-testid="host-row"][data-host-label="web"]')).toBeVisible()

  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-nav-appearance').click()
  await expect(page.getByTestId('setting-show-favorites')).not.toBeChecked()
  await page.getByTestId('setting-show-favorites').check()
  await page.keyboard.press('Escape')
  await expect(favorites).toBeVisible()
})
