import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activeTab, echoComputed, expect, sendLine, test, waitForText } from './fixtures'

/** Mọi file .log trong thư mục (đệ quy). */
function logFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.log'))
    .map((f) => join(dir, f))
}

test('ghi log phiên: bật trong cài đặt → tab mới ghi output ra file văn bản thường', async ({
  page
}) => {
  const dir = mkdtempSync(join(tmpdir(), 'sh-logs-'))
  try {
    await page.getByTestId('open-settings').click()
    await page.getByTestId('settings-nav-files').click()
    await page.getByTestId('setting-logging-mode').selectOption('all')
    await expect(page.getByTestId('logging-warning')).toBeVisible()
    await page.evaluate((d) => window.shellhouse.updateSettings({ logging: { directory: d } }), dir)
    await page.keyboard.press('Escape')

    await page.getByTestId('new-tab').click()
    await expect(page.getByTestId('tab')).toHaveCount(2)
    const tab = await activeTab(page)
    const { command, expected } = echoComputed('logged')
    await sendLine(page, tab, command)
    await waitForText(page, tab, expected)

    await expect.poll(() => logFiles(dir).length).toBe(1)
    const [file] = logFiles(dir)
    if (!file) throw new Error('no log file')
    await expect.poll(() => readFileSync(file, 'utf8')).toContain(expected)
    const text = readFileSync(file, 'utf8')
    expect(text).toMatch(/^=== Shellhouse session log: /)
    expect(text).not.toContain('\x1b[') // không còn mã màu
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})
