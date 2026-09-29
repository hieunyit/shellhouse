import type { ElectronApplication, Page } from '@playwright/test'
import { activeTab, expect, sendLine, test, waitForText } from './fixtures'

const setClipboard = (app: ElectronApplication, text: string): Promise<void> =>
  app.evaluate(({ clipboard }, t) => {
    void clipboard.writeText(t)
  }, text)
const getClipboard = (app: ElectronApplication): Promise<string> =>
  app.evaluate(({ clipboard }) => clipboard.readText())

const terminal = (page: Page, tab: string) =>
  page.locator(`[data-testid="terminal-${tab}"] .xterm-screen`)

test('chuột phải trong terminal: menu Copy / Paste / Select all / Clear', async ({ app, page }) => {
  const tab = await activeTab(page)
  await sendLine(page, tab, 'echo menu-copy-test')
  await waitForText(page, tab, 'menu-copy-test\n')

  // Chưa chọn gì → Copy bị tắt.
  await terminal(page, tab).click({ button: 'right' })
  const menu = page.getByTestId('context-menu')
  await expect(menu).toBeVisible()
  await expect(page.getByTestId('menu-term-copy')).toBeDisabled()
  await page.getByTestId('menu-term-select-all').click()
  await expect(menu).toHaveCount(0)

  await terminal(page, tab).click({ button: 'right' })
  await page.getByTestId('menu-term-copy').click()
  await expect.poll(() => getClipboard(app)).toContain('menu-copy-test')

  await setClipboard(app, 'echo pasted-by-menu')
  await terminal(page, tab).click({ button: 'right' })
  await page.getByTestId('menu-term-paste').click()
  await page.keyboard.press('Enter')
  await waitForText(page, tab, 'pasted-by-menu\n')

  await terminal(page, tab).click({ button: 'right' })
  await page.getByTestId('menu-term-clear').click()
  await expect
    .poll(() => page.evaluate((id) => window.__shellhouseTest.bufferText(id), tab))
    .not.toContain('menu-copy-test')
})

test('kiểu PuTTY: chuột phải dán ngay, có vùng chọn thì copy; Shift+Insert dán', async ({
  app,
  page
}) => {
  const tab = await activeTab(page)
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-nav-terminal').click()
  await page.getByTestId('setting-right-click-paste').click()
  await page.keyboard.press('Escape')

  await setClipboard(app, 'echo putty-paste')
  await terminal(page, tab).click({ button: 'right' })
  await expect(page.getByTestId('context-menu')).toHaveCount(0)
  await page.keyboard.press('Enter')
  await waitForText(page, tab, 'putty-paste\n')

  // Có vùng chọn → chuột phải = copy (không dán).
  await page.evaluate((id) => {
    window.__shellhouseTest.sendInput(id, 'clear\r')
  }, tab)
  await sendLine(page, tab, 'echo chon-de-copy')
  await waitForText(page, tab, 'chon-de-copy\n')
  // Kéo chuột chọn dòng đầu của màn hình.
  const box = await terminal(page, tab).boundingBox()
  if (!box) throw new Error('terminal chưa hiện')
  await page.mouse.move(box.x + 2, box.y + 6)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 4, box.y + 6, { steps: 5 })
  await page.mouse.up()
  await terminal(page, tab).click({ button: 'right', position: { x: 20, y: 6 } })
  await expect.poll(() => getClipboard(app)).not.toBe('echo putty-paste')
  expect((await getClipboard(app)).length).toBeGreaterThan(0)

  await setClipboard(app, 'echo shift-insert')
  await terminal(page, tab).click()
  await page.keyboard.press('Shift+Insert')
  await page.keyboard.press('Enter')
  await waitForText(page, tab, 'shift-insert\n')
})

test('ô nhập có menu chuột phải chuẩn (Cut / Copy / Paste / Select All)', async ({ app }) => {
  // Menu native không bấm được bằng Playwright → kiểm tra menu mà main dựng ra.
  const build = (params: object): Promise<string[]> =>
    app.evaluate(({ BrowserWindow, Menu }, p) => {
      const original = Menu.buildFromTemplate.bind(Menu)
      let labels: string[] = []
      Menu.buildFromTemplate = (template: { label?: string; type?: string }[]) => {
        labels = template.map((i) => i.label ?? i.type ?? '')
        return { popup: () => undefined } as unknown as Electron.Menu
      }
      try {
        BrowserWindow.getAllWindows()[0]?.webContents.emit('context-menu', {}, p)
      } finally {
        Menu.buildFromTemplate = original
      }
      return labels
    }, params)
  const flags = {
    canUndo: false,
    canRedo: false,
    canCut: true,
    canCopy: true,
    canPaste: true,
    canSelectAll: true,
    canDelete: true,
    canEditRichly: false
  }
  expect(await build({ isEditable: true, selectionText: '', editFlags: flags })).toEqual([
    'Undo',
    'Redo',
    'separator',
    'Cut',
    'Copy',
    'Paste',
    'separator',
    'Select All'
  ])
  expect(await build({ isEditable: false, selectionText: 'abc', editFlags: flags })).toEqual([
    'Copy'
  ])
  expect(await build({ isEditable: false, selectionText: '', editFlags: flags })).toEqual([])
})
