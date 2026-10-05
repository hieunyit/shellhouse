import type { Page } from '@playwright/test'
import { startTestSshServer, type TestSshServer } from '../integration/ssh-test-server'
import { activeTab, expect, test, waitForText } from './fixtures'

const isMac = process.platform === 'darwin'
let server: TestSshServer | null = null
test.afterEach(async () => {
  await server?.close()
  server = null
})

/** testid của phần tử tổ tiên gần nhất có data-testid chứa focus hiện tại. */
const focusedIn = (page: Page, testId: string): Promise<boolean> =>
  page.evaluate((id) => !!document.activeElement?.closest(`[data-testid="${id}"]`), testId)

const focusedTestId = (page: Page): Promise<string | null> =>
  page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null)

/** Nhấn Tab tới khi focus vào phần tử có testid cho trước (tối đa n lần). */
async function tabTo(page: Page, testId: string, n = 30): Promise<void> {
  for (let i = 0; i < n; i++) {
    if ((await focusedTestId(page)) === testId) return
    await page.keyboard.press('Tab')
  }
  throw new Error(`Không Tab tới được ${testId}`)
}

test('hộp thoại: focus bị giữ bên trong khi Tab, Esc trả focus về terminal', async ({ page }) => {
  const tab = await activeTab(page)
  await page.getByTestId(`terminal-${tab}`).click()
  expect(await focusedIn(page, `terminal-${tab}`)).toBe(true)

  // Trang Settings (không phải hộp thoại): mở bằng phím → focus vào trang; Esc → quay lại terminal.
  await page.keyboard.press(isMac ? 'Meta+Comma' : 'Control+Comma')
  await expect(page.getByTestId('settings-dialog')).toBeVisible()
  await expect.poll(() => focusedIn(page, 'settings-dialog')).toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-dialog')).toHaveCount(0)
  await expect.poll(() => focusedIn(page, `terminal-${tab}`)).toBe(true)

  // Hộp thoại thật (Snippets): Tab / Shift+Tab xoay vòng bên trong, Esc trả focus về terminal.
  await page.keyboard.press(isMac ? 'Meta+S' : 'Control+Shift+S')
  const snippets = page.getByTestId('snippets-dialog')
  await expect(snippets).toBeVisible()
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press(i % 7 === 6 ? 'Shift+Tab' : 'Tab')
    expect(await focusedIn(page, 'snippets-dialog')).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(snippets).toHaveCount(0)
  await expect.poll(() => focusedIn(page, `terminal-${tab}`)).toBe(true)

  // Bảng lệnh: mở, chọn bằng phím mũi tên / Enter, không cần chuột.
  await page.keyboard.press(isMac ? 'Meta+K' : 'Control+Shift+P')
  expect(await focusedTestId(page)).toBe('palette-input')
  await page.keyboard.type('new terminal')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('tab')).toHaveCount(2)
})

test('kết nối SSH chỉ bằng bàn phím: host key → mật khẩu → gõ lệnh', async ({ page }) => {
  server = await startTestSshServer([{ username: 'kb', password: 'ban-phim' }])
  // Quick connect bằng phím (Ctrl+Shift+O): ô nhập có focus sẵn.
  await page.keyboard.press(isMac ? 'Meta+Shift+O' : 'Control+Shift+O')
  await expect(page.getByTestId('quick-connect')).toBeFocused()
  await page.keyboard.type(`kb@127.0.0.1:${server.port}`)
  await page.keyboard.press('Enter')
  const dialog = page.getByTestId('prompt-dialog')
  await expect(dialog).toHaveAttribute('data-prompt-kind', 'hostkey')
  await expect.poll(() => focusedIn(page, 'prompt-dialog')).toBe(true)
  await tabTo(page, 'hostkey-accept')
  await page.keyboard.press('Enter')

  await expect(dialog).toHaveAttribute('data-prompt-kind', 'password')
  await expect.poll(() => focusedTestId(page)).toBe('prompt-input')
  await page.keyboard.type('ban-phim')
  await page.keyboard.press('Enter')
  await expect(dialog).toHaveCount(0)

  const tab = await activeTab(page)
  await waitForText(page, tab, 'welcome to test server')
  await expect.poll(() => focusedIn(page, `terminal-${tab}`)).toBe(true)
  await page.keyboard.type('echo chi-ban-phim\r')
  await waitForText(page, tab, 'chi-ban-phim\n')
})

test('tuỳ chọn screen reader bật cây accessibility của terminal', async ({ page }) => {
  const tab = await activeTab(page)
  const tree = page.locator(`[data-testid="terminal-${tab}"] .xterm-accessibility-tree`)
  await expect(tree).toHaveCount(0)
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-nav-terminal').click()
  await page.getByTestId('setting-screen-reader').check()
  await page.keyboard.press('Escape')
  await expect(tree).toHaveCount(1)
})
