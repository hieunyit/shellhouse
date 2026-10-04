import type { Page } from '@playwright/test'
import { activeTab, expect, openArea, test } from './fixtures'

/**
 * Khung app mới (thiết kế v0.5 – v0.7): khu vực trên activity bar, ← / →, Focus mode, môi trường,
 * xuất danh sách host, Quick connect "lưu thành host".
 */
const isMac = process.platform === 'darwin'

async function saveGroup(
  page: Page,
  name: string,
  defaults: Record<string, unknown> = {}
): Promise<string> {
  const r = await page.evaluate(
    ([n, d]) => window.shellhouse.saveGroup({ parentId: null, name: n, defaults: d }),
    [name, defaults] as const
  )
  if (!r.ok) throw new Error(r.message)
  return r.id
}

async function saveHost(page: Page, label: string, groupId: string | null): Promise<string> {
  const r = await page.evaluate(
    ([l, g]) =>
      window.shellhouse.saveHost({
        groupId: g,
        label: l,
        hostname: `${l}.example.com`,
        port: 22,
        username: 'deploy',
        auth: 'auto',
        keyId: null,
        keyFile: null,
        proxyJump: null,
        jumpHostIds: [],
        mode: 'builtin',
        tags: [],
        color: null
      }),
    [label, groupId] as const
  )
  if (!r.ok) throw new Error(r.message)
  return r.id
}

test('khu vực: Home / Hosts / Settings / Transfers; ← / → theo lịch sử; bấm lại ẩn Explorer', async ({
  page
}) => {
  await expect(page.getByTestId('explorer')).toHaveAttribute('data-area', 'hosts')
  await openArea(page, 'home')
  await expect(page.getByTestId('welcome')).toBeVisible()
  await page.getByTestId('open-settings').click()
  await expect(page.getByTestId('settings-dialog')).toBeVisible()
  await openArea(page, 'transfers')
  await expect(page.getByTestId('transfers-page')).toContainText('No transfers')

  await page.getByTestId('nav-back').click()
  await expect(page.getByTestId('settings-dialog')).toBeVisible()
  await page.getByTestId('nav-back').click()
  await expect(page.getByTestId('welcome')).toBeVisible()
  await page.getByTestId('nav-forward').click()
  await expect(page.getByTestId('settings-dialog')).toBeVisible()

  // Bấm lại khu vực đang chọn: ẩn / hiện Explorer.
  await openArea(page, 'hosts')
  await page.getByTestId('activity-hosts').click()
  await expect(page.getByTestId('explorer')).toHaveCount(0)
  await page.getByTestId('activity-hosts').click()
  await expect(page.getByTestId('explorer')).toBeVisible()
})

test('Focus mode: chỉ còn terminal + title bar; Esc không thoát; thoát bằng nút hoặc phím', async ({
  page
}) => {
  const tab = await activeTab(page)
  await page.getByTestId('focus-mode').click()
  await expect(page.getByTestId('activity-bar')).toHaveCount(0)
  await expect(page.getByTestId('statusbar')).toHaveCount(0)
  await expect(page.getByTestId('focus-pill')).toBeVisible()
  await expect(page.getByTestId(`terminal-${tab}`)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('focus-pill')).toBeVisible()
  await page.getByTestId('focus-exit').click()
  await expect(page.getByTestId('activity-bar')).toBeVisible()
  await page.keyboard.press(isMac ? 'Meta+Shift+Enter' : 'Control+Shift+Enter')
  await expect(page.getByTestId('focus-pill')).toBeVisible()
  await page.keyboard.press(isMac ? 'Meta+Shift+Enter' : 'Control+Shift+Enter')
  await expect(page.getByTestId('focus-pill')).toHaveCount(0)
})

test('môi trường: tạo môi trường mới, đặt cho nhóm bằng menu ⋯, nhãn ở hàng nhóm + header, vạch trên cùng', async ({
  page
}) => {
  const g = await saveGroup(page, 'Lab')
  await saveHost(page, 'lab-1', g)

  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-nav-environments').click()
  await expect(page.getByTestId('environment-row')).toHaveCount(4)
  // Production dựng sẵn: không xoá được.
  await page
    .locator('[data-testid="environment-row"][data-id="prod"]')
    .getByTestId('environment-menu')
    .click()
  await expect(page.getByTestId('menu-env-delete')).toBeDisabled()
  await page.keyboard.press('Escape')

  await page.getByTestId('environment-new').click()
  const dialog = page.getByTestId('environment-dialog')
  await dialog.getByTestId('environment-name').fill('QA lab')
  await expect(dialog.getByTestId('environment-short')).toHaveValue('QL')
  await dialog.getByTestId('environment-short').fill('QA')
  await dialog.getByTestId('environment-top-line').check()
  await dialog.getByTestId('environment-save').click()
  await expect(page.locator('[data-testid="environment-row"][data-id="qa-lab"]')).toContainText(
    'QA lab'
  )
  await page.keyboard.press('Escape')

  // Nhóm: menu ⋯ → đổi môi trường nhanh (toast có Undo).
  await openArea(page, 'hosts')
  const group = page.locator('[data-testid="group-row"][data-group-name="Lab"]')
  await group.hover()
  await group.getByTestId('group-more').click()
  await page.getByTestId('menu-env-qa-lab').click()
  await expect(group.getByRole('img', { name: 'QA lab' })).toBeVisible()

  // Mở host → header có nhãn môi trường, vạch trên cùng (môi trường bật "Line at the top").
  await page.locator('[data-testid="host-row"][data-host-label="lab-1"]').dblclick()
  await expect(page.getByTestId('hosts-header')).toHaveAttribute('data-env', 'qa-lab')
  await expect(page.getByTestId('main').getByTestId('env-line')).toBeVisible()

  // Môi trường đang dùng → xoá phải chọn môi trường thay thế.
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-nav-environments').click()
  const row = page.locator('[data-testid="environment-row"][data-id="qa-lab"]')
  await expect(row.getByTestId('environment-used-by')).toContainText('1 group')
  await row.getByTestId('environment-menu').click()
  await page.getByTestId('menu-env-delete').click()
  await page.getByTestId('environment-replace-dev').click()
  await page.getByTestId('environment-delete-confirm').click()
  await expect(row).toHaveCount(0)
  const tree = await page.evaluate(() => window.shellhouse.hostTree())
  expect(tree.groups.find((x) => x.name === 'Lab')?.defaults.environment).toBe('dev')
})

test('xuất danh sách host: YAML / OpenSSH config, phạm vi nhóm, không có mật khẩu', async ({
  page
}) => {
  const g = await saveGroup(page, 'Production', { environment: 'prod' })
  await saveHost(page, 'web', g)
  await saveHost(page, 'loose', null)
  await page.getByTestId('hosts-export').click()
  const dialog = page.getByTestId('export-dialog')
  const preview = dialog.getByTestId('export-preview')
  await expect(preview).toContainText('environment: prod')
  await expect(preview).toContainText('hostname: web.example.com')
  await expect(dialog.getByTestId('export-count')).toContainText('2 hosts')
  await dialog.getByTestId('export-format-ssh').click()
  await expect(preview).toContainText('Host web\n  HostName web.example.com\n  User deploy')
  await dialog.getByTestId('export-scope').selectOption({ label: 'Production' })
  await expect(preview).not.toContainText('loose')
  await expect(preview).not.toContainText(/password\s*:|passphrase|secret/i)
})

test('Quick connect: gõ tên host đã lưu hoặc user@host; Ctrl+Enter lưu thành host (form điền sẵn)', async ({
  page
}) => {
  await saveHost(page, 'db-main', null)
  await page.keyboard.press(isMac ? 'Meta+Shift+O' : 'Control+Shift+O')
  const input = page.getByTestId('quick-connect')
  await input.fill('db')
  await expect(page.getByTestId('quick-connect-host').first()).toContainText('db-main')
  await input.fill('ops@10.9.8.7:2200')
  await expect(page.getByTestId('quick-connect-address')).toContainText('ops@10.9.8.7:2200')
  await input.press('Control+Enter')
  const form = page.getByTestId('host-form')
  await expect(form.getByTestId('host-hostname')).toHaveValue('10.9.8.7')
  await expect(form.getByTestId('host-port')).toHaveValue('2200')
  await expect(form.getByTestId('host-username')).toHaveValue('ops')
})
