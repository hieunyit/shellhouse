import { startTestSshServer } from '../integration/ssh-test-server'
import { activeTab, expect, launchApp, test, waitForText } from './fixtures'

/**
 * Giao diện tiếng Việt (SHELLHOUSE_LANG=vi): các màn hình chính hiện tiếng Việt, ngày giờ theo
 * định dạng Việt Nam (ngày/tháng/năm, 24 giờ). Các test khác chạy tiếng Anh cố định.
 */
test.setTimeout(90_000)

test('giao diện tiếng Việt: thanh bên, form host, cài đặt, định dạng ngày', async () => {
  const server = await startTestSshServer([{ username: 'demo', password: 'pw' }])
  const launched = await launchApp({ SHELLHOUSE_LANG: 'vi' })
  const { page } = launched
  try {
    await expect(page.locator('html')).toHaveAttribute('lang', 'vi')

    // Thanh bên.
    await expect(page.getByTestId('host-search')).toHaveAttribute('placeholder', 'Tìm host…')
    await expect(page.getByTestId('add-group')).toContainText('Nhóm mới')
    await expect(page.getByTestId('sidebar-get-started')).toContainText('Thêm server của bạn')

    // Form host: tiêu đề, nhãn, gợi ý dạng "vd: …", lỗi ngay dưới ô.
    await page.getByTestId('add-host').click()
    const form = page.getByTestId('host-form')
    await expect(form).toHaveAttribute('aria-label', 'Host mới')
    await expect(form).toContainText('Tên đăng nhập')
    await expect(form).toContainText('Xác thực')
    await expect(form.getByTestId('host-username')).toHaveAttribute('placeholder', 'vd: root')
    await expect(form.getByTestId('host-color-red')).toHaveAttribute('aria-label', 'Đỏ')
    await form.getByTestId('host-port').fill('70000')
    await expect(form.getByTestId('host-port-error')).toContainText('1 đến 65535')
    await form.getByTestId('host-port').fill(String(server.port))
    await form.getByTestId('host-hostname').fill('127.0.0.1')
    await form.getByTestId('host-username').fill('demo')
    await form.getByTestId('host-label').fill('máy thử')
    await form.getByTestId('host-auth-password').click()
    await form.getByTestId('host-password').fill('pw')
    await form.getByTestId('host-save').click()
    await expect(page.getByTestId('toast').filter({ hasText: 'Đã thêm máy thử' })).toBeVisible()

    // Kết nối → hàng host có "Lần dùng cuối" theo định dạng Việt Nam (ngày/tháng/năm, 24 giờ).
    const row = page.locator('[data-testid="host-row"][data-host-label="máy thử"]')
    await row.dblclick()
    await page.getByTestId('hostkey-accept').click()
    await waitForText(page, await activeTab(page), 'welcome to test server')
    const now = new Date()
    const day = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getFullYear())}`
    await expect.poll(async () => (await row.getAttribute('title')) ?? '').toContain(day)
    const title = (await row.getAttribute('title')) ?? ''
    expect(title).toContain('Lần dùng cuối:')
    expect(title).not.toMatch(/AM|PM/)

    // Cài đặt.
    await page.getByTestId('open-settings').click()
    await expect(page.getByTestId('settings-nav-appearance')).toContainText('Giao diện')
    await expect(page.getByTestId('settings-nav-security')).toContainText('Bảo mật')
    await page.getByTestId('settings-nav-appearance').click()
    await expect(page.getByTestId('settings-dialog')).toContainText('Ngôn ngữ')
    await page.keyboard.press('Escape')

    // Trang chủ.
    await page.getByTestId('open-home').click()
    await expect(page.getByTestId('welcome')).toContainText('Thêm host')
    await expect(page.getByTestId('home-host-card').first()).toContainText('Kết nối')
  } finally {
    await launched.close()
    await server.close()
  }
})
