import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _electron as electron,
  expect as baseExpect,
  test as base,
  type Page
} from '@playwright/test'
import { startTestSshServer, type TestSshServer } from '../integration/ssh-test-server'
import { activeTab, E2E_PASSWORD, expect, sendLine, test, waitForText } from './fixtures'

let server: TestSshServer | null = null
test.afterEach(async () => {
  await server?.close()
  server = null
})

async function createHost(
  page: Page,
  opts: { hostname: string; port: number; username: string; label: string; password?: string }
): Promise<void> {
  await page.getByTestId('add-host').click()
  const form = page.getByTestId('host-form')
  await form.getByTestId('host-hostname').fill(opts.hostname)
  await form.getByTestId('host-port').fill(String(opts.port))
  await form.getByTestId('host-username').fill(opts.username)
  await form.getByTestId('host-label').fill(opts.label)
  if (opts.password) {
    await form.getByTestId('host-auth-password').check()
    await form.getByTestId('host-password').fill(opts.password)
  }
  await form.getByTestId('host-save').click()
  await expect(form).toHaveCount(0)
}

test('tạo host có mật khẩu → kết nối không cần nhập mật khẩu; sửa giữ nguyên mật khẩu', async ({
  page
}) => {
  server = await startTestSshServer([{ username: 'alice', password: 'luu-trong-vault' }])
  await createHost(page, {
    hostname: '127.0.0.1',
    port: server.port,
    username: 'alice',
    label: 'Máy test',
    password: 'luu-trong-vault'
  })
  const row = page.locator('[data-testid="host-row"][data-host-label="Máy test"]')
  await expect(row).toContainText(`alice@127.0.0.1:${server.port}`)

  await row.dblclick()
  await expect(page.getByTestId('tab').last()).toContainText('Máy test')
  const tab = await activeTab(page)
  await page.getByTestId('hostkey-accept').click()
  // Mật khẩu đã lưu → không có ô nhập mật khẩu.
  await waitForText(page, tab, 'welcome to test server')
  await expect(page.getByTestId('prompt-dialog')).toHaveCount(0)

  // Sửa tên mà không nhập lại mật khẩu → mật khẩu vẫn còn.
  await row.hover()
  await row.getByTestId('host-edit').click()
  await expect(page.getByTestId('host-password')).toHaveAttribute('placeholder', /Saved/)
  await page.getByTestId('host-label').fill('Máy test 2')
  await page.getByTestId('host-save').click()
  const renamed = page.locator('[data-testid="host-row"][data-host-label="Máy test 2"]')
  await renamed.dblclick()
  const tab2 = await activeTab(page)
  await waitForText(page, tab2, 'welcome to test server')
  await sendLine(page, tab2, 'echo host-da-luu')
  await waitForText(page, tab2, 'host-da-luu\n')
})

test('tìm kiếm mờ bằng Ctrl+Shift+K, Enter để kết nối', async ({ page }) => {
  server = await startTestSshServer([{ username: 'bob', password: 'pw' }])
  await createHost(page, {
    hostname: '127.0.0.1',
    port: server.port,
    username: 'bob',
    label: 'prod-web-01'
  })
  await createHost(page, { hostname: '10.9.9.9', port: 22, username: 'x', label: 'staging-db' })

  await page.getByTestId(`terminal-${await activeTab(page)}`).click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+Shift+K')
  await expect(page.getByTestId('host-search')).toBeFocused()
  await page.keyboard.type('pw01')
  const rows = page.getByTestId('host-row')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toHaveAttribute('data-host-label', 'prod-web-01')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('tab').last()).toContainText('prod-web-01')
  await expect(page.getByTestId('prompt-dialog')).toHaveAttribute('data-prompt-kind', 'hostkey')
})

test('nhóm: tạo nhóm, kéo host vào nhóm; xoá host', async ({ page }) => {
  await createHost(page, { hostname: 'db.example.com', port: 22, username: 'ops', label: 'db-1' })
  await page.getByTestId('add-group').click()
  await page.getByTestId('group-name').fill('Production')
  await page.getByTestId('group-save').click()

  const group = page.locator('[data-testid="group-row"][data-group-name="Production"]')
  const host = page.locator('[data-testid="host-row"][data-host-label="db-1"]')
  await host.dragTo(group)
  await expect(group).toContainText('1')
  await expect(page.getByTestId('ungrouped').getByTestId('host-row')).toHaveCount(0)

  await host.hover()
  await host.getByTestId('host-edit').click()
  await page.getByRole('button', { name: 'Delete host' }).click()
  await expect(page.getByTestId('host-row')).toHaveCount(0)
  await expect(group).toContainText('0')
})

test('form từ chối hostname chèn tham số', async ({ page }) => {
  await page.getByTestId('add-host').click()
  await page.getByTestId('host-hostname').fill('-oProxyCommand=touch')
  await page.getByTestId('host-username').fill('root')
  await page.getByTestId('host-save').click()
  await expect(page.getByTestId('host-error')).toContainText('hostname')
  await expect(page.getByTestId('host-form')).toBeVisible()
})

base('nhập từ ~/.ssh/config: xem trước, bỏ mục lỗi, nhập mục được chọn', async () => {
  const home = mkdtempSync(join(tmpdir(), 'shellhouse-home-'))
  mkdirSync(join(home, '.ssh'))
  writeFileSync(join(home, '.ssh', 'id_test'), 'dummy')
  writeFileSync(
    join(home, '.ssh', 'config'),
    [
      'Host web',
      '  HostName web.example.com',
      '  User deploy',
      '  IdentityFile ~/.ssh/id_test',
      'Host bad',
      '  HostName -oProxyCommand=x',
      'Host *.corp',
      '  User corp',
      'Host *',
      '  User fallback'
    ].join('\n')
  )
  const userData = join(home, 'userdata')
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      SHELLHOUSE_TEST_HOOKS: '1',
      SHELLHOUSE_FAST_KDF: '1',
      SHELLHOUSE_USER_DATA: userData
    }
  })
  try {
    const page = await app.firstWindow()
    await page.waitForFunction(() => 'shellhouse' in window)
    await page.evaluate((pw) => window.shellhouse.createVault(pw), E2E_PASSWORD)

    await page.getByTestId('import-ssh-config').click()
    const dialog = page.getByTestId('import-dialog')
    await baseExpect(dialog.getByTestId('import-row-web')).toContainText('deploy@web.example.com')
    await baseExpect(dialog.getByTestId('import-row-bad')).toContainText('Invalid hostname')
    await baseExpect(dialog.getByTestId('import-row-bad').getByRole('checkbox')).toBeDisabled()
    await baseExpect(dialog.locator('[data-testid^="import-row-"]')).toHaveCount(2) // không có *.corp, *
    await dialog.getByTestId('import-run').click()
    await baseExpect(dialog.getByTestId('import-result')).toContainText('Imported 1 host')
    await dialog.getByRole('button', { name: 'Done' }).click()

    const row = page.locator('[data-testid="host-row"][data-host-label="web"]')
    await baseExpect(row).toContainText('deploy@web.example.com')
  } finally {
    await app.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('tuỳ chọn "Allow legacy algorithms" được lưu theo host', async ({ page }) => {
  await page.getByTestId('add-host').click()
  const form = page.getByTestId('host-form')
  await form.getByTestId('host-hostname').fill('10.0.0.1')
  await form.getByTestId('host-username').fill('admin')
  await form.getByTestId('host-label').fill('old-switch')
  await form.getByTestId('host-legacy').check()
  await form.getByTestId('host-save').click()
  await expect(form).toHaveCount(0)
  const row = page.locator('[data-testid="host-row"][data-host-label="old-switch"]')
  await row.hover()
  await row.getByTestId('host-edit').click()
  await expect(form.getByTestId('host-legacy')).toBeChecked()
})
