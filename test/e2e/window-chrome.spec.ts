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
    const bar = document.querySelector('nav.sh-titlebar')
    const settings = document.querySelector('[data-testid="open-settings"]')
    const quick = document.querySelector('[data-testid="quick-connect"]')
    const wco = (
      navigator as Navigator & {
        windowControlsOverlay?: { visible: boolean; getTitlebarAreaRect: () => DOMRect }
      }
    ).windowControlsOverlay
    const area = wco?.visible ? wco.getTitlebarAreaRect() : null
    return {
      platform: document.documentElement.dataset['platform'],
      bar: region(bar),
      sidebarHeader: region(document.querySelector('.sh-titlebar-lead')),
      settings: region(settings),
      quick: region(quick?.closest('form') ?? null),
      settingsRight: settings?.getBoundingClientRect().right ?? 0,
      area: area ? { x: area.x, width: area.width } : null,
      width: window.innerWidth
    }
  })
  expect(info.bar).toBe('drag')
  expect(info.sidebarHeader).toBe('drag')
  expect(info.settings).toBe('no-drag')
  expect(info.quick).toBe('no-drag')
  if (info.platform !== 'darwin' && info.area) {
    // Nút cuối của thanh nằm trọn bên trái vùng nút điều khiển cửa sổ.
    expect(info.settingsRight).toBeLessThanOrEqual(info.area.x + info.area.width)
  }

  // Hộp thoại mở đè lên vùng kéo: phần nổi phải no-drag (bấm được).
  await page.getByTestId('open-settings').click()
  await expect(page.getByTestId('settings-dialog')).toBeVisible()
  const dialogRegion = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="settings-dialog"]')
    return el ? getComputedStyle(el).getPropertyValue('-webkit-app-region') : ''
  })
  expect(dialogRegion).toBe('no-drag')
  await page.keyboard.press('Escape')

  // Các nút của thanh vẫn bấm được như trước.
  await page.getByTestId('open-home').click()
  await expect(page.getByTestId('welcome')).toBeVisible()
})
