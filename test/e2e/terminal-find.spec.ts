import { activeTab, echoComputed, expect, sendLine, test, waitForText } from './fixtures'

test('terminal: tìm (Ctrl+Shift+F) đếm kết quả, chuyển kết quả, Esc đóng; Ctrl+= / Ctrl+- / Ctrl+0 đổi cỡ chữ', async ({
  page
}) => {
  const tab = await activeTab(page)
  // In hai lần cùng một chuỗi (chuỗi không có sẵn trong dòng lệnh).
  const out = echoComputed('needle')
  await sendLine(page, tab, out.command)
  await waitForText(page, tab, out.expected)
  await sendLine(page, tab, out.command)
  await page.waitForFunction(
    ([id, t]) => window.__shellhouseTest.bufferText(id).split(t).length - 1 >= 2,
    [tab, out.expected] as const
  )

  await page.locator('.xterm').first().click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+F' : 'Control+Shift+F')
  const bar = page.getByTestId('terminal-find')
  await expect(page.getByTestId('terminal-find-input')).toBeFocused()
  await page.keyboard.type(out.expected)
  await expect(bar.getByTestId('terminal-find-count')).toHaveText(/of 2$/)
  const first = await bar.getByTestId('terminal-find-count').textContent()
  await page.keyboard.press('Enter')
  await expect(bar.getByTestId('terminal-find-count')).not.toHaveText(first ?? '')
  // Không có kết quả → báo rõ.
  await page.getByTestId('terminal-find-input').fill('khong-co-chuoi-nay-xyz')
  await expect(bar.getByTestId('terminal-find-count')).toHaveText('No results')
  await page.keyboard.press('Escape')
  await expect(bar).toHaveCount(0)

  // Cỡ chữ: lớn hơn / nhỏ hơn / mặc định, có toast báo cỡ.
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.keyboard.press(`${mod}+Equal`)
  await expect(page.getByTestId('toast').filter({ hasText: 'Terminal text size 15' })).toBeVisible()
  await page.keyboard.press(`${mod}+Minus`)
  await page.keyboard.press(`${mod}+Minus`)
  await expect(page.getByTestId('toast').filter({ hasText: 'Terminal text size 13' })).toBeVisible()
  await page.keyboard.press(`${mod}+Digit0`)
  await expect(page.getByTestId('toast').filter({ hasText: 'Terminal text size 14' })).toBeVisible()
})
