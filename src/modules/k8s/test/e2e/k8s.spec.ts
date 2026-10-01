import { connect } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { activeTab, expect, launchApp, test, waitForText } from '../../../../../test/e2e/fixtures'
import { startApiTestServer, TEST_CA, TOKEN, type ApiTestServer } from '../api-test-server'

async function enableK8s(page: Page): Promise<void> {
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-nav-modules').click()
  await page.getByTestId('module-toggle-k8s').click()
  await expect(page.getByTestId('module-enable-dialog')).toContainText('Reads ~/.kube/')
  await page.getByTestId('module-enable-confirm').click()
  await expect(page.getByTestId('module-toggle-k8s')).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
}

function kubeconfig(server: ApiTestServer): string {
  return `apiVersion: v1
kind: Config
current-context: test
clusters:
- name: fake
  cluster:
    server: ${server.url}
    certificate-authority-data: ${Buffer.from(TEST_CA).toString('base64')}
users:
- name: dev
  user:
    token: ${TOKEN}
contexts:
- name: test
  context:
    cluster: fake
    user: dev
    namespace: shop
`
}

test('Kubernetes: context từ KUBECONFIG, pod sống (watch), mô tả, log, shell, scale, secret, port-forward, chỉ đọc', async () => {
  // Kịch bản dài (nhiều tab, nhiều loại tài nguyên).
  test.setTimeout(90_000)
  const server = await startApiTestServer()
  const dir = mkdtempSync(join(tmpdir(), 'sh-kube-'))
  const file = join(dir, 'config')
  writeFileSync(file, kubeconfig(server))
  const launched = await launchApp({ KUBECONFIG: file })
  const { page } = launched
  try {
    await enableK8s(page)
    const context = page.locator('[data-testid="k8s-context"][data-name="test"]')
    await context.dblclick()
    const view = page.getByTestId('k8s-view')
    // Cửa sổ cố định: số cột hiện được tuỳ độ rộng (cửa sổ mặc định của CI macOS hẹp hơn).
    await page.setViewportSize({ width: 1366, height: 820 })
    const rows = view.getByTestId('k8s-row')
    await expect(rows).toHaveCount(2)
    await expect(view.locator('[data-testid="k8s-row"][data-name="shop/web-2"]')).toContainText(
      'CrashLoopBackOff'
    )

    // Watch: pod mới xuất hiện không cần tải lại.
    server.upsert('pods', {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'web-3', namespace: 'shop' }
    })
    await expect(rows).toHaveCount(3)

    // Tab ẩn: sự kiện được giữ lại, hiện tab thì bảng cập nhật đúng.
    await page.getByTestId('tab').first().click()
    server.upsert('pods', {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'web-4', namespace: 'shop' }
    })
    await page.waitForTimeout(300)
    await page.getByTestId('tab').filter({ hasText: 'test' }).first().click()
    await expect(rows).toHaveCount(4)
    server.remove('pods', 'shop', 'web-4')
    await expect(rows).toHaveCount(3)

    // Mô tả (phím d): tab Overview có container; tab Events có sự kiện liên quan.
    await view.locator('[data-testid="k8s-row"][data-name="shop/web-2"]').click()
    await page.keyboard.press('d')
    const describe = view.getByTestId('k8s-describe')
    // Chi tiết mở → bảng hẹp lại: bỏ bớt cột phụ, Status vẫn hiện đủ chữ.
    await expect(
      view.locator('[data-testid="k8s-row"][data-name="shop/web-2"]').getByText('CrashLoopBackOff')
    ).toBeVisible()
    await expect(describe.getByTestId('k8s-container')).toContainText('CrashLoopBackOff')
    await describe.getByTestId('k8s-detail-tab-events').click()
    await expect(view.getByTestId('k8s-events')).toContainText('BackOff')
    await page.keyboard.press('Escape')
    await expect(describe).toHaveCount(0)
    // Cột CPU / Memory từ metrics-server.
    await expect(view.locator('[data-testid="k8s-row"][data-name="shop/web-1"]')).toContainText(
      '64Mi'
    )

    // Log pod.
    const web1 = view.locator('[data-testid="k8s-row"][data-name="shop/web-1"]')
    await web1.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Logs' }).click()
    await expect(page.getByTestId('k8s-logs')).toContainText('log line 1 from web-1')

    // Shell vào pod → tab terminal (exec qua WebSocket).
    await page.getByTestId('tab').filter({ hasText: 'test' }).first().click()
    await web1.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Open shell' }).click()
    await expect(page.getByTestId('tab').last()).toContainText('web-1/app (shell)')
    const tab = await activeTab(page)
    await waitForText(page, tab, 'exec: sh -c')
    await page.evaluate((id) => {
      window.__shellhouseTest.sendInput(id, 'echo xin-chao\r')
    }, tab)
    await waitForText(page, tab, 'echo xin-chao')

    // Thanh lệnh kiểu k9s: ":deploy" → Deployments; scale bằng phím S; Enter → pod của deployment.
    await page.getByTestId('tab').filter({ hasText: 'test' }).first().click()
    await view.getByTestId('k8s-filter').fill(':deploy')
    await page.keyboard.press('Enter')
    await expect(view.getByTestId('k8s-nav-deployments.apps')).toHaveAttribute(
      'aria-current',
      'true'
    )
    const deploy = view.locator('[data-testid="k8s-row"][data-name="shop/web"]')
    await deploy.click()
    await page.keyboard.press('d')
    await expect(view.getByTestId('k8s-replicas')).toHaveText('2')
    await page.keyboard.press('Shift+S')
    await page.getByTestId('k8s-scale-more').click()
    await page.getByTestId('k8s-scale-apply').click()
    await expect(view.getByTestId('k8s-replicas')).toHaveText('3')
    await page.keyboard.press('Escape')
    await deploy.dblclick()
    await expect(view.getByTestId('k8s-breadcrumb')).toContainText('deployment/web')
    await expect(rows).toHaveCount(2)
    await page.keyboard.press('Escape')
    await expect(view.getByTestId('k8s-breadcrumb')).not.toContainText('deployment/web')

    // Thanh bên: nhóm thu gọn được — chỉ Workloads mở sẵn; lựa chọn được nhớ.
    await expect(view.getByTestId('k8s-nav-secrets')).toHaveCount(0)
    await view.getByTestId('k8s-nav-group-Workloads').click()
    await expect(view.getByTestId('k8s-nav-pods')).toHaveCount(0)
    await view.getByTestId('k8s-nav-group-Workloads').click()
    await expect(view.getByTestId('k8s-nav-pods')).toBeVisible()

    // Bảng phím tắt đầy đủ (phím ?) — thanh dưới chỉ hiện vài phím chính.
    await view.getByTestId('key-hints-all').click()
    await expect(view.getByTestId('key-hints-sheet')).toContainText('Rollout history')
    await page.keyboard.press('Escape')
    await expect(view.getByTestId('key-hints-sheet')).toHaveCount(0)

    // Tổng quan cluster.
    await view.getByTestId('k8s-nav-overview').click()
    await expect(view.getByTestId('k8s-ov-nodes')).toContainText('1/2')

    // Secret: giá trị ẩn, bấm mới hiện.
    await view.getByTestId('k8s-nav-group-Config').click()
    await view.getByTestId('k8s-nav-secrets').click()
    await view.locator('[data-testid="k8s-row"][data-name="shop/db"]').click()
    await page.keyboard.press('d')
    await view.getByTestId('k8s-detail-tab-data').click()
    await expect(view.getByTestId('k8s-secret-keys')).toContainText('password')
    await expect(view.getByTestId('k8s-secret-value')).toHaveCount(0)
    await view.getByTestId('k8s-secret-reveal').first().click()
    await expect(view.getByTestId('k8s-secret-value').first()).toHaveText('s3cr3t')

    // Port-forward tới pod.
    await view.getByTestId('k8s-nav-pods').click()
    await web1.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Forward a port…' }).click()
    await page.getByTestId('k8s-forward-start').click()
    const forward = view.getByTestId('k8s-forward')
    await expect(forward).toContainText('localhost:')
    const port = Number(/localhost:(\d+)/.exec((await forward.textContent()) ?? '')?.[1])
    const reply = await new Promise<string>((resolve, reject) => {
      const c = connect(port, '127.0.0.1')
      c.once('connect', () => c.write('hello'))
      c.once('data', (d) => {
        resolve(d.toString('utf8'))
        c.destroy()
      })
      c.once('error', reject)
    })
    expect(reply).toBe('echo:8080:hello')

    // Namespace khác: chọn thêm "default".
    await view.getByTestId('k8s-namespace').click()
    await view.getByTestId('k8s-ns-default').click()
    await expect(view.getByTestId('k8s-ns-default')).toBeChecked()
    await expect(view.locator('[data-testid="k8s-row"][data-name="default/tool"]')).toBeVisible()

    // Chỉ đọc: không còn thao tác thay đổi.
    await context.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Read-only mode' }).click()
    await expect(view.getByTestId('k8s-read-only')).toBeVisible()
    await web1.click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: /^Delete/ })).toHaveCount(0)
    await page.keyboard.press('Escape')
  } finally {
    await launched.close()
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Kubernetes: import kubeconfig (mã hoá trong vault), context production phải gõ tên để xoá', async () => {
  const server = await startApiTestServer()
  const launched = await launchApp({ KUBECONFIG: join(tmpdir(), 'does-not-exist-kubeconfig') })
  const { page } = launched
  try {
    await enableK8s(page)
    await page.getByTestId('k8s-import').click()
    await page.getByRole('menuitem', { name: 'Paste a kubeconfig…' }).click()
    await page.getByTestId('k8s-import-name').fill('staging')
    await page.getByTestId('k8s-import-yaml').fill(kubeconfig(server))
    await page.getByTestId('k8s-import-save').click()
    const context = page.locator('[data-testid="k8s-context"][data-name="test"]')
    await expect(context).toBeVisible()
    await expect(context).toHaveAttribute('title', /Imported: staging/)

    // Đánh dấu production (đỏ).
    await context.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Context settings…' }).click()
    await page.getByTestId('k8s-color-red').click()
    await page.getByTestId('k8s-context-save').click()

    await context.dblclick()
    const view = page.getByTestId('k8s-view')
    const row = view.locator('[data-testid="k8s-row"][data-name="shop/web-1"]')
    await row.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Delete…' }).click()
    const confirm = page.getByTestId('k8s-delete-confirm')
    await expect(confirm).toBeDisabled()
    await page.getByTestId('k8s-delete-typed').fill('web-1')
    await confirm.click()
    await expect(row).toHaveCount(0)
  } finally {
    await launched.close()
    await server.close()
  }
})

test('Kubernetes: import kubeconfig từ file (chứng chỉ tham chiếu được nhúng), ẩn context', async () => {
  const server = await startApiTestServer()
  const dir = mkdtempSync(join(tmpdir(), 'sh-kube-file-'))
  // Kubeconfig trỏ tới CA bằng đường dẫn tương đối — sau khi import vẫn kết nối được.
  writeFileSync(join(dir, 'ca.crt'), TEST_CA)
  writeFileSync(
    join(dir, 'team.yaml'),
    kubeconfig(server).replace(/certificate-authority-data: .*/, 'certificate-authority: ca.crt')
  )
  const launched = await launchApp({ KUBECONFIG: join(tmpdir(), 'does-not-exist-kubeconfig') })
  const { page, app } = launched
  try {
    await enableK8s(page)
    await app.evaluate(
      ({ dialog }, f) => {
        dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [f] })
      },
      join(dir, 'team.yaml')
    )
    await page.getByTestId('k8s-import').click()
    await page.getByRole('menuitem', { name: 'Import kubeconfig files…' }).click()
    await expect(page.getByTestId('k8s-import-note')).toContainText('Imported 1 file (1 context)')
    rmSync(dir, { recursive: true, force: true })
    const context = page.locator('[data-testid="k8s-context"][data-name="test"]')
    await expect(context).toHaveAttribute('title', /Imported: team/)
    await context.dblclick()
    await expect(page.getByTestId('k8s-view').getByTestId('k8s-row')).toHaveCount(2)

    await context.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Hide from sidebar' }).click()
    await expect(context).toHaveCount(0)
  } finally {
    await launched.close()
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Kubernetes: ~/.kube có file tên tuỳ ý, Refresh đọc file mới, xoá context (sửa file + .bak)', async () => {
  test.setTimeout(60_000)
  const home = mkdtempSync(join(tmpdir(), 'sh-home-'))
  mkdirSync(join(home, '.kube'))
  const yaml = (names: string[]): string => `apiVersion: v1
kind: Config
current-context: ${names[0] ?? ''}
clusters:
${names.map((n) => `- name: ${n}-c\n  cluster: { server: 'https://127.0.0.1:6443' }`).join('\n')}
users:
- name: u
  user: { token: x }
contexts:
${names.map((n) => `- name: ${n}\n  context: { cluster: ${n}-c, user: u }`).join('\n')}
`
  const file = join(home, '.kube', 'console-stg-kubeconfig')
  writeFileSync(file, yaml(['stg', 'old']))
  const launched = await launchApp({ HOME: home, KUBECONFIG: '' })
  const { page } = launched
  try {
    await enableK8s(page)
    const ctx = (name: string) => page.locator(`[data-testid="k8s-context"][data-name="${name}"]`)
    await expect(ctx('stg')).toBeVisible()
    await expect(ctx('old')).toBeVisible()

    // File mới tải về khi app đang mở → Refresh là thấy.
    writeFileSync(join(home, '.kube', 'prod.yaml'), yaml(['prod']))
    await page.getByTestId('k8s-refresh').click()
    await expect(ctx('prod')).toBeVisible()

    // Xoá context không dùng: file được sửa, bản cũ giữ ở .bak.
    await ctx('old').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Delete context…' }).click()
    await expect(page.getByTestId('k8s-delete-context')).toContainText('console-stg-kubeconfig')
    await page.getByTestId('k8s-delete-context-confirm').click()
    await expect(ctx('old')).toHaveCount(0)
    await expect(ctx('stg')).toBeVisible()
    expect(readFileSync(file, 'utf8')).not.toContain('old-c')
    expect(readFileSync(`${file}.bak`, 'utf8')).toContain('name: old')
  } finally {
    await launched.close()
    rmSync(home, { recursive: true, force: true })
  }
})
