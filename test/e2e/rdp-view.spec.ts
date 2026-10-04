import { expect, test as base } from '@playwright/test'
import { launchApp, type LaunchedApp } from './fixtures'
import { startFakeRdp, type FakeRdp } from '../integration/rdp-fake-server'

/**
 * Remote Desktop trong tab: tab mở → kiểm chứng chỉ (TOFU) → IronRDP (WASM, chạy dưới CSP của bản
 * build) kết nối proxy RDCleanPath trong Session Host → proxy làm X.224 + TLS với server giả.
 * Server giả không nói RDP thật nên phiên dừng ở bước CredSSP — đủ để kiểm cả đường ống tới hết
 * RDCleanPath. Vẽ desktop thật cần server RDP thật (xem docs / hướng dẫn thử bằng xrdp).
 */
const test = base.extend<{ launched: LaunchedApp; server: FakeRdp; legacyServer: FakeRdp }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright bắt buộc destructuring fixture
  server: async ({}, use) => {
    const server = await startFakeRdp()
    await use(server)
    await server.close()
  },
  // eslint-disable-next-line no-empty-pattern -- Playwright bắt buộc destructuring fixture
  legacyServer: async ({}, use) => {
    const server = await startFakeRdp({ cert: 'legacy' })
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

/**
 * Chứng chỉ RDP mặc định của Windows (keyUsage chỉ keyEncipherment + dataEncipherment): BoringSSL
 * của Electron từ chối bắt tay ECDHE / TLS 1.3 ("KEY_USAGE_BIT_INCORRECT") — chỉ tái hiện được trong
 * app thật, không phải Vitest. Proxy phải làm lại X.224 + TLS 1.2 trao đổi khoá RSA và tới được bước
 * RDCleanPath thành công (IronRDP chạy tiếp tới CredSSP với server giả).
 */
test('tab Remote Desktop: chứng chỉ thiếu digitalSignature → TLS 1.2 (RSA)', async ({
  launched,
  legacyServer: server
}) => {
  const { page } = launched
  await page.getByTestId('add-host').click()
  const form = page.getByTestId('host-form')
  await form.getByTestId('host-protocol-rdp').click()
  await form.getByTestId('host-hostname').fill('127.0.0.1')
  await form.getByTestId('host-port').fill(String(server.port))
  await form.getByTestId('host-username').fill('alice')
  await form.getByTestId('host-password').fill('Secr3t!')
  await form.getByTestId('host-label').fill('win-default-cert')
  await form.getByTestId('host-save').click()
  await expect(form).toHaveCount(0)

  await page.locator('[data-testid="host-row"][data-host-label="win-default-cert"]').dblclick()
  const view = page.getByTestId('rdp-view')
  // Dò chứng chỉ: lượt đầu chết ở TLS (BoringSSL), lượt hai bằng trao đổi khoá RSA.
  const cert = view.getByTestId('rdp-view-certificate')
  await expect(cert).toBeVisible({ timeout: 30_000 })
  await expect(cert).toContainText('fake-rdp-legacy.test')
  expect(server.requests).toHaveLength(2)
  expect(server.handshakes).toHaveLength(1)
  expect(server.handshakes[0]?.protocol).toBe('TLSv1.2')
  expect(server.handshakes[0]?.cipher).not.toMatch(/ECDHE|DHE/)
  await cert.getByTestId('rdp-view-cert-trust').click()

  // Kết nối qua proxy: đã nhớ đích cần RSA → một lượt X.224 + TLS; RDCleanPath thành công, IronRDP
  // gửi CredSSP qua TLS (server giả dội lại → phiên dừng ở CredSSP, không phải lỗi TLS / chứng chỉ).
  await expect.poll(() => server.handshakes.length, { timeout: 30_000 }).toBe(2)
  expect(server.requests).toHaveLength(3)
  expect(server.handshakes[1]?.protocol).toBe('TLSv1.2')
  await expect(view).toHaveAttribute('data-phase', 'disconnected', { timeout: 30_000 })
  const reason = view.getByTestId('rdp-view-disconnected')
  await expect(reason).not.toContainText(/TLS|KEY_USAGE|certificate/i)
  await expect(view.getByTestId('rdp-view-certificate')).toHaveCount(0)
})
