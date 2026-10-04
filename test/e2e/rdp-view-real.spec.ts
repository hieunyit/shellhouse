import { expect, test as base } from '@playwright/test'
import { launchApp, type LaunchedApp } from './fixtures'

/**
 * Remote Desktop trong tab với server RDP THẬT — chỉ chạy khi đặt biến môi trường (mặc định bỏ qua):
 *
 *   docker run -d -p 127.0.0.1:33890:3389 scottyhardy/docker-remote-desktop   # xrdp, ubuntu/ubuntu
 *   SHELLHOUSE_TEST_RDP_SERVER=127.0.0.1:33890 SHELLHOUSE_TEST_RDP_USER=ubuntu \
 *     SHELLHOUSE_TEST_RDP_PASSWORD=ubuntu pnpm test:e2e test/e2e/rdp-view-real.spec.ts
 *
 * Chứng chỉ kiểu Windows (keyUsage thiếu digitalSignature → TLS 1.2 trao đổi khoá RSA): trỏ
 * certificate= / key_file= trong /etc/xrdp/xrdp.ini tới chứng chỉ tạo bằng
 * `openssl req -x509 … -addext keyUsage=critical,keyEncipherment,dataEncipherment`, khởi động lại
 * container, chạy kèm SHELLHOUSE_TEST_RDP_TLS="TLS 1.2 (RSA)".
 *
 * Với Windows: bật Remote Desktop (NLA bật / tắt đều được), dùng địa chỉ + tài khoản của máy đó.
 * xrdp: IronRDP không gửi cờ autologon nên xrdp hiện hộp đăng nhập riêng (vẽ bằng drawing order —
 * IronRDP chưa hỗ trợ nên hộp này hiển thị lỗi hình); sau khi đăng nhập, desktop Xfce vẽ bình thường.
 */
const server = process.env['SHELLHOUSE_TEST_RDP_SERVER'] ?? ''
const [host = '', port = '3389'] = server.split(/:(?=\d+$)/)
const user = process.env['SHELLHOUSE_TEST_RDP_USER'] ?? ''
const password = process.env['SHELLHOUSE_TEST_RDP_PASSWORD'] ?? ''
const shot = process.env['SHELLHOUSE_TEST_RDP_SCREENSHOT']
/**
 * Kiểu TLS mong đợi trên thanh trạng thái, vd. "TLS 1.2 (RSA)" cho server dùng chứng chỉ mặc định
 * của Windows (keyUsage thiếu digitalSignature). Không đặt = chỉ kiểm có hiện TLS.
 */
const expectTls = process.env['SHELLHOUSE_TEST_RDP_TLS']

const test = base.extend<{ launched: LaunchedApp }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright bắt buộc destructuring fixture
  launched: async ({}, use) => {
    const launched = await launchApp()
    await use(launched)
    await launched.close()
  }
})

test.skip(!server, 'SHELLHOUSE_TEST_RDP_SERVER chưa đặt')

test('kết nối server RDP thật, vẽ màn hình, nhận chuột / phím', async ({ launched }) => {
  test.setTimeout(120_000)
  const { page } = launched
  await page.getByTestId('add-host').click()
  const form = page.getByTestId('host-form')
  await form.getByTestId('host-protocol-rdp').click()
  await form.getByTestId('host-hostname').fill(host)
  await form.getByTestId('host-port').fill(port)
  await form.getByTestId('host-username').fill(user)
  await form.getByTestId('host-password').fill(password)
  await form.getByTestId('host-label').fill('real-rdp')
  await form.getByTestId('host-save').click()

  await page.locator('[data-testid="host-row"][data-host-label="real-rdp"]').dblclick()
  const view = page.getByTestId('rdp-view')
  await view.getByTestId('rdp-view-cert-trust').click()
  await expect(view).toHaveAttribute('data-phase', 'connected', { timeout: 60_000 })
  await expect(view.getByTestId('rdp-view-resolution')).toHaveText(/^\d+×\d+$/)
  await expect(view.getByTestId('rdp-view-tls')).toHaveText(expectTls ?? /^TLS 1\.[23]( \(RSA\))?$/)
  // Chờ server vẽ khung hình đầu.
  await page.waitForTimeout(4_000)
  const canvas = view.getByTestId('rdp-view-canvas')
  await canvas.click({ position: { x: 20, y: 20 } })
  await page.keyboard.type('shellhouse')
  if (shot) await page.screenshot({ path: shot })
  // Canvas có nội dung (không chỉ một màu).
  const distinct = await canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement
    const ctx = c.getContext('2d')
    if (!ctx) return 0
    const data = ctx.getImageData(0, 0, c.width, c.height).data
    const seen = new Set<number>()
    for (let i = 0; i < data.length && seen.size < 50; i += 4 * 97)
      seen.add(((data[i] ?? 0) << 16) | ((data[i + 1] ?? 0) << 8) | (data[i + 2] ?? 0))
    return seen.size
  })
  expect(distinct).toBeGreaterThan(3)
  await view.getByTestId('rdp-view-disconnect').click()
  await expect(view).toHaveAttribute('data-phase', 'disconnected')
})
