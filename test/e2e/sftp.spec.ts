import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { basename, join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  findSftpServer,
  startTestSshServer,
  type TestSshServer
} from '../integration/ssh-test-server'
import { activeTab, expect, isWindows, test, waitForText } from './fixtures'

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

let server: TestSshServer | null = null
const dirs: string[] = []
test.afterEach(async () => {
  await server?.close()
  server = null
})
// Dọn sau khi app đã đóng: trên Windows sftp-server.exe (cwd = thư mục remote) còn sống tới lúc phiên
// SSH của app đóng, xoá sớm sẽ gặp EPERM.
test.afterAll(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    } catch {
      // Thư mục tạm — để hệ điều hành dọn.
    }
  }
})

test.skip(!findSftpServer(), 'Cần sftp-server của OpenSSH')

test('SFTP qua giao diện: tải lên, tạo thư mục, tải về, xoá', async ({ app, page }) => {
  const remote = mkdtempSync(join(tmpdir(), 'sh-remote-'))
  const local = mkdtempSync(join(tmpdir(), 'sh-local-'))
  dirs.push(remote, local)
  writeFileSync(join(remote, 'co-san.txt'), 'nội dung có sẵn')
  const payload = randomBytes(3 * 1024 * 1024)
  writeFileSync(join(local, 'tai-len.bin'), payload)
  server = await startTestSshServer([{ username: 'u', password: 'p' }], { sftpRoot: remote })

  await page.getByTestId('titlebar-connect').click()
  await page.getByTestId('quick-connect').fill(`u@127.0.0.1:${server.port}`)
  await page.getByTestId('quick-connect').press('Enter')
  const tab = await activeTab(page)
  await page.getByTestId('hostkey-accept').click()
  await page.getByTestId('prompt-input').fill('p')
  await page.getByTestId('prompt-submit').click()
  await waitForText(page, tab, 'welcome to test server')

  await page.getByTestId('toggle-sftp').last().click()
  const panel = page.getByTestId('sftp-panel')
  // macOS: /var là symlink tới /private/var — server trả đường dẫn thật. Windows: sftp-server của
  // Win32-OpenSSH trả dạng "/C:/Users/…".
  const real = realpathSync(remote)
  await expect(panel.getByTestId('sftp-path')).toHaveValue(
    isWindows ? `/${real.replaceAll('\\', '/')}` : real
  )
  await expect(panel.locator('[data-testid="sftp-entry"][data-name="co-san.txt"]')).toBeVisible()

  // Menu Sort: Modified mới trước / cũ trước.
  writeFileSync(join(remote, 'moi-hon.txt'), 'x')
  utimesSync(join(remote, 'co-san.txt'), new Date(2020, 0, 1), new Date(2020, 0, 1))
  await panel.getByRole('button', { name: 'Refresh' }).first().click()
  const order = (): Promise<(string | null)[]> =>
    panel
      .getByTestId('sftp-entry')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-name')))
  await expect.poll(order).toEqual(['co-san.txt', 'moi-hon.txt'])
  await panel.getByTestId('sftp-sort').click()
  await page.getByRole('menuitem', { name: 'Modified' }).click()
  await expect.poll(order).toEqual(['moi-hon.txt', 'co-san.txt'])
  await panel.getByTestId('sftp-sort').click()
  await page.getByRole('menuitem', { name: 'Oldest first' }).click()
  await expect.poll(order).toEqual(['co-san.txt', 'moi-hon.txt'])
  await panel.getByTestId('sftp-sort').click()
  await page.getByRole('menuitem', { name: 'Name' }).click()

  // Chọn nhiều (Ctrl+bấm) rồi Del → hộp xoá liệt kê đủ, xoá cả hai.
  writeFileSync(join(remote, 'xoa-1.tmp'), '1')
  writeFileSync(join(remote, 'xoa-2.tmp'), '2')
  await panel.getByRole('button', { name: 'Refresh' }).first().click()
  await panel.locator('[data-testid="sftp-entry"][data-name="xoa-1.tmp"]').click()
  await panel
    .locator('[data-testid="sftp-entry"][data-name="xoa-2.tmp"]')
    .click({ modifiers: ['ControlOrMeta'] })
  await expect(panel.getByTestId('sftp-status')).toContainText('2 selected')
  await page.keyboard.press('Delete')
  await expect(page.getByTestId('sftp-dialog')).toContainText('Delete these 2 items')
  await page.getByTestId('sftp-dialog-submit').click()
  await expect(panel.locator('[data-testid="sftp-entry"][data-name="xoa-1.tmp"]')).toHaveCount(0)
  await expect(panel.locator('[data-testid="sftp-entry"][data-name="xoa-2.tmp"]')).toHaveCount(0)
  expect(existsSync(join(remote, 'xoa-1.tmp'))).toBe(false)

  // Tải lên (hộp thoại chọn file được thay bằng đường dẫn cố định).
  await app.evaluate(
    ({ dialog }, file) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [file] })
    },
    join(local, 'tai-len.bin')
  )
  await panel.getByTestId('sftp-upload').click()
  await expect(panel.getByTestId('transfer-row').first()).toHaveAttribute('data-state', 'done')
  await expect(panel.locator('[data-testid="sftp-entry"][data-name="tai-len.bin"]')).toBeVisible()
  expect(sha(readFileSync(join(remote, 'tai-len.bin')))).toBe(sha(payload))

  // Tạo thư mục.
  await panel.getByTestId('sftp-mkdir').click()
  await page.getByTestId('sftp-dialog-input').fill('thu-muc-moi')
  await page.getByTestId('sftp-dialog-submit').click()
  await expect(panel.locator('[data-testid="sftp-entry"][data-name="thu-muc-moi"]')).toBeVisible()
  expect(existsSync(join(remote, 'thu-muc-moi'))).toBe(true)

  // Tải về.
  const savedTo = join(local, 'tai-ve.txt')
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: file })
  }, savedTo)
  await panel.locator('[data-testid="sftp-entry"][data-name="co-san.txt"]').click()
  await panel.getByTestId('sftp-download').click()
  await expect
    .poll(() => (existsSync(savedTo) ? readFileSync(savedTo, 'utf8') : ''))
    .toBe('nội dung có sẵn')

  // Xoá.
  await panel.locator('[data-testid="sftp-entry"][data-name="tai-len.bin"]').click()
  await panel.getByTestId('sftp-delete').click()
  await page.getByTestId('sftp-dialog-submit').click()
  await expect(panel.locator('[data-testid="sftp-entry"][data-name="tai-len.bin"]')).toHaveCount(0)
  expect(existsSync(join(remote, 'tai-len.bin'))).toBe(false)
})

test('sửa file trên server bằng editor trên máy (menu chuột phải), lưu → tự tải lên', async ({
  app,
  page
}) => {
  const remote = mkdtempSync(join(tmpdir(), 'sh-remote-'))
  dirs.push(remote)
  writeFileSync(join(remote, 'app.conf'), 'port=80\n')
  server = await startTestSshServer([{ username: 'u', password: 'p' }], { sftpRoot: remote })

  // Editor giả: ghi lại đường dẫn main định mở thay vì mở chương trình thật.
  await app.evaluate(({ shell }) => {
    const opened: string[] = []
    Object.assign(globalThis, { __opened: opened })
    shell.openPath = (p) => {
      opened.push(p)
      return Promise.resolve('')
    }
  })
  const opened = (): Promise<string[]> =>
    app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened)

  await page.getByTestId('titlebar-connect').click()
  await page.getByTestId('quick-connect').fill(`u@127.0.0.1:${server.port}`)
  await page.getByTestId('quick-connect').press('Enter')
  const tab = await activeTab(page)
  await page.getByTestId('hostkey-accept').click()
  await page.getByTestId('prompt-input').fill('p')
  await page.getByTestId('prompt-submit').click()
  await waitForText(page, tab, 'welcome to test server')
  await page.getByTestId('toggle-sftp').last().click()
  const panel = page.getByTestId('sftp-panel')

  await panel.locator('[data-testid="sftp-entry"][data-name="app.conf"]').click({ button: 'right' })
  await page.getByTestId('menu-sftp-edit').click()
  await expect.poll(async () => (await opened()).length).toBe(1)
  const [local] = await opened()
  if (!local) throw new Error('editor was not opened')
  expect(readFileSync(local, 'utf8')).toBe('port=80\n')

  writeFileSync(local, 'port=8080\n') // "Lưu" trong editor
  await expect.poll(() => readFileSync(join(remote, 'app.conf'), 'utf8')).toBe('port=8080\n')
  await expect(panel.getByTestId('transfer-row').last()).toContainText('Saved to server')
})

test('editor trong app: bấm đúp file cấu hình, tô màu, Ctrl+S lưu thẳng lên server, xung đột, đóng khi chưa lưu', async ({
  page
}) => {
  const remote = mkdtempSync(join(tmpdir(), 'sh-remote-'))
  dirs.push(remote)
  writeFileSync(join(remote, 'nginx.conf'), 'server {\r\n  listen 80;\r\n}\r\n')
  writeFileSync(join(remote, 'blob.dat'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]))
  server = await startTestSshServer([{ username: 'u', password: 'p' }], { sftpRoot: remote })

  await page.getByTestId('titlebar-connect').click()
  await page.getByTestId('quick-connect').fill(`u@127.0.0.1:${server.port}`)
  await page.getByTestId('quick-connect').press('Enter')
  const tab = await activeTab(page)
  await page.getByTestId('hostkey-accept').click()
  await page.getByTestId('prompt-input').fill('p')
  await page.getByTestId('prompt-submit').click()
  await waitForText(page, tab, 'welcome to test server')
  await page.getByTestId('toggle-sftp').last().click()
  const panel = page.getByTestId('sftp-panel')

  await panel.locator('[data-testid="sftp-entry"][data-name="nginx.conf"]').dblclick()
  const editor = page.getByTestId('editor')
  // Đường dẫn trên server (macOS: /private/var/…, Windows: /C:/…) — chỉ cần đúng thư mục + tên.
  await expect(editor.getByTestId('editor-path')).toHaveText(
    new RegExp(`${basename(remote)}/nginx\\.conf$`)
  )
  await expect(editor.getByTestId('editor-language')).toHaveValue('nginx')
  await expect(editor.locator('.cm-content')).toContainText('listen 80;')
  await expect(editor.getByTestId('editor-state')).toHaveText('Saved')
  await expect(editor).toContainText('CRLF')

  // Sửa: dòng 2 → "listen 8080;", Ctrl+S → ghi lên server, giữ CRLF.
  await editor.locator('.cm-line').nth(1).click()
  await page.keyboard.press('End')
  // Home của CodeMirror dừng sau phần thụt lề → chỉ thay phần chữ.
  await page.keyboard.press('Shift+Home')
  await page.keyboard.type('listen 8080;')
  await expect(editor.getByTestId('editor-state')).toHaveText('Unsaved changes')
  await expect(
    page.locator(`[data-testid="tab"][data-tab-id]`).filter({ hasText: '● nginx.conf' })
  ).toBeVisible()
  await page.keyboard.press('ControlOrMeta+s')
  await expect(editor.getByTestId('editor-state')).toHaveText('Saved')
  await expect
    .poll(() => readFileSync(join(remote, 'nginx.conf'), 'utf8'))
    .toBe('server {\r\n  listen 8080;\r\n}\r\n')

  // Ai đó sửa file trên server → lưu báo xung đột; chọn ghi đè.
  writeFileSync(join(remote, 'nginx.conf'), 'server {\r\n  listen 9090;\r\n}\r\n')
  utimesSync(join(remote, 'nginx.conf'), new Date(), new Date(Date.now() + 10_000))
  await editor.locator('.cm-line').nth(0).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' # mine')
  await page.keyboard.press('ControlOrMeta+s')
  await expect(editor.getByTestId('editor-conflict')).toBeVisible()
  expect(readFileSync(join(remote, 'nginx.conf'), 'utf8')).toContain('9090')
  await editor.getByTestId('editor-overwrite').click()
  await expect(editor.getByTestId('editor-conflict')).toHaveCount(0)
  await expect
    .poll(() => readFileSync(join(remote, 'nginx.conf'), 'utf8'))
    .toBe('server { # mine\r\n  listen 8080;\r\n}\r\n')

  // Chưa lưu → đóng tab hỏi lại; chọn giữ thì tab còn.
  await editor.locator('.cm-line').nth(2).click()
  await page.keyboard.type('x')
  await expect(editor.getByTestId('editor-state')).toHaveText('Unsaved changes')
  const editorTab = page.locator('[data-testid="tab"]').filter({ hasText: 'nginx.conf' })
  await editorTab.getByTestId('tab-close').click()
  await page.getByTestId('close-tab-confirm').getByTestId('confirm-cancel').click()
  await expect(editorTab).toHaveCount(1)
  await editorTab.getByTestId('tab-close').click()
  await page.getByTestId('close-tab-confirm').getByTestId('confirm-ok').click()
  await expect(editorTab).toHaveCount(0)

  // File nhị phân: không mở bằng editor của app (menu "Edit" vẫn báo rõ).
  await panel.locator('[data-testid="sftp-entry"][data-name="blob.dat"]').click({ button: 'right' })
  await page.getByTestId('menu-sftp-edit-app').click()
  await expect(page.getByTestId('editor-message')).toContainText('binary')
})

test('tải cả thư mục lên và về qua giao diện', async ({ app, page }) => {
  const remote = mkdtempSync(join(tmpdir(), 'sh-remote-'))
  const local = mkdtempSync(join(tmpdir(), 'sh-local-'))
  dirs.push(remote, local)
  mkdirSync(join(local, 'du-an', 'src'), { recursive: true })
  writeFileSync(join(local, 'du-an', 'README.md'), '# dự án')
  writeFileSync(join(local, 'du-an', 'src', 'main.ts'), 'console.log(1)')
  server = await startTestSshServer([{ username: 'u', password: 'p' }], { sftpRoot: remote })

  await page.getByTestId('titlebar-connect').click()
  await page.getByTestId('quick-connect').fill(`u@127.0.0.1:${server.port}`)
  await page.getByTestId('quick-connect').press('Enter')
  const tab = await activeTab(page)
  await page.getByTestId('hostkey-accept').click()
  await page.getByTestId('prompt-input').fill('p')
  await page.getByTestId('prompt-submit').click()
  await waitForText(page, tab, 'welcome to test server')
  await page.getByTestId('toggle-sftp').last().click()
  const panel = page.getByTestId('sftp-panel')

  // Hộp thoại chọn thư mục được thay bằng đường dẫn cố định.
  const pickFolder = (folder: string) =>
    app.evaluate(({ dialog }, f) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [f] })
    }, folder)

  await pickFolder(join(local, 'du-an'))
  await panel.getByTestId('sftp-upload-folder').click()
  await expect(panel.locator('[data-testid="sftp-entry"][data-name="du-an"]')).toBeVisible()
  await expect
    .poll(() =>
      existsSync(join(remote, 'du-an', 'src', 'main.ts'))
        ? readFileSync(join(remote, 'du-an', 'src', 'main.ts'), 'utf8')
        : ''
    )
    .toBe('console.log(1)')

  const saveTo = mkdtempSync(join(tmpdir(), 'sh-save-'))
  dirs.push(saveTo)
  await pickFolder(saveTo)
  await panel.locator('[data-testid="sftp-entry"][data-name="du-an"]').click()
  await panel.getByTestId('sftp-download').click()
  await expect
    .poll(() =>
      existsSync(join(saveTo, 'du-an', 'README.md'))
        ? readFileSync(join(saveTo, 'du-an', 'README.md'), 'utf8')
        : ''
    )
    .toBe('# dự án')
})
