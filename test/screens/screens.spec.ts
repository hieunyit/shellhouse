import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { startTestSshServer } from '../integration/ssh-test-server'
import { activeTab, expect, launchApp, test, waitForText } from '../e2e/fixtures'

/**
 * Chụp các màn hình chính ở cả sáng và tối để rà soát giao diện bằng mắt (không assert pixel).
 *   pnpm build && pnpm screens                       → ảnh trong screens/<theme>-<tên>.png
 *   SHELLHOUSE_LANG=vi pnpm screens                  → giao diện tiếng Việt: screens/vi-<theme>-<tên>.png
 */
const OUT = 'screens'
/** launchApp đọc SHELLHOUSE_LANG (mặc định en); ảnh tiếng Việt có tiền tố riêng, không đè ảnh tiếng Anh. */
const PREFIX = process.env['SHELLHOUSE_LANG'] === 'vi' ? 'vi-' : ''
test.setTimeout(180_000)

async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-nav-appearance').click()
  await page.getByTestId(`appearance-${theme}`).click()
  await page.keyboard.press('Escape')
}

test('chụp màn hình giao diện', async () => {
  mkdirSync(OUT, { recursive: true })
  // execHome: server chạy lệnh thật → thanh số liệu server (Linux) có dữ liệu.
  const server = await startTestSshServer([{ username: 'demo', password: 'pw' }], {
    execHome: mkdtempSync(join(tmpdir(), 'sh-screens-')),
    sftpRoot: mkdtempSync(join(tmpdir(), 'sh-screens-sftp-'))
  })
  const launched = await launchApp()
  const { page } = launched
  await page.setViewportSize({ width: 1360, height: 820 })
  try {
    // Dữ liệu mẫu: vài nhóm + host.
    const groups: Record<string, string> = {}
    const tree: [string, string | null][] = [
      ['Production', null],
      ['Web', 'Production'],
      ['Database', 'Production'],
      ['EU West', 'Database'],
      ['Staging', null]
    ]
    for (const [name, parent] of tree) {
      const r = await page.evaluate(
        ([n, p]) =>
          window.shellhouse.saveGroup({
            parentId: p,
            name: n,
            defaults:
              n === 'Production' ? { color: 'red' } : n === 'Staging' ? { color: 'yellow' } : {}
          }),
        [name, parent ? (groups[parent] ?? null) : null] as const
      )
      if (r.ok && r.id) groups[name] = r.id
    }
    const hosts: [string, string | null, string][] = [
      ['web-01', 'Web', 'web-01.example.com'],
      ['web-02', 'Web', 'web-02.example.com'],
      ['db-primary', 'Database', '10.0.1.20'],
      ['db-replica-eu', 'EU West', '10.8.1.21'],
      ['bastion', 'Production', 'bastion.example.com'],
      ['staging-api', 'Staging', 'staging.example.com'],
      ['local test server', 'Web', '127.0.0.1']
    ]
    for (const [label, group, hostname] of hosts) {
      await page.evaluate(
        ([l, g, h, port]) =>
          window.shellhouse.saveHost({
            groupId: g,
            label: l,
            hostname: h,
            port: h === '127.0.0.1' ? port : 22,
            username: 'demo',
            auth: 'password',
            password: 'pw',
            keyId: null,
            keyFile: null,
            proxyJump: null,
            jumpHostIds: [],
            mode: 'builtin',
            tags: l.startsWith('web') ? ['web'] : [],
            color: l === 'db-primary' ? 'red' : null
          }),
        [label, group ? (groups[group] ?? null) : null, hostname, server.port] as const
      )
    }

    const tree0 = await page.evaluate(() => window.shellhouse.hostTree())
    const fav = tree0.hosts
      .filter((h) => ['db-primary', 'bastion'].includes(h.label))
      .map((h) => h.id)
    await page.evaluate((ids) => window.shellhouse.setFavorite(ids, true), fav)

    // Kết nối SSH để có tab SSH + SFTP.
    await page.locator('[data-testid="host-row"][data-host-label="local test server"]').dblclick()
    const sshTab = await activeTab(page)
    await page.getByTestId('hostkey-accept').click()
    await waitForText(page, sshTab, 'welcome to test server')
    await page.evaluate((id) => {
      window.__shellhouseTest.sendInput(id, 'ls -la /\r')
    }, sshTab)
    await page.waitForTimeout(500)

    for (const theme of ['dark', 'light'] as const) {
      await setTheme(page, theme)
      const shot = async (name: string): Promise<void> => {
        await page.waitForTimeout(250)
        await page.screenshot({ path: `${OUT}/${PREFIX}${theme}-${name}.png` })
      }
      await shot('01-main')

      // Trang chủ (Home): kết nối gần đây, yêu thích, thao tác bắt đầu.
      await page.getByTestId('open-home').click()
      await expect(page.getByTestId('welcome')).toBeVisible()
      await shot('00-home')
      await page.locator(`[data-testid="tab"][data-tab-id="${sshTab}"]`).click()
      const web1 = page.locator('[data-testid="host-row"][data-host-label="web-01"]')
      await web1.click({ button: 'right' })
      await shot('01b-context-menu')
      await page.keyboard.press('Escape')
      await web1.click()
      await page
        .locator('[data-testid="host-row"][data-host-label="web-02"]')
        .click({ modifiers: ['Control'] })
      await shot('01c-multiselect')
      await page.keyboard.press('Escape')
      await page
        .locator(`[data-testid="terminal-${sshTab}"] .xterm-screen`)
        .click({ button: 'right', position: { x: 160, y: 60 } })
      await shot('01d-terminal-menu')
      await page.keyboard.press('Escape')

      await page.getByTestId('toggle-sftp').last().click()
      await page.waitForTimeout(600)
      await shot('02-sftp')
      await page.getByTestId('toggle-sftp').last().click()

      await page.getByTestId('toggle-forwards').last().click()
      await shot('03-forwards')
      await page.getByTestId('toggle-forwards').last().click()

      // Menu chuột phải của tab.
      await page.locator(`[data-testid="tab"][data-tab-id="${sshTab}"]`).click({ button: 'right' })
      await shot('03b-tab-menu')
      await page.keyboard.press('Escape')

      // Trình quản lý file hai cột.
      await page.getByTestId('toggle-files').last().click()
      await page.waitForTimeout(700)
      await shot('03c-file-manager')
      await page.getByTestId('toggle-files').last().click()

      // Workspaces + Import.
      await page.getByTestId('open-workspaces').click()
      await page.getByTestId('workspace-name').fill('Prod web + DB')
      await page.getByTestId('workspace-save').click()
      // Lượt theme thứ hai: workspace đã có → hộp hỏi "Replace?" của app.
      const replace = page.getByTestId('confirm-dialog')
      if (await replace.isVisible().catch(() => false))
        await replace.getByTestId('confirm-ok').click()
      await shot('03d-workspaces')
      await page.keyboard.press('Escape')
      await page.getByTestId('import-ssh-config').click()
      await page.getByTestId('import-source-csv').click()
      await shot('03e-import')
      await page.keyboard.press('Escape')

      // Thanh bên ẩn.
      await page.getByTestId('toggle-sidebar').click()
      await shot('03f-sidebar-hidden')
      await page.getByTestId('toggle-sidebar').click()

      // Thanh bên gọn (thanh icon) + mở tạm khi rê chuột — mặc định ở tab module.
      await page.getByTestId('sidebar-collapse').click()
      await page.mouse.move(700, 400)
      await shot('03g-sidebar-rail')
      await page.getByTestId('rail-search').hover()
      await expect(page.getByTestId('sidebar-panel')).toHaveAttribute('data-peek', 'open')
      await shot('03h-sidebar-peek')
      await page.getByTestId('sidebar-pin').click()
      await page.mouse.move(700, 400)

      await page.getByTestId('add-host').click()
      await shot('04-host-form')
      // Ô tag dạng chip + gợi ý từ tag đã dùng; lỗi port ngay dưới ô.
      await page.getByTestId('host-tags-input').fill('we')
      await page.getByTestId('host-port').fill('99999')
      await page.getByTestId('host-auth-password').click()
      await shot('04a-host-form-details')
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('host-form')).toHaveCount(0)

      const dbRow = page.locator('[data-testid="group-row"][data-group-name="Database"]')
      await dbRow.hover()
      await shot('04b-group-hover')
      await dbRow.getByTestId('group-edit').click()
      await page.getByTestId('group-parent').focus()
      await shot('04c-group-form')
      await page.getByTestId('group-delete').click()
      await shot('04d-group-delete')
      await page.keyboard.press('Escape')

      await page.keyboard.press('Control+Shift+P')
      await shot('05-palette')
      await page.keyboard.press('Escape')

      await page.getByTestId('open-snippets').click()
      await shot('06-snippets')
      await page.keyboard.press('Escape')

      await page.getByTestId('open-settings').click()
      for (const section of [
        'appearance',
        'terminal',
        'security',
        'files',
        'keys',
        'shortcuts',
        'updates'
      ]) {
        const nav = page.getByTestId(`settings-nav-${section}`)
        if (await nav.count()) {
          await nav.click()
          await shot(`07-settings-${section}`)
        }
      }
      await page.keyboard.press('Escape')

      // Prompt mật khẩu trong tab (kết nối nhanh không lưu mật khẩu).
      await page.getByTestId('quick-connect').fill(`demo@127.0.0.1:${server.port}`)
      await page.getByTestId('quick-connect').press('Enter')
      await expect(page.getByTestId('prompt-dialog')).toBeVisible()
      await shot('08-password-prompt')
      await page.keyboard.press('Escape')
      await page.keyboard.press('Control+Shift+W')

      await page.getByTestId('lock-vault').click()
      await shot('09-vault-locked')
      await page.getByTestId('vault-password').fill('e2e-master-password')
      await page.getByTestId('vault-submit').click()
      await expect(page.getByTestId('vault-gate')).toHaveCount(0)
    }
    // Lưới + gõ đồng loạt (theme sáng — vòng lặp trên kết thúc ở light).
    await page
      .locator('[data-testid="group-row"][data-group-name="Web"]')
      .click({ button: 'right' })
    await page.getByTestId('menu-open-multiexec').click()
    await page
      .getByTestId('hostkey-accept')
      .first()
      .click({ timeout: 3_000 })
      .catch(() => undefined)
    await page.waitForTimeout(1500)
    await page.screenshot({ path: `${OUT}/${PREFIX}light-10-multiexec.png` })
  } finally {
    await launched.close()
    await server.close()
  }
})
