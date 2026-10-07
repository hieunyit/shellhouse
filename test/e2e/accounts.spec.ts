import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  generateTestKey,
  startTestSshServer,
  type TestSshServer
} from '../integration/ssh-test-server'
import { activeTab, expect, test, waitForText } from './fixtures'

let server: TestSshServer | null = null
const dirs: string[] = []
test.afterEach(async () => {
  await server?.close()
  server = null
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

test('tài khoản dùng chung: tạo ở Settings (key + passphrase) → host chọn tài khoản → kết nối không hỏi gì', async ({
  app,
  page
}) => {
  const pair = generateTestKey('acc-passphrase')
  const dir = mkdtempSync(join(tmpdir(), 'sh-acc-'))
  dirs.push(dir)
  const keyFile = join(dir, 'id_deploy')
  writeFileSync(keyFile, pair.private, { mode: 0o600 })
  await app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [f] })
  }, keyFile)
  // Server chỉ nhận key (không có mật khẩu): kết nối được tức là đã dùng key + passphrase đã lưu.
  server = await startTestSshServer([{ username: 'deployer', publicKey: pair.public }])

  // Settings → Keychain → New → Account: tạo tài khoản, nhập key có passphrase.
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-nav-keychain').click()
  await page.getByTestId('keychain-new').click()
  await page.getByTestId('menu-keychain-new-account').click()
  const editor = page.getByTestId('account-editor')
  await editor.getByTestId('account-name').fill('Prod deploy')
  await editor.getByTestId('account-username').fill('deployer')
  await editor.getByTestId('account-import-key').click()
  // Hộp thoại import: đặt tên, passphrase sai bị báo ngay; đúng thì lưu (nhớ trong vault).
  const importDialog = page.getByTestId('key-import-dialog')
  await expect(importDialog.getByTestId('key-import-info')).toContainText('id_deploy')
  await importDialog.getByTestId('key-import-name').fill('id_deploy')
  await importDialog.getByTestId('key-import-passphrase').fill('wrong')
  await importDialog.getByTestId('key-import-save').click()
  await expect(importDialog.getByTestId('key-import-error')).toContainText('Wrong passphrase')
  await importDialog.getByTestId('key-import-passphrase').fill('acc-passphrase')
  await expect(importDialog.getByTestId('key-import-remember')).toBeChecked()
  await importDialog.getByTestId('key-import-save').click()
  await expect(importDialog).toHaveCount(0)
  await expect(editor.getByTestId('account-key')).not.toHaveValue('')
  await editor.getByTestId('account-passphrase').fill('acc-passphrase')
  await editor.getByTestId('account-save').click()
  await expect(editor).toHaveCount(0)
  const accountRow = page.locator('[data-testid="account-row"][data-account-name="Prod deploy"]')
  await expect(accountRow).toContainText('deployer')
  await expect(accountRow.locator('[data-badge="key"]')).toContainText('id_deploy')
  await expect(accountRow.locator('[data-badge="passphrase"]')).toBeVisible()
  await expect(accountRow.getByTestId('account-row-usage')).toHaveText('Not used by any host')
  // Cùng một danh sách: key vừa import nằm dưới, ghi rõ tài khoản đang dùng nó.
  const keyRow = page.locator('[data-testid="key-row"][data-key-name="id_deploy"]')
  await expect(keyRow.getByTestId('key-row-usage')).toHaveText('Used by: Prod deploy')
  await page.getByTestId('keychain-filter-accounts').click()
  await expect(keyRow).toHaveCount(0)
  await page.getByTestId('keychain-filter-keys').click()
  await expect(accountRow).toHaveCount(0)
  // Chi tiết key → liên kết tới tài khoản: bỏ lọc, chọn tài khoản.
  await keyRow.click()
  await page.getByTestId('key-usage-accounts').getByText('Prod deploy').click()
  await expect(page.getByTestId('account-detail')).toHaveAttribute(
    'data-account-name',
    'Prod deploy'
  )
  await page.keyboard.press('Escape')

  // Host mới chọn tài khoản: username lấy từ tài khoản (chỉ đọc), không nhập gì về xác thực.
  await page.getByTestId('add-host').click()
  const form = page.getByTestId('host-form')
  await form.getByTestId('host-hostname').fill('127.0.0.1')
  await form.getByTestId('host-port').fill(String(server.port))
  await form.getByTestId('host-label').fill('acct-host')
  await form.getByTestId('host-account').click()
  await form.getByTestId('host-account-search').fill('prod')
  await form.locator('[data-testid="host-account-option"][data-account-name="Prod deploy"]').click()
  await expect(form.getByTestId('host-account-summary')).toBeVisible()
  await expect(form.getByTestId('host-username')).toHaveValue('deployer')
  await expect(form.getByTestId('host-username')).toBeDisabled()
  await form.getByTestId('host-save').click()
  await expect(form).toHaveCount(0)

  const row = page.locator('[data-testid="host-row"][data-host-label="acct-host"]')
  await row.dblclick()
  const tab = await activeTab(page)
  await page.getByTestId('hostkey-accept').click()
  await waitForText(page, tab, 'welcome to test server')
  // Không hỏi passphrase / mật khẩu.
  await expect(page.getByTestId('prompt-dialog')).toHaveCount(0)
  expect(server.events.authAttempts.some((a) => a.method === 'publickey')).toBe(true)
  expect(server.events.authAttempts.some((a) => a.method === 'password')).toBe(false)

  // Mở lại form: vẫn là tài khoản; đổi sang Custom thì chép username / SSH key để sửa tiếp.
  await row.hover()
  await row.getByTestId('host-edit').click()
  await expect(form.getByTestId('host-account')).toContainText('Prod deploy')
  await form.getByTestId('host-account').click()
  await form.locator('[data-testid="host-account-option"][data-account-name=""]').click()
  await expect(form.getByTestId('host-username')).toHaveValue('deployer')
  await expect(form.getByTestId('host-auth-key')).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
  await expect(form).toHaveCount(0)

  // Tài khoản đang dùng: xoá phải chọn cách xử lý host.
  // Mở thẳng từ form host: "Manage accounts…" → Keychain lọc sẵn Accounts.
  await page.getByTestId('add-host').click()
  await form.getByTestId('host-account').click()
  await form.getByTestId('host-account-manage').click()
  const manage = page.getByTestId('accounts-dialog')
  await expect(manage.getByTestId('keychain-filter-accounts')).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await expect(accountRow.getByTestId('account-row-usage')).toHaveText('Used by 1 host')
  // Bàn phím: chọn tài khoản, Delete → hỏi cách xử lý host đang dùng.
  await accountRow.click()
  await page.keyboard.press('Delete')
  const dialog = page.getByTestId('account-delete-dialog')
  await expect(dialog).toContainText('acct-host')
  await dialog.getByTestId('account-delete-submit').click()
  await expect(accountRow).toHaveCount(0)
})
