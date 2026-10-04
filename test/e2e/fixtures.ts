import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _electron as electron,
  expect,
  test as base,
  type ElectronApplication,
  type Locator,
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
  // macOS CI: cửa sổ mới thường chưa phải cửa sổ active, còn đổi kích thước một lúc sau khi hiện —
  // blur / resize đóng menu chuột phải ngay trước cú click. Kéo lên trước, đợi kích thước đứng yên.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.focus()
  })
  await page
    .waitForFunction(() => document.hasFocus(), undefined, { timeout: 3_000 })
    .catch(() => {
      // Máy không cho cửa sổ nhận focus (headless) — test vẫn chạy.
    })
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let size = `${String(innerWidth)}x${String(innerHeight)}`
        let stable = 0
        const started = Date.now()
        const tick = (): void => {
          const now = `${String(innerWidth)}x${String(innerHeight)}`
          stable = now === size ? stable + 1 : 0
          size = now
          if (stable >= 6 || Date.now() - started > 5_000) resolve()
          else setTimeout(tick, 50)
        }
        tick()
      })
  )
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
  try {
    await page.waitForFunction(
      ([id, t]) => window.__shellhouseTest.bufferText(id).includes(t),
      [tabId, text] as const,
      { timeout, polling: 50 }
    )
  } catch (e) {
    // Hết giờ: in kèm trạng thái + cuối buffer — lỗi chỉ gặp trên CI mới đọc được nguyên nhân.
    const seen = await page
      .evaluate(
        (id) => ({
          state: window.__shellhouseTest.state(id),
          info: window.__shellhouseTest.terminalInfo(id),
          head: window.__shellhouseTest.bufferText(id).trim().slice(0, 400),
          active: window.__shellhouseTest.activeTabId(),
          tail: window.__shellhouseTest.bufferText(id, 15)
        }),
        tabId
      )
      .catch(() => null)
    throw new Error(
      `waitForText(${JSON.stringify(text)}) hết ${String(timeout)}ms — ${JSON.stringify(seen)}`,
      { cause: e }
    )
  }
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

/**
 * Chuyển khu vực trên activity bar (khung app v0.5): 'home', 'hosts', 'files', 'transfers' hoặc id
 * module ('docker', 'k8s', 's3'). Đang ở khu vực đó thì giữ nguyên (bấm lại sẽ ẩn Explorer).
 */
export async function openArea(page: Page, area: string): Promise<void> {
  const item = page.getByTestId(area === 'home' ? 'open-home' : `activity-${area}`)
  if ((await item.getAttribute('aria-current')) !== 'page') await item.click()
  await expect(page.getByTestId('explorer')).toHaveAttribute(
    'data-area',
    area === 'home' || area === 'hosts' || area === 'files' || area === 'transfers'
      ? area
      : `m:${area}`
  )
}

/** Tab đang chọn có tiêu đề chứa `text` (tab module / Home không nằm trong dải tab của dockview). */
export async function expectActiveTab(page: Page, text: string): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__shellhouseTest.activeTabTitle()))
    .toContain(text)
}

/** Hàng host trong cây (một dòng): địa chỉ nằm trong tooltip (title). */
export async function expectHostAddress(row: Locator, address: string): Promise<void> {
  await expect(row).toHaveAttribute(
    'title',
    new RegExp(address.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  )
}
