import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test as base } from '@playwright/test'
import { expectHostAddress, launchApp, type LaunchedApp } from './fixtures'

/**
 * Host Remote Desktop: tạo bằng form, hiện trên thanh bên với icon riêng, Connect mở client RDP.
 * Client được thay bằng bản giả (SHELLHOUSE_TEST_RDP=stub): main ghi kế hoạch chạy ra file thay vì
 * mở mstsc / FreeRDP thật.
 */
const test = base.extend<{ launched: LaunchedApp }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright bắt buộc destructuring fixture
  launched: async ({}, use) => {
    const launched = await launchApp({ SHELLHOUSE_TEST_RDP: 'stub' })
    await use(launched)
    await launched.close()
  }
})

test('host RDP: form, thanh bên, kết nối bằng client ngoài, Disconnect', async ({ launched }) => {
  const { page, userData } = launched
  await page.getByTestId('add-host').click()
  const form = page.getByTestId('host-form')
  await form.getByTestId('host-protocol-rdp').click()
  await expect(form.getByTestId('rdp-fields')).toBeVisible()
  await form.getByTestId('host-hostname').fill('10.0.0.5')
  await expect(form.getByTestId('host-port')).toHaveAttribute('placeholder', '3389')
  await form.getByTestId('host-username').fill('CORP\\john')
  await form.getByTestId('host-password').fill('Secr3t!')
  await form.getByTestId('host-label').fill('win-server')
  await form.getByTestId('rdp-open-native').click()
  await form.getByTestId('rdp-display-full').click()
  await form.getByTestId('rdp-drives').check()
  await form.getByTestId('host-save').click()
  await expect(form).toHaveCount(0)

  const row = page.locator('[data-testid="host-row"][data-host-label="win-server"]')
  await expectHostAddress(row, 'rdp john@10.0.0.5')
  await expect(row.getByTestId('rdp-avatar')).toBeVisible()

  // Sửa lại: form mở đúng tab RDP, domain đã tách từ CORP\john.
  await row.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Edit…' }).click()
  await expect(form.getByTestId('host-protocol-rdp')).toHaveAttribute('aria-checked', 'true')
  await expect(form.getByTestId('rdp-domain')).toHaveValue('CORP')
  await expect(form.getByTestId('host-username')).toHaveValue('john')
  await form.getByRole('button', { name: 'Cancel' }).click()

  await row.dblclick()
  const card = page.getByTestId('rdp-connection')
  await expect(card).toHaveAttribute('data-phase', 'running')
  await expect(card.getByTestId('rdp-status')).toHaveText('Connected via test-rdp')
  const record = join(userData, 'rdp-test-launch.json')
  await expect.poll(() => existsSync(record)).toBe(true)
  const plan = JSON.parse(readFileSync(record, 'utf8')) as Record<string, unknown>
  expect(plan).toMatchObject({
    host: '10.0.0.5',
    port: 3389,
    username: 'john',
    domain: 'CORP',
    fullScreen: true,
    passwordProvided: true
  })
  // Mật khẩu không bao giờ nằm trong file .rdp.
  expect(String(plan['rdpFile'])).toContain('drivestoredirect:s:*')
  expect(String(plan['rdpFile'])).not.toContain('Secr3t!')

  await card.getByTestId('rdp-disconnect').click()
  await expect(card).toHaveCount(0)
})
