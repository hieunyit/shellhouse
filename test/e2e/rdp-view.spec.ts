import { expect, test as base } from '@playwright/test'
import { launchApp, type LaunchedApp } from './fixtures'
import { startFakeRdp, type FakeRdp } from '../integration/rdp-fake-server'

/**
 * Remote Desktop trong tab: tab mở → kiểm chứng chỉ (TOFU) → IronRDP (WASM, chạy dưới CSP của bản
 * build) kết nối proxy RDCleanPath trong Session Host → proxy làm X.224 + TLS với server giả.
 * Server giả không nói RDP thật nên phiên dừng ở bước CredSSP — đủ để kiểm cả đường ống tới hết
 * RDCleanPath. Vẽ desktop thật cần server RDP thật (xem docs / hướng dẫn thử bằng xrdp).
 */
const test = base.extend<{ launched: LaunchedApp; server: FakeRdp }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright bắt buộc destructuring fixture
  server: async ({}, use) => {
    const server = await startFakeRdp()
    await use(server)
    await server.close()
  },
  // eslint-disable-next-line no-empty-pattern -- Playwright bắt buộc destructuring fixture
  launched: async ({}, use) => {
    const launched = await launchApp()
    await use(launched)
    await launched.close()
  }
})

test('tab Remote Desktop: chứng chỉ, proxy RDCleanPath, WASM dưới CSP', async ({
  launched,
  server
}) => {
  const { page } = launched
  await page.getByTestId('add-host').click()
  const form = page.getByTestId('host-form')
  await form.getByTestId('host-protocol-rdp').click()
  await form.getByTestId('host-hostname').fill('127.0.0.1')
  await form.getByTestId('host-port').fill(String(server.port))
  await form.getByTestId('host-username').fill('alice')
  await form.getByTestId('host-password').fill('Secr3t!')
  await form.getByTestId('host-label').fill('fake-rdp')
  await form.getByTestId('host-save').click()
  await expect(form).toHaveCount(0)

  await page.locator('[data-testid="host-row"][data-host-label="fake-rdp"]').dblclick()
  const view = page.getByTestId('rdp-view')
  await expect(view).toBeVisible()
  await expect(page.getByTestId('tab').filter({ hasText: 'fake-rdp' })).toBeVisible()

  // Lần đầu: hỏi tin chứng chỉ, hiện fingerprint SHA-256.
  const cert = view.getByTestId('rdp-view-certificate')
  await expect(cert).toBeVisible()
  await expect(cert).toContainText('Trust this Remote Desktop server?')
  await expect(cert.getByTestId('rdp-view-cert-fingerprint')).toHaveText(
    /^SHA-256 ([0-9A-F]{2}:){31}[0-9A-F]{2}$/
  )
  await cert.getByTestId('rdp-view-cert-trust').click()

  // WASM nạp, mở WebSocket tới proxy, proxy chuyển X.224 của IronRDP tới server (lần 2: sau probe).
  await expect.poll(() => server.requests.length, { timeout: 30_000 }).toBe(2)
  // Server giả không biết CredSSP → phiên kết thúc với lỗi, có nút Reconnect.
  await expect(view).toHaveAttribute('data-phase', 'disconnected', { timeout: 30_000 })
  await expect(view.getByTestId('rdp-view-disconnected')).toBeVisible()

  // Kết nối lại: chứng chỉ đã tin → không hỏi nữa.
  await view.getByTestId('rdp-view-reconnect').click()
  await expect.poll(() => server.requests.length, { timeout: 30_000 }).toBe(4)
  await expect(view.getByTestId('rdp-view-certificate')).toHaveCount(0)

  // Chứng chỉ đổi → cảnh báo.
  server.setCert('b')
  await expect(view).toHaveAttribute('data-phase', 'disconnected', { timeout: 30_000 })
  await view.getByTestId('rdp-view-reconnect').click()
  await expect(view.getByTestId('rdp-view-certificate')).toContainText(
    'The server certificate has changed'
  )
  await view.getByTestId('rdp-view-certificate').getByRole('button', { name: 'Cancel' }).click()
  await expect(view).toHaveAttribute('data-phase', 'disconnected')

  // Đóng tab = ngắt kết nối.
  await page.getByTestId('tab').filter({ hasText: 'fake-rdp' }).getByTestId('tab-close').click()
  await expect(view).toHaveCount(0)
})
