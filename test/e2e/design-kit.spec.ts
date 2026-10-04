import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, setWindowSize, test } from './fixtures'

const isMac = process.platform === 'darwin'

/** Ảnh chụp Design kit (sáng / tối) khi đặt DS_KIT_SHOTS=<thư mục> — để xem lại bằng mắt. */
const SHOTS = process.env['DS_KIT_SHOTS']

const active = (
  page: Page
): Promise<{ testId: string | null; text: string; focusVisible: boolean; ring: string }> =>
  page.evaluate(() => {
    const el = document.activeElement
    return {
      testId: el?.getAttribute('data-testid') ?? null,
      text: (el?.querySelector('.truncate')?.textContent ?? el?.textContent ?? '').trim(),
      focusVisible: el?.matches(':focus-visible') ?? false,
      ring: el ? getComputedStyle(el).boxShadow : 'none'
    }
  })

async function openKit(page: Page): Promise<void> {
  // Bật "New interface (beta)" trong Settings → Appearance.
  await page.keyboard.press(isMac ? 'Meta+Comma' : 'Control+Comma')
  await expect(page.getByTestId('settings-dialog')).toBeVisible()
  await page.getByTestId('setting-new-ui').check()
  await expect(page.getByTestId('setting-density-comfortable')).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-dialog')).toHaveCount(0)

  // Bảng lệnh → "Open design kit".
  await page.keyboard.press(isMac ? 'Meta+Shift+P' : 'Control+Shift+P')
  await page.getByTestId('palette-input').fill('design kit')
  await expect(page.locator('[data-command="designkit.open"]')).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('design-kit')).toBeVisible()
  await expect(page.getByTestId('kit-pane-dark')).toBeVisible()
  await expect(page.getByTestId('kit-pane-light')).toBeVisible()
}

test('Design kit: chỉ có khi bật giao diện mới; Esc đóng lớp trên cùng rồi mới đóng trang', async ({
  page
}) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  // Chưa bật cờ: không có trong bảng lệnh.
  await page.keyboard.press(isMac ? 'Meta+Shift+P' : 'Control+Shift+P')
  await page.getByTestId('palette-input').fill('design kit')
  await expect(page.locator('[data-command="designkit.open"]')).toHaveCount(0)
  await page.keyboard.press('Escape')

  await openKit(page)
  // Phần còn lại của app bị inert trong lúc mở.
  expect(await page.evaluate(() => document.getElementById('root')?.inert)).toBe(true)

  // Menu: mở bằng Enter, ↓, gõ chữ để nhảy, Esc đóng menu (trang vẫn mở), focus về nút.
  const trigger = page.getByTestId('kit-menu-dark')
  await trigger.focus()
  await page.keyboard.press('Enter')
  const menu = page.getByRole('menu', { name: 'Pod actions' })
  await expect(menu).toBeVisible()
  await expect.poll(async () => (await active(page)).text).toBe('Logs')
  await page.keyboard.press('ArrowDown')
  await expect.poll(async () => (await active(page)).text).toBe('Open shell')
  await page.keyboard.press('r')
  await expect.poll(async () => (await active(page)).text).toBe('Restart')
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(page.getByTestId('design-kit')).toBeVisible()
  expect((await active(page)).testId).toBe('kit-menu-dark')

  // Chọn bằng Enter chạy lệnh.
  await page.keyboard.press('ArrowDown')
  await expect(menu).toBeVisible()
  await expect.poll(async () => (await active(page)).text).toBe('Logs')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('kit-menu-last-dark')).toContainText('logs')
  await expect(menu).toHaveCount(0)

  // Đưa focus về nút một cách tường minh: sau khi chọn mục, thời điểm Radix trả focus
  // khác nhau giữa các máy (CI Linux/Windows) — phần dưới chỉ kiểm vòng focus.
  await trigger.focus()

  // Focus bàn phím luôn thấy được (vòng focus = box-shadow).
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Tab')
  const focus = await active(page)
  expect(focus.testId).toBe('kit-menu-dark')
  expect(focus.focusVisible).toBe(true)
  expect(focus.ring).not.toBe('none')

  // Tooltip của nút icon hiện ngay khi focus bằng bàn phím, Esc ẩn.
  await page.getByTestId('kit-icon-button').first().focus()
  await expect(page.getByRole('tooltip').first()).toBeVisible()

  // Xác nhận production: phải gõ đúng tên; Esc đóng hộp thoại, trang vẫn mở.
  await page.getByTestId('kit-confirm-prod-dark').click()
  const confirm = page.getByTestId('kit-confirm')
  await expect(confirm).toHaveAttribute('role', 'alertdialog')
  const ok = confirm.getByTestId('confirm-ok')
  await expect(ok).toBeDisabled()
  await expect.poll(async () => (await active(page)).testId).toBe('confirm-type-input')
  await page.keyboard.type('Web')
  await expect(ok).toBeDisabled()
  await page.keyboard.press(isMac ? 'Meta+A' : 'Control+A')
  await page.keyboard.type('web')
  await expect(ok).toBeEnabled()
  await page.keyboard.press('Escape')
  await expect(confirm).toHaveCount(0)
  await expect(page.getByTestId('design-kit')).toBeVisible()

  // Bảng: một điểm dừng Tab; j / x / Shift+j chọn → thanh hàng loạt; Esc bỏ chọn; Enter mở Inspector.
  const table = page.getByTestId('kit-table-dark')
  const grid = table.getByRole('grid')
  await grid.focus()
  await page.keyboard.press('j')
  await page.keyboard.press('x')
  await page.keyboard.press('Shift+j')
  await expect(table.getByRole('toolbar', { name: 'Bulk actions' })).toContainText('2 selected')
  await expect(table.locator('[role="row"][aria-selected="true"]')).toHaveCount(2)
  await page.keyboard.press('Escape')
  await expect(table.locator('[role="row"][aria-selected="true"]')).toHaveCount(0)
  await expect(page.getByTestId('design-kit')).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('kit-inspector-dark')).toBeVisible()

  // Sắp xếp bằng tiêu đề cột (aria-sort).
  const nameHeader = table.locator('[role="columnheader"][data-column="name"]')
  await expect(nameHeader).toHaveAttribute('aria-sort', 'ascending')
  await table.getByTestId('table-sort-name').click()
  await expect(nameHeader).toHaveAttribute('aria-sort', 'descending')
  await table.getByTestId('table-sort-namespace').click()
  await expect(nameHeader).not.toHaveAttribute('aria-sort', /.+/)
  await expect(table.locator('[role="columnheader"][data-column="namespace"]')).toHaveAttribute(
    'aria-sort',
    'ascending'
  )

  // Esc (không còn lớp nổi / lựa chọn) → đóng trang, app hết inert.
  // Nút có tooltip: Esc đầu ẩn tooltip (lớp trên cùng), Esc kế đóng trang.
  await page.getByTestId('kit-close').focus()
  await expect(page.getByRole('tooltip')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  await expect(page.getByTestId('design-kit')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('design-kit')).toHaveCount(0)
  expect(await page.evaluate(() => document.getElementById('root')?.inert)).toBe(false)
  expect(errors).toEqual([])
})

test('Design kit: ảnh chụp sáng / tối (DS_KIT_SHOTS)', async ({ launched, page }) => {
  test.skip(!SHOTS, 'Đặt DS_KIT_SHOTS=<thư mục> để chụp')
  const dir = SHOTS ?? ''
  mkdirSync(dir, { recursive: true })
  await setWindowSize(launched, 1600, 1000)
  await openKit(page)
  const scroller = page.getByTestId('kit-scroll')
  for (const density of ['comfortable', 'compact'] as const) {
    await page.getByTestId(`kit-density-${density}`).click()
    for (const theme of ['dark', 'light'] as const) {
      await page.getByTestId(`kit-layout-${theme}`).click()
      await page.mouse.move(0, 0)
      const height = await scroller.evaluate((el) => el.scrollHeight)
      for (let y = 0, i = 1; y < height; y += 900, i++) {
        await scroller.evaluate((el, top) => {
          el.scrollTop = top
        }, y)
        await page.waitForTimeout(120)
        await page.screenshot({
          path: join(dir, `kit-${theme}-${density}-${String(i).padStart(2, '0')}.png`)
        })
        if (density === 'compact' && i >= 1) break
      }
    }
  }
  // Hai theme cạnh nhau (mặc định của trang): phần nút / trạng thái.
  await page.getByTestId('kit-layout-both').click()
  await page.getByTestId('kit-menu-dark').scrollIntoViewIfNeeded()
  await page.waitForTimeout(120)
  await page.screenshot({ path: join(dir, 'kit-both-status.png') })
  // Lớp nổi: menu + hộp thoại production (tối và sáng).
  await page.getByTestId('kit-density-comfortable').click()
  for (const theme of ['dark', 'light'] as const) {
    await page.getByTestId(`kit-layout-${theme}`).click()
    await page.getByTestId(`kit-menu-${theme}`).scrollIntoViewIfNeeded()
    await page.getByTestId(`kit-menu-${theme}`).click()
    await page.waitForTimeout(150)
    await page.screenshot({ path: join(dir, `kit-${theme}-menu.png`) })
    await page.keyboard.press('Escape')
    await page.getByTestId(`kit-confirm-prod-${theme}`).click()
    await page.keyboard.type('we')
    await page.waitForTimeout(150)
    await page.screenshot({ path: join(dir, `kit-${theme}-confirm.png`) })
    await page.keyboard.press('Escape')
    const table = page.getByTestId(`kit-table-${theme}`)
    await table.scrollIntoViewIfNeeded()
    await table.getByRole('grid').focus()
    await page.keyboard.press('j')
    await page.keyboard.press('x')
    await page.keyboard.press('Shift+j')
    await page.keyboard.press('Shift+j')
    await table.locator('[role="row"][aria-rowindex="6"]').click()
    await page.waitForTimeout(150)
    await page.screenshot({ path: join(dir, `kit-${theme}-table.png`) })
    await table.getByTestId('table-clear-selection').click()
  }
})
