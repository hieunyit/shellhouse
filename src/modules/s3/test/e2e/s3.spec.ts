import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startS3TestServer, type S3TestServer } from '../s3-test-server'
import {
  activeTab,
  expect,
  expectActiveTab,
  openArea,
  test,
  waitForText
} from '../../../../../test/e2e/fixtures'

let server: S3TestServer | null = null
test.afterEach(async () => {
  await server?.close()
  server = null
})

test('S3 internal TLS: add a CA and reconnect an existing failed tab with verification enabled', async ({
  page
}) => {
  const { createServer } = await import('node:https')
  const fixtures = join(process.cwd(), 'src/modules/docker/test/fixtures')
  const ca = readFileSync(join(fixtures, 'ca.pem'), 'utf8')
  const endpoint = createServer(
    {
      key: readFileSync(join(fixtures, 'server-key.pem')),
      cert: readFileSync(join(fixtures, 'server.pem'))
    },
    (_request, response) => {
      response.setHeader('content-type', 'application/xml')
      response.end(
        '<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Buckets><Bucket><Name>private-minio</Name></Bucket></Buckets></ListAllMyBucketsResult>'
      )
    }
  )
  await new Promise<void>((resolve) => {
    endpoint.listen(0, '127.0.0.1', resolve)
  })
  try {
    await openArea(page, 's3')
    await page.getByTestId('s3-add-account').click()
    const form = page.getByTestId('s3-account-form')
    await form.getByTestId('s3-account-name').fill('Internal MinIO')
    await form
      .getByTestId('s3-account-endpoint')
      .fill(`https://127.0.0.1:${(endpoint.address() as { port: number }).port}`)
    await form.getByTestId('s3-account-key').fill('test')
    await form.getByTestId('s3-account-secret').fill('test')
    await form.getByTestId('s3-account-save').click()
    const account = page.locator('[data-testid="s3-account"][data-name="Internal MinIO"]')
    await account.dblclick()
    const view = page.getByTestId('s3-view')
    await expect(view.getByTestId('s3-error')).toContainText('CA certificate (PEM)')

    await account.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Edit…', exact: true }).click()
    await form.getByText('Network', { exact: true }).click()
    await form.getByTestId('s3-account-ca').fill(ca)
    await expect(form.getByTestId('s3-account-insecure')).not.toBeChecked()
    await form.getByTestId('s3-account-test').click()
    await expect(form.getByTestId('s3-account-test-result')).toContainText('Connected')
    await form.getByTestId('s3-account-save').click()
    await expect(form).toHaveCount(0)

    await view.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(view.locator('[data-testid="s3-bucket"][data-name="private-minio"]')).toBeVisible()
    await expect(view.getByTestId('s3-error')).toHaveCount(0)
    await account.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Edit…', exact: true }).click()
    await expect(form.getByTestId('s3-account-ca')).toHaveValue(ca.trim())
    await expect(form.getByTestId('s3-account-insecure')).not.toBeChecked()
  } finally {
    endpoint.closeAllConnections()
    await new Promise<void>((resolve) => {
      endpoint.close(() => {
        resolve()
      })
    })
  }
})

test('S3: copy checks show progress and can be stopped while browsing', async ({ page }) => {
  const { createServer, request } = await import('node:http')
  const { S3Client, PutObjectCommand, ListObjectsV2Command } = await import('@aws-sdk/client-s3')
  server = await startS3TestServer(['demo'])
  const upstream = server.endpoint
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const proxy = createServer((incoming, response) => {
    const forward = (): void => {
      if (response.destroyed) return
      const target = request(
        new URL(incoming.url ?? '/', upstream),
        { method: incoming.method, headers: incoming.headers },
        (out) => {
          response.writeHead(out.statusCode ?? 502, out.headers)
          out.pipe(response)
        }
      )
      target.on('error', () => {
        if (!response.destroyed) response.writeHead(502).end()
      })
      incoming.pipe(target)
    }
    if (incoming.method === 'HEAD') void gate.then(forward)
    else forward()
  })
  await new Promise<void>((resolve) => {
    proxy.listen(0, '127.0.0.1', resolve)
  })
  const client = new S3Client({
    endpoint: upstream,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: server.accessKeyId, secretAccessKey: server.secretAccessKey }
  })
  try {
    for (const Key of ['a.txt', 'b.txt'])
      await client.send(new PutObjectCommand({ Bucket: 'demo', Key, Body: 'keep source' }))
    await page.evaluate((input) => window.shellhouse.invokeModule('s3', 'save', [input]), {
      name: 'Copy checks',
      endpoint: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`,
      region: 'us-east-1',
      accessKeyId: server.accessKeyId,
      secretAccessKey: server.secretAccessKey,
      forcePathStyle: true
    })
    await openArea(page, 's3')
    await page.locator('[data-testid="s3-account"][data-name="Copy checks"]').dblclick()
    const view = page.getByTestId('s3-view')
    await view.locator('[data-testid="s3-bucket"][data-name="demo"]').dblclick()
    await view.locator('[data-testid="s3-entry"][data-name="a.txt"]').click()
    await view
      .locator('[data-testid="s3-entry"][data-name="b.txt"]')
      .click({ modifiers: ['ControlOrMeta'] })
    await view.getByTestId('s3-copy').click()
    await page.getByTestId('s3-copy-prefix').fill('target/')
    await page.getByTestId('s3-dialog-submit').click()
    await expect(view.getByTestId('s3-job')).toContainText('Checking files: 0 of 2')
    await view.getByTestId('s3-mkdir').click()
    await page.getByTestId('s3-dialog-input').fill('while-checking')
    await page.getByTestId('s3-dialog-submit').click()
    await expect(view.locator('[data-testid="s3-entry"][data-name="while-checking"]')).toBeVisible()
    await view.getByTestId('s3-job-stop').click()
    await expect(view.getByTestId('s3-job')).toHaveCount(0)
    await openArea(page, 'transfers')
    const stopped = page.locator('[data-testid="transfers-center-row"][data-operation="copy"]')
    await expect(stopped).toHaveAttribute('data-state', 'cancelled')
    await expect(stopped).toContainText('0 of 2 objects')
    await openArea(page, 's3')
    await page
      .locator('[data-testid="tab"]')
      .filter({ hasText: 'demo' })
      .getByTestId('tab-close')
      .click()
    await openArea(page, 'transfers')
    await expect(stopped).toHaveCount(1)
    await page.reload()
    await openArea(page, 'transfers')
    await expect(stopped).toHaveCount(1)
    await expect(stopped).toHaveAttribute('data-state', 'cancelled')
    await page.getByTestId('transfers-clear-finished').click()
    await expect(stopped).toHaveCount(0)
    await expect
      .poll(
        async () =>
          await page.evaluate(() => window.shellhouse.invokeModule('s3', 'taskHistory', []))
      )
      .toEqual([])
    expect(
      (await client.send(new ListObjectsV2Command({ Bucket: 'demo', Prefix: 'target/' })))
        .Contents ?? []
    ).toHaveLength(0)
    expect(
      (await client.send(new ListObjectsV2Command({ Bucket: 'demo' }))).Contents?.map((o) => o.Key)
    ).toEqual(['a.txt', 'b.txt', 'while-checking/'])
  } finally {
    release?.()
    client.destroy()
    proxy.closeAllConnections()
    await new Promise<void>((resolve) => {
      proxy.close(() => {
        resolve()
      })
    })
  }
})

test('S3: multiple background syncs allow browsing and stopping one task without stopping another', async ({
  page
}) => {
  test.setTimeout(60_000)
  const { createServer, request } = await import('node:http')
  const { S3Client, PutObjectCommand, GetObjectCommand } = await import('@aws-sdk/client-s3')
  server = await startS3TestServer(['src', 'dst'])
  const upstream = server.endpoint
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let pendingCopies = 0
  const proxy = createServer((incoming, response) => {
    const forward = (): void => {
      if (response.destroyed) return
      const target = request(
        new URL(incoming.url ?? '/', upstream),
        { method: incoming.method, headers: incoming.headers },
        (out) => {
          response.writeHead(out.statusCode ?? 502, out.headers)
          out.pipe(response)
        }
      )
      target.on('error', () => {
        if (!response.destroyed) response.writeHead(502).end()
      })
      incoming.pipe(target)
    }
    if (incoming.headers['x-amz-copy-source']) {
      pendingCopies++
      void gate.then(forward)
    } else forward()
  })
  await new Promise<void>((resolve) => {
    proxy.listen(0, '127.0.0.1', resolve)
  })
  const address = proxy.address() as { port: number }
  const client = new S3Client({
    endpoint: upstream,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: server.accessKeyId, secretAccessKey: server.secretAccessKey }
  })
  try {
    await client.send(new PutObjectCommand({ Bucket: 'src', Key: 'data.txt', Body: 'background' }))
    const saved = await page.evaluate(
      (input) => window.shellhouse.invokeModule('s3', 'save', [input]),
      {
        name: 'Background',
        endpoint: `http://127.0.0.1:${address.port}`,
        region: 'us-east-1',
        accessKeyId: server.accessKeyId,
        secretAccessKey: server.secretAccessKey,
        forcePathStyle: true
      }
    )
    expect(saved).toMatchObject({ ok: true })
    await openArea(page, 's3')
    await page.locator('[data-testid="s3-account"][data-name="Background"]').dblclick()
    const view = page.getByTestId('s3-view')
    await view.locator('[data-testid="s3-bucket"][data-name="src"]').click()
    for (const prefix of ['first/', 'second/']) {
      await view.getByTestId('s3-sync-bucket').click()
      const dialog = page.getByTestId('s3-sync-dialog')
      await dialog.getByTestId('s3-sync-bucket').fill('dst')
      await dialog.getByTestId('s3-sync-prefix').fill(prefix)
      await dialog.getByTestId('s3-sync-start').click()
      await expect.poll(() => pendingCopies).toBe(prefix === 'first/' ? 1 : 2)
      await dialog.getByTestId('s3-sync-background').click()
      await expect(dialog).toHaveCount(0)
    }
    await expect(view.getByTestId('s3-sync-task')).toHaveCount(2)
    // An unrelated write succeeds while both copies are held by the proxy.
    await view.locator('[data-testid="s3-bucket"][data-name="src"]').dblclick()
    await view.getByTestId('s3-mkdir').click()
    await page.getByTestId('s3-dialog-input').fill('while-syncing')
    await page.getByTestId('s3-dialog-submit').click()
    await expect(view.locator('[data-testid="s3-entry"][data-name="while-syncing"]')).toBeVisible()
    await view.getByTestId('s3-sync-task').first().click()
    const first = page.getByTestId('s3-sync-dialog')
    await first.getByTestId('s3-sync-stop').click()
    await expect(first.getByTestId('s3-sync-progress')).toHaveAttribute('data-phase', 'stopped')
    await first.getByText('Close', { exact: true }).click()
    release?.()
    await view.getByTestId('s3-sync-task').click()
    await expect(page.getByTestId('s3-sync-result')).toContainText('In sync: 1 copied')
    const result = await client.send(
      new GetObjectCommand({ Bucket: 'dst', Key: 'second/data.txt' })
    )
    expect(await result.Body?.transformToString()).toBe('background')
    await page.getByTestId('s3-sync-dialog').getByText('Close', { exact: true }).click()
    await openArea(page, 'transfers')
    const history = page.locator('[data-testid="transfers-center-row"][data-operation="sync"]')
    await expect(history).toHaveCount(2)
    await expect(history.filter({ hasText: 'Stopped' })).toHaveAttribute('data-state', 'cancelled')
    await expect(history.filter({ hasText: 'Completed' })).toHaveAttribute('data-state', 'done')
    await expect(
      client.send(new GetObjectCommand({ Bucket: 'dst', Key: 'first/data.txt' }))
    ).rejects.toThrow()
  } finally {
    release?.()
    client.destroy()
    proxy.closeAllConnections()
    await new Promise<void>((resolve) => {
      proxy.close(() => {
        resolve()
      })
    })
  }
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
    await openArea(page, 's3')
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
      'caPem',
      'direct',
      'endpoint',
      'forcePathStyle',
      'hasSecret',
      'id',
      'insecureTls',
      'name',
      'pins',
      'region'
    ])
    expect(accounts[0]).toMatchObject({ hasSecret: true })

    // Mở tab S3 → bảng bucket; bấm đúp để vào bucket, tên tab theo vị trí.
    await account.dblclick()
    const view = page.getByTestId('s3-view')
    await expectActiveTab(page, 'MinIO test')
    await view.locator('[data-testid="s3-bucket"][data-name="demo"]').dblclick()
    await expect(view.getByTestId('s3-crumb-bucket')).toHaveText('demo')
    await expectActiveTab(page, 'demo')

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
    await expect(page.getByTestId('s3-view')).toHaveCount(2)
    const pinnedView = page.getByTestId('s3-view').last()
    await expect(
      pinnedView.locator('[data-testid="s3-entry"][data-name="bao-cao-2024.txt"]')
    ).toBeVisible()
    await expectActiveTab(page, 'demo/reports')
    await page.getByTestId('tab').last().getByTestId('tab-close').click()
    await expect(page.getByTestId('s3-view')).toHaveCount(1)

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

    await openArea(page, 's3')
    await page.getByTestId('s3-add-account').click()
    const form = page.getByTestId('s3-account-form')
    await form.getByTestId('s3-account-name').fill('Sort test')
    await form.getByTestId('s3-account-endpoint').fill(server.endpoint)
    await form.getByTestId('s3-account-key').fill(server.accessKeyId)
    await form.getByTestId('s3-account-secret').fill(server.secretAccessKey)
    await form.getByTestId('s3-account-path-style').check()
    await form.getByTestId('s3-account-save').click()
    const account = page.locator('[data-testid="s3-account"][data-name="Sort test"]')
    // Explorer (thiết kế v0.5): mở tài khoản → danh sách bucket; bấm bucket → tab tại bucket đó.
    await account.getByTestId('s3-account-expand').click()
    const buckets = page.getByTestId('s3-explorer-bucket')
    await expect(buckets).toHaveCount(2)
    await expect(buckets.first()).toHaveAttribute('data-name', 'demo')
    await page.locator('[data-testid="s3-explorer-bucket"][data-name="demo"]').click()
    const view = page.getByTestId('s3-view').last()
    await expect(view.getByTestId('s3-path')).toContainText('demo')
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
    await openArea(page, 's3')
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
    await openArea(page, 's3')
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

test('S3 tự kết nối lại sau khi Session Host chết, giữ vị trí đang xem và tiếp tục thao tác', async ({
  page
}) => {
  const local = await activeTab(page)
  server = await startS3TestServer(['demo'])
  await openArea(page, 's3')
  await page.getByTestId('s3-add-account').click()
  const form = page.getByTestId('s3-account-form')
  await form.getByTestId('s3-account-name').fill('Restart S3')
  await form.getByTestId('s3-account-endpoint').fill(server.endpoint)
  await form.getByTestId('s3-account-key').fill(server.accessKeyId)
  await form.getByTestId('s3-account-secret').fill(server.secretAccessKey)
  await form.getByTestId('s3-account-path-style').check()
  await form.getByTestId('s3-account-save').click()
  await page.locator('[data-testid="s3-account"][data-name="Restart S3"]').dblclick()
  const view = page.getByTestId('s3-view')
  await view.locator('[data-testid="s3-bucket"][data-name="demo"]').dblclick()
  await view.getByTestId('s3-mkdir').click()
  await page.getByTestId('s3-dialog-input').fill('reports')
  await page.getByTestId('s3-dialog-submit').click()
  await view.locator('[data-testid="s3-entry"][data-name="reports"]').dblclick()
  await expect(view.getByTestId('s3-path')).toContainText('reports')
  await page.evaluate(() => window.shellhouse.crashSessionHostForTest())
  await waitForText(page, local, '— new session —')
  await expect(view.getByTestId('s3-mkdir')).toBeEnabled()
  await expect(view.getByTestId('s3-path')).toContainText('reports')
  await view.getByTestId('s3-mkdir').click()
  await page.getByTestId('s3-dialog-input').fill('after-restart')
  await page.getByTestId('s3-dialog-submit').click()
  await expect(view.locator('[data-testid="s3-entry"][data-name="after-restart"]')).toBeVisible()
  await expect(view.getByText('The tab is closed', { exact: true })).toHaveCount(0)
})
