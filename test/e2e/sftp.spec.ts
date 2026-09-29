import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
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
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
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
