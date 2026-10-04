import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  findSftpServer,
  startTestSshServer,
  type TestSshServer
} from '../integration/ssh-test-server'
import { activeTab, expect, test, waitForText } from './fixtures'

let server: TestSshServer | null = null
const dirs: string[] = []
test.afterEach(async () => {
  await server?.close()
  server = null
})
test.afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 20 })
})

test.skip(!findSftpServer(), 'Cần sftp-server của OpenSSH')

// PNG 1×1 đỏ.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64'
)

test('SFTP: xem nhanh (Space / menu Preview) — văn bản có số dòng, ảnh, file nhị phân', async ({
  page
}) => {
  const remote = mkdtempSync(join(tmpdir(), 'sh-preview-'))
  dirs.push(remote)
  writeFileSync(join(remote, 'notes.txt'), 'dòng một\nline two\nline three\n')
  writeFileSync(join(remote, 'dot.png'), PNG)
  writeFileSync(join(remote, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255, 0]))
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

  // Văn bản: chọn rồi Space.
  await panel.locator('[data-testid="sftp-entry"][data-name="notes.txt"]').click()
  await page.keyboard.press('Space')
  const dialog = page.getByTestId('file-preview')
  await expect(dialog.getByTestId('file-preview-text')).toContainText('dòng một')
  await expect(dialog.getByTestId('file-preview-text')).toContainText('3line three')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  // Ảnh: menu chuột phải → Preview.
  await panel.locator('[data-testid="sftp-entry"][data-name="dot.png"]').click({ button: 'right' })
  await page.getByTestId('menu-sftp-preview').click()
  await expect(dialog.getByTestId('file-preview-image')).toBeVisible()
  await page.keyboard.press('Escape')

  // Nhị phân → báo không xem được, gợi ý tải về.
  await panel.locator('[data-testid="sftp-entry"][data-name="blob.bin"]').click()
  await page.keyboard.press('Space')
  await expect(dialog.getByTestId('file-preview-none')).toContainText('not text or an image')
})

test('File manager ↔ terminal giữ nguyên phiên SSH (không mở phiên mới, không mất lệnh đang chạy)', async ({
  page
}) => {
  const remote = mkdtempSync(join(tmpdir(), 'sh-keep-'))
  dirs.push(remote)
  writeFileSync(join(remote, 'a.txt'), 'a')
  server = await startTestSshServer([{ username: 'u', password: 'p' }], { sftpRoot: remote })
  await page.getByTestId('titlebar-connect').click()
  await page.getByTestId('quick-connect').fill(`u@127.0.0.1:${server.port}`)
  await page.getByTestId('quick-connect').press('Enter')
  const tab = await activeTab(page)
  await page.getByTestId('hostkey-accept').click()
  await page.getByTestId('prompt-input').fill('p')
  await page.getByTestId('prompt-submit').click()
  await waitForText(page, tab, 'welcome to test server')

  await page.getByTestId('toggle-files').last().click()
  await expect(
    page.getByTestId('sftp-panel').locator('[data-testid="sftp-entry"][data-name="a.txt"]')
  ).toBeVisible()
  await page.getByTestId('toggle-files').last().click()
  await page.waitForTimeout(1500)
  const text = await page.evaluate((id) => window.__shellhouseTest.bufferText(id), tab)
  expect(text).not.toContain('new session')
  expect(text.match(/welcome to test server/g)?.length).toBe(1)
})
