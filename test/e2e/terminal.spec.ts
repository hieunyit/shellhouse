import { activeTab, echoComputed, expect, isWindows, sendLine, test, waitForText } from './fixtures'

test('mở sẵn một tab, shell chạy lệnh và trả kết quả', async ({ page }) => {
  await expect(page.getByTestId('tab')).toHaveCount(1)
  const tab = await activeTab(page)
  const { command, expected } = echoComputed('hello')
  await sendLine(page, tab, command)
  await waitForText(page, tab, expected)
})

test('gõ phím thật vào terminal', async ({ page }) => {
  const tab = await activeTab(page)
  await page.getByTestId(`terminal-${tab}`).click()
  const { command, expected } = echoComputed('typed')
  await page.keyboard.type(command)
  await page.keyboard.press('Enter')
  await waitForText(page, tab, expected)
})

test('biến môi trường terminal được đặt đúng', async ({ page }) => {
  const tab = await activeTab(page)
  await sendLine(
    page,
    tab,
    isWindows
      ? 'Write-Output "T=$env:TERM C=$env:COLORTERM P=$env:TERM_PROGRAM E=$(if ($env:ELECTRON_RUN_AS_NODE) { $env:ELECTRON_RUN_AS_NODE } else { \'none\' })"'
      : 'echo "T=$TERM C=$COLORTERM P=$TERM_PROGRAM E=${ELECTRON_RUN_AS_NODE:-none}"'
  )
  await waitForText(page, tab, 'T=xterm-256color C=truecolor P=Shellhouse E=none')
})

test('kích thước PTY theo kích thước cửa sổ', async ({ app, page }) => {
  const tab = await activeTab(page)
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(900, 600)
  })
  await page.waitForTimeout(300)
  const size = await page.evaluate((id) => window.__shellhouseTest.size(id), tab)
  expect(size).not.toBeNull()
  await sendLine(
    page,
    tab,
    isWindows
      ? 'Write-Output "SIZE=$($Host.UI.RawUI.WindowSize.Height) $($Host.UI.RawUI.WindowSize.Width)"'
      : 'echo "SIZE=$(stty size)"'
  )
  await waitForText(page, tab, `SIZE=${size?.rows} ${size?.cols}`)
})

test('nhiều tab độc lập, phím tắt tạo và đóng tab', async ({ page }) => {
  const first = await activeTab(page)
  await page.getByTestId(`terminal-${first}`).click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+T' : 'Control+Shift+T')
  await expect(page.getByTestId('tab')).toHaveCount(2)
  const second = await activeTab(page)
  expect(second).not.toBe(first)

  const a = echoComputed('tabA')
  const b = echoComputed('tabB')
  await sendLine(page, first, a.command)
  await sendLine(page, second, b.command)
  await waitForText(page, first, a.expected)
  await waitForText(page, second, b.expected)
  expect(await page.evaluate((id) => window.__shellhouseTest.bufferText(id), first)).not.toContain(
    b.expected
  )

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+W' : 'Control+Shift+W')
  await expect(page.getByTestId('tab')).toHaveCount(1)
})

test('gõ exit thì tab tự đóng', async ({ page }) => {
  await page.getByTestId('new-tab').click()
  await expect(page.getByTestId('tab')).toHaveCount(2)
  const tab = await activeTab(page)
  await sendLine(page, tab, 'exit')
  await expect(page.getByTestId('tab')).toHaveCount(1)
})

test('Session Host bị giết → tab mở lại phiên mới, giữ scrollback', async ({ page }) => {
  const tab = await activeTab(page)
  const before = echoComputed('before')
  await sendLine(page, tab, before.command)
  await waitForText(page, tab, before.expected)

  await page.evaluate(() => window.shellhouse.crashSessionHostForTest())
  await waitForText(page, tab, '— new session —')

  const after = echoComputed('after')
  await sendLine(page, tab, after.command)
  await waitForText(page, tab, after.expected)
  expect(await page.evaluate((id) => window.__shellhouseTest.bufferText(id), tab)).toContain(
    before.expected
  )
})

test('output lớn không làm treo UI', async ({ page }) => {
  const tab = await activeTab(page)
  await page.evaluate(() => window.__shellhouseTest.maxLongTaskMs(true))
  const { command, expected } = echoComputed('bigdone')
  const line = '0123456789abcdef0123456789abcdef0123456789'
  // ~20 MB output (trên Windows đi qua ConPTY).
  await sendLine(
    page,
    tab,
    isWindows
      ? `[Console]::Out.Write(((,'${line}') * 450000) -join [char]10); ${command}`
      : `yes ${line} | head -n 450000; ${command}`
  )
  await waitForText(page, tab, expected, 30_000)
  const longest = await page.evaluate(() => window.__shellhouseTest.maxLongTaskMs())
  expect(longest).toBeLessThan(500)
})
