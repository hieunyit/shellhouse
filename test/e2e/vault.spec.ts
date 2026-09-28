import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test as base } from '@playwright/test'
import { activeTab, E2E_PASSWORD, echoComputed, sendLine, test, waitForText } from './fixtures'

base('lần đầu chạy: tạo master password qua giao diện', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'shellhouse-e2e-'))
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      SHELLHOUSE_TEST_HOOKS: '1',
      SHELLHOUSE_FAST_KDF: '1',
      SHELLHOUSE_USER_DATA: userData
    }
  })
  try {
    const page = await app.firstWindow()
    const gate = page.getByTestId('vault-gate')
    await expect(gate).toHaveAttribute('data-vault-state', 'uninitialized')
    await expect(page.getByTestId('tab')).toHaveCount(0) // app chưa hiện khi chưa mở vault

    await page.getByTestId('vault-password').fill('ngan')
    await page.getByTestId('vault-confirm').fill('ngan')
    await page.getByTestId('vault-submit').click()
    await expect(page.getByTestId('vault-error')).toContainText('at least')

    await page.getByTestId('vault-password').fill('mat-khau-dai-du')
    await page.getByTestId('vault-confirm').fill('khac-nhau-roi')
    await page.getByTestId('vault-submit').click()
    await expect(page.getByTestId('vault-error')).toContainText('do not match')

    await page.getByTestId('vault-password').fill('mat-khau-dai-du')
    await page.getByTestId('vault-confirm').fill('mat-khau-dai-du')
    await page.getByTestId('vault-submit').click()
    await expect(gate).toHaveCount(0)
    await expect(page.getByTestId('tab')).toHaveCount(1)
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true })
  }
})

test('khoá rồi mở lại: sai mật khẩu bị từ chối, terminal vẫn chạy phía dưới', async ({ page }) => {
  const tab = await activeTab(page)
  const before = echoComputed('beforelock')
  await sendLine(page, tab, before.command)
  await waitForText(page, tab, before.expected)

  await page.getByTestId('lock-vault').click()
  const gate = page.getByTestId('vault-gate')
  await expect(gate).toHaveAttribute('data-vault-state', 'locked')

  // Terminal vẫn nhận lệnh trong lúc khoá (session không bị đóng).
  const during = echoComputed('duringlock')
  await sendLine(page, tab, during.command)
  await waitForText(page, tab, during.expected)

  await page.getByTestId('vault-password').fill('sai-mat-khau')
  await page.getByTestId('vault-submit').click()
  await expect(page.getByTestId('vault-error')).toContainText('Wrong master password')
  await expect(page.getByTestId('vault-password')).toHaveValue('')

  await page.getByTestId('vault-password').fill(E2E_PASSWORD)
  await page.getByTestId('vault-submit').click()
  await expect(gate).toHaveCount(0)
  await expect(page.getByTestId('tab')).toHaveCount(1)
  expect(await page.evaluate((id) => window.__shellhouseTest.bufferText(id), tab)).toContain(
    before.expected
  )
})
