import { activeTab, echoComputed, expect, isWindows, sendLine, test, waitForText } from './fixtures'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control+Shift'

test('chia màn hình: hai terminal hiển thị cùng lúc, chạy độc lập', async ({ page }) => {
  const first = await activeTab(page)
  await page.getByTestId(`terminal-${first}`).click()
  await page.keyboard.press(`${mod}+D`)
  await expect(page.getByTestId('tab')).toHaveCount(2)
  const second = await activeTab(page)
  expect(second).not.toBe(first)

  // Cả hai đều hiển thị và nằm cạnh nhau (không chồng lên nhau như tab thường).
  const a = await page.getByTestId(`terminal-${first}`).boundingBox()
  const b = await page.getByTestId(`terminal-${second}`).boundingBox()
  expect(a && b).toBeTruthy()
  if (a && b) {
    expect(a.width).toBeGreaterThan(100)
    expect(b.width).toBeGreaterThan(100)
    expect(b.x).toBeGreaterThanOrEqual(a.x + a.width - 2)
  }
  await page.waitForFunction((id) => window.__shellhouseTest.state(id) === 'connected', second)

  const x = echoComputed('ben-trai')
  const y = echoComputed('ben-phai')
  await sendLine(page, first, x.command)
  await sendLine(page, second, y.command)
  await waitForText(page, first, x.expected)
  await waitForText(page, second, y.expected)
  expect(await page.evaluate((id) => window.__shellhouseTest.bufferText(id), first)).not.toContain(
    y.expected
  )

  // Chia ngang ở pane bên phải → 3 terminal.
  await page.getByTestId(`terminal-${second}`).click()
  await page.keyboard.press(`${mod}+E`)
  await expect(page.getByTestId('tab')).toHaveCount(3)
  const third = await activeTab(page)
  const c = await page.getByTestId(`terminal-${third}`).boundingBox()
  const b2 = await page.getByTestId(`terminal-${second}`).boundingBox()
  if (c && b2) expect(c.y).toBeGreaterThanOrEqual(b2.y + b2.height - 2)

  // Đóng pane bằng nút × trên tab của nó.
  await page.locator(`[data-testid="tab"][data-tab-id="${third}"]`).hover()
  await page
    .locator(`[data-testid="tab"][data-tab-id="${third}"] [data-testid="tab-close"]`)
    .click()
  await expect(page.getByTestId('tab')).toHaveCount(2)
})

test('snippet có biến: tạo, điền biến, chèn và chạy trong terminal', async ({ page }) => {
  // Cùng một kết quả "xin-chao-hieu-42" bằng cú pháp POSIX sh hoặc PowerShell.
  const body = isWindows
    ? 'Write-Output ("xin-chao-{{ten}}-{{so:4}}" + (1+1))'
    : 'echo "xin-chao-{{ten}}-{{so:4}}$((1+1))"'
  const preview = isWindows
    ? 'Write-Output ("xin-chao-hieu-4" + (1+1))'
    : 'echo "xin-chao-hieu-4$((1+1))"'
  const tab = await activeTab(page)
  await page.getByTestId('open-snippets').click()
  const dialog = page.getByTestId('snippets-dialog')
  await dialog.getByTestId('snippet-new').click()
  await dialog.getByTestId('snippet-name').fill('chào hỏi')
  await dialog.getByTestId('snippet-body').fill(body)
  await dialog.getByTestId('snippet-save').click()

  await expect(dialog.getByTestId('snippet-var-so')).toHaveValue('4')
  await dialog.getByTestId('snippet-var-ten').fill('hieu')
  await expect(dialog.getByTestId('snippet-preview')).toHaveText(preview)
  await dialog.getByTestId('snippet-run').click()
  await expect(dialog).toHaveCount(0)
  await waitForText(page, tab, 'xin-chao-hieu-42')

  // Tìm lại bằng tìm kiếm mờ, Enter để mở; thiếu biến bắt buộc → báo lỗi, không chèn.
  await page.getByTestId('open-snippets').click()
  await dialog.getByTestId('snippet-search').fill('chao')
  await dialog.getByTestId('snippet-search').press('Enter')
  // Enter chỉ MỞ snippet — không được tự chạy khi chưa điền biến.
  await expect(dialog.getByTestId('snippet-var-ten')).toBeVisible()
  await expect(dialog.getByTestId('snippet-var-ten')).toHaveValue('')
  await dialog.getByTestId('snippet-run').click()
  await expect(dialog).toContainText('Missing value for: ten')
  expect(await page.evaluate((id) => window.__shellhouseTest.bufferText(id), tab)).not.toContain(
    'xin-chao--4'
  )
})

test('snippet nhiều dòng được dán (bracketed paste), không tự chạy từng dòng', async ({ page }) => {
  test.skip(isWindows, 'Cần bash (bracketed paste của PSReadLine khác)')
  // Runner macOS dùng /bin/bash 3.2 (2007) — chưa có bracketed paste; máy Mac thật mặc định zsh.
  test.skip(process.platform === 'darwin', 'bash 3.2 của macOS không có bracketed paste')
  const tab = await activeTab(page)
  // Bật bracketed paste như bash/zsh hiện đại.
  await sendLine(page, tab, "bind 'set enable-bracketed-paste on' 2>/dev/null; echo san-sang")
  await waitForText(page, tab, 'san-sang')
  await page.getByTestId('open-snippets').click()
  const dialog = page.getByTestId('snippets-dialog')
  await dialog.getByTestId('snippet-new').click()
  await dialog.getByTestId('snippet-name').fill('hai dòng')
  await dialog.getByTestId('snippet-body').fill('echo dong-mot-$((1+1))\necho dong-hai-$((2+2))')
  await dialog.getByTestId('snippet-save').click()
  await dialog.getByTestId('snippet-insert').click()
  await page.waitForTimeout(500)
  const text = await page.evaluate((id) => window.__shellhouseTest.bufferText(id), tab)
  expect(text).not.toContain('dong-mot-2\n') // chưa chạy vì chỉ "chèn"
})

test('macro trong MultiExec: chạy từng dòng trên mọi terminal, chờ dấu nhắc giữa các dòng', async ({
  page
}) => {
  const first = await activeTab(page)
  await page.getByTestId('new-tab').click()
  await expect(page.getByTestId('tab')).toHaveCount(2)
  const second = await activeTab(page)
  // Chờ cả hai shell sẵn sàng.
  for (const tab of [first, second]) {
    const { command, expected } = echoComputed(`ready-${tab.slice(0, 4)}`)
    await sendLine(page, tab, command)
    await waitForText(page, tab, expected)
  }

  await page.getByTestId('open-snippets').click()
  const dialog = page.getByTestId('snippets-dialog')
  await dialog.getByTestId('snippet-new').click()
  await dialog.getByTestId('snippet-name').fill('hai buoc')
  const a = echoComputed('macro-a')
  const b = echoComputed('macro-b')
  await dialog.getByTestId('snippet-body').fill(`# bước 1\n${a.command}\n# wait 0.3\n${b.command}`)
  await dialog.getByTestId('snippet-macro').check()
  await dialog.getByTestId('snippet-save').click()
  await page.keyboard.press('Escape')

  await page.getByTestId('toggle-broadcast').click()
  await expect(page.getByTestId('multiexec')).toBeVisible()
  await page.getByTestId('open-snippets').click()
  await dialog.locator('[data-testid="snippet-item"][data-name="hai buoc"]').click()
  await expect(dialog.getByTestId('snippet-macro-note')).toBeVisible()
  await dialog.getByTestId('snippet-run').click()

  for (const tab of [first, second]) {
    await waitForText(page, tab, b.expected)
    const text = await page.evaluate((id) => window.__shellhouseTest.bufferText(id), tab)
    expect(text.indexOf(a.expected)).toBeGreaterThan(-1)
    expect(text.indexOf(a.expected)).toBeLessThan(text.indexOf(b.expected))
    // Mỗi dòng chỉ chạy một lần trên mỗi terminal (không bị phát lại qua MultiExec).
    expect(text.split(b.expected).length - 1).toBe(1)
  }
})
