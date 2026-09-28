import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { startTestSshServer } from '../integration/ssh-test-server'
import { activeTab, E2E_PASSWORD, expect, launchApp, test, waitForText } from './fixtures'

function allFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? allFiles(path) : [path]
  })
}

test('CSP của bản build chặn script inline', async ({ page }) => {
  const csp = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content')
  expect(csp).toContain("script-src 'self'")
  expect(csp).toContain("object-src 'none'")
  const ran = await page.evaluate(async () => {
    const w = window as unknown as { __inlineRan?: boolean }
    const s = document.createElement('script')
    s.textContent = 'window.__inlineRan = true'
    document.head.appendChild(s)
    await new Promise((r) => setTimeout(r, 100))
    return w.__inlineRan === true
  })
  expect(ran).toBe(false)
})

test('IPC từ cửa sổ không thuộc app bị từ chối', async ({ app }) => {
  // Cửa sổ lạ nạp đúng preload của app nhưng ở origin khác (data:) — mô phỏng nội dung bị chiếm.
  const preload = join(process.cwd(), 'out/preload/index.js')
  const result = await app.evaluate(async ({ BrowserWindow }, preloadPath) => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: preloadPath,
        sandbox: true,
        contextIsolation: true
      }
    })
    await win.loadURL('data:text/html,<p>x</p>')
    const out = (await win.webContents.executeJavaScript(
      `window.shellhouse.getInfo().then(() => 'allowed', (e) => String(e.message))`
    )) as string
    win.destroy()
    return out
  }, preload)
  expect(result).toContain('Forbidden')
})

test('mật khẩu không bao giờ nằm dạng rõ trong log / DB / file dữ liệu', async () => {
  const server = await startTestSshServer([
    { username: 'alice', password: 'mat-khau-ssh' },
    { username: 'bob', password: 'luu-trong-vault' }
  ])
  const launched = await launchApp()
  const { app, page, userData } = launched
  const secrets = [E2E_PASSWORD, 'mat-khau-ssh', 'sai-mat-khau-1', 'luu-trong-vault']
  try {
    // 1) Kết nối nhanh, gõ sai một lần rồi đúng.
    await page.getByTestId('quick-connect').fill(`alice@127.0.0.1:${server.port}`)
    await page.getByTestId('quick-connect').press('Enter')
    const tab = await activeTab(page)
    await page.getByTestId('hostkey-accept').click()
    await page.getByTestId('prompt-input').fill('sai-mat-khau-1')
    await page.getByTestId('prompt-submit').click()
    await expect(page.getByTestId('prompt-dialog')).toHaveAttribute('data-prompt-kind', 'password')
    await page.getByTestId('prompt-input').fill('mat-khau-ssh')
    await page.getByTestId('prompt-submit').click()
    await waitForText(page, tab, 'welcome to test server')

    // 2) Host lưu mật khẩu trong vault, kết nối bằng mật khẩu đã lưu.
    await page.getByTestId('add-host').click()
    const form = page.getByTestId('host-form')
    await form.getByTestId('host-hostname').fill('127.0.0.1')
    await form.getByTestId('host-port').fill(String(server.port))
    await form.getByTestId('host-username').fill('bob')
    await form.getByTestId('host-label').fill('saved')
    await form.getByTestId('host-auth-password').check()
    await form.getByTestId('host-password').fill('luu-trong-vault')
    await form.getByTestId('host-save').click()
    await page.locator('[data-testid="host-row"][data-host-label="saved"]').dblclick()
    await waitForText(page, await activeTab(page), 'welcome to test server')

    // 3) Khoá vault, mở lại sai rồi đúng.
    await page.getByTestId('lock-vault').click()
    await page.getByTestId('vault-password').fill('sai-mat-khau-1')
    await page.getByTestId('vault-submit').click()
    await expect(page.getByTestId('vault-error')).toBeVisible()
    await page.getByTestId('vault-password').fill(E2E_PASSWORD)
    await page.getByTestId('vault-submit').click()
    await expect(page.getByTestId('vault-gate')).toHaveCount(0)
  } finally {
    await app.close()
    await server.close()
  }
  try {
    const files = allFiles(userData)
    expect(files.some((f) => f.endsWith('.log'))).toBe(true)
    expect(files.some((f) => f.endsWith('.db'))).toBe(true)
    const leaks: string[] = []
    for (const file of files) {
      const bytes = readFileSync(file)
      for (const secret of secrets) {
        // Kiểm tra cả UTF-8 lẫn UTF-16LE (Chromium lưu một số chuỗi dạng UTF-16).
        if (bytes.includes(secret) || bytes.includes(Buffer.from(secret, 'utf16le')))
          leaks.push(`${file.slice(userData.length)}: ${secret}`)
      }
    }
    expect(leaks).toEqual([])
  } finally {
    rmSync(userData, { recursive: true, force: true })
  }
})

test('link ngoài: hỏi xác nhận trước khi mở; chỉ http/https', async ({ app, page }) => {
  await app.evaluate(({ dialog, shell }) => {
    const g = globalThis as unknown as { __asked: string[]; __opened: string[]; __answer: number }
    g.__asked = []
    g.__opened = []
    g.__answer = 0
    dialog.showMessageBox = (...args: unknown[]) => {
      const opts = args.at(-1) as { detail?: string }
      g.__asked.push(opts.detail ?? '')
      return Promise.resolve({ response: g.__answer, checkboxChecked: false })
    }
    shell.openExternal = (url: string) => {
      g.__opened.push(url)
      return Promise.resolve()
    }
  })
  const state = (): Promise<{ asked: string[]; opened: string[] }> =>
    app.evaluate(() => {
      const g = globalThis as unknown as { __asked: string[]; __opened: string[] }
      return { asked: [...g.__asked], opened: [...g.__opened] }
    })
  const open = (url: string): Promise<void> =>
    page.evaluate((u) => {
      window.open(u, '_blank', 'noopener')
    }, url)

  await open('https://example.com/huy') // người dùng bấm Cancel
  await expect.poll(async () => (await state()).asked).toEqual(['https://example.com/huy'])
  expect((await state()).opened).toEqual([])

  await app.evaluate(() => {
    ;(globalThis as unknown as { __answer: number }).__answer = 1
  })
  await open('https://example.com/mo')
  await expect.poll(async () => (await state()).opened).toEqual(['https://example.com/mo'])

  await open('file:///etc/passwd')
  await page.waitForTimeout(300)
  expect((await state()).asked).toHaveLength(2) // không hỏi, không mở
  expect((await state()).opened).toEqual(['https://example.com/mo'])
})
