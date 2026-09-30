import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startS3TestServer, type S3TestServer } from '../integration/s3-test-server'
import { expect, test } from './fixtures'

let server: S3TestServer | null = null
test.afterEach(async () => {
  await server?.close()
  server = null
})

test('trình quản lý S3: thêm tài khoản, duyệt bucket, thư mục, tải lên / về, link chia sẻ, đổi tên, copy, thống kê, xoá', async ({
  app,
  page
}) => {
  server = await startS3TestServer(['demo'])
  const local = mkdtempSync(join(tmpdir(), 'sh-s3-local-'))
  try {
    writeFileSync(join(local, 'bao-cao.txt'), 'nội dung báo cáo')

    // Thêm tài khoản (secret không bao giờ quay về renderer).
    await page.getByTestId('s3-add-account').click()
    const form = page.getByTestId('s3-account-form')
    await form.getByTestId('s3-account-name').fill('MinIO test')
    await form.getByTestId('s3-account-endpoint').fill(server.endpoint)
    await form.getByTestId('s3-account-key').fill(server.accessKeyId)
    await form.getByTestId('s3-account-secret').fill(server.secretAccessKey)
    await form.getByTestId('s3-account-path-style').check()
    await form.getByTestId('s3-account-save').click()
    const account = page.locator('[data-testid="s3-account"][data-name="MinIO test"]')
    await expect(account).toBeVisible()
    const accounts = await page.evaluate(() => window.shellhouse.s3Accounts())
    // Renderer chỉ biết "đã có secret", không bao giờ nhận secret.
    expect(Object.keys(accounts[0] ?? {}).sort()).toEqual([
      'accessKeyId',
      'endpoint',
      'forcePathStyle',
      'hasSecret',
      'id',
      'name',
      'region'
    ])
    expect(accounts[0]).toMatchObject({ hasSecret: true })

    // Mở tab S3, chọn bucket.
    await account.dblclick()
    const view = page.getByTestId('s3-view')
    await expect(page.getByTestId('tab').last()).toContainText('MinIO test')
    await view.locator('[data-testid="s3-bucket"][data-name="demo"]').click()
    await expect(view.getByTestId('s3-path')).toContainText('demo')

    // Thư mục mới, vào trong, tải file lên.
    await view.getByTestId('s3-mkdir').click()
    await page.getByTestId('s3-dialog-input').fill('reports')
    await page.getByTestId('s3-dialog-submit').click()
    const folder = view.locator('[data-testid="s3-entry"][data-name="reports"]')
    await expect(folder).toBeVisible()
    await folder.dblclick()
    await expect(view.getByTestId('s3-path')).toContainText('reports')
    await app.evaluate(
      ({ dialog }, f) => {
        dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [f] })
      },
      join(local, 'bao-cao.txt')
    )
    await view.getByTestId('s3-upload').click()
    const file = view.locator('[data-testid="s3-entry"][data-name="bao-cao.txt"]')
    await expect(file).toBeVisible()

    // Link chia sẻ tải được mà không cần khoá.
    await file.click()
    await view.getByTestId('s3-link').click()
    await page.getByTestId('s3-dialog-submit').click()
    const url = await page.getByTestId('s3-link-url').inputValue()
    expect(await (await fetch(url)).text()).toBe('nội dung báo cáo')
    await page.keyboard.press('Escape')

    // Tải về.
    const saved = join(local, 'tai-ve.txt')
    await app.evaluate(({ dialog }, f) => {
      dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: f })
    }, saved)
    await file.click()
    await view.getByTestId('s3-download').click()
    await expect
      .poll(() => (existsSync(saved) ? readFileSync(saved, 'utf8') : ''))
      .toBe('nội dung báo cáo')

    // Đổi tên (F2), rồi copy ra gốc bucket (copy trên server).
    await file.click()
    await page.keyboard.press('F2')
    await page.getByTestId('s3-dialog-input').fill('bao-cao-2024.txt')
    await page.getByTestId('s3-dialog-submit').click()
    const renamed = view.locator('[data-testid="s3-entry"][data-name="bao-cao-2024.txt"]')
    await expect(renamed).toBeVisible()
    await expect(file).toHaveCount(0)
    await renamed.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Copy to…' }).click()
    await page.getByTestId('s3-copy-prefix').fill('')
    await page.getByTestId('s3-dialog-submit').click()
    await expect(page.getByTestId('s3-dialog')).toHaveCount(0)
    await page.locator('[data-testid="s3-path"] button').first().click()
    await expect(
      view.locator('[data-testid="s3-entry"][data-name="bao-cao-2024.txt"]')
    ).toBeVisible()

    // Thống kê bucket: 2 object (bản trong reports/ + bản ở gốc).
    await view.getByTestId('s3-bucket-stats').click()
    const row = page.locator('[data-testid="s3-stats-row"][data-name="demo"]')
    await expect(row).toHaveAttribute('data-state', 'done')
    await expect(row.getByTestId('s3-stats-objects')).toHaveText('2')
    await expect(row.getByTestId('s3-stats-size')).toHaveText(
      `${2 * Buffer.byteLength('nội dung báo cáo')} B`
    )
    await page.keyboard.press('Escape')

    // Xoá cả thư mục từ gốc bucket.
    await folder.click()
    await view.getByTestId('s3-delete').click()
    await page.getByTestId('s3-dialog-submit').click()
    await expect(folder).toHaveCount(0)
  } finally {
    rmSync(local, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
