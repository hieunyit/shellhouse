import { expect, test } from './fixtures'

test('workspace: lưu bố cục chia màn hình, đóng hết, mở lại đúng số tab và số khung', async ({
  page
}) => {
  // Tab local có sẵn + chia phải + thêm một tab trong khung bên phải.
  await expect(page.getByTestId('tab')).toHaveCount(1)
  await page.getByTestId('layout-menu').click()
  await page.getByTestId('menu-split-right').click()
  await expect(page.getByTestId('tab')).toHaveCount(2)
  await page.getByTestId('new-tab').click()
  await expect(page.getByTestId('tab')).toHaveCount(3)
  const groups = page.locator('.dv-groupview')
  await expect(groups).toHaveCount(2)

  await page.getByTestId('open-workspaces').click()
  const dialog = page.getByTestId('workspaces-dialog')
  await dialog.getByTestId('workspace-name').fill('Dev layout')
  await dialog.getByTestId('workspace-save').click()
  await expect(
    dialog.locator('[data-testid="workspace-row"][data-name="Dev layout"]')
  ).toContainText('3 local')
  await page.keyboard.press('Escape')

  // Đóng hết tab.
  while ((await page.getByTestId('tab').count()) > 0) {
    await page.getByTestId('tab').first().getByTestId('tab-close').click({ force: true })
  }
  await expect(page.getByTestId('tab')).toHaveCount(0)

  // Mở lại từ bảng lệnh.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+P' : 'Control+Shift+P')
  await page.getByTestId('palette-input').fill('Dev layout')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('tab')).toHaveCount(3)
  await expect(groups).toHaveCount(2)

  // Xoá.
  await page.getByTestId('open-workspaces').click()
  page.once('dialog', (d) => void d.accept())
  await dialog.getByTestId('workspace-delete').click()
  await expect(dialog.getByTestId('workspace-row')).toHaveCount(0)
})
