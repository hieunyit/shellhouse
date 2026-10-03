import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _electron as electron,
  test as base,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import type { ShellhouseTestHooks } from '../../src/shared/test-hooks'

declare global {
  interface Window {
    __shellhouseTest: ShellhouseTestHooks
  }
}

export const isWindows = process.platform === 'win32'
export const E2E_PASSWORD = 'e2e-master-password'

/**
 * Đặt kích thước THẬT của cửa sổ (không chỉ giả lập viewport): trên macOS, `page.setViewportSize`
 * lớn hơn cửa sổ Electron thật (mặc định 1200×800) để phần vượt ra ngoài không bấm được — chuột
 * rơi vào <html>. Đổi cửa sổ rồi chờ renderer thấy đúng kích thước; màn hình không đủ chỗ (máy CI
 * nhỏ) thì mới dùng viewport giả lập.
 */
export async function setWindowSize(
  launched: Pick<LaunchedApp, 'app' | 'page'>,
  width: number,
  height: number
): Promise<void> {
  await launched.app.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win?.isMaximized()) win.unmaximize()
      win?.setContentSize(size.width, size.height)
      // macOS CI: cửa sổ test thường không phải cửa sổ đang active — kéo lên trước.
      win?.focus()
    },
    { width, height }
  )
  const fits = await launched.page
    .waitForFunction(
      (size) => window.innerWidth === size.width && window.innerHeight === size.height,
      { width, height },
      { timeout: 3_000 }
    )
    .then(() => true)
    .catch(() => false)
  if (!fits) await launched.page.setViewportSize({ width, height })
}

export interface LaunchedApp {
  app: ElectronApplication
  page: Page
  userData: string
  close(): Promise<void>
}

/** Khởi động app với thư mục dữ liệu riêng, tạo vault, đợi tab đầu tiên sẵn sàng. */
export async function launchApp(extraEnv: Record<string, string> = {}): Promise<LaunchedApp> {
  const userData = mkdtempSync(join(tmpdir(), 'shellhouse-e2e-'))
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      SHELLHOUSE_TEST_HOOKS: '1',
      SHELLHOUSE_FAST_KDF: '1',
      // Giao diện tiếng Anh cố định (test tìm theo chữ); chụp màn hình tiếng Việt: SHELLHOUSE_LANG=vi.
      SHELLHOUSE_LANG: process.env['SHELLHOUSE_LANG'] ?? 'en',
      SHELLHOUSE_USER_DATA: userData,
      ...extraEnv
    }
  })
  const page = await app.firstWindow()
  await page.waitForFunction(() => 'shellhouse' in window)
  const created = await page.evaluate((pw) => window.shellhouse.createVault(pw), E2E_PASSWORD)
  if (!created.ok) throw new Error(`Không tạo được vault: ${created.message}`)
  // Tự khoá đo thời gian rảnh của CẢ MÁY: chạy test trên máy thật mà không ai chạm chuột lâu hơn
  // 15 phút thì vault tự khoá giữa chừng. Test nào cần thì tự bật lại.
  // Gợi ý module dò máy / server thật (có Docker hay không) → tắt để test không phụ thuộc máy chạy.
  await page.evaluate(() =>
    window.shellhouse.updateSettings({
      security: { autoLockMinutes: 0 },
      moduleOptions: { suggest: false }
    })
  )
  await page.waitForFunction(() => {
    if (!('__shellhouseTest' in window)) return false
    const hooks = window.__shellhouseTest
    const id = hooks.activeTabId()
    return !!id && hooks.state(id) === 'connected' && hooks.bufferText(id).trim().length > 0
  })
  return {
    app,
    page,
    userData,
    close: async () => {
      await app.close()
      rmSync(userData, { recursive: true, force: true })
    }
  }
}

interface Fixtures {
  app: ElectronApplication
  page: Page
}

export const test = base.extend<Fixtures & { launched: LaunchedApp }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright bắt buộc destructuring fixture
  launched: async ({}, use) => {
    const launched = await launchApp()
    await use(launched)
    await launched.close()
  },
  app: async ({ launched }, use) => {
    await use(launched.app)
  },
  page: async ({ launched }, use) => {
    await use(launched.page)
  }
})

export { expect } from '@playwright/test'

export async function activeTab(page: Page): Promise<string> {
  const id = await page.evaluate(() => window.__shellhouseTest.activeTabId())
  if (!id) throw new Error('Không có tab đang mở')
  return id
}

/**
 * Đợi tới khi `text` xuất hiện trong buffer của tab. Runner Windows của CI khởi động PowerShell rất
 * chậm khi hai shell mở cùng lúc → chờ lâu hơn.
 */
export async function waitForText(
  page: Page,
  tabId: string,
  text: string,
  timeout = isWindows ? 30_000 : 10_000
): Promise<void> {
  await page.waitForFunction(
    ([id, t]) => window.__shellhouseTest.bufferText(id).includes(t),
    [tabId, text] as const,
    { timeout, polling: 50 }
  )
}

export async function sendLine(page: Page, tabId: string, line: string): Promise<void> {
  await page.evaluate(
    ([id, l]) => {
      window.__shellhouseTest.sendInput(id, `${l}\r`)
    },
    [tabId, line] as const
  )
}

/** Lệnh in ra `marker-<n>` mà không để chính chuỗi đó xuất hiện trong dòng lệnh. */
export function echoComputed(marker: string): { command: string; expected: string } {
  return isWindows
    ? { command: `Write-Output ("${marker}-" + (40+2))`, expected: `${marker}-42` }
    : { command: `echo ${marker}-$((40+2))`, expected: `${marker}-42` }
}

/**
 * Xác nhận hộp thoại "Close …?" hiện khi đóng tab SSH đang kết nối (cài đặt "confirmCloseConnected"
 * mặc định bật) — gọi ngay sau thao tác đóng (nút ×, Ctrl+W, "Close other tabs"…). `optional`: tab có
 * thể đã mất kết nối (mạng chập chờn) nên không hỏi → chỉ bấm nếu hộp thoại hiện trong `timeout`
 * (guard được hỏi đồng bộ lúc đóng, hộp thoại hiện ngay hoặc không bao giờ).
 */
export async function confirmTabClose(
  page: Page,
  { optional = false, timeout = 2_000 }: { optional?: boolean; timeout?: number } = {}
): Promise<void> {
  const ok = page.getByTestId('close-tab-confirm').getByTestId('confirm-ok')
  if (optional) await ok.click({ timeout }).catch(() => undefined)
  else await ok.click()
}
