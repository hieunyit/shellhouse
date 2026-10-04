import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { startTestSshServer, type TestSshServer } from '../integration/ssh-test-server'
import { activeTab, E2E_PASSWORD, expect, isWindows, test, waitForText } from './fixtures'

let server: TestSshServer | null = null
const dirs: string[] = []
test.afterEach(async () => {
  await server?.close()
  server = null
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function openSettings(page: Page, section: string): Promise<void> {
  await page.getByTestId('open-settings').click()
  await page.getByTestId(`settings-nav-${section}`).click()
}

test('đổi theme và cỡ chữ: áp dụng ngay cho terminal đang mở', async ({ page }) => {
  const tab = await activeTab(page)
  await openSettings(page, 'terminal')
  await page.getByTestId('setting-theme').selectOption('solarized-light')
  await page.getByTestId('setting-font-size').fill('18')
  await expect
    .poll(() => page.evaluate((id) => window.__shellhouseTest.terminalOptions(id), tab))
    .toEqual({ fontSize: 18, background: '#fdf6e3', cursorStyle: 'block' })
})

test('phím tắt tuỳ chỉnh + bảng lệnh', async ({ page }) => {
  await openSettings(page, 'shortcuts')
  const row = page.locator('[data-testid="shortcut-row"][data-command="tab.new"]')
  await row.getByTestId('shortcut-key').click()
  await page.keyboard.press('Control+Alt+N')
  await expect(row.getByTestId('shortcut-key')).toHaveText(
    process.platform === 'darwin' ? '⌃⌥N' : 'Ctrl+Alt+N'
  )
  // Esc khi đang ghi phím → chỉ huỷ ghi, không đóng trang cài đặt.
  const close = page.locator('[data-testid="shortcut-row"][data-command="tab.close"]')
  await close.getByTestId('shortcut-key').click()
  await expect(close.getByTestId('shortcut-key')).toHaveText('Press keys…')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-dialog')).toBeVisible()
  await expect(close.getByTestId('shortcut-key')).not.toHaveText('Press keys…')
  // Esc lần nữa (không ghi) → đóng.
  await page.getByTestId('settings-nav-shortcuts').click()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-dialog')).toHaveCount(0)

  const tab = await activeTab(page)
  await page.getByTestId(`terminal-${tab}`).click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+T' : 'Control+Shift+T') // phím cũ: không còn mở tab
  await page.waitForTimeout(300)
  await expect(page.getByTestId('tab')).toHaveCount(1)
  await page.keyboard.press('Control+Alt+N')
  await expect(page.getByTestId('tab')).toHaveCount(2)

  // Bảng lệnh: tìm mờ "split rig" → "Split right".
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+P' : 'Control+Shift+P')
  await page.getByTestId('palette-input').fill('split rig')
  await page.getByTestId('palette-input').press('Enter')
  await expect(page.getByTestId('tab')).toHaveCount(3)
})

test('đổi master password: mật khẩu mới dùng được, mật khẩu cũ bị từ chối', async ({ page }) => {
  await openSettings(page, 'security')
  await page.getByTestId('pw-current').fill(E2E_PASSWORD)
  await page.getByTestId('pw-next').fill('mat-khau-moi-123')
  await page.getByTestId('pw-confirm').fill('mat-khau-moi-123')
  await page.getByTestId('pw-change').click()
  await expect(page.getByTestId('security-message')).toHaveText('Master password changed.')
  await page.keyboard.press('Escape')

  await page.getByTestId('lock-vault').click()
  await page.getByTestId('vault-password').fill(E2E_PASSWORD)
  await page.getByTestId('vault-submit').click()
  await expect(page.getByTestId('vault-error')).toContainText('Wrong')
  await page.getByTestId('vault-password').fill('mat-khau-moi-123')
  await page.getByTestId('vault-submit').click()
  await expect(page.getByTestId('vault-gate')).toHaveCount(0)
})

test('khoá khi máy khoá màn hình; "nhớ trên máy" chỉ bật được khi có keychain an toàn', async ({
  app,
  page
}) => {
  await openSettings(page, 'security')
  const unavailable = page.getByTestId('remember-unavailable')
  const remember = page.getByTestId('setting-remember')
  // Trạng thái keychain được tải bất đồng bộ — chờ tới khi biết chắc (count() không chờ).
  await expect
    .poll(async () => (await unavailable.count()) > 0 || (await remember.isEnabled()))
    .toBe(true)
  if (await unavailable.count()) {
    await expect(remember).toBeDisabled() // ví dụ Linux không có Secret Service
  } else {
    await remember.check()
    // Bật cần nhập lại master password.
    await page.getByTestId('remember-password').fill(E2E_PASSWORD)
    await page.getByTestId('remember-confirm').click()
    await expect(page.getByTestId('remember-password')).toHaveCount(0)
    await expect(remember).toBeChecked()
  }
  await page.keyboard.press('Escape')

  await app.evaluate(({ powerMonitor }) => {
    powerMonitor.emit('lock-screen')
  })
  await expect(page.getByTestId('vault-gate')).toHaveAttribute('data-vault-state', 'locked')
})

test('tạo key → triển khai lên server bằng mật khẩu → đăng nhập lại bằng key, không cần mật khẩu', async ({
  page
}) => {
  // Server SSH giả chạy lệnh bằng /bin/sh (script deploy nhắm tới server POSIX ở đầu xa).
  test.skip(isWindows, 'Server thử nghiệm cần /bin/sh')
  const home = mkdtempSync(join(tmpdir(), 'sh-home-'))
  dirs.push(home)
  server = await startTestSshServer([{ username: 'u', password: 'pw' }], { execHome: home })

  // Tạo key trong vault: Settings → Keychain → New → Generate SSH key.
  await openSettings(page, 'keychain')
  await page.getByTestId('keychain-new').click()
  await page.getByTestId('menu-keychain-generate-key').click()
  await page.getByTestId('keygen-name').fill('laptop-e2e')
  await page.getByTestId('keygen-create').click()
  await expect(page.getByTestId('keygen-dialog')).toHaveCount(0)
  const keyRow = page.locator('[data-testid="key-row"][data-key-name="laptop-e2e"]')
  await expect(keyRow).toBeVisible()
  // Key mới được chọn sẵn: khung chi tiết có public key + fingerprint SHA256.
  const detail = page.getByTestId('key-detail')
  await expect(detail).toHaveAttribute('data-key-name', 'laptop-e2e')
  await expect(detail.getByTestId('key-type')).toHaveText('ED25519')
  await expect(detail.getByTestId('key-fingerprint')).toContainText('SHA256:')
  await expect(detail.getByTestId('key-public')).toHaveValue(/^ssh-ed25519 AAAA\S+ laptop-e2e$/)
  await expect(keyRow.getByTestId('key-row-usage')).toHaveText('Not used by any account or host')
  await page.keyboard.press('Escape')

  // Host dùng mật khẩu; kết nối và triển khai key.
  await page.getByTestId('add-host').click()
  const form = page.getByTestId('host-form')
  await form.getByTestId('host-hostname').fill('127.0.0.1')
  await form.getByTestId('host-port').fill(String(server.port))
  await form.getByTestId('host-username').fill('u')
  await form.getByTestId('host-label').fill('key-target')
  await form.getByTestId('host-auth-password').check()
  await form.getByTestId('host-password').fill('pw')
  await form.getByTestId('host-save').click()
  const row = page.locator('[data-testid="host-row"][data-host-label="key-target"]')
  await row.dblclick()
  const tab = await activeTab(page)
  await page.getByTestId('hostkey-accept').click()
  await waitForText(page, tab, 'welcome to test server')

  // Keychain → Deploy to server…: chọn phiên SSH đang kết nối.
  await openSettings(page, 'keychain')
  await keyRow.click()
  await page.getByTestId('key-deploy').click()
  const deploy = page.getByTestId('keychain-deploy-dialog')
  await expect(deploy.getByTestId('keychain-deploy-session')).toHaveCount(1)
  await deploy.getByTestId('keychain-deploy-run').click()
  await expect(deploy.getByTestId('keychain-deploy-result')).toHaveText(
    'Key added to ~/.ssh/authorized_keys.'
  )
  await page.keyboard.press('Escape')
  await expect(deploy).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-dialog')).toHaveCount(0)

  // Nút "Deploy key" trên thanh công cụ terminal: key đã có trên server.
  await page.getByTestId('open-deploy-key').last().click()
  await page.getByTestId('deploy-key-run').click()
  await expect(page.getByTestId('deploy-key-result')).toHaveText(
    'The key is already on the server.'
  )
  await page.keyboard.press('Escape')
  const authorized = readFileSync(join(home, '.ssh', 'authorized_keys'), 'utf8')
  expect(authorized.trim().split('\n')).toHaveLength(1)
  expect(statSync(join(home, '.ssh', 'authorized_keys')).mode & 0o777).toBe(0o600)

  // Chuyển host sang dùng key (xoá mật khẩu) → kết nối lại không cần mật khẩu.
  await row.hover()
  await row.getByTestId('host-edit').click()
  await form.getByTestId('host-auth-key').check()
  await form.getByTestId('host-save').click()
  await row.dblclick()
  const tab2 = await activeTab(page)
  await waitForText(page, tab2, 'welcome to test server')
  await expect(page.getByTestId('prompt-dialog')).toHaveCount(0)
  expect(server.events.authAttempts.filter((a) => a.method === 'publickey').length).toBeGreaterThan(
    0
  )

  // Keychain biết host đang dùng key; xoá bị chặn kèm lý do.
  await openSettings(page, 'keychain')
  await page.getByTestId('keychain-filter-keys').click()
  await expect(keyRow.getByTestId('key-row-usage')).toHaveText('Used by: 1 host')
  await keyRow.click()
  await page.keyboard.press('Delete')
  await expect(page.getByTestId('key-in-use')).toContainText('Used by: 1 host')
  await page.keyboard.press('Escape')
  await expect(keyRow).toBeVisible()
})

test('xuất bản sao lưu', async ({ app, page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'sh-backup-'))
  dirs.push(dir)
  const target = join(dir, 'backup.shellhouse-backup')
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: file })
  }, target)
  await openSettings(page, 'security')
  await page.getByTestId('backup-export').click()
  await expect(page.getByTestId('security-message')).toContainText('Saved to')
  expect(statSync(target).size).toBeGreaterThan(0)
})
