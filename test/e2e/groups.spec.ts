import type { Locator, Page } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, setWindowSize, test } from './fixtures'

const row = (page: Page, name: string): Locator =>
  page.locator(`[data-testid="group-row"][data-group-name="${name}"]`)

async function addSubgroup(page: Page, parent: string, name: string): Promise<void> {
  await row(page, parent).hover()
  await row(page, parent).getByTestId('group-more').click()
  await page.getByTestId('menu-add-subgroup').click()
  const form = page.getByTestId('group-form')
  await expect(form).toContainText('New subgroup')
  await form.getByTestId('group-name').fill(name)
  await form.getByTestId('group-save').click()
  await expect(form).toHaveCount(0)
}

test('nhóm lồng nhóm: tạo, đếm đệ quy, kéo thả, thu gọn được nhớ, tìm theo đường dẫn, xoá an toàn', async ({
  page
}) => {
  await page.getByTestId('add-group').click()
  await page.getByTestId('group-name').fill('Company')
  await page.getByTestId('group-save').click()
  await addSubgroup(page, 'Company', 'Prod')
  await addSubgroup(page, 'Prod', 'DB')
  await expect(row(page, 'DB')).toHaveAttribute('data-group-path', 'Company / Prod / DB')

  // Thêm host thẳng vào nhóm DB (nhóm được chọn sẵn trong form).
  await row(page, 'DB').hover()
  await row(page, 'DB').getByTestId('group-add-host').click()
  const form = page.getByTestId('host-form')
  await expect(form.getByTestId('host-group')).toHaveValue(/.+/)
  await form.getByTestId('host-hostname').fill('10.0.0.5')
  await form.getByTestId('host-label').fill('pg-main')
  await form.getByTestId('host-save').click()
  // Thiếu username → thông báo dễ hiểu (không phải thông báo thô của zod).
  await expect(form.getByRole('alert')).toHaveText('Enter a username')
  await form.getByTestId('host-username').fill('postgres')
  await form.getByTestId('host-save').click()
  await expect(form).toHaveCount(0)
  // Số trên nhóm cha tính cả nhóm con cháu.
  await expect(row(page, 'Company').getByTestId('group-count')).toHaveText('1')
  await expect(row(page, 'Prod').getByTestId('group-count')).toHaveText('1')

  // Ô chọn nhóm cha: không chọn được chính nó / nhóm con cháu.
  await row(page, 'Company').hover()
  await row(page, 'Company').getByTestId('group-more').click()
  await page.getByTestId('menu-edit').click()
  const parent = page.getByTestId('group-parent')
  await expect(parent.locator('option', { hasText: 'Company' })).toHaveAttribute('disabled', '')
  await expect(parent.locator('option', { hasText: 'Prod' })).toHaveAttribute('disabled', '')
  await expect(parent.locator('option', { hasText: 'DB' })).toHaveAttribute('disabled', '')
  await page.keyboard.press('Escape')

  // Kéo nhóm DB (cùng host bên trong) lên thẳng Company.
  await row(page, 'DB').dragTo(row(page, 'Company'))
  await expect(row(page, 'DB')).toHaveAttribute('data-group-path', 'Company / DB')
  await expect(row(page, 'Prod').getByTestId('group-count')).toHaveText('0')
  // Không thả được nhóm cha vào nhóm con (không đổi gì).
  await row(page, 'Company').dragTo(row(page, 'DB'))
  await expect(row(page, 'Company')).toHaveAttribute('data-group-path', 'Company')

  // Thu gọn được nhớ qua lần tải lại.
  await row(page, 'Company').getByRole('button', { name: 'Collapse Company' }).click()
  await expect(row(page, 'Prod')).toHaveCount(0)
  await page.reload()
  await expect(row(page, 'Company')).toBeVisible()
  await expect(row(page, 'Prod')).toHaveCount(0)

  // Tìm theo tên nhóm → host hiện kèm đường dẫn nhóm.
  await page.getByTestId('host-search').fill('company pg')
  const hit = page.locator('[data-testid="host-row"][data-host-label="pg-main"]')
  await expect(hit).toContainText('Company / DB')
  await page.getByTestId('host-search').fill('')

  // Xoá Company: nhóm con + host dời ra cấp cao nhất, không mất gì.
  await row(page, 'Company').hover()
  await row(page, 'Company').getByTestId('group-more').click()
  await page.getByTestId('menu-edit').click()
  await page.getByTestId('group-delete').click()
  await expect(page.getByTestId('group-delete-notice')).toContainText(
    '1 host and 2 subgroups move to the top level'
  )
  await page.getByTestId('group-delete-confirm').click()
  await expect(row(page, 'Company')).toHaveCount(0)
  await expect(row(page, 'Prod')).toHaveAttribute('data-group-path', 'Prod')
  await expect(row(page, 'DB')).toHaveAttribute('data-group-path', 'DB')
  await expect(row(page, 'DB').getByTestId('group-count')).toHaveText('1')
})

test('sidebar kéo đổi độ rộng, được nhớ; nhấp đúp về mặc định', async ({ page }) => {
  const sidebar = page.getByTestId('sidebar')
  const handle = page.getByTestId('sidebar-resize')
  const width = async (): Promise<number> => (await sidebar.boundingBox())?.width ?? 0
  const before = await width()
  const box = await handle.boundingBox()
  if (!box) throw new Error('no handle')
  await page.mouse.move(box.x + box.width / 2, box.y + 200)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + 200, { steps: 5 })
  await page.mouse.up()
  await expect.poll(width).toBeGreaterThan(before + 100)
  const widened = await width()
  await page.reload()
  await expect.poll(width).toBe(widened)
  await handle.dblclick()
  await expect.poll(width).toBe(before)
})

test('import directly into root and nested groups keeps the destination and creates no source folders', async ({
  launched,
  page,
  app
}, testInfo) => {
  const ids = await page.evaluate(async () => {
    const parent = await window.shellhouse.saveGroup({ parentId: null, name: 'Import target' })
    if (!parent.ok) throw new Error(parent.message)
    const child = await window.shellhouse.saveGroup({ parentId: parent.id, name: 'Child target' })
    if (!child.ok) throw new Error(child.message)
    return { parent: parent.id, child: child.id }
  })
  const file = join(launched.userData, 'group-import.csv')
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] })
  }, file)
  for (const item of [
    { name: 'Import target', id: ids.parent, label: 'parent-host', direct: true },
    { name: 'Child target', id: ids.child, label: 'child-host', direct: false }
  ]) {
    writeFileSync(
      file,
      `Group,Label,Hostname,Username\nOriginal/Nested,${item.label},${item.label}.example.com,deploy\n`
    )
    await row(page, item.name).hover()
    if (item.direct) {
      await page.mouse.move(700, 400)
      await page.keyboard.press('Tab')
      await row(page, item.name).locator('..').focus()
      await expect(row(page, item.name).getByTestId('group-import')).toBeVisible()
      await page.keyboard.press('Tab')
      await page.keyboard.press('Tab')
      await expect(row(page, item.name).getByTestId('group-import')).toBeFocused()
      await page.keyboard.press('Enter')
    } else {
      await row(page, item.name).getByTestId('group-more').click()
      await page.getByTestId('menu-import').click()
    }
    const dialog = page.getByTestId('import-dialog')
    await expect(dialog.getByTestId('import-option-group')).toHaveValue(item.id)
    await dialog.getByTestId('import-source').selectOption('csv')
    await expect(dialog.getByTestId('import-option-group')).toHaveValue(item.id)
    await dialog.getByTestId('import-choose-file').click()
    await expect(dialog.getByTestId(`import-row-Original\\Nested\\${item.label}`)).toBeVisible()
    await expect(dialog.getByTestId('import-summary')).toContainText('1 host selected')
    // Check the full dialog at a compact window size, including the destination and footer.
    if (!item.direct) await setWindowSize(launched, 720, 600)
    await expect(dialog.getByTestId('import-run')).toBeInViewport()
    const overflows = await dialog.evaluate((el) => el.scrollWidth > el.clientWidth)
    expect(overflows).toBe(false)
    await page.screenshot({
      path: testInfo.outputPath(
        item.direct ? 'group-import-desktop.png' : 'group-import-compact.png'
      )
    })
    await dialog.getByTestId('import-run').click()
    await expect(dialog.getByTestId('import-result')).toContainText('Imported 1 host')
    await dialog.getByRole('button', { name: 'Done' }).click()
    const saved = await page.evaluate(async (label) => {
      const tree = await window.shellhouse.hostTree()
      return {
        groupId: tree.hosts.find((host) => host.label === label)?.groupId,
        names: tree.groups.map((group) => group.name).sort()
      }
    }, item.label)
    expect(saved).toEqual({ groupId: item.id, names: ['Child target', 'Import target'] })
  }
})
