import { activeTab, echoComputed, expect, openArea, sendLine, test, waitForText } from './fixtures'

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
  // Ghi lại trạng thái tab + blur / resize quanh cú click (chẩn đoán lỗi chỉ gặp trên macOS CI).
  await page.evaluate((id) => {
    const log: string[] = []
    ;(window as unknown as { __diag: string[] }).__diag = log
    let last = ''
    const timer = setInterval(() => {
      const s = window.__shellhouseTest.state(id) ?? 'none'
      if (s !== last) log.push(`state:${s}`)
      last = s
    }, 5)
    setTimeout(() => {
      clearInterval(timer)
    }, 8_000)
    window.addEventListener('blur', () => log.push('blur'))
    window.addEventListener('resize', () => log.push('resize'))
    document.addEventListener(
      'click',
      (e) =>
        log.push(
          `click:${(e.target as HTMLElement).closest('[data-testid]')?.getAttribute('data-testid') ?? '?'}`
        ),
      true
    )
  }, tab)
  await page.getByTestId('menu-tab-reconnect').click()
  await waitForText(page, tab, '— new session —').catch(async (e: unknown) => {
    const diag = await page.evaluate(() => (window as unknown as { __diag: string[] }).__diag)
    throw new Error(
      `${String(e)}\ndiag: ${diag.join(' ')}\nbuffer: ${await page.evaluate((id) => window.__shellhouseTest.bufferText(id).trim().slice(0, 600), tab)}`
    )
  })
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
  await page.getByTestId('sidebar-collapse').click()
  await expect(search).toHaveCount(0)
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+B' : 'Control+Shift+B')
  await expect(search).toBeVisible()
  await page.getByTestId('sidebar-collapse').click()
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
    await expect(page.getByTestId('titlebar-connect')).toBeInViewport()
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

test('mở lại tab vừa đóng: Ctrl+Alt+T và menu tab; Home không vào danh sách', async ({ page }) => {
  await page.getByTestId('new-tab').click()
  await expect(page.getByTestId('tab')).toHaveCount(2)
  const title = await page.getByTestId('tab').last().textContent()
  await page.getByTestId('tab-close').last().click()
  await expect(page.getByTestId('tab')).toHaveCount(1)
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Alt+T' : 'Control+Alt+T')
  await expect(page.getByTestId('tab')).toHaveCount(2)
  await expect(page.getByTestId('tab').last()).toContainText(
    (title ?? '').replace(/\d+$/, '').trim()
  )

  // Đóng Home (phím đóng tab) không thêm gì vào danh sách mở lại; khu vực Home vẫn hiện trang chủ.
  await page.getByTestId('open-home').click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+W' : 'Control+Shift+W')
  await expect(page.getByTestId('welcome')).toBeVisible()
  await openArea(page, 'hosts')
  await page.getByTestId('tab').last().click({ button: 'right' })
  await expect(page.getByText('Reopen “Home”')).toHaveCount(0)
})

test('tab: kéo thả đổi thứ tự; "Recently closed" mở lại đúng tab đã chọn', async ({ page }) => {
  await page.getByTestId('new-tab').click()
  await page.getByTestId('new-tab').click()
  const tabs = page.getByTestId('tab')
  await expect(tabs).toHaveCount(3)
  const ids = async (): Promise<(string | null)[]> =>
    tabs.evaluateAll((els) => els.map((e) => e.getAttribute('data-tab-id')))
  const before = await ids()
  // Kéo tab cuối lên đầu.
  await tabs.last().dragTo(tabs.first())
  await expect.poll(ids).not.toEqual(before)
  expect((await ids()).sort()).toEqual([...before].sort())

  // Đóng hai tab, mở lại tab đóng TRƯỚC (không phải tab gần nhất) từ menu. (Không so tiêu đề:
  // shell trên máy CI tự đổi tiêu đề tab thành "user@host: ~".)
  await tabs.nth(1).getByTestId('tab-close').click()
  await expect(tabs).toHaveCount(2)
  await tabs.nth(1).getByTestId('tab-close').click()
  await expect(tabs).toHaveCount(1)
  await page.getByTestId('new-tab-menu').click()
  await expect(page.getByText('Recently closed')).toBeVisible()
  await expect(page.locator('[data-testid^="menu-reopen-"]')).toHaveCount(2)
  await page.getByTestId('menu-reopen-0').click()
  await expect(tabs).toHaveCount(2)
  // Còn đúng tab đóng sau cùng trong danh sách (mục 0 đã mở lại).
  await page.getByTestId('new-tab-menu').click()
  await expect(page.locator('[data-testid^="menu-reopen-"]')).toHaveCount(1)
  await page.keyboard.press('Escape')
})
