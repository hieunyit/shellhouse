import type { Page } from '@playwright/test'
import { activeTab, echoComputed, expect, isWindows, sendLine, test, waitForText } from './fixtures'

/** Đợi dấu nhắc lệnh mới in xong (gõ sớm hơn → shell vẽ lại dòng lung tung). */
async function waitPrompt(page: Page, tab: string): Promise<void> {
  await expect
    .poll(async () => {
      const st = (await page.evaluate(
        (id) => window.__shellhouseTest.suggestionState(id),
        tab
      )) as { beforeCursor?: string } | null
      return /[$#%>] $/.test(st?.beforeCursor ?? '')
    })
    .toBe(true)
}

/**
 * Dấu nhắc ngắn "$ ": runner macOS dùng bash 3.2 với dấu nhắc ~72 ký tự trên 80 cột — mọi lệnh bị
 * ngắt dòng và bash 3.2 vẽ lại sai. Trường hợp ngắt dòng có test riêng bên dưới.
 */
async function prepareShell(page: Page, tab: string): Promise<void> {
  if (!isWindows) {
    await sendLine(page, tab, "export PS1='$ '; echo ps1-ready")
    await waitForText(page, tab, 'ps1-ready\n')
  }
  await waitPrompt(page, tab)
}

test('gợi ý lệnh từ lịch sử: chữ mờ sau con trỏ, → để nhận; lệnh bắt đầu bằng dấu cách không lưu', async ({
  page
}) => {
  const tab = await activeTab(page)
  const terminal = page.getByTestId(`terminal-${tab}`)
  await terminal.click()
  await prepareShell(page, tab)
  const typeLine = async (line: string): Promise<void> => {
    await waitPrompt(page, tab)
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
  await waitPrompt(page, tab)
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
  // Chẩn đoán cho người dùng (bảng lệnh): chép trạng thái — lịch sử đã nạp, có lệnh khớp.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+Shift+P')
  await page.getByTestId('palette-input').fill('command suggestion diagnostics')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('toast-title').last()).toContainText('diagnostics copied')
  const report = JSON.parse(await page.evaluate(() => window.shellhouse.readClipboard())) as {
    history: { loaded: boolean; matches: number }
  }
  expect(report.history).toMatchObject({ loaded: true, matches: 1 })
  await page.getByTestId(`terminal-${tab}`).click()
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
    // Đang ở dấu nhắc "Secret: " của read → gõ thẳng, không chờ dấu nhắc shell.
    await page.keyboard.type('topsecret-value')
    await page.keyboard.press('Enter')
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
  await prepareShell(page, tab)
  const ready = echoComputed('ready')
  await page.keyboard.type(ready.command)
  await page.keyboard.press('Enter')
  await waitForText(page, tab, ready.expected)
  await waitPrompt(page, tab)
  const cols = await page.evaluate((id) => window.__shellhouseTest.size(id)?.cols ?? 80, tab)
  // Dài hơn một dòng terminal → chắc chắn bị ngắt.
  const long = `echo ${'dai-'.repeat(Math.ceil(cols / 4))}xong`
  await page.keyboard.type(long, { delay: 5 })
  await page.keyboard.press('Enter')
  // Output dài bị ngắt giữa chữ → đợi dấu nhắc mới thay vì tìm chữ trên màn hình.
  await waitPrompt(page, tab)
  await expect
    .poll(() => page.evaluate(() => window.shellhouse.commandHistory('local:default')), {
      timeout: 10_000
    })
    .toContain(long)
  await waitPrompt(page, tab)
  await page.keyboard.type('echo dai-dai', { delay: 5 })
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
  await prepareShell(page, tab)
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
  // Nạp sẵn lệnh dài vào lịch sử (việc ghi lệnh đã có test riêng): gõ tay lệnh dài đúng tới mép
  // phải đôi khi làm readline (bash 3.2 trên macOS) vẽ sai dòng → app đúng ra không lưu lệnh.
  await page.evaluate(([target, cmd]) => window.__shellhouseTest.seedCommandHistory(target, cmd), [
    'local:default',
    command
  ] as const)
  await expect.poll(async () => /[$#%>] $/.test((await promptState()).beforeCursor)).toBe(true)
  await page.keyboard.type(prefix, { delay: 5 })
  await expect(page.getByTestId('command-suggestion'))
    .toHaveText('-phan-con-lai')
    .catch(async () => {
      const st = await page.evaluate((id) => window.__shellhouseTest.suggestionState(id), tab)
      throw new Error(`no suggestion at the right edge (cols ${cols}): ${JSON.stringify(st)}`)
    })
})
