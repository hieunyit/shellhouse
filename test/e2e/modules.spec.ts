import { expect, openArea, test } from './fixtures'

/** Trang Settings → Modules (ADR-014 mục 3.12) và bật / tắt module lúc chạy. */
test('Modules: tìm kiếm, lọc, quyền; tắt S3 → mục và tab biến mất, bật lại → dữ liệu còn; Remove data hai bước', async ({
  page
}) => {
  // Có một tài khoản S3 (secret giả — không cần kết nối).
  const saved = (await page.evaluate(() =>
    window.shellhouse.invokeModule('s3', 'save', [
      {
        name: 'Keep me',
        endpoint: 'http://127.0.0.1:9',
        region: '',
        accessKeyId: 'AK',
        secretAccessKey: 'SK',
        forcePathStyle: true
      }
    ])
  )) as { ok: boolean }
  expect(saved.ok).toBe(true)
  const account = page.locator('[data-testid="s3-account"][data-name="Keep me"]')
  await openArea(page, 's3')
  await expect(account).toBeVisible()

  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-nav-modules').click()
  const modules = page.getByTestId('settings-modules')
  const s3Card = modules.locator('[data-testid="module-card"][data-id="s3"]')
  await expect(s3Card).toHaveAttribute('data-enabled', 'true')

  // Tìm theo từ khoá / không dấu / gần đúng; không khớp → lời mời góp ý.
  const search = page.getByTestId('module-search')
  await search.fill('MINIO')
  await expect(s3Card).toBeVisible()
  await search.fill('storag')
  await expect(s3Card).toBeVisible()
  await search.fill('no such thing')
  await expect(modules.getByTestId('module-card')).toHaveCount(0)
  await expect(modules).toContainText('No module matches “no such thing”')
  await expect(modules.getByRole('link', { name: /Tell us what you need/ })).toBeVisible()
  await search.fill('')
  await page.getByTestId('module-status-off').click()
  await expect(s3Card).toHaveCount(0)
  await page.getByTestId('module-status-all').click()
  await page.getByTestId('module-category-cloud').click()
  await expect(s3Card).toBeVisible()

  // Trang chi tiết: mô tả, quyền, trang cài đặt riêng.
  await s3Card.click()
  const detail = page.getByTestId('module-detail-s3')
  await expect(detail.getByTestId('module-permissions')).toContainText(
    'Stores secret access keys encrypted in the vault'
  )
  await expect(detail.getByTestId('setting-s3-requests')).toBeVisible()
  // Remove data chỉ khi đã tắt.
  await expect(detail.getByTestId('module-remove-data')).toBeDisabled()

  // Đang mở một tab S3 → tắt module hỏi đóng tab.
  await page.keyboard.press('Escape')
  await account.dblclick()
  await expect(page.getByTestId('s3-view')).toBeVisible()
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-nav-modules').click()
  await page.locator('[data-testid="module-card"][data-id="s3"]').click()
  await page.getByTestId('module-toggle-s3').click()
  const turnOff = page.getByTestId('confirm-dialog')
  await expect(turnOff).toContainText('1 open tab')
  await turnOff.getByTestId('confirm-ok').click()
  await expect(page.getByTestId('module-toggle-s3')).toHaveAttribute('aria-checked', 'false')
  await expect(page.getByTestId('s3-view')).toHaveCount(0)
  await page.keyboard.press('Escape')
  // Khu vực S3 biến mất khỏi activity bar cùng với mục của nó.
  await expect(page.getByTestId('activity-s3')).toHaveCount(0)
  await expect(page.getByTestId('s3-section')).toHaveCount(0)
  // Main từ chối gọi module đã tắt.
  const refused = await page.evaluate(() =>
    window.shellhouse.invokeModule('s3', 'accounts', []).then(
      () => 'ok',
      (e: unknown) => String(e)
    )
  )
  expect(refused).toContain('turned off')

  // Bật lại (đã xác nhận quyền trước đó? — S3 bật sẵn nên lần đầu bật tay sẽ hỏi).
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-nav-modules').click()
  await page.getByTestId('module-toggle-s3').click()
  const confirm = page.getByTestId('module-enable-dialog')
  await expect(confirm).toContainText('Stores secret access keys encrypted in the vault')
  await page.getByTestId('module-enable-confirm').click()
  await expect(page.getByTestId('module-toggle-s3')).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
  await openArea(page, 's3')
  await expect(account).toBeVisible()

  // Remove data: tắt → bấm hai lần → tài khoản mất hẳn.
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-nav-modules').click()
  await page.locator('[data-testid="module-card"][data-id="s3"]').click()
  await page.getByTestId('module-toggle-s3').click()
  await expect(page.getByTestId('module-toggle-s3')).toHaveAttribute('aria-checked', 'false')
  const remove = page.getByTestId('module-remove-data')
  await remove.click()
  await expect(remove).toHaveText(/Yes, remove all S3 storage data/)
  await remove.click()
  await expect(page.getByTestId('module-detail-s3')).toContainText('data was removed')
  // Lần này không hỏi quyền nữa (đã xác nhận).
  await page.getByTestId('module-toggle-s3').click()
  await expect(page.getByTestId('module-toggle-s3')).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
  await openArea(page, 's3')
  await expect(page.getByTestId('s3-section')).toBeVisible()
  await expect(account).toHaveCount(0)
})

test('bảng lệnh: "Modules: Browse" mở trang Modules; gõ từ khoá tìm ra module', async ({
  page
}) => {
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-nav-modules').click()
  await page.getByTestId('module-toggle-s3').click()
  await page.keyboard.press('Escape')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+Shift+P')
  const palette = page.getByTestId('command-palette')
  await palette.getByTestId('palette-input').fill('bucket')
  await expect(palette.getByRole('option').first()).toContainText('Modules: Enable S3 storage')
  await palette.getByTestId('palette-input').fill('modules: browse')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('settings-modules')).toBeVisible()
})
