import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startS3TestServer, type S3TestServer } from '../s3-test-server'
import { expect, test } from '../../../../../test/e2e/fixtures'

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
    const accounts = (await page.evaluate(() =>
      window.shellhouse.invokeModule('s3', 'accounts', [])
    )) as Record<string, unknown>[]
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

    // Link chia sẻ tải được mà không cần khoá (chọn thời hạn rồi bấm Create link).
    await file.click()
    await view.getByTestId('s3-link').click()
    await page.getByTestId('s3-link-expiry-86400').click()
    await page.getByTestId('s3-link-create').click()
    await expect(page.getByTestId('s3-link-expiry')).toContainText('Expires')
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

    // Sửa ngay trong app: nút Edit → tab editor, Ctrl+S ghi thẳng lên bucket.
    await file.click()
    await view.getByTestId('s3-edit').click()
    const editor = page.getByTestId('editor')
    await expect(editor.getByTestId('editor-path')).toHaveText('s3://demo/reports/bao-cao.txt')
    await expect(editor.locator('.cm-content')).toContainText('nội dung báo cáo')
    await editor.locator('.cm-line').first().click()
    await page.keyboard.press('End')
    await page.keyboard.type(' (đã sửa)')
    await page.keyboard.press('ControlOrMeta+s')
    await expect(editor.getByTestId('editor-state')).toHaveText('Saved')
    expect(await (await fetch(url)).text()).toBe('nội dung báo cáo (đã sửa)')
    await page
      .locator('[data-testid="tab"]')
      .filter({ hasText: 'bao-cao.txt' })
      .getByTestId('tab-close')
      .click()
    await expect(editor).toHaveCount(0)

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
      `${2 * Buffer.byteLength('nội dung báo cáo (đã sửa)')} B`
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

test('sắp xếp: menu Sort (dung lượng, thời gian, đảo chiều), nhớ cho tab sau; cài đặt số luồng', async ({
  app,
  page
}) => {
  server = await startS3TestServer(['demo', 'logs'])
  const local = mkdtempSync(join(tmpdir(), 'sh-s3-sort-'))
  try {
    // Kích thước khác nhau; tên đặt ngược thứ tự dung lượng để thấy rõ khác biệt.
    writeFileSync(join(local, 'a-nho.txt'), 'x'.repeat(10))
    writeFileSync(join(local, 'b-vua.txt'), 'x'.repeat(2000))
    writeFileSync(join(local, 'c-lon.txt'), 'x'.repeat(50_000))

    // Cài đặt số luồng: S3 ở Settings → Modules → S3 storage, SFTP ở Files; đổi rồi đọc lại.
    await page.getByTestId('open-settings').click()
    await page.getByTestId('settings-nav-modules').click()
    await page.getByTestId('module-settings-s3').click()
    await page.getByTestId('setting-s3-requests').selectOption('32')
    await page.getByTestId('settings-nav-files').click()
    await page.getByTestId('setting-sftp-transfers').selectOption('2')
    await expect
      .poll(() => page.evaluate(() => window.shellhouse.getSettings()))
      .toMatchObject({
        files: { sftpTransfers: 2, sftpRequests: 8 },
        modules: { s3: { requests: 32 } }
      })
    await page.keyboard.press('Escape')

    await page.getByTestId('s3-add-account').click()
    const form = page.getByTestId('s3-account-form')
    await form.getByTestId('s3-account-name').fill('Sort test')
    await form.getByTestId('s3-account-endpoint').fill(server.endpoint)
    await form.getByTestId('s3-account-key').fill(server.accessKeyId)
    await form.getByTestId('s3-account-secret').fill(server.secretAccessKey)
    await form.getByTestId('s3-account-path-style').check()
    await form.getByTestId('s3-account-save').click()
    const account = page.locator('[data-testid="s3-account"][data-name="Sort test"]')
    await account.dblclick()
    const view = page.getByTestId('s3-view').last()
    await view.locator('[data-testid="s3-bucket"][data-name="demo"]').dblclick()
    await app.evaluate(
      ({ dialog }, files) => {
        dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: files })
      },
      ['a-nho.txt', 'b-vua.txt', 'c-lon.txt'].map((f) => join(local, f))
    )
    await view.getByTestId('s3-upload').click()
    const names = view.getByTestId('s3-entry')
    await expect(names).toHaveCount(3)
    const order = (): Promise<(string | null)[]> =>
      names.evaluateAll((els) => els.map((e) => e.getAttribute('data-name')))
    await expect.poll(order).toEqual(['a-nho.txt', 'b-vua.txt', 'c-lon.txt'])

    // Size → mặc định lớn trước; đảo chiều → nhỏ trước.
    await view.getByTestId('s3-sort').click()
    await page.getByRole('menuitem', { name: 'Size' }).click()
    await expect.poll(order).toEqual(['c-lon.txt', 'b-vua.txt', 'a-nho.txt'])
    await view.getByTestId('s3-sort').click()
    await page.getByRole('menuitem', { name: 'Smallest first' }).click()
    await expect.poll(order).toEqual(['a-nho.txt', 'b-vua.txt', 'c-lon.txt'])
    // Bấm tiêu đề cột Name → A → Z.
    await view.getByRole('columnheader', { name: 'Name' }).click()
    await view.getByRole('columnheader', { name: 'Name' }).click()
    await expect.poll(order).toEqual(['c-lon.txt', 'b-vua.txt', 'a-nho.txt'])

    // Size lớn trước rồi mở tab mới: vẫn giữ kiểu sắp xếp.
    await view.getByTestId('s3-sort').click()
    await page.getByRole('menuitem', { name: 'Size' }).click()
    await view.getByTestId('s3-sort').click()
    await page.getByRole('menuitem', { name: 'Largest first' }).click()
    await account.dblclick()
    const second = page.getByTestId('s3-view').last()
    await second.locator('[data-testid="s3-bucket"][data-name="demo"]').dblclick()
    await expect
      .poll(() =>
        second
          .getByTestId('s3-entry')
          .evaluateAll((els) => els.map((e) => e.getAttribute('data-name')))
      )
      .toEqual(['c-lon.txt', 'b-vua.txt', 'a-nho.txt'])
  } finally {
    rmSync(local, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('S3: export danh sách bucket (CSV) và đồng bộ sang tài khoản khác (xem trước → chạy)', async ({
  app,
  page
}) => {
  // Nhiều bước + khởi động Electron (runner macOS lần đầu ~25 giây).
  test.setTimeout(60_000)
  const { GetObjectCommand, PutObjectCommand, S3Client } = await import('@aws-sdk/client-s3')
  server = await startS3TestServer(['photos', 'logs'])
  const other = await startS3TestServer(['existing'])
  const out = mkdtempSync(join(tmpdir(), 'sh-s3-export-'))
  const conn = (s: S3TestServer) => ({
    endpoint: s.endpoint,
    region: 'us-east-1',
    accessKeyId: s.accessKeyId,
    secretAccessKey: s.secretAccessKey,
    forcePathStyle: true
  })
  const client = (s: S3TestServer) =>
    new S3Client({
      endpoint: s.endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey }
    })
  const ca = client(server)
  const cb = client(other)
  try {
    await ca.send(new PutObjectCommand({ Bucket: 'photos', Key: 'a.txt', Body: 'aaa' }))
    await ca.send(new PutObjectCommand({ Bucket: 'photos', Key: 'dir/b.txt', Body: 'bbbb' }))
    for (const [name, s] of [
      ['Source', server],
      ['Backup', other]
    ] as const) {
      const r = (await page.evaluate(
        (input) => window.shellhouse.invokeModule('s3', 'save', [input]),
        { name, ...conn(s), secretAccessKey: s.secretAccessKey }
      )) as { ok: boolean }
      expect(r.ok).toBe(true)
    }
    const account = page.locator('[data-testid="s3-account"][data-name="Source"]')
    await account.dblclick()
    const view = page.getByTestId('s3-view')
    await expect(view.locator('[data-testid="s3-bucket"]')).toHaveCount(2)

    // Export: đếm object còn thiếu rồi ghi CSV vào file người dùng chọn.
    const csvPath = join(out, 'buckets.csv')
    await app.evaluate(({ dialog }, f) => {
      dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: f })
    }, csvPath)
    await view.getByTestId('s3-export').click()
    await page.getByTestId('s3-export-submit').click()
    await expect(page.getByTestId('s3-export-done')).toContainText('buckets.csv')
    const csv = readFileSync(csvPath, 'utf8')
    expect(csv.split('\r\n')[0]).toBe(
      '\uFEFFAccount,Bucket,Region,Created,Objects,Size,Size (bytes)'
    )
    expect(csv).toMatch(/\r\nSource,photos,[^,]*,[^,]+,2,7 B,7\r\n/)
    await page.getByRole('button', { name: 'Done' }).click()

    // Đồng bộ photos → tài khoản Backup, bucket mới (tự tạo), xem trước trước khi chạy.
    await view.locator('[data-testid="s3-bucket"][data-name="photos"]').click()
    await view.getByTestId('s3-sync-bucket').click()
    const dialog = page.getByTestId('s3-sync-dialog')
    const backupId = await page.evaluate(async () => {
      const list = (await window.shellhouse.invokeModule('s3', 'accounts', [])) as {
        id: string
        name: string
      }[]
      return list.find((a) => a.name === 'Backup')?.id ?? ''
    })
    await dialog.getByTestId('s3-sync-account').selectOption(backupId)
    await dialog.getByTestId('s3-sync-bucket').fill('photos-backup')
    await expect(dialog).toContainText('This bucket will be created')
    await dialog.getByTestId('s3-sync-preview').click()
    await expect(dialog.getByTestId('s3-sync-plan')).toContainText('2 new')
    await expect(dialog.getByTestId('s3-sync-item')).toHaveCount(2)
    await dialog.getByTestId('s3-sync-run').click()
    await expect(dialog.getByTestId('s3-sync-result')).toContainText('In sync: 2 copied')
    const got = await cb.send(new GetObjectCommand({ Bucket: 'photos-backup', Key: 'dir/b.txt' }))
    expect(await got.Body?.transformToString()).toBe('bbbb')

    // Chạy lại: không còn gì để copy.
    await dialog.getByRole('button', { name: 'Back', exact: true }).click()
    await dialog.getByTestId('s3-sync-preview').click()
    await expect(dialog.getByTestId('s3-sync-run')).toHaveText('Already in sync')
  } finally {
    ca.destroy()
    cb.destroy()
    await other.close()
    rmSync(out, { recursive: true, force: true })
  }
})

test('S3: bảng chi tiết (tag, metadata, địa chỉ), cài đặt bucket (CORS, versioning, lifecycle), thanh đường dẫn sâu', async ({
  page
}) => {
  test.setTimeout(60_000)
  const { HeadObjectCommand, PutObjectCommand, S3Client } = await import('@aws-sdk/client-s3')
  server = await startS3TestServer(['demo'])
  const client = new S3Client({
    endpoint: server.endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: server.accessKeyId, secretAccessKey: server.secretAccessKey }
  })
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: 'demo',
        Key: 'a/b/c/d/e/report.txt',
        Body: 'hello',
        ContentType: 'text/plain'
      })
    )
    const r = (await page.evaluate(
      (input) => window.shellhouse.invokeModule('s3', 'save', [input]),
      {
        name: 'Details test',
        endpoint: server.endpoint,
        region: 'us-east-1',
        accessKeyId: server.accessKeyId,
        secretAccessKey: server.secretAccessKey,
        forcePathStyle: true
      }
    )) as { ok: boolean }
    expect(r.ok).toBe(true)
    await page.locator('[data-testid="s3-account"][data-name="Details test"]').dblclick()
    const view = page.getByTestId('s3-view')
    await view.locator('[data-testid="s3-bucket"][data-name="demo"]').dblclick()

    // Đi sâu 5 cấp: thanh đường dẫn gộp các cấp giữa vào nút "…".
    for (const name of ['a', 'b', 'c', 'd', 'e'])
      await view.locator(`[data-testid="s3-entry"][data-name="${name}"]`).dblclick()
    await expect(view.getByTestId('s3-crumb-more')).toBeVisible()
    await expect(view.getByTestId('s3-crumb')).toHaveCount(3)
    await view.getByTestId('s3-crumb-more').click()
    await page.getByRole('menuitem', { name: 'b' }).click()
    await expect(view.locator('[data-testid="s3-entry"][data-name="c"]')).toBeVisible()
    for (const name of ['c', 'd', 'e'])
      await view.locator(`[data-testid="s3-entry"][data-name="${name}"]`).dblclick()

    // Bảng chi tiết: Space mở, thấy key / kiểu nội dung; sửa tag và metadata.
    const file = view.locator('[data-testid="s3-entry"][data-name="report.txt"]')
    await file.click()
    await page.keyboard.press('Space')
    const details = view.getByTestId('s3-details')
    await expect(details.getByTestId('s3-details-name')).toHaveText('report.txt')
    await expect(details.getByTestId('s3-details-overview')).toContainText('a/b/c/d/e/report.txt')
    await expect(details.getByTestId('s3-details-overview')).toContainText('text/plain')

    await details.getByTestId('s3-details-tags').getByText('Add tag').click()
    const tagRow = details.getByTestId('s3-details-tag-list')
    await tagRow.getByLabel('Key').fill('env')
    await tagRow.getByLabel('Value').fill('prod')
    await details.getByTestId('s3-details-save-tags').click()
    await expect(details.getByTestId('s3-details-save-tags')).toHaveCount(0)

    await details.getByTestId('s3-details-cc').fill('max-age=60')
    await details.getByTestId('s3-details-save-props').click()
    await expect(details.getByTestId('s3-details-save-props')).toHaveCount(0)
    await expect
      .poll(
        async () =>
          (
            await client.send(
              new HeadObjectCommand({ Bucket: 'demo', Key: 'a/b/c/d/e/report.txt' })
            )
          ).CacheControl
      )
      .toBe('max-age=60')
    await expect(details.getByTestId('s3-details-versions')).toContainText(/Versioning/)

    // Cài đặt bucket: CORS ghi được; lifecycle của s3rver không hỗ trợ → báo rõ, không lỗi.
    await view.getByTestId('s3-open-bucket-settings').click()
    const settings = page.getByTestId('s3-bucket-settings')
    await settings.getByTestId('s3-settings-tab-cors').click()
    await settings.getByRole('button', { name: 'Insert example' }).click()
    await settings.getByTestId('s3-cors-save').click()
    await expect(settings.getByTestId('s3-cors-remove')).toBeVisible()
    await settings.getByTestId('s3-settings-tab-lifecycle').click()
    await expect(settings.getByTestId('s3-feature-unavailable')).toHaveText(
      'Not supported by this provider'
    )
    await settings.getByTestId('s3-settings-tab-versioning').click()
    await expect(settings).not.toContainText('Loading…')
    await page.keyboard.press('Escape')
    await expect(settings).toHaveCount(0)
  } finally {
    client.destroy()
  }
})
