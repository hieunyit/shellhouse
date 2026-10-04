import { fingerprintSha256 } from '../../src/node-shared/hostkey'
import { startTestSshServer, type TestSshServer } from '../integration/ssh-test-server'
import { activeTab, expect, sendLine, test, waitForText } from './fixtures'
import type { Page } from '@playwright/test'

let server: TestSshServer | null = null
test.afterEach(async () => {
  await server?.close()
  server = null
})

async function quickConnect(page: Page, target: string): Promise<string> {
  const before = await page.getByTestId('tab').count()
  await page.getByTestId('titlebar-connect').click()
  await page.getByTestId('quick-connect').fill(target)
  await page.getByTestId('quick-connect').press('Enter')
  await expect(page.getByTestId('tab')).toHaveCount(before + 1)
  return activeTab(page)
}

test('kết nối nhanh: xác nhận host mới → mật khẩu → shell; lần sau không hỏi host key', async ({
  page
}) => {
  server = await startTestSshServer([{ username: 'alice', password: 'mat-khau-ssh' }])
  const tab = await quickConnect(page, `alice@127.0.0.1:${server.port}`)
  await expect(page.getByTestId('tab').last()).toContainText('alice@127.0.0.1')

  const dialog = page.getByTestId('prompt-dialog')
  await expect(dialog).toHaveAttribute('data-prompt-kind', 'hostkey')
  await expect(page.getByTestId('hostkey-fingerprint')).toHaveText(
    fingerprintSha256(server.hostKeyBlob)
  )
  await page.getByTestId('hostkey-accept').click()

  await expect(dialog).toHaveAttribute('data-prompt-kind', 'password')
  await page.getByTestId('prompt-input').fill('mat-khau-ssh')
  await page.getByTestId('prompt-submit').click()
  await expect(dialog).toHaveCount(0)

  await waitForText(page, tab, 'welcome to test server')
  await sendLine(page, tab, 'echo qua-ssh')
  await waitForText(page, tab, 'qua-ssh\n')
  // Mật khẩu không bao giờ hiện trong terminal.
  expect(await page.evaluate((id) => window.__shellhouseTest.bufferText(id), tab)).not.toContain(
    'mat-khau-ssh'
  )

  // Kết nối lần hai: host key đã được tin → chỉ hỏi mật khẩu.
  await quickConnect(page, `alice@127.0.0.1:${server.port}`)
  await expect(dialog).toHaveAttribute('data-prompt-kind', 'password')
})

test('huỷ nhập mật khẩu → tab báo ngắt, Enter để thử lại', async ({ page }) => {
  server = await startTestSshServer([{ username: 'alice', password: 'p' }])
  const tab = await quickConnect(page, `alice@127.0.0.1:${server.port}`)
  await page.getByTestId('hostkey-accept').click()
  await expect(page.getByTestId('prompt-dialog')).toHaveAttribute('data-prompt-kind', 'password')
  await page.keyboard.press('Escape')
  await waitForText(page, tab, 'Disconnected')

  await page.getByTestId(`terminal-${tab}`).click()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('prompt-dialog')).toHaveAttribute('data-prompt-kind', 'password')
})

test('host key bị đổi: cảnh báo đỏ, phải xác nhận 2 bước; huỷ thì không kết nối', async ({
  page
}) => {
  server = await startTestSshServer([{ username: 'alice', password: 'p' }])
  const port = server.port
  const first = await quickConnect(page, `alice@127.0.0.1:${port}`)
  await page.getByTestId('hostkey-accept').click()
  await page.getByTestId('prompt-input').fill('p')
  await page.getByTestId('prompt-submit').click()
  await expect(page.getByTestId('prompt-dialog')).toHaveCount(0)
  // Đóng tab đầu: không thì nó tự kết nối lại khi server đổi, hiện thêm một hộp cảnh báo nữa.
  await page
    .locator(`[data-testid="tab"][data-tab-id="${first}"] [data-testid="tab-close"]`)
    .click()
  // Tab SSH đang kết nối: đóng phải xác nhận.
  await page.getByTestId('close-tab-confirm').getByTestId('confirm-ok').click()
  await expect(page.locator(`[data-testid="tab"][data-tab-id="${first}"]`)).toHaveCount(0)

  // Server khác (host key khác) trên cùng port — giống bị MITM hoặc cài lại server.
  await server.close()
  server = await startTestSshServer([{ username: 'alice', password: 'p' }], { port })

  const tab = await quickConnect(page, `alice@127.0.0.1:${port}`)
  await expect(page.getByTestId('hostkey-changed')).toBeVisible()
  await expect(page.getByTestId('hostkey-changed')).toContainText(
    fingerprintSha256(server.hostKeyBlob)
  )
  const accept = page.getByTestId('hostkey-accept')
  await expect(accept).toBeDisabled()
  await page.getByTestId('hostkey-confirm').check()
  await expect(accept).toBeEnabled()
  await page.getByTestId('hostkey-confirm').uncheck()
  await page.getByTestId('prompt-cancel').click()

  await waitForText(page, tab, 'Disconnected')
  expect(server.events.authAttempts).toHaveLength(0) // không gửi gì tới server lạ
})

test('mất kết nối → tự kết nối lại khi server lên lại; sai/huỷ xác thực thì không tự thử', async ({
  page
}) => {
  server = await startTestSshServer([{ username: 'alice', password: 'p' }])
  const { port, hostKey } = server
  const tab = await quickConnect(page, `alice@127.0.0.1:${port}`)
  await page.getByTestId('hostkey-accept').click()
  await page.getByTestId('prompt-input').fill('p')
  await page.getByTestId('prompt-submit').click()
  await waitForText(page, tab, 'welcome to test server')

  // Server sập (ngắt mọi client) → tab chuyển sang tự kết nối lại.
  await server.close()
  await waitForText(page, tab, 'reconnecting in 1 s')
  await expect
    .poll(() => page.evaluate((id) => window.__shellhouseTest.state(id), tab))
    .toBe('reconnecting')

  // Server lên lại (cùng host key) → app tự nối, chỉ hỏi mật khẩu (chưa lưu), không hỏi host key.
  server = await startTestSshServer([{ username: 'alice', password: 'p' }], { port, hostKey })
  const dialog = page.getByTestId('prompt-dialog')
  await expect(dialog).toHaveAttribute('data-prompt-kind', 'password', { timeout: 15_000 })
  await page.getByTestId('prompt-input').fill('p')
  await page.getByTestId('prompt-submit').click()
  await expect
    .poll(() => page.evaluate((id) => window.__shellhouseTest.state(id), tab))
    .toBe('connected')
  await sendLine(page, tab, 'echo da-noi-lai')
  await waitForText(page, tab, 'da-noi-lai\n')

  // Lần rớt tiếp theo mà người dùng huỷ ô mật khẩu → dừng, không lặp vô hạn.
  await server.close()
  server = await startTestSshServer([{ username: 'alice', password: 'p' }], { port, hostKey })
  await expect(dialog).toHaveAttribute('data-prompt-kind', 'password', { timeout: 15_000 })
  await page.getByTestId('prompt-cancel').click()
  await waitForText(page, tab, 'Disconnected')
  await page.waitForTimeout(2_500)
  await expect(dialog).toHaveCount(0)
  expect(await page.evaluate((id) => window.__shellhouseTest.state(id), tab)).toBe('exited')
})
