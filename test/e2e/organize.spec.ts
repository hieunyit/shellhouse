import type { Locator, Page } from '@playwright/test'
import type { GroupDefaults } from '../../src/shared/hosts'
import { startTestSshServer, type TestSshServer } from '../integration/ssh-test-server'
import { expect, test, waitForText } from './fixtures'

let server: TestSshServer | null = null
test.afterEach(async () => {
  await server?.close()
  server = null
})

const hostRow = (page: Page, label: string): Locator =>
  page.locator(`[data-testid="host-row"][data-host-label="${label}"]`)
const groupRow = (page: Page, name: string): Locator =>
  page.locator(`[data-testid="group-row"][data-group-name="${name}"]`)

async function saveGroup(page: Page, name: string, defaults: GroupDefaults = {}): Promise<string> {
  const r = await page.evaluate(
    ([n, d]) => window.shellhouse.saveGroup({ parentId: null, name: n, defaults: d }),
    [name, defaults] as const
  )
  if (!r.ok) throw new Error(r.message)
  return r.id
}

async function saveHost(
  page: Page,
  label: string,
  opts: { groupId?: string | null; port?: number | null; username?: string } = {}
): Promise<string> {
  const r = await page.evaluate(
    ([l, o]) =>
      window.shellhouse.saveHost({
        groupId: o.groupId ?? null,
        label: l,
        hostname: '127.0.0.1',
        port: o.port === undefined ? 22 : o.port,
        username: o.username ?? 'u',
        auth: 'password',
        password: 'pw',
        keyId: null,
        keyFile: null,
        proxyJump: null,
        jumpHostIds: [],
        mode: 'builtin',
        tags: [],
        color: null
      }),
    [label, opts] as const
  )
  if (!r.ok) throw new Error(r.message)
  return r.id
}

/** Chấp nhận mọi hộp thoại host key đang/ sắp hiện (mỗi tab một hộp). */
async function acceptHostKeys(page: Page, tabs: number): Promise<void> {
  for (let i = 0; i < tabs; i++) {
    const accept = page.getByTestId('hostkey-accept')
    await accept
      .first()
      .click({ timeout: 3_000 })
      .catch(() => undefined)
  }
}

test('nhóm đặt username / port / màu → host để trống kế thừa; tab + thanh phiên mang màu môi trường', async ({
  page
}) => {
  server = await startTestSshServer([{ username: 'deploy', password: 'pw' }])
  await saveGroup(page, 'Production', { username: 'deploy', port: server.port, color: 'red' })

  await groupRow(page, 'Production').hover()
  await groupRow(page, 'Production').getByTestId('group-add-host').click()
  const form = page.getByTestId('host-form')
  await form.getByTestId('host-hostname').fill('127.0.0.1')
  await form.getByTestId('host-label').fill('inherits')
  await expect(form).toContainText('Using “deploy” (from Production)')
  await expect(form.getByTestId('host-port')).toHaveAttribute('placeholder', String(server.port))
  await form.getByTestId('host-auth-password').check()
  await form.getByTestId('host-password').fill('pw')
  await form.getByTestId('host-save').click()
  await expect(form).toHaveCount(0)
  await expect(hostRow(page, 'inherits')).toContainText(`deploy@127.0.0.1:${server.port}`)

  await hostRow(page, 'inherits').dblclick()
  await page.getByTestId('hostkey-accept').click()
  const tab = await page.evaluate(() => window.__shellhouseTest.activeTabId())
  await waitForText(page, tab ?? '', 'welcome to test server')
  expect(server.events.authAttempts.some((a) => a.username === 'deploy')).toBe(true)
  await expect(page.locator(`[data-testid="tab"][data-tab-id="${tab}"]`)).toHaveAttribute(
    'data-env-color',
    'red'
  )
  await expect(page.getByTestId('session-group-path').last()).toHaveText('Production')

  // Form nhóm hiện đúng giá trị mặc định đã lưu.
  await groupRow(page, 'Production').click({ button: 'right' })
  await page.getByTestId('menu-edit').click()
  await expect(page.getByTestId('group-default-username')).toHaveValue('deploy')
  await expect(page.getByTestId('group-color-red')).toHaveAttribute('aria-checked', 'true')
})

test('menu chuột phải: yêu thích, copy lệnh ssh, nhân bản, mở SFTP; mục Recent', async ({
  app,
  page
}) => {
  server = await startTestSshServer([{ username: 'u', password: 'pw' }])
  await saveHost(page, 'web', { port: server.port })
  const menu = page.getByTestId('context-menu')

  await hostRow(page, 'web').click({ button: 'right' })
  await expect(menu).toBeVisible()
  // Bàn phím: mũi tên + Esc.
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)

  await hostRow(page, 'web').click({ button: 'right' })
  await page.getByTestId('menu-favorite').click()
  await expect(page.locator('[data-testid="favorite-row"][data-host-label="web"]')).toBeVisible()

  await hostRow(page, 'web').click({ button: 'right' })
  await page.getByTestId('menu-copy-ssh').click()
  await expect
    .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
    .toBe(`ssh -p ${server.port} u@127.0.0.1`)

  await hostRow(page, 'web').click({ button: 'right' })
  await page.getByTestId('menu-duplicate').click()
  await expect(hostRow(page, 'web (copy)')).toBeVisible()

  await hostRow(page, 'web').click({ button: 'right' })
  await page.getByTestId('menu-sftp').click()
  await page.getByTestId('hostkey-accept').click()
  await expect(page.getByTestId('sftp-panel')).toBeVisible()
  await expect(page.locator('[data-testid="recent-row"][data-host-label="web"]')).toBeVisible()
})

test('chọn nhiều (Ctrl / Shift): chuyển nhóm, gắn tag, xoá hàng loạt', async ({ page }) => {
  const g = await saveGroup(page, 'Target')
  for (const l of ['alpha', 'bravo', 'charlie', 'delta']) await saveHost(page, l)

  await hostRow(page, 'alpha').click()
  await hostRow(page, 'charlie').click({ modifiers: ['Shift'] }) // dải alpha → charlie
  await expect(page.getByTestId('selection-bar')).toContainText('3 selected')
  await hostRow(page, 'bravo').click({ modifiers: ['ControlOrMeta'] }) // bỏ chọn một mục
  await expect(page.getByTestId('selection-bar')).toContainText('2 selected')
  await hostRow(page, 'bravo').click({ modifiers: ['ControlOrMeta'] })
  await expect(page.getByTestId('selection-bar')).toContainText('3 selected')

  await page.getByTestId('selection-tags').click()
  await page.getByTestId('tags-add').fill('bulk, web')
  await page.getByTestId('tags-ok').click()
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.shellhouse.hostTree())).hosts
        .filter((h) => h.tags.includes('bulk'))
        .map((h) => h.label)
        .sort()
    )
    .toEqual(['alpha', 'bravo', 'charlie'])

  await page.getByTestId('selection-move').click()
  await page.getByTestId('move-target').selectOption(g)
  await page.getByTestId('move-ok').click()
  await expect(groupRow(page, 'Target').getByTestId('group-count')).toHaveText('3')

  // Vùng chọn vẫn giữ sau khi chuyển → Delete xoá cả 3 (có xác nhận).
  await hostRow(page, 'alpha').focus()
  await page.keyboard.press('Delete')
  await expect(page.getByTestId('confirm-dialog')).toContainText('Delete 3 hosts?')
  await page.getByTestId('confirm-ok').click()
  await expect(page.getByTestId('host-row')).toHaveCount(1)
  await expect(hostRow(page, 'delta')).toBeVisible()
})

test('kéo thả để sắp xếp host thủ công', async ({ page }) => {
  for (const l of ['alpha', 'bravo', 'charlie']) await saveHost(page, l)
  const order = (): Promise<(string | null)[]> =>
    page
      .getByTestId('ungrouped')
      .getByTestId('host-row')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-host-label')))
  await expect.poll(order).toEqual(['alpha', 'bravo', 'charlie'])
  await hostRow(page, 'charlie').dragTo(hostRow(page, 'alpha'), {
    targetPosition: { x: 40, y: 3 }
  })
  await expect.poll(order).toEqual(['charlie', 'alpha', 'bravo'])
  await hostRow(page, 'charlie').dragTo(hostRow(page, 'bravo'), {
    targetPosition: { x: 40, y: 30 }
  })
  await expect.poll(order).toEqual(['alpha', 'bravo', 'charlie'])
})

test('MultiExec: mọi terminal xếp đều trên một màn hình, chọn ô nhận lệnh, thoát trả về tab', async ({
  page
}) => {
  server = await startTestSshServer([{ username: 'u', password: 'pw' }])
  const g = await saveGroup(page, 'Cluster')
  await saveHost(page, 'node-1', { groupId: g, port: server.port })
  await saveHost(page, 'node-2', { groupId: g, port: server.port })
  const localTab = await page.evaluate(() => window.__shellhouseTest.activeTabId())

  // Mở cả nhóm vào MultiExec: lưới gồm MỌI terminal (kể cả tab local), chỉ 2 host mới nhận lệnh.
  await groupRow(page, 'Cluster').click({ button: 'right' })
  await page.getByTestId('menu-open-multiexec').click()
  const grid = page.getByTestId('multiexec')
  await expect(grid).toBeVisible()
  await expect(grid.getByTestId('multiexec-cell')).toHaveCount(3)
  await expect(page.getByTestId('multiexec-summary')).toHaveText('Typing goes to 2 of 3 terminals')
  // Host key được xác nhận ngay trong ô lưới, không phải thoát ra.
  await acceptHostKeys(page, 2)
  const nodes = await page.evaluate(() => window.__shellhouseTest.tabIds().slice(-2))
  for (const id of nodes) await waitForText(page, id, 'welcome to test server')

  // Các ô chia đều màn hình.
  const boxes = await grid
    .getByTestId('multiexec-cell')
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width))
  expect(Math.max(...boxes) - Math.min(...boxes)).toBeLessThan(2)

  const cell = (id: string): Locator =>
    page.locator(`[data-testid="multiexec-cell"][data-tab-id="${id}"]`)
  await cell(nodes[0] ?? '').click()
  await page.keyboard.type('echo cung-luc\r')
  for (const id of nodes) await waitForText(page, id, 'cung-luc')
  expect(
    await page.evaluate((id) => window.__shellhouseTest.bufferText(id), localTab ?? '')
  ).not.toContain('cung-luc')

  // Bỏ chọn node-2 → chỉ node-1 nhận.
  await cell(nodes[1] ?? '')
    .getByTestId('multiexec-toggle')
    .uncheck()
  await expect(page.getByTestId('multiexec-summary')).toHaveText('Typing goes to 1 of 3 terminals')
  await cell(nodes[0] ?? '').click()
  await page.keyboard.type('echo chi-mot\r')
  await waitForText(page, nodes[0] ?? '', 'chi-mot')
  await page.waitForTimeout(500)
  expect(
    await page.evaluate((id) => window.__shellhouseTest.bufferText(id), nodes[1] ?? '')
  ).not.toContain('chi-mot')

  // Thoát: terminal về lại tab của nó, phiên vẫn sống (không kết nối lại).
  await page.getByTestId('multiexec-exit').click()
  await expect(grid).toHaveCount(0)
  for (const id of nodes)
    await expect(page.locator(`[data-testid="terminal-${id}"] .xterm`)).toHaveCount(1)
  expect(server.events.authAttempts.filter((a) => a.method === 'password')).toHaveLength(2)

  // Nút trên thanh công cụ: bật MultiExec với tất cả terminal được chọn.
  await page.getByTestId('toggle-broadcast').click()
  await expect(page.getByTestId('multiexec-summary')).toHaveText('Typing goes to 3 of 3 terminals')
  await page.getByTestId('toggle-broadcast').click()
  await expect(grid).toHaveCount(0)
})
