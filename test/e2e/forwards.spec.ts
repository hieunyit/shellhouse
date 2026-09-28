import { connect, createServer, type AddressInfo, type Server } from 'node:net'
import type { Page } from '@playwright/test'
import { startTestSshServer, type TestSshServer } from '../integration/ssh-test-server'
import { activeTab, expect, test, waitForText } from './fixtures'

let ssh: TestSshServer | null = null
let echo: Server | null = null
test.afterEach(async () => {
  await ssh?.close()
  const server = echo
  if (server) {
    await new Promise<void>((r) => {
      server.close(() => {
        r()
      })
    })
  }
  ssh = null
  echo = null
})

async function startEcho(): Promise<number> {
  echo = createServer((s) => {
    s.on('data', (c) => s.write(`echo:${c.toString()}`))
    s.on('error', () => undefined)
  })
  await new Promise<void>((r) => echo?.listen(0, '127.0.0.1', r))
  return (echo.address() as AddressInfo).port
}

function throughTunnel(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect(port, '127.0.0.1')
    const timer = setTimeout(() => {
      reject(new Error('hết giờ'))
    }, 5_000)
    s.on('error', reject)
    s.on('data', (c) => {
      clearTimeout(timer)
      s.end()
      resolve(c.toString())
    })
    s.once('connect', () => s.write(text))
  })
}

async function openSavedHost(page: Page, port: number): Promise<string> {
  await page.getByTestId('add-host').click()
  const form = page.getByTestId('host-form')
  await form.getByTestId('host-hostname').fill('127.0.0.1')
  await form.getByTestId('host-port').fill(String(port))
  await form.getByTestId('host-username').fill('u')
  await form.getByTestId('host-label').fill('fwd-host')
  await form.getByTestId('host-auth-password').check()
  await form.getByTestId('host-password').fill('p')
  await form.getByTestId('host-save').click()
  return connectSaved(page, { firstTime: true })
}

/**
 * Lần đầu: phải xác nhận host key (click tự chờ hộp thoại). Lần sau: host key đã được tin.
 * (Không dùng isVisible({ timeout }) — Playwright bỏ qua timeout đó và trả kết quả ngay.)
 */
async function connectSaved(page: Page, { firstTime }: { firstTime: boolean }): Promise<string> {
  await page.locator('[data-testid="host-row"][data-host-label="fwd-host"]').dblclick()
  const tab = await activeTab(page)
  if (firstTime) await page.getByTestId('hostkey-accept').click()
  await waitForText(page, tab, 'welcome to test server')
  await expect(page.getByTestId('prompt-dialog')).toHaveCount(0)
  return tab
}

test('forward -L qua giao diện: dữ liệu đi qua tunnel; lưu + tự bật khi mở lại host', async ({
  page
}) => {
  ssh = await startTestSshServer([{ username: 'u', password: 'p' }])
  const echoPort = await startEcho()
  await openSavedHost(page, ssh.port)

  await page.getByTestId('toggle-forwards').last().click()
  const panel = page.getByTestId('forwards-panel')
  await panel.getByTestId('forward-kind-L').click()
  await panel.getByTestId('forward-dest-port').fill(String(echoPort))
  await panel.getByLabel('Start on connect').check()
  await panel.getByTestId('forward-add').click()

  const row = panel.getByTestId('forward-row')
  await expect(row).toHaveAttribute('data-forward-state', 'active')
  const port = Number(await row.getAttribute('data-forward-port'))
  expect(port).toBeGreaterThan(0)
  expect(await throughTunnel(port, 'qua-giao-dien')).toBe('echo:qua-giao-dien')
  await expect(row)
    .toContainText('1 connection', { timeout: 3_000 })
    .catch(() => undefined)
  expect(ssh.events.directTcpip).toContainEqual({ destIP: '127.0.0.1', destPort: echoPort })

  // Đóng tab → forward dừng; mở lại host → forward tự bật (cổng mới do hệ điều hành chọn).
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+W' : 'Control+Shift+W')
  await expect
    .poll(() =>
      throughTunnel(port, 'x').then(
        () => 'mở',
        () => 'đóng'
      )
    )
    .toBe('đóng')

  await connectSaved(page, { firstTime: false })
  await page.getByTestId('toggle-forwards').last().click()
  const again = page.getByTestId('forwards-panel').getByTestId('forward-row')
  await expect(again).toHaveAttribute('data-forward-state', 'active')
  await expect(again).toContainText('auto-start')
  const newPort = Number(await again.getAttribute('data-forward-port'))
  expect(await throughTunnel(newPort, 'tu-bat')).toBe('echo:tu-bat')
})
