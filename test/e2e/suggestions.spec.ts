import { activeTab, echoComputed, expect, isWindows, test, waitForText } from './fixtures'

test('gợi ý lệnh từ lịch sử: chữ mờ sau con trỏ, → để nhận; lệnh bắt đầu bằng dấu cách không lưu', async ({
  page
}) => {
  const tab = await activeTab(page)
  const terminal = page.getByTestId(`terminal-${tab}`)
  await terminal.click()
  const typeLine = async (line: string): Promise<void> => {
    await page.keyboard.type(line)
    await page.keyboard.press('Enter')
  }
  // Chờ shell sẵn sàng.
  const ready = echoComputed('ready')
  await typeLine(ready.command)
  await waitForText(page, tab, ready.expected)

  const first = echoComputed('goi-y-lenh')
  await typeLine(first.command)
  await waitForText(page, tab, first.expected)
  await typeLine(` ${echoComputed('bi-mat').command}`) // dấu cách đầu → không lưu

  // Bước 1: lệnh đã vào lịch sử (tách riêng để biết lỗi ở khâu lưu hay khâu hiện gợi ý).
  const target = 'local:default'
  const diagnose = async (what: string): Promise<never> => {
    const screen = await page.evaluate((id) => window.__shellhouseTest.bufferText(id, 12), tab)
    const state = await page.evaluate((id) => window.__shellhouseTest.suggestionState(id), tab)
    const history = await page.evaluate((t) => window.shellhouse.commandHistory(t), target)
    throw new Error(
      `${what}\nstate: ${JSON.stringify(state)}\nhistory: ${JSON.stringify(history)}\nscreen: ${JSON.stringify(screen)}`
    )
  }
  await expect
    .poll(() => page.evaluate((t) => window.shellhouse.commandHistory(t), target), {
      timeout: 10_000
    })
    .toContain(first.command)
    .catch(() => diagnose('command was not recorded'))
  // Bước 2: gõ phần đầu → gợi ý phần còn lại.
  const ghost = page.getByTestId('command-suggestion')
  await page.keyboard.type(first.command.slice(0, 8))
  await expect(ghost)
    .toHaveText(first.command.slice(8))
    .catch(() => diagnose('no suggestion shown'))
  await page.keyboard.press('ArrowRight')
  await expect(ghost).toHaveCount(0)
  await page.keyboard.press('Enter')
  await expect
    .poll(() =>
      page.evaluate(([id, t]) => window.__shellhouseTest.bufferText(id).split(t).length - 1, [
        tab,
        first.expected
      ] as const)
    )
    .toBe(2)

  // Lệnh có dấu cách đầu không được gợi ý.
  await page.keyboard.type(isWindows ? 'Write-Output ("bi' : 'echo bi')
  await page.waitForTimeout(300)
  await expect(ghost).toHaveCount(0)
  await page.keyboard.press('Control+C')

  // Chữ không hiện trên màn hình (mật khẩu) không bao giờ vào lịch sử.
  if (!isWindows) {
    await typeLine("read -s -p 'Secret: ' x; echo; echo read-done")
    await waitForText(page, tab, 'Secret: ')
    await typeLine('topsecret-value')
    await waitForText(page, tab, 'read-done\n')
    await page.keyboard.type('tops')
    await page.waitForTimeout(300)
    await expect(ghost).toHaveCount(0)
  }
})
