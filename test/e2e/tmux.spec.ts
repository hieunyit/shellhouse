import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startTestSshServer, type TestSshServer } from '../integration/ssh-test-server'
import { activeTab, expect, sendLine, test, waitForText } from './fixtures'

let server: TestSshServer | null = null
test.afterEach(async () => {
  await server?.close()
  server = null
})

test.skip(process.platform === 'win32', 'tmux giả là script sh')

test('host bật tmux: mỗi tab gắn vào phiên tmux riêng, kết nối lại về đúng phiên cũ', async ({
  page
}) => {
  const home = mkdtempSync(join(tmpdir(), 'sh-tmux-'))
  const bin = join(home, 'bin')
  mkdirSync(bin)
  // tmux giả: in tham số rồi lặp lại những gì nhận được.
  writeFileSync(join(bin, 'tmux'), '#!/bin/sh\necho "fake-tmux $*"\nexec /bin/cat\n')
  chmodSync(join(bin, 'tmux'), 0o755)
  server = await startTestSshServer([{ username: 'u', password: 'p' }], {
    execHome: home,
    execPath: bin,
    execPathOnly: true
  })
  await page.getByTestId('add-host').click()
  const form = page.getByTestId('host-form')
  await form.getByTestId('host-hostname').fill('127.0.0.1')
  await form.getByTestId('host-port').fill(String(server.port))
  await form.getByTestId('host-username').fill('u')
  await form.getByTestId('host-label').fill('box')
  await form.getByTestId('host-auth-password').check()
  await form.getByTestId('host-password').fill('p')
  await form.getByTestId('host-advanced').click()
  await form.getByTestId('host-tmux').check()
  await form.getByTestId('host-save').click()

  const row = page.locator('[data-testid="host-row"][data-host-label="box"]')
  await row.dblclick()
  await page
    .getByTestId('hostkey-accept')
    .click({ timeout: 5000 })
    .catch(() => undefined)
  const first = await activeTab(page)
  await waitForText(page, first, 'fake-tmux new-session -A -s shellhouse-1')
  await sendLine(page, first, 'still here')
  await waitForText(page, first, 'still here')

  // Tab thứ hai của cùng host → phiên riêng.
  await row.dblclick()
  const second = await activeTab(page)
  await waitForText(page, second, 'fake-tmux new-session -A -s shellhouse-2')

  // Kết nối lại tab đầu → vẫn phiên shellhouse-1 (không chiếm số mới).
  await page.locator(`[data-testid="tab"][data-tab-id="${first}"]`).click({ button: 'right' })
  await page.getByTestId('menu-tab-reconnect').click()
  await waitForText(page, first, '— new session —')
  await expect
    .poll(() =>
      page.evaluate(
        (id) => window.__shellhouseTest.bufferText(id).split('-s shellhouse-1').length - 1,
        first
      )
    )
    .toBeGreaterThanOrEqual(2)

  // Mở lại form: tuỳ chọn đã lưu, mục Advanced tự mở.
  await row.click({ button: 'right' })
  await page.getByTestId('menu-edit').click()
  await expect(page.getByTestId('host-form').getByTestId('host-tmux')).toBeChecked()
})
