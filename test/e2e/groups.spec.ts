import type { Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures'

const row = (page: Page, name: string): Locator =>
  page.locator(`[data-testid="group-row"][data-group-name="${name}"]`)

async function addSubgroup(page: Page, parent: string, name: string): Promise<void> {
  await row(page, parent).hover()
  await row(page, parent).getByTestId('group-add-subgroup').click()
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
  await row(page, 'Company').getByTestId('group-edit').click()
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
  await row(page, 'Company').getByTestId('group-edit').click()
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
