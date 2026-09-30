import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

base('nhập từ ~/.ssh/config và MobaXterm: xem trước, bỏ mục lỗi, nhập mục được chọn', async () => {
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
  // MobaXterm.ini ở vị trí mặc định (%APPDATA%\MobaXterm): một phiên SSH trong thư mục lồng nhau,
  // một phiên RDP (bỏ qua) và mục mật khẩu (không bao giờ được đọc).
  const appData = join(home, 'AppData', 'Roaming')
  mkdirSync(join(appData, 'MobaXterm'), { recursive: true })
  const sshSession = (host: string, user: string): string =>
    `#109#0%${host}%22%${user}%%-1%-1%%%22%%0%0%0%%%-1%0%0%0%%1080%%0%0%1#MobaFont%10%0%0%-1%15#0# #-1`
  writeFileSync(
    join(appData, 'MobaXterm', 'MobaXterm.ini'),
    [
      '[Bookmarks]',
      'SubRep=',
      'ImgNum=42',
      'desktop=#91#4%192.0.2.10%3389%administrator%0%0%0%0%-1%0%0%-1%%%%%0#MobaFont%10#0# #-1',
      '[Bookmarks_1]',
      'SubRep=Prod\\Database',
      'ImgNum=41',
      `pg-main=${sshSession('db.example.com', 'postgres')}`,
      '[Passwords]',
      'ssh22:postgres@db.example.com=NOT-READ'
    ].join('\r\n')
  )
  const userData = join(home, 'userdata')
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: appData,
      SHELLHOUSE_TEST_HOOKS: '1',
      SHELLHOUSE_FAST_KDF: '1',
      SHELLHOUSE_USER_DATA: userData,
      SHELLHOUSE_HOME: home
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

    // MobaXterm: nhóm lồng nhau theo thư mục bookmark.
    await page.getByTestId('import-ssh-config').click()
    await dialog.getByTestId('import-source-mobaxterm').click()
    await baseExpect(dialog.getByTestId('import-file')).toContainText('MobaXterm.ini')
    await baseExpect(dialog.getByTestId('import-ignored')).toContainText('1 RDP')
    await baseExpect(dialog.locator('[data-testid^="import-row-"]')).toHaveCount(1)
    await baseExpect(dialog.locator('[data-testid^="import-row-"]')).toContainText(
      'postgres@db.example.com'
    )
    await dialog.getByTestId('import-run').click()
    await baseExpect(dialog.getByTestId('import-result')).toContainText('Imported 1 host')
    await dialog.getByRole('button', { name: 'Done' }).click()
    await baseExpect(
      page.locator('[data-testid="group-row"][data-group-name="Database"]')
    ).toBeVisible()
    await baseExpect(
      page.locator('[data-testid="host-row"][data-host-label="pg-main"]')
    ).toContainText('postgres@db.example.com')

    // CSV (kiểu Termius): cột Password bị bỏ qua.
    const csv = join(home, 'termius.csv')
    writeFileSync(
      csv,
      'Groups,Label,Tags,Hostname/IP,Protocol,Port,Username,Password\n' +
        'Staging,api-stg,api,api.stg.example.com,ssh,22,ubuntu,NOT-IMPORTED\n'
    )
    await app.evaluate(({ dialog }, f) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [f] })
    }, csv)
    await page.getByTestId('import-ssh-config').click()
    await dialog.getByTestId('import-source-csv').click()
    await dialog.getByTestId('import-choose-file').click()
    await baseExpect(dialog.getByTestId('import-secrets-skipped')).toContainText('Password')
    await baseExpect(dialog.locator('[data-testid^="import-row-"]')).toContainText(
      'ubuntu@api.stg.example.com'
    )
    await dialog.getByTestId('import-run').click()
    await baseExpect(dialog.getByTestId('import-result')).toContainText('Imported 1 host')
    await dialog.getByRole('button', { name: 'Done' }).click()
    await baseExpect(
      page.locator('[data-testid="host-row"][data-host-label="api-stg"]')
    ).toContainText('ubuntu@api.stg.example.com')
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

test('mất kết nối lúc vault đang khoá: báo rõ, mở khoá xong tự kết nối lại', async ({ page }) => {
  server = await startTestSshServer([{ username: 'alice', password: 'pw-trong-vault' }])
  await createHost(page, {
    hostname: '127.0.0.1',
    port: server.port,
    username: 'alice',
    label: 'Khoá rồi nối lại',
    password: 'pw-trong-vault'
  })
  await page.locator('[data-testid="host-row"][data-host-label="Khoá rồi nối lại"]').dblclick()
  const tab = await activeTab(page)
  await page.getByTestId('hostkey-accept').click()
  await waitForText(page, tab, 'welcome to test server')

  // Vault tự khoá (máy rảnh) rồi kết nối lại (như mất mạng) → không lấy được mật khẩu đã lưu.
  await page.evaluate(() => window.shellhouse.lockVault())
  await page.evaluate((id) => {
    window.__shellhouseTest.reconnect(id)
  }, tab)
  await waitForText(page, tab, 'The vault is locked')
  await page.evaluate((pw) => window.shellhouse.unlockVault(pw), E2E_PASSWORD)
  await expect
    .poll(() =>
      page.evaluate(
        (id) => window.__shellhouseTest.bufferText(id).split('welcome to test server').length - 1,
        tab
      )
    )
    .toBe(2)
})

test('chuột phải host → Open SFTP: trình quản lý file hai cột Local | Remote', async ({ page }) => {
  const remote = mkdtempSync(join(tmpdir(), 'sh-remote-'))
  const local = mkdtempSync(join(tmpdir(), 'sh-local-'))
  try {
    writeFileSync(join(remote, 'tren-server.txt'), 'từ server')
    writeFileSync(join(local, 'tren-may.txt'), 'từ máy')
    server = await startTestSshServer([{ username: 'alice', password: 'pw' }], { sftpRoot: remote })
    await createHost(page, {
      hostname: '127.0.0.1',
      port: server.port,
      username: 'alice',
      label: 'File server',
      password: 'pw'
    })
    await page
      .locator('[data-testid="host-row"][data-host-label="File server"]')
      .click({ button: 'right' })
    await page.getByTestId('menu-sftp').click()
    await page.getByTestId('hostkey-accept').click()

    const manager = page.getByTestId('file-manager')
    await expect(manager).toBeVisible()
    await expect(page.getByTestId('tab').last()).toContainText('File server (SFTP)')
    const remotePane = manager.getByTestId('sftp-panel')
    const localPane = manager.getByTestId('local-panel')
    // Thư mục home của máy hiện sẵn; chuyển tới thư mục test.
    await localPane.getByTestId('local-path').fill(local)
    await localPane.getByTestId('local-path').press('Enter')
    await expect(
      localPane.locator('[data-testid="local-entry"][data-name="tren-may.txt"]')
    ).toBeVisible()
    await expect(
      remotePane.locator('[data-testid="sftp-entry"][data-name="tren-server.txt"]')
    ).toBeVisible()

    // Local → Remote: bấm đúp file.
    await localPane.locator('[data-testid="local-entry"][data-name="tren-may.txt"]').dblclick()
    await expect
      .poll(() =>
        existsSync(join(remote, 'tren-may.txt'))
          ? readFileSync(join(remote, 'tren-may.txt'), 'utf8')
          : ''
      )
      .toBe('từ máy')

    // Remote → Local: kéo thả, lưu thẳng vào thư mục local đang mở (không hỏi chỗ lưu).
    await remotePane
      .locator('[data-testid="sftp-entry"][data-name="tren-server.txt"]')
      .dragTo(localPane)
    await expect
      .poll(() =>
        existsSync(join(local, 'tren-server.txt'))
          ? readFileSync(join(local, 'tren-server.txt'), 'utf8')
          : ''
      )
      .toBe('từ server')
    await expect(
      localPane.locator('[data-testid="local-entry"][data-name="tren-server.txt"]')
    ).toBeVisible()

    // Xem terminal của cùng kết nối.
    await page.getByTestId('toggle-files').click()
    await expect(manager).toHaveCount(0)
    await waitForText(page, await activeTab(page), 'welcome to test server')
  } finally {
    // Windows: sftp-server.exe (cwd = thư mục remote) còn sống tới lúc app đóng → EPERM; thư mục
    // tạm để hệ điều hành dọn.
    for (const dir of [remote, local]) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      } catch {
        // bỏ qua
      }
    }
  }
})
