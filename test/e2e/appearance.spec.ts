import type { Page } from '@playwright/test'
import { activeTab, expect, test } from './fixtures'

async function openAppearance(page: Page): Promise<void> {
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-nav-appearance').click()
}

const canvasColor = (page: Page): Promise<string> =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor)

test('Light / Dark / System: app, dockview và terminal đổi theme cùng lúc', async ({ page }) => {
  const tab = await activeTab(page)
  await openAppearance(page)

  await page.getByTestId('appearance-light').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  expect(await canvasColor(page)).toBe('rgb(236, 238, 241)')
  await expect
    .poll(() => page.evaluate((id) => window.__shellhouseTest.terminalOptions(id)?.background, tab))
    .toBe('#fbfbfb') // Shellhouse Light

  await page.getByTestId('appearance-dark').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  expect(await canvasColor(page)).toBe('rgb(8, 9, 10)')
  await expect
    .poll(() => page.evaluate((id) => window.__shellhouseTest.terminalOptions(id)?.background, tab))
    .toBe('#0a0b0c') // Shellhouse Dark

  // Nền quanh terminal (dockview) lấy đúng màu nền của theme terminal.
  const groupBg = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--sh-terminal').trim()
  )
  expect(groupBg).toBe('#0a0b0c')

  await page.getByTestId('appearance-system').click()
  await expect(page.getByTestId('appearance-system')).toHaveAttribute('aria-checked', 'true')
  const expected = await page.evaluate(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  )
  await expect(page.locator('html')).toHaveAttribute('data-theme', expected)
})

test('lựa chọn theme được lưu lại qua lần mở app sau', async ({ app, page }) => {
  await openAppearance(page)
  await page.getByTestId('appearance-light').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('light')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
})
