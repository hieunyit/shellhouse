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
      'pins',
      'region'
    ])
    expect(accounts[0]).toMatchObject({ hasSecret: true })

    // Mở tab S3 → bảng bucket; bấm đúp để vào bucket, tên tab theo vị trí.
    await account.dblclick()
    const view = page.getByTestId('s3-view')
    await expect(page.getByTestId('tab').last()).toContainText('MinIO test')
    await view.locator('[data-testid="s3-bucket"][data-name="demo"]').dblclick()
    await expect(view.getByTestId('s3-crumb-bucket')).toHaveText('demo')
    await expect(page.getByTestId('tab').last()).toContainText('demo')

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
    await view.getByTestId('s3-crumb-bucket').click()
    await expect(
      view.locator('[data-testid="s3-entry"][data-name="bao-cao-2024.txt"]')
    ).toBeVisible()

    // Ghim thư mục reports lên thanh bên → bấm mục ghim mở tab mới ngay tại đó.
    await folder.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Pin to sidebar' }).click()
    const pin = page.locator('[data-testid="s3-pin"][data-name="demo / reports"]')
    await expect(pin).toBeVisible()
    await pin.click()
    await expect(page.getByTestId('tab')).toHaveCount(3)
    const pinnedView = page.getByTestId('s3-view').last()
    await expect(
      pinnedView.locator('[data-testid="s3-entry"][data-name="bao-cao-2024.txt"]')
    ).toBeVisible()
    await expect(page.getByTestId('tab').last()).toContainText('demo/reports')
    await page.getByTestId('tab').last().getByTestId('tab-close').click()
    await expect(page.getByTestId('tab')).toHaveCount(2)

    // Về bảng bucket (bấm tên tài khoản) → tính dung lượng: 2 object (reports/ + gốc).
    await view.getByTestId('s3-crumb-account').click()
    const row = view.locator('[data-testid="s3-bucket"][data-name="demo"]')
    await row.getByTestId('s3-bucket-calc').click()
    await expect(row.getByTestId('s3-bucket-objects')).toHaveText('2')
    await expect(row.getByTestId('s3-bucket-size')).toHaveText(
      `${2 * Buffer.byteLength('nội dung báo cáo')} B`
    )

    // Bỏ ghim từ thanh bên.
    await pin.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Unpin' }).click()
    await expect(pin).toHaveCount(0)

    // Xoá cả thư mục từ gốc bucket.
    await row.dblclick()
    await folder.click()
    await view.getByTestId('s3-delete').click()
    await page.getByTestId('s3-dialog-submit').click()
    await expect(folder).toHaveCount(0)
  } finally {
    rmSync(local, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
