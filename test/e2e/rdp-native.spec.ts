import { expect, test as base } from '@playwright/test'
import { isWindows, launchApp, type LaunchedApp } from './fixtures'

/**
 * Remote Desktop bằng control gốc của Windows: tiến trình phụ shellhouse-rdp-host.exe chạy chế độ
 * `--selftest` (không tạo control RDP, không cần server — một mảng màu + sự kiện giả) và được gắn
 * làm cửa sổ con của cửa sổ app. Kiểm vị trí THẬT của cửa sổ Win32 so với vùng tab, ẩn khi đổi tab,
 * lớp phủ (hộp thoại) thì ẩn + hiện ảnh chụp. Chỉ Windows; CI build exe trước
 * (node scripts/build-rdp-host.mjs --require).
 */

interface NativeState {
  sessionId: string
  hostId: string
  state: {
    hwnd: string
    parent: string
    x: number
    y: number
    width: number
    height: number
    visible: boolean
    region: string
    connected: boolean
    screenColor?: string
  } | null
}

const test = base.extend<{ launched: LaunchedApp }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright bắt buộc destructuring fixture
  launched: async ({}, use) => {
    const launched = await launchApp({ SHELLHOUSE_TEST_RDP_NATIVE: 'selftest' })
    await use(launched)
    await launched.close()
  }
})

test.skip(!isWindows, 'Control RDP gốc chỉ có trên Windows')

async function nativeState(launched: LaunchedApp): Promise<NativeState[]> {
  return launched.app.evaluate(async () => {
    const hooks = (globalThis as Record<string, unknown>)['__shellhouseRdpNative'] as
      { inspect(): Promise<NativeState[]> } | undefined
    return hooks ? hooks.inspect() : []
  })
}

test('tab RDP dùng control gốc: cửa sổ native nằm đúng vùng tab, ẩn khi đổi tab / có hộp thoại', async ({
  launched
}) => {
  const { page } = launched
  await page.getByTestId('add-host').click()
  const form = page.getByTestId('host-form')
  await form.getByTestId('host-protocol-rdp').click()
  // Engine mặc định: Automatic (control gốc khi có).
  await expect(form.getByTestId('rdp-engine-auto')).toHaveAttribute('aria-checked', 'true')
  await form.getByTestId('host-hostname').fill('127.0.0.2')
  await form.getByTestId('host-username').fill('alice')
  await form.getByTestId('host-password').fill('Secr3t!')
  await form.getByTestId('host-label').fill('native-rdp')
  await form.getByTestId('host-save').click()
  await expect(form).toHaveCount(0)

  await page.locator('[data-testid="host-row"][data-host-label="native-rdp"]').dblclick()
  const view = page.getByTestId('rdp-native-view')
  await expect(view).toHaveAttribute('data-phase', 'connected', { timeout: 30_000 })
  await expect(page.getByTestId('rdp-view')).toHaveCount(0) // không phải IronRDP

  const area = page.getByTestId('rdp-native-area')
  const expected = async () => {
    const box = await area.boundingBox()
    const dpr = await page.evaluate(() => window.devicePixelRatio)
    if (!box) throw new Error('no area')
    return {
      x: Math.round(box.x * dpr),
      y: Math.round(box.y * dpr),
      width: Math.round((box.x + box.width) * dpr) - Math.round(box.x * dpr),
      height: Math.round((box.y + box.height) * dpr) - Math.round(box.y * dpr)
    }
  }
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= 2

  // Cửa sổ native: con của cửa sổ app, hiện, đúng vị trí / cỡ vùng tab (pixel vật lý).
  await expect
    .poll(
      async () => {
        const [s] = await nativeState(launched)
        const want = await expected()
        const st = s?.state
        return (
          !!st &&
          st.parent !== '0' &&
          st.visible &&
          st.region === 'full' &&
          near(st.x, want.x) &&
          near(st.y, want.y) &&
          near(st.width, want.width) &&
          near(st.height, want.height)
        )
      },
      { timeout: 15_000 }
    )
    .toBe(true)
  const [first] = await nativeState(launched)
  // Màu đọc từ màn hình ở giữa vùng: magenta = cửa sổ native thật sự nổi trên nội dung web.
  // (Máy CI không có màn hình thật / cửa sổ bị che thì chỉ ghi chú, không đánh trượt.)
  test.info().annotations.push({
    type: 'screen-color',
    description: first?.state?.screenColor ?? 'n/a'
  })

  // Đổi cỡ cửa sổ → vị trí / cỡ theo kịp.
  await launched.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win?.isMaximized()) win.unmaximize()
    win?.setContentSize(1000, 700)
  })
  await expect
    .poll(
      async () => {
        const [s] = await nativeState(launched)
        const want = await expected()
        return !!s?.state && near(s.state.width, want.width) && near(s.state.height, want.height)
      },
      { timeout: 10_000 }
    )
    .toBe(true)

  // Hộp thoại (nền mờ toàn cửa sổ) → ẩn cửa sổ native, hiện ảnh chụp thay vào.
  await page.getByTestId('add-host').click()
  await expect(page.getByTestId('host-form')).toBeVisible()
  await expect
    .poll(async () => (await nativeState(launched))[0]?.state?.region, { timeout: 10_000 })
    .toBe('none')
  await expect(page.getByTestId('rdp-native-snapshot')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('host-form')).toHaveCount(0)
  await expect
    .poll(async () => (await nativeState(launched))[0]?.state?.region, { timeout: 10_000 })
    .toBe('full')

  // Tab khác → cửa sổ native ẩn; quay lại → hiện.
  await page.getByTestId('new-tab').click()
  await expect
    .poll(async () => (await nativeState(launched))[0]?.state?.visible, { timeout: 10_000 })
    .toBe(false)
  await page.getByTestId('tab').filter({ hasText: 'native-rdp' }).click()
  await expect
    .poll(async () => (await nativeState(launched))[0]?.state?.visible, { timeout: 10_000 })
    .toBe(true)

  // Disconnect → tiến trình phụ thoát; đóng tab.
  await view.getByTestId('rdp-native-disconnect').click()
  await expect(view).toHaveAttribute('data-phase', 'disconnected', { timeout: 15_000 })
  await expect.poll(async () => (await nativeState(launched)).length).toBe(0)
  await view.getByTestId('rdp-native-ironrdp').click()
  await expect(page.getByTestId('rdp-view')).toBeVisible()
})
