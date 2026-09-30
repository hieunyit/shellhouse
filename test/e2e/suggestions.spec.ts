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
  // PowerShell (PSReadLine) tự hiện gợi ý của nó ngay sau con trỏ → app không vẽ chồng lên;
  // → vẫn nhận gợi ý (của PSReadLine).
  const shown = async (): Promise<string> => {
    if ((await ghost.count()) > 0) return (await ghost.textContent()) ?? ''
    const state = (await page.evaluate(
      (id) => window.__shellhouseTest.suggestionState(id),
      tab
    )) as {
      afterCursor?: string
    } | null
    return isWindows ? (state?.afterCursor ?? '') : ''
  }
  await expect
    .poll(shown)
    .toBe(first.command.slice(8))
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

test('gợi ý lệnh với dòng lệnh dài bị ngắt xuống dòng (cửa sổ hẹp / dấu nhắc dài)', async ({
  app,
  page
}) => {
  test.skip(isWindows, 'PowerShell tự gợi ý (PSReadLine)')
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(760, 600)
  })
  const tab = await activeTab(page)
  await page.getByTestId(`terminal-${tab}`).click()
  const ready = echoComputed('ready')
  await page.keyboard.type(ready.command)
  await page.keyboard.press('Enter')
  await waitForText(page, tab, ready.expected)
  const cols = await page.evaluate((id) => window.__shellhouseTest.size(id)?.cols ?? 80, tab)
  // Dài hơn một dòng terminal → chắc chắn bị ngắt.
  const long = `echo ${'dai-'.repeat(Math.ceil(cols / 4))}xong`
  await page.keyboard.type(long)
  await page.keyboard.press('Enter')
  await waitForText(page, tab, 'xong\n')
  await expect
    .poll(() => page.evaluate(() => window.shellhouse.commandHistory('local:default')), {
      timeout: 10_000
    })
    .toContain(long)
  await page.keyboard.type('echo dai-dai')
  // Gợi ý = phần còn lại của lệnh (có thể bị cắt ở mép phải cửa sổ).
  const rest = long.slice('echo dai-dai'.length)
  await expect
    .poll(async () => {
      const text = (await page.getByTestId('command-suggestion').textContent()) ?? ''
      return text.length > 0 && rest.startsWith(text)
    })
    .toBe(true)
})

test('gợi ý khi con trỏ đứng ngay mép phải: chữ gợi ý tràn sang dòng dưới', async ({ page }) => {
  test.skip(isWindows, 'PowerShell tự gợi ý (PSReadLine)')
  const tab = await activeTab(page)
  await page.getByTestId(`terminal-${tab}`).click()
  const ready = echoComputed('ready')
  await page.keyboard.type(ready.command)
  await page.keyboard.press('Enter')
  await waitForText(page, tab, ready.expected)
  // Đợi dấu nhắc mới in xong rồi mới đo vị trí con trỏ (đo sớm → tính sai độ dài, và gõ đè lúc
  // bash còn đang vẽ dấu nhắc).
  type State = { cursor: { col: number }; beforeCursor: string }
  const promptState = (): Promise<State> =>
    page.evaluate((id) => window.__shellhouseTest.suggestionState(id), tab) as Promise<State>
  await expect.poll(async () => /[$#%>] $/.test((await promptState()).beforeCursor)).toBe(true)
  const state = await promptState()
  const cols = await page.evaluate((id) => window.__shellhouseTest.size(id)?.cols ?? 80, tab)
  // Phần gõ vừa đủ để con trỏ chạm mép phải dòng.
  const prefix = `echo ${'m'.repeat(cols - state.cursor.col - 5)}`
  const command = `${prefix}-phan-con-lai`
  // Gõ với tốc độ gần người thật: gõ tức thì đúng lúc chạm mép phải làm readline (bash) tự vẽ sai
  // dòng — khi đó app đúng ra không lưu lệnh (không khớp màn hình).
  await page.keyboard.type(command, { delay: 5 })
  await page.keyboard.press('Enter')
  await waitForText(page, tab, 'phan-con-lai\n')
  await expect
    .poll(() => page.evaluate(() => window.shellhouse.commandHistory('local:default')), {
      timeout: 10_000
    })
    .toContain(command)
    .catch(async () => {
      const screen = (await page.evaluate((id) => window.__shellhouseTest.bufferText(id), tab))
        .trimEnd()
        .split('\n')
        .slice(-6)
      throw new Error(`long command not recorded; screen: ${JSON.stringify(screen)}`)
    })
  await expect.poll(async () => /[$#%>] $/.test((await promptState()).beforeCursor)).toBe(true)
  await page.keyboard.type(prefix, { delay: 5 })
  await expect(page.getByTestId('command-suggestion'))
    .toHaveText('-phan-con-lai')
    .catch(async () => {
      const st = await page.evaluate((id) => window.__shellhouseTest.suggestionState(id), tab)
      throw new Error(`no suggestion at the right edge (cols ${cols}): ${JSON.stringify(st)}`)
    })
})
