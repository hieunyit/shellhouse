import type { Page } from '@playwright/test'
import { activeTab, expect, isWindows, sendLine, test, waitForText } from './fixtures'

async function openShell(page: Page, id: string): Promise<string> {
  const before = await page.getByTestId('tab').count()
  await page.getByTestId('new-tab-menu').click()
  await page.getByTestId(`menu-shell-${id}`).click()
  await expect(page.getByTestId('tab')).toHaveCount(before + 1)
  return activeTab(page)
}

test('menu chọn shell: mở đúng shell đã chọn, tab mang tên shell', async ({ page }) => {
  await page.getByTestId('new-tab-menu').click()
  const menu = page.getByTestId('context-menu')
  await expect(menu).toBeVisible()
  if (isWindows) {
    await expect(page.getByTestId('menu-shell-powershell')).toBeVisible()
    await expect(page.getByTestId('menu-shell-cmd')).toBeVisible()
  } else {
    await expect(page.getByTestId('menu-shell-sh')).toBeVisible()
  }
  await page.keyboard.press('Escape')

  if (isWindows) {
    const cmd = await openShell(page, 'cmd')
    await expect(page.locator(`[data-testid="tab"][data-tab-id="${cmd}"]`)).toContainText(
      'Command Prompt'
    )
    await sendLine(page, cmd, 'echo SHELL=%COMSPEC%')
    await waitForText(page, cmd, 'cmd.exe')

    // WSL: chỉ khi máy có ít nhất một bản phân phối.
    const wsl = page.locator('[data-testid^="menu-shell-wsl:"]')
    await page.getByTestId('new-tab-menu').click()
    const count = await wsl.count()
    await page.keyboard.press('Escape')
    if (count > 0) {
      const id = ((await wsl.first().getAttribute('data-testid')) ?? '').replace('menu-shell-', '')
      const tab = await openShell(page, id)
      await sendLine(page, tab, 'echo KERNEL=$(uname -s)')
      await waitForText(page, tab, 'KERNEL=Linux', 20_000)
    }
  } else {
    const tab = await openShell(page, 'sh')
    await expect(page.locator(`[data-testid="tab"][data-tab-id="${tab}"]`)).toContainText('sh')
    // $0 của dash / sh là "sh" (bash sẽ in "bash").
    await sendLine(page, tab, 'echo "ZERO=$0"')
    await waitForText(page, tab, 'ZERO=/bin/sh')
  }
})

test('shell mặc định trong cài đặt được dùng cho tab mới (Ctrl+Shift+T)', async ({ page }) => {
  const target = isWindows ? 'cmd' : 'sh'
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-nav-terminal').click()
  await page.getByTestId('setting-default-shell').selectOption(target)
  await page.keyboard.press('Escape')
  const first = await activeTab(page)
  await page.getByTestId(`terminal-${first}`).click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+T' : 'Control+Shift+T')
  await expect(page.getByTestId('tab')).toHaveCount(2)
  const tab = await activeTab(page)
  if (isWindows) {
    await sendLine(page, tab, 'echo SHELL=%COMSPEC%')
    await waitForText(page, tab, 'cmd.exe')
  } else {
    await sendLine(page, tab, 'echo "ZERO=$0"')
    await waitForText(page, tab, 'ZERO=/bin/sh')
  }
})
