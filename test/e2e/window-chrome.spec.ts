import { expect, test } from './fixtures'

/**
 * Cửa sổ không có thanh tiêu đề của hệ điều hành (src/main/window-chrome.ts): thanh trên cùng là
 * vùng kéo, nút bấm bên trong vẫn bấm được, nút điều khiển cửa sổ không đè lên nút của app.
 */
test('thanh trên cùng: vùng kéo cửa sổ, nút bên trong no-drag, không bị nút cửa sổ che', async ({
  page
}) => {
  const info = await page.evaluate(() => {
    const region = (el: Element | null): string =>
      el ? getComputedStyle(el).getPropertyValue('-webkit-app-region') : ''
    const bar = document.querySelector('[data-testid="titlebar"]')
    const connect = document.querySelector('[data-testid="titlebar-connect"]')
    const last = document.querySelector('[data-testid="open-workspaces"]')
    const wco = (
      navigator as Navigator & {
        windowControlsOverlay?: { visible: boolean; getTitlebarAreaRect: () => DOMRect }
      }
    ).windowControlsOverlay
    const area = wco?.visible ? wco.getTitlebarAreaRect() : null
    return {
      platform: document.documentElement.dataset['platform'],
      bar: region(bar),
      lead: region(document.querySelector('.sh-titlebar-lead')),
      connect: region(connect),
      palette: region(document.querySelector('[data-testid="command-center"]')),
      lastRight: last?.getBoundingClientRect().right ?? 0,
      area: area ? { x: area.x, width: area.width } : null,
      width: window.innerWidth
    }
  })
  expect(info.bar).toBe('drag')
  expect(info.lead).toBe('drag')
  expect(info.connect).toBe('no-drag')
  expect(info.palette).toBe('no-drag')
  if (info.platform !== 'darwin' && info.area) {
    // Nút cuối của title bar nằm trọn bên trái vùng nút điều khiển cửa sổ.
    expect(info.lastRight).toBeLessThanOrEqual(info.area.x + info.area.width)
  }

  // Hộp thoại mở đè lên vùng kéo (Quick connect ngay dưới title bar): phải no-drag (bấm được).
  await page.getByTestId('titlebar-connect').click()
  await expect(page.getByTestId('quick-connect-dialog')).toBeVisible()
  const dialogRegion = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="quick-connect-dialog"]')
    return el ? getComputedStyle(el).getPropertyValue('-webkit-app-region') : ''
  })
  expect(dialogRegion).toBe('no-drag')
  await page.keyboard.press('Escape')

  // Các nút của thanh vẫn bấm được như trước.
  await page.getByTestId('open-home').click()
  await expect(page.getByTestId('welcome')).toBeVisible()
})
