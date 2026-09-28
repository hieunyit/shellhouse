import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// Ký tự chỉ có trong tiếng Việt (có dấu) — giao diện phải hoàn toàn tiếng Anh.
const VIETNAMESE = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i

/** Chữ đang hiển thị (bỏ nội dung terminal — đó là output của shell, không phải giao diện). */
async function visibleText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const clone = document.body.cloneNode(true) as HTMLElement
    for (const el of clone.querySelectorAll('.xterm')) el.remove()
    const attrs = [...document.querySelectorAll('[placeholder],[title],[aria-label]')]
      .flatMap((el) => ['placeholder', 'title', 'aria-label'].map((a) => el.getAttribute(a) ?? ''))
      .join('\n')
    return `${clone.innerText}\n${attrs}`
  })
}

async function expectEnglish(page: Page, where: string): Promise<void> {
  const text = await visibleText(page)
  const offending = text.split('\n').filter((line) => VIETNAMESE.test(line))
  expect(offending, `Vietnamese text on ${where}`).toEqual([])
}

test('mọi màn hình chính chỉ có tiếng Anh', async ({ page }) => {
  await expectEnglish(page, 'main window')

  await page.getByTestId('add-host').click()
  await expectEnglish(page, 'host form')
  await page.getByTestId('host-auth-password').click()
  await page.getByTestId('host-auth-key').click()
  await expectEnglish(page, 'host form (auth options)')
  await page.keyboard.press('Escape')

  await page.getByTestId('add-group').click()
  await expectEnglish(page, 'group form')
  await page.keyboard.press('Escape')

  await page.getByTestId('import-ssh-config').click()
  await expectEnglish(page, 'import dialog')
  await page.keyboard.press('Escape')

  await page.getByTestId('open-snippets').click()
  await page.getByTestId('snippet-new').click()
  await expectEnglish(page, 'snippets')
  await page.keyboard.press('Escape')

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+P' : 'Control+Shift+P')
  await expect(page.getByTestId('command-palette')).toBeVisible()
  await expectEnglish(page, 'command palette')
  await page.keyboard.press('Escape')

  await page.getByTestId('open-settings').click()
  for (const section of [
    'appearance',
    'terminal',
    'security',
    'keys',
    'shortcuts',
    'updates',
    'diagnostics'
  ]) {
    await page.getByTestId(`settings-nav-${section}`).click()
    if (section === 'diagnostics') await page.getByTestId('run-selfcheck').click()
    await page.waitForTimeout(150)
    await expectEnglish(page, `settings → ${section}`)
  }
  await page.keyboard.press('Escape')

  await page.getByTestId('lock-vault').click()
  await expect(page.getByTestId('vault-gate')).toBeVisible()
  await page.getByTestId('vault-password').fill('wrong-password')
  await page.getByTestId('vault-submit').click()
  await expect(page.getByTestId('vault-error')).toBeVisible()
  await expectEnglish(page, 'lock screen')
})
