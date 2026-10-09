import { connect } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import {
  activeTab,
  expect,
  expectActiveTab,
  launchApp,
  openArea,
  setWindowSize,
  test,
  waitForText
} from '../../../../../test/e2e/fixtures'
import { startApiTestServer, TEST_CA, TOKEN, type ApiTestServer } from '../api-test-server'
import { hubbleFlow } from '../hubble-flows'

async function enableK8s(page: Page): Promise<void> {
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-nav-modules').click()
  await page.getByTestId('module-toggle-k8s').click()
  await expect(page.getByTestId('module-enable-dialog')).toContainText('Reads ~/.kube/')
  await page.getByTestId('module-enable-confirm').click()
  await expect(page.getByTestId('module-toggle-k8s')).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
  await openArea(page, 'k8s')
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
    await setWindowSize(launched, 1366, 820)
    const rows = view.getByTestId('k8s-row')
    await expect(rows).toHaveCount(2)
    await expect(view.locator('[data-testid="k8s-row"][data-name="shop/web-2"]')).toContainText(
      'CrashLoopBackOff'
    )

    // Watch: pod mới xuất hiện không cần tải lại. Server giả chỉ gửi sự kiện cho watch đang mở →
    // đợi app mở watch pods (sau bước list) rồi mới thêm pod.
    await expect.poll(() => server.requests.some((r) => /\/pods\?.*watch=true/.test(r))).toBe(true)
    server.upsert('pods', {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'web-3', namespace: 'shop' }
    })
    await expect(rows).toHaveCount(3)

    // Tab ẩn: sự kiện được giữ lại, hiện tab thì bảng cập nhật đúng.
    await openArea(page, 'hosts')
    server.upsert('pods', {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'web-4', namespace: 'shop' }
    })
    await page.waitForTimeout(300)
    await openArea(page, 'k8s')
    await expect(rows).toHaveCount(4)
    server.remove('pods', 'shop', 'web-4')
    await expect(rows).toHaveCount(3)

    // Bảng đang watch → "Live"; pod lỗi → "N failing" cạnh Pods; chip
    // Status lọc theo trạng thái.
    await expect(view.getByTestId('k8s-live')).toBeVisible()
    await expect(page.getByTestId('k8s-nav-pods').getByTestId('k8s-nav-failing')).toContainText(
      '1 failing'
    )
    await view.getByTestId('k8s-chip-status').click()
    await page.getByTestId('menu-chip-status-CrashLoopBackOff').click()
    await expect(rows).toHaveCount(1)
    await expect(view.getByTestId('k8s-chip-status')).toContainText('CrashLoopBackOff')
    await view.getByTestId('k8s-chip-status').click()
    await page.getByTestId('menu-chip-status-any').click()
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
    // Kéo mép trái để nới bảng chi tiết (nhớ cho lần sau); thu gọn / hiện thanh điều hướng.
    const before = (await describe.boundingBox())?.width ?? 0
    const handle = (await describe.getByTestId('side-panel-resize').boundingBox()) ?? {
      x: 0,
      y: 0,
      width: 0,
      height: 0
    }
    await page.mouse.move(handle.x + 2, handle.y + 200)
    await page.mouse.down()
    await page.mouse.move(handle.x - 98, handle.y + 200, { steps: 5 })
    await page.mouse.up()
    expect(Math.round(((await describe.boundingBox())?.width ?? 0) - before)).toBe(100)
    // Thanh điều hướng nằm ở Explorer; ẩn Explorer → điều hướng về trong view, thu gọn được.
    await expect(page.getByTestId('explorer').getByTestId('k8s-nav')).toBeVisible()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+B' : 'Control+Shift+B')
    await expect(view.getByTestId('k8s-nav')).toBeVisible()
    await page.getByTestId('k8s-nav-toggle').click()
    await expect(page.getByTestId('k8s-nav')).toHaveCount(0)
    await page.getByTestId('k8s-nav-toggle').click()
    await expect(page.getByTestId('k8s-nav')).toBeVisible()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+B' : 'Control+Shift+B')
    await expect(page.getByTestId('explorer').getByTestId('k8s-nav')).toBeVisible()
    await describe.getByTestId('k8s-detail-tab-events').click()
    await expect(view.getByTestId('k8s-events')).toContainText('BackOff')
    await page.keyboard.press('Escape')
    await expect(describe).toHaveCount(0)
    // Cột CPU / Memory từ metrics-server.
    await expect(view.locator('[data-testid="k8s-row"][data-name="shop/web-1"]')).toContainText(
      '64Mi'
    )

    // Chọn nhiều dòng (ô chọn / Ctrl+A) → thanh thao tác hàng loạt; Esc bỏ chọn.
    // Chọn tất cả = mọi dòng đang hiện.
    const visible = await rows.count()
    await view.getByTestId('k8s-select-all').check()
    await expect(view.getByTestId('k8s-bulk-count')).toContainText(`${String(visible)} selected`)
    await view.getByTestId('k8s-bulk-delete').click()
    await expect(page.getByTestId('k8s-bulk-targets')).toContainText('shop/web-1')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('k8s-bulk-dialog')).toHaveCount(0)
    await view.getByTestId('k8s-bulk-clear').click()
    await expect(view.getByTestId('k8s-bulk-bar')).toHaveCount(0)

    // Log pod.
    const web1 = view.locator('[data-testid="k8s-row"][data-name="shop/web-1"]')
    await web1.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Logs' }).click()
    await expect(page.getByTestId('k8s-logs')).toContainText('log line 1 from web-1')

    // Shell vào pod → tab terminal (exec qua WebSocket).
    await page.getByTestId('tab').filter({ hasText: 'test' }).first().click()
    await web1.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Open shell' }).click()
    await expectActiveTab(page, 'web-1/app (shell)')
    const tab = await activeTab(page)
    await waitForText(page, tab, 'exec: sh -c')
    // Banner tới trước khi phiên báo "connected" → gõ sớm hơn thì chữ có thể chưa tới exec.
    await page.waitForFunction((id) => window.__shellhouseTest.state(id) === 'connected', tab)
    await page.evaluate((id) => {
      window.__shellhouseTest.sendInput(id, 'echo xin-chao\r')
    }, tab)
    await waitForText(page, tab, 'echo xin-chao')

    // Thanh lệnh kiểu k9s: ":deploy" → Deployments; scale bằng phím S; Enter → pod của deployment.
    await openArea(page, 'k8s')
    await view.getByTestId('k8s-filter').fill(':deploy')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('k8s-nav-deployments.apps')).toHaveAttribute(
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
    // Thao tác một phím (r = rollout restart) hỏi trước bằng hộp thoại của app — không chạy ngay.
    await deploy.click()
    await page.keyboard.press('r')
    await expect(page.getByTestId('k8s-confirm')).toContainText('Restart web?')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('k8s-confirm')).toHaveCount(0)
    // Bấm đúp workload → chi tiết ở tab Related (kiểu Rancher): service, pod… liên quan.
    await deploy.dblclick()
    const related = view.getByTestId('k8s-related')
    await expect(
      related.locator('[data-testid="k8s-related-group"][data-group="services"]')
    ).toContainText('ClusterIP · 10.0.0.10')
    await expect(
      related.locator('[data-testid="k8s-related-group"][data-group="pods"]')
    ).toContainText('web-1')
    // "Show in table" → pod của deployment trong bảng chính (breadcrumb, Esc để quay lại).
    await related.getByTestId('k8s-related-show-pods').click()
    await expect(view.getByTestId('k8s-breadcrumb')).toContainText('deployment/web')
    await expect(rows).toHaveCount(2)
    await page.keyboard.press('Escape')
    await expect(view.getByTestId('k8s-breadcrumb')).not.toContainText('deployment/web')
    // Bấm vào service liên quan → sang Services, mở chi tiết của nó.
    await deploy.dblclick()
    await related.locator('[data-testid="k8s-related-item"][data-name="web"]').click()
    await expect(page.getByTestId('k8s-nav-services')).toHaveAttribute('aria-current', 'true')
    await expect(view.getByTestId('k8s-describe')).toContainText('web')
    await page.keyboard.press('Escape')

    // Thanh bên: nhóm thu gọn được — chỉ Workloads mở sẵn; lựa chọn được nhớ.
    await expect(page.getByTestId('k8s-nav-secrets')).toHaveCount(0)
    await page.getByTestId('k8s-nav-group-Workloads').click()
    await expect(page.getByTestId('k8s-nav-pods')).toHaveCount(0)
    await page.getByTestId('k8s-nav-group-Workloads').click()
    await expect(page.getByTestId('k8s-nav-pods')).toBeVisible()

    // Bảng phím tắt đầy đủ (phím ?) — thanh dưới chỉ hiện vài phím chính.
    await view.getByTestId('key-hints-all').click()
    await expect(view.getByTestId('key-hints-sheet')).toContainText('Rollout history')
    await page.keyboard.press('Escape')
    await expect(view.getByTestId('key-hints-sheet')).toHaveCount(0)

    // Số đối tượng cạnh từng loại (như Rancher).
    await expect(
      page.getByTestId('k8s-nav-deployments.apps').getByTestId('k8s-nav-count')
    ).toHaveText('1')

    // Helm releases (đọc Secret của Helm 3) — nhóm Apps.
    const { gzipSync } = await import('node:zlib')
    const record = {
      name: 'shop-db',
      namespace: 'shop',
      version: 3,
      info: {
        status: 'deployed',
        last_deployed: new Date().toISOString(),
        notes: 'Thanks for installing'
      },
      chart: { metadata: { name: 'postgresql', version: '15.1.0', appVersion: '16.4' } },
      config: { auth: { database: 'shop' } },
      manifest: 'kind: StatefulSet'
    }
    server.upsert('secrets', {
      apiVersion: 'v1',
      kind: 'Secret',
      type: 'helm.sh/release.v1',
      metadata: {
        name: 'sh.helm.release.v1.shop-db.v3',
        namespace: 'shop',
        labels: { owner: 'helm', name: 'shop-db', version: '3', status: 'deployed' }
      },
      data: {
        release: Buffer.from(
          gzipSync(Buffer.from(JSON.stringify(record))).toString('base64')
        ).toString('base64')
      }
    })
    await page.getByTestId('k8s-nav-group-Apps').click()
    await page.getByTestId('k8s-nav-helm-releases').click()
    const release = view.locator('[data-testid="k8s-helm-release"][data-name="shop/shop-db"]')
    await expect(release).toContainText('postgresql-15.1.0')
    await expect(release).toContainText('deployed')
    await release.click()
    await expect(view.getByTestId('k8s-helm-detail')).toContainText('Thanks for installing')
    await view.getByTestId('k8s-helm-tab-values').click()
    await expect(view.getByTestId('k8s-helm-detail')).toContainText('database: shop')
    // Chỉ có một revision → không rollback được; gỡ cài đặt hỏi trước (không làm ở đây).
    await expect(view.getByTestId('k8s-helm-rollback')).toBeDisabled()
    await view.getByTestId('k8s-helm-uninstall').click()
    await expect(page.getByTestId('k8s-helm-uninstall-dialog')).toContainText('Uninstall shop-db?')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('k8s-helm-uninstall-dialog')).toHaveCount(0)
    await page.getByTestId('k8s-nav-group-Apps').click()

    // Tổng quan cluster.
    await page.getByTestId('k8s-nav-overview').click()
    await expect(view.getByTestId('k8s-ov-nodes')).toContainText('1/2')
    // Vấn đề theo nhóm: pod crash-loop, node chưa Ready — bấm để mở.
    await expect(view.getByTestId('k8s-ov-problem-failing')).toContainText('web-2')
    await expect(view.getByTestId('k8s-ov-problem-nodes')).toBeVisible()

    // Secret: giá trị ẩn, bấm mới hiện.
    await page.getByTestId('k8s-nav-group-Config').click()
    await page.getByTestId('k8s-nav-secrets').click()
    await view.locator('[data-testid="k8s-row"][data-name="shop/db"]').click()
    await page.keyboard.press('d')
    await view.getByTestId('k8s-detail-tab-data').click()
    await expect(view.getByTestId('k8s-secret-keys')).toContainText('password')
    await expect(view.getByTestId('k8s-secret-value')).toHaveCount(0)
    await view.getByTestId('k8s-secret-reveal').first().click()
    await expect(view.getByTestId('k8s-secret-value').first()).toHaveText('s3cr3t')

    // Port-forward tới pod.
    await page.getByTestId('k8s-nav-pods').click()
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
    await page.getByTestId('k8s-env-prod').click()
    await expect(page.getByTestId('k8s-env-rules')).toContainText('type the name to delete')
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
  // Thư mục nhà giả (SHELLHOUSE_HOME — Windows không đọc HOME, đổi USERPROFILE thì app không chạy).
  const launched = await launchApp({ SHELLHOUSE_HOME: home, KUBECONFIG: '' })
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

test('Kubernetes: Map — ba chế độ, lưới tổng quan namespace (gom theo mục đích / nhãn), mở namespace', async () => {
  test.setTimeout(60_000)
  const server = await startApiTestServer()
  const dir = mkdtempSync(join(tmpdir(), 'sh-kube-'))
  const file = join(dir, 'config')
  writeFileSync(file, kubeconfig(server))
  const launched = await launchApp({ KUBECONFIG: file })
  const { page } = launched
  try {
    await enableK8s(page)
    await page.locator('[data-testid="k8s-context"][data-name="test"]').dblclick()
    const view = page.getByTestId('k8s-view')
    await setWindowSize(launched, 1366, 820)
    await view.getByTestId('k8s-namespace').click()
    await page.getByRole('menuitemradio', { name: 'All namespaces' }).click()
    await page.keyboard.press('Escape')
    await page.getByTestId('k8s-nav-map').click()
    const map = view.getByTestId('k8s-map')
    // Ba chế độ, mỗi chế độ một câu hỏi (giải thích khi rê chuột); Workloads đã gộp vào Topology.
    await expect(map.getByTestId('k8s-map-view-topology')).toHaveAttribute('aria-checked', 'true')
    await expect(map.getByTestId('k8s-map-view-topology')).toHaveAttribute('title', /requests/)
    await expect(map.getByTestId('k8s-map-view-nodes')).toHaveCount(1)
    await expect(map.getByTestId('k8s-map-view-traffic')).toHaveCount(1)
    await expect(map.getByTestId('k8s-map-view-workloads')).toHaveCount(0)

    // Gập hết → lưới tổng quan: mỗi namespace một ô (số workload / pod, pod lỗi), gom theo mục đích.
    await map.getByTestId('k8s-topo-view').click()
    await page.getByTestId('k8s-topo-fold-all').click()
    await page.keyboard.press('Escape')
    const tile = (ns: string) =>
      map.locator(`[data-testid="k8s-topo-node"][data-kind="namespace"][data-name="${ns}"]`)
    await expect(tile('shop')).toContainText('failing pod')
    await expect(tile('shop')).toContainText('workload')
    await expect(
      map.locator('[data-testid="k8s-topo-group"][data-group="Applications"]')
    ).toContainText('namespaces')
    await expect(map.locator('[data-testid="k8s-topo-node"][data-kind="workload"]')).toHaveCount(0)

    // Gom theo nhãn team của namespace (gợi ý có sẵn), theo nhãn gõ tay, rồi về mục đích.
    await map.getByTestId('k8s-topo-view').click()
    await page.getByTestId('k8s-topo-grouping').selectOption('label:team')
    await expect(map.locator('[data-testid="k8s-topo-group"][data-group="commerce"]')).toBeVisible()
    await page.getByTestId('k8s-topo-grouping').selectOption('__custom')
    await page.getByTestId('k8s-topo-grouping-custom').fill('tier')
    await page.getByTestId('k8s-topo-grouping-custom').press('Enter')
    await expect(page.getByTestId('k8s-topo-grouping')).toHaveValue('label:tier')
    await expect(map.locator('[data-testid="k8s-topo-group"][data-group="Other"]')).toBeVisible()
    await page.getByTestId('k8s-topo-grouping').selectOption('purpose')
    await page.keyboard.press('Escape')

    // Bấm ô → namespace mở thành luồng chi tiết bên dưới lưới; gập lại → về lưới.
    await tile('shop').click()
    const toggle = map.locator('[data-testid="k8s-topo-ns-toggle"][data-ns="shop"]')
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(tile('shop')).toHaveCount(0)
    await expect(
      map.locator('[data-testid="k8s-topo-node"][data-kind="workload"][data-name="web"]')
    ).toHaveCount(1)
    await toggle.click()
    await expect(tile('shop')).toHaveCount(1)
  } finally {
    await launched.close()
    await server.close()
  }
})

test('Kubernetes: Topology tĩnh — vấn đề giải thích bằng lời, tìm theo nhãn, tập trung, pod, YAML', async () => {
  test.setTimeout(60_000)
  const server = await startApiTestServer()
  server.seedDemo()
  const dir = mkdtempSync(join(tmpdir(), 'sh-kube-'))
  const file = join(dir, 'config')
  writeFileSync(file, kubeconfig(server))
  const launched = await launchApp({ KUBECONFIG: file })
  const { page } = launched
  try {
    await enableK8s(page)
    await page.locator('[data-testid="k8s-context"][data-name="test"]').dblclick()
    const view = page.getByTestId('k8s-view')
    await setWindowSize(launched, 1366, 820)
    await page.getByTestId('k8s-nav-map').click()
    const map = view.getByTestId('k8s-map')
    // Topology là mặc định: làn có tên, thẻ Ingress ghi từng luật host / path.
    await expect(map.getByTestId('k8s-topo-canvas')).toBeVisible()
    await expect(map.locator('[data-testid="k8s-topo-lanes"] [data-lane="entry"]')).toHaveText(
      'Entry'
    )
    const ingress = map.locator(
      '[data-testid="k8s-topo-node"][data-kind="ingress"][data-name="storefront"]'
    )
    await expect(ingress.getByTestId('k8s-topo-row').first()).toContainText('shop.example.com/')

    // Menu namespace của thanh trên nằm TRÊN thanh công cụ Map (không bị che mục đầu); bấm ra
    // ngoài (vào bản đồ) đóng, Esc đóng, chọn checkbox thì vẫn mở (chọn nhiều).
    const nsMenu = view.getByTestId('k8s-namespace-menu')
    await view.getByTestId('k8s-namespace').click()
    const allNs = nsMenu.getByRole('menuitemradio', { name: 'All namespaces' })
    await expect(allNs).toBeVisible()
    const onTop = await allNs.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return !!hit && el.contains(hit)
    })
    expect(onTop).toBe(true)
    await view.getByTestId('k8s-ns-default').click()
    await expect(nsMenu).toBeVisible()
    await map.getByTestId('k8s-topo-canvas').click({ position: { x: 600, y: 500 } })
    await expect(nsMenu).toBeHidden()
    await view.getByTestId('k8s-namespace').click()
    await expect(nsMenu).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(nsMenu).toBeHidden()
    // Trả lựa chọn namespace như cũ cho phần sau.
    await view.getByTestId('k8s-namespace').click()
    await view.getByTestId('k8s-ns-default').click()
    await page.keyboard.press('Escape')
    await expect(nsMenu).toBeHidden()

    // Danh sách vấn đề: lỗi cấu hình được giải thích bằng lời; bấm → chọn + bảng chi tiết.
    await map.getByTestId('k8s-topo-problems').click()
    const problem = (code: string) =>
      map.locator(`[data-testid="k8s-topo-problem"][data-code="${code}"]`).first()
    await expect(problem('svc-no-match')).toContainText('app=redis')
    await expect(problem('ing-missing-svc')).toContainText('legacy-api')
    await problem('ing-missing-svc').click()
    const panel = view.getByTestId('k8s-topo-panel')
    await expect(panel).toContainText('storefront')
    await expect(panel.getByTestId('k8s-topo-problems')).toContainText(
      'TLS Secret admin-tls not found'
    )
    await expect(
      map.locator('[data-testid="k8s-topo-edge"][data-target="svc:shop/legacy-api"]').first()
    ).toHaveAttribute('data-broken', 'true')

    // Tập trung: chỉ còn đường đi qua Ingress này.
    await panel.getByTestId('k8s-topo-focus').click()
    await expect(map.getByTestId('k8s-topo-focus-chip')).toContainText('storefront')
    await expect(map.locator('[data-testid="k8s-topo-node"][data-name="media"]')).toHaveCount(0)
    await expect(
      map.locator('[data-testid="k8s-topo-node"][data-name="api"]').first()
    ).toBeVisible()
    await map.getByTestId('k8s-topo-focus-chip').getByRole('button').click()
    await expect(map.getByTestId('k8s-topo-focus-chip')).toHaveCount(0)

    // Tìm theo nhãn (key=value) → workload api; HPA ở mức tối đa được nói rõ.
    await map.getByTestId('k8s-topo-search').fill('tier=backend')
    // Enter = chọn kết quả đầu (dùng bàn phím — không phụ thuộc cú bấm chuột vào danh sách).
    // Đợi danh sách của truy vấn MỚI (không phải kết quả cũ còn trên màn hình) rồi mới Enter.
    await expect(map.getByTestId('k8s-topo-result').first()).toContainText('api')
    await map.getByTestId('k8s-topo-search').press('Enter')
    await expect(panel).toContainText('Deployment · shop')
    await expect(panel.getByTestId('k8s-topo-problems')).toContainText('at its maximum')
    // PDB không cho evict pod nào → nói rõ, kèm gợi ý sửa.
    await expect(panel.getByTestId('k8s-topo-problems')).toContainText('allows no disruptions')
    await expect(panel.getByTestId('k8s-topo-problem-fix').first()).toBeVisible()

    // Mở danh sách pod → chọn pod → Shell / Logs / YAML.
    await map
      .locator(
        '[data-testid="k8s-topo-node"][data-kind="pods"][data-name="wl:deployments.apps:shop/api"]'
      )
      .getByTestId('k8s-topo-pods-toggle')
      .click()
    await expect(map.getByTestId('k8s-topo-pod')).toHaveCount(3)
    await map.getByTestId('k8s-topo-pod').first().click()
    await expect(panel).toContainText('Pod · shop')
    await expect(panel.getByTestId('k8s-topo-shell')).toBeVisible()
    await panel.getByTestId('k8s-topo-yaml').click()
    await expect(page.getByTestId('k8s-topo-yaml-dialog')).toContainText('apiVersion')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('k8s-topo-yaml-dialog')).toHaveCount(0)
  } finally {
    await launched.close()
    await server.close()
  }
})

test('Kubernetes: Map › Nodes — lọc nhãn, cấp phát / dùng thật, node hỏng lên đầu, mở pod', async () => {
  test.setTimeout(60_000)
  const server = await startApiTestServer()
  const dir = mkdtempSync(join(tmpdir(), 'sh-kube-'))
  const file = join(dir, 'config')
  writeFileSync(file, kubeconfig(server))
  const launched = await launchApp({ KUBECONFIG: file })
  const { page } = launched
  try {
    await enableK8s(page)
    await page.locator('[data-testid="k8s-context"][data-name="test"]').dblclick()
    const view = page.getByTestId('k8s-view')
    await setWindowSize(launched, 1366, 820)
    await page.getByTestId('k8s-nav-map').click()
    const map = view.getByTestId('k8s-map')
    // Xem theo node: lọc theo nhãn kiểu kubectl làm mờ pod không khớp.
    await map.getByTestId('k8s-map-view-nodes').click()
    const filter = map.getByTestId('k8s-map-label-filter')
    await filter.fill('a=b=c')
    await expect(filter).toHaveAttribute('aria-invalid', 'true')
    const web1 = map.locator('[data-testid="k8s-node-pod"][aria-label="shop/web-1"]')
    await filter.fill('app=nothing')
    await expect(filter).toHaveAttribute('aria-invalid', 'false')
    await expect(web1).toHaveAttribute('data-match', 'false')
    await filter.fill('app in (web, api)')
    await expect(web1).toHaveAttribute('data-match', 'true')
    await filter.press('Escape')
    await expect(filter).toHaveValue('')

    // Cấp phát / dùng thật, node hỏng nổi lên đầu, bấm pod mở chi tiết.
    const nodes = map.getByTestId('k8s-nodes')
    await expect(nodes.getByTestId('k8s-nodes-summary')).toContainText('2 nodes · 1 ready')
    await expect(nodes.getByTestId('k8s-node-card').first()).toHaveAttribute('data-name', 'node-2')
    const down = nodes.locator('[data-testid="k8s-node-card"][data-name="node-2"]')
    await expect(down).toHaveAttribute('data-tone', 'bad')
    await expect(down.getByTestId('k8s-node-issues')).toContainText('Not ready')
    const up = nodes.locator('[data-testid="k8s-node-card"][data-name="node-1"]')
    await expect(up.getByTestId('k8s-node-cpu')).toContainText('requested')
    await expect(up.getByTestId('k8s-node-cpu')).toContainText('1.5 used')
    await expect(up.getByTestId('k8s-node-memory')).toContainText('2Gi used')
    await nodes.getByTestId('k8s-nodes-filter').fill('node-1')
    await expect(nodes.getByTestId('k8s-node-card')).toHaveCount(1)
    await up.locator('[data-testid="k8s-node-pod"][aria-label="shop/web-1"]').click()
    await expect(view.getByTestId('k8s-describe')).toContainText('web-1')
  } finally {
    await launched.close()
    await server.close()
  }
})

test('Kubernetes: trang Deployment (Status / Resources / Pods / ReplicaSets), Topology, Metrics', async () => {
  test.setTimeout(60_000)
  const server = await startApiTestServer()
  const dir = mkdtempSync(join(tmpdir(), 'sh-kube-'))
  const file = join(dir, 'config')
  writeFileSync(file, kubeconfig(server))
  const launched = await launchApp({ KUBECONFIG: file })
  const { page } = launched
  try {
    await enableK8s(page)
    await page.locator('[data-testid="k8s-context"][data-name="test"]').dblclick()
    const view = page.getByTestId('k8s-view')
    await setWindowSize(launched, 1366, 820)
    // Đợi bảng pod tải xong lần đầu rồi mới đổi loại (không đua với lần tải đầu).
    await expect(view.locator('[data-testid="k8s-row"][data-name="shop/web-1"]')).toBeVisible()
    await page.getByTestId('k8s-nav-deployments.apps').click()
    await expect(page.getByTestId('k8s-nav-deployments.apps')).toHaveAttribute(
      'aria-current',
      'true'
    )
    await view.locator('[data-testid="k8s-row"][data-name="shop/web"]').click()
    await page.keyboard.press('d')
    const detail = view.getByTestId('k8s-describe')

    // Overview: trạng thái rollout, lưới pod (pod lỗi trước), ReplicaSet có Roll back.
    await expect(detail.getByTestId('k8s-rollout-state')).toHaveText('Rolling out')
    await expect(detail.getByTestId('k8s-replicas')).toHaveText('2')
    await expect(detail.getByTestId('k8s-pod-phases')).toContainText('CrashLoopBackOff')
    const tiles = detail.getByTestId('k8s-pod-tile')
    await expect(tiles).toHaveCount(2)
    await expect(tiles.first()).toHaveAttribute('data-name', 'web-2')
    // Pod mới của Deployment (Deployment không đổi) → lưới pod tự cập nhật (nhịp 10 giây), không
    // cần bấm Refresh.
    server.upsert('pods', {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'web-9', namespace: 'shop', labels: { app: 'web' } }
    })
    await expect(tiles).toHaveCount(3, { timeout: 15_000 })
    server.remove('pods', 'shop', 'web-9')
    await expect(tiles).toHaveCount(2, { timeout: 15_000 })
    await expect(detail.getByTestId('k8s-resources-table')).toContainText('nginx:1.27')
    await expect(detail.getByTestId('k8s-replicaset-row')).toHaveCount(2)
    await expect(detail.getByTestId('k8s-replicaset-rollback')).toHaveCount(1)
    // Labels / Annotations (thu gọn) đứng đầu Overview, trước Status.
    const metaBox = await detail.getByTestId('k8s-meta-header').boundingBox()
    const statusBox = await detail.getByTestId('k8s-workload-status').boundingBox()
    expect((metaBox?.y ?? 1e9) < (statusBox?.y ?? 0)).toBe(true)
    // Gọn: không còn Strategy / UID.
    await expect(detail.getByText('Strategy', { exact: true })).toHaveCount(0)
    await expect(detail.getByText('UID', { exact: true })).toHaveCount(0)

    // Phóng to thành cả trang.
    await detail.getByTestId('k8s-detail-wide').click()
    await expect(detail).toHaveAttribute('data-expanded', 'true')

    // Timeline: rollout (image đổi), event lỗi; lọc theo làn; "trước lần chết" = 30 phút trước nó.
    await detail.getByTestId('k8s-detail-tab-timeline').click()
    const tl = detail.getByTestId('k8s-timeline')
    const tlEntry = tl.getByTestId('k8s-timeline-entry')
    await expect(
      tlEntry.filter({ hasText: 'Rollout · revision 2' }).filter({ hasText: 'nginx: 1.26 → 1.27' })
    ).toHaveCount(1)
    await expect(tl.getByTestId('k8s-timeline-crash')).toContainText('BackOff')
    await tl.getByTestId('k8s-timeline-lane-rollout').click()
    await expect(
      tl.locator('[data-testid="k8s-timeline-entry"]:not([data-lane="rollout"])')
    ).toHaveCount(0)
    await tl.getByTestId('k8s-timeline-lane-rollout').click()
    await expect(tlEntry.filter({ hasText: 'BackOff' })).toHaveCount(1)
    await tl.getByTestId('k8s-timeline-before').click()
    await expect(tl.getByTestId('k8s-timeline-focus')).toBeVisible()
    await expect(
      tl.locator('[data-testid="k8s-timeline-entry"][data-severity="danger"]')
    ).not.toHaveCount(0)
    await expect(tl.getByTestId('k8s-timeline-history')).toContainText('about an hour')

    // Topology: Deployment → ReplicaSet → Pod → Node, ConfigMap, ServiceAccount → RBAC.
    await detail.getByTestId('k8s-detail-tab-topology').click()
    const topo = detail.getByTestId('k8s-topology')
    const node = (kind: string, name: string) =>
      topo.locator(`[data-testid="k8s-topology-node"][data-kind="${kind}"][data-name="${name}"]`)
    await expect(node('deployments.apps', 'web')).toHaveAttribute('data-root', 'true')
    await expect(node('replicasets.apps', 'web-rs2')).toHaveCount(1)
    await expect(node('pods', 'web-2')).toHaveCount(1)
    // RBAC và Scheduling mặc định tắt — bật ở thanh lọc mới thấy Node / Role.
    await expect(node('nodes', 'node-1')).toHaveCount(0)
    await expect(node('roles.rbac.authorization.k8s.io', 'secret-reader')).toHaveCount(0)
    await topo.locator('[data-testid="k8s-topology-filter"][data-category="scheduling"]').click()
    await topo.locator('[data-testid="k8s-topology-filter"][data-category="rbac"]').click()
    await expect(node('nodes', 'node-1')).toHaveCount(1)
    await expect(node('roles.rbac.authorization.k8s.io', 'secret-reader')).toHaveCount(1)
    await expect(node('gateways.gateway.networking.k8s.io', 'public')).toHaveCount(1)
    // Blast radius của ConfigMap: deployment, pod, service, route…
    // Đồ thị lớn mở ở mức đọc được; Fit → thấy toàn bộ.
    await topo.getByTestId('k8s-topology-fit').click()
    await node('configmaps', 'web-config').click()
    await topo.getByTestId('k8s-topology-impact').click()
    await expect(topo.getByTestId('k8s-topology-impact-summary')).toContainText('1 Deployment')
    await expect(topo.getByTestId('k8s-topology-impact-summary')).toContainText('2 Pods')
    await expect(node('pods', 'web-1')).toHaveAttribute('data-affected', 'true')
    // Mở rộng node dùng chung → thấy pod khác chạy trên nó.
    await node('nodes', 'node-1').click()
    await topo.getByTestId('k8s-topology-expand').click()
    await expect(node('pods', 'tool')).toHaveCount(1)
    // Tắt nhóm Access (RBAC) → bỏ nhánh role.
    await topo.locator('[data-testid="k8s-topology-filter"][data-category="rbac"]').click()
    await expect(node('roles.rbac.authorization.k8s.io', 'secret-reader')).toHaveCount(0)
    // Kéo một mục sang chỗ khác → giữ vị trí mới; Reset layout → về chỗ tự xếp.
    const pod = node('pods', 'web-2')
    const before = await pod.boundingBox()
    if (!before) throw new Error('pod node')
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
    await page.mouse.down()
    await page.mouse.move(before.x + before.width / 2 + 140, before.y + before.height / 2 + 60, {
      steps: 8
    })
    await page.mouse.up()
    await expect
      .poll(async () => Math.round((await pod.boundingBox())?.x ?? 0))
      .toBeGreaterThan(Math.round(before.x) + 60)
    await topo.getByTestId('k8s-topology-reset').click()
    await expect
      .poll(async () => Math.round((await pod.boundingBox())?.x ?? 0))
      .toBe(Math.round(before.x))

    // Không còn tab Security.
    await expect(detail.getByTestId('k8s-detail-tab-security')).toHaveCount(0)

    // Metrics: tổng CPU / RAM và theo pod.
    await detail.getByTestId('k8s-detail-tab-metrics').click()
    await expect(detail.getByTestId('k8s-metrics')).toContainText('By pod')
    await expect(detail.getByTestId('k8s-metrics')).toContainText('web-1')

    // Traffic: không có Caretta → báo rõ "Unavailable" (không nhầm với "không có traffic").
    await detail.getByTestId('k8s-detail-tab-traffic').click()
    await expect(detail.getByTestId('k8s-traffic')).toHaveAttribute('data-status', 'unavailable')
    await expect(detail.getByTestId('k8s-traffic')).toContainText('Caretta is not installed')

    // Overview: bấm node của pod → mở Node.
    await detail.getByTestId('k8s-detail-tab-overview').click()
    await detail.getByTestId('k8s-pod-node').first().click()
    await expect(page.getByTestId('k8s-nav-nodes')).toHaveAttribute('aria-current', 'true')
    await expect(view.getByTestId('k8s-describe')).toContainText('node-1')
  } finally {
    await launched.close()
    await server.close()
  }
})

test('Kubernetes: Metrics lấy lịch sử từ Prometheus trong cluster (chọn 15m / 1h / 6h / 24h), trang Pod gọn', async () => {
  test.setTimeout(60_000)
  const server = await startApiTestServer()
  server.enablePrometheus()
  const dir = mkdtempSync(join(tmpdir(), 'sh-kube-'))
  const file = join(dir, 'config')
  writeFileSync(file, kubeconfig(server))
  const launched = await launchApp({ KUBECONFIG: file })
  const { page } = launched
  try {
    await enableK8s(page)
    await page.locator('[data-testid="k8s-context"][data-name="test"]').dblclick()
    const view = page.getByTestId('k8s-view')
    await page.getByTestId('k8s-nav-deployments.apps').click()
    await view.locator('[data-testid="k8s-row"][data-name="shop/web"]').click()
    await page.keyboard.press('d')
    const detail = view.getByTestId('k8s-describe')
    await detail.getByTestId('k8s-detail-tab-metrics').click()
    const metrics = detail.getByTestId('k8s-metrics')
    await expect(metrics).toHaveAttribute('data-source', 'prometheus')
    await expect(metrics.getByTestId('k8s-metrics-source')).toContainText(
      'Prometheus · monitoring/prometheus-operated'
    )
    await expect(metrics.getByTestId('k8s-metrics-range-1h')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await metrics.getByTestId('k8s-metrics-range-6h').click()
    // 6 giờ / ~120 điểm → bước 180 s.
    await expect
      .poll(() => server.requests.some((r) => r.includes('query_range') && r.includes('step=180')))
      .toBe(true)
    // Rê chuột lên biểu đồ → giá trị tại thời điểm đó.
    const chart = metrics.getByTestId('k8s-metrics-cpu')
    const box = await chart.boundingBox()
    if (!box) throw new Error('chart')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await expect(metrics.getByTestId('k8s-metrics-cpu-hover')).toContainText('m')
    await expect(metrics).toContainText('By pod')

    // Trang Pod: dòng tóm tắt + Usage (cùng biểu đồ), không còn QoS / Restart policy.
    await page.keyboard.press('Escape')
    await page.getByTestId('k8s-nav-pods').click()
    await view.locator('[data-testid="k8s-row"][data-name="shop/web-1"]').click()
    await page.keyboard.press('d')
    await expect(detail.getByTestId('k8s-pod-summary')).toContainText('node-1')
    await expect(detail.getByTestId('k8s-metrics')).toHaveAttribute('data-source', 'prometheus')
    await expect(detail.getByText('Restart policy')).toHaveCount(0)
    await expect(detail.getByTestId('k8s-container')).toContainText('nginx:1.27')
  } finally {
    await launched.close()
    await server.close()
  }
})

test('Kubernetes: lịch sử traffic qua Prometheus — Map › Traffic và tab Traffic của Deployment', async () => {
  test.setTimeout(60_000)
  const server = await startApiTestServer()
  server.enablePrometheus({ history: true })
  const dir = mkdtempSync(join(tmpdir(), 'sh-kube-'))
  const file = join(dir, 'config')
  writeFileSync(file, kubeconfig(server))
  const launched = await launchApp({ KUBECONFIG: file })
  const { page } = launched
  try {
    await enableK8s(page)
    await page.locator('[data-testid="k8s-context"][data-name="test"]').dblclick()
    const view = page.getByTestId('k8s-view')
    await setWindowSize(launched, 1366, 820)
    await page.getByTestId('k8s-nav-map').click()
    const map = view.getByTestId('k8s-map')
    await map.getByTestId('k8s-map-view-traffic').click()
    // Có Prometheus thu Caretta → chọn được khoảng đã qua; bản đồ là trung bình của khoảng đó.
    const past = map.getByTestId('k8s-traffic-window-6h')
    await expect(past).toBeEnabled()
    await past.click()
    await expect(map.getByTestId('k8s-traffic-history-banner')).toContainText(
      'Average traffic from'
    )
    await expect(map.getByTestId('k8s-traffic-history-banner')).toContainText(
      'monitoring/prometheus-operated'
    )
    // Chọn web → đường của nó hiện nhãn tốc độ + cổng; bảng bên: gọi tới api cổng 8080.
    await map.locator('[data-testid="k8s-traffic-node"][data-name="web"]').click()
    await expect(map.getByTestId('k8s-traffic-edge-label').first()).toContainText('KB/s')
    await expect(map.getByTestId('k8s-traffic-edge-port').first()).toContainText(':8080')
    await expect(
      map.locator('[data-testid="k8s-traffic-panel-peer"][data-name="api"]')
    ).toContainText(':8080')
    await map.getByTestId('k8s-traffic-window-live').click()
    await expect(map.getByTestId('k8s-traffic-history-banner')).toHaveCount(0)

    // Tab Traffic của Deployment web: 24h từ Prometheus — đối tác + tổng vào / ra theo thời gian.
    await page.getByTestId('k8s-nav-deployments.apps').click()
    await view.locator('[data-testid="k8s-row"][data-name="shop/web"]').click()
    await page.keyboard.press('d')
    const detail = view.getByTestId('k8s-describe')
    await detail.getByTestId('k8s-detail-tab-traffic').click()
    const traffic = detail.getByTestId('k8s-traffic')
    await traffic.getByTestId('k8s-traffic-window-24h').click()
    await expect(traffic.getByTestId('k8s-traffic-status')).toHaveText('History')
    await expect(traffic).toContainText('from Prometheus monitoring/prometheus-operated')
    await expect(
      traffic.locator('[data-testid="k8s-traffic-peer"][data-name="api"]')
    ).toContainText(':8080')
  } finally {
    await launched.close()
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Home › Infrastructure: cluster Production tự theo dõi (không mở tab), vấn đề lên Needs attention, tắt theo dõi', async () => {
  test.setTimeout(60_000)
  const server = await startApiTestServer()
  const dir = mkdtempSync(join(tmpdir(), 'sh-kube-'))
  const file = join(dir, 'config')
  writeFileSync(file, kubeconfig(server))
  const launched = await launchApp({ KUBECONFIG: file })
  const { page } = launched
  try {
    await enableK8s(page)
    const context = page.locator('[data-testid="k8s-context"][data-name="test"]')
    // Chưa thuộc Production → không theo dõi.
    await page.getByTestId('open-home').click()
    await expect(page.getByTestId('home-infra')).toHaveCount(0)
    await openArea(page, 'k8s')
    await context.click({ button: 'right' })
    await page.getByTestId('menu-env-prod').click()

    // Không mở tab nào: Home vẫn có trạng thái cluster (kết nối nền, chỉ đọc).
    await page.getByTestId('open-home').click()
    const row = page.getByTestId('home-infra').getByTestId('home-infra-item')
    await expect(row).toHaveCount(1)
    await expect(row).toHaveAttribute('data-id', /^k8s:/)
    await expect(row).toHaveAttribute('data-state', 'warning', { timeout: 15_000 })
    await expect(row).toContainText('Kubernetes · v1.')
    await expect(row.getByTestId('home-infra-stats')).toContainText('Failing pods')
    // Vấn đề của cluster theo dõi lên Needs attention; bấm → mở tab tới đúng pod.
    const item = page
      .getByTestId('home-attention-item')
      .filter({ hasText: 'web-2' })
      .filter({ hasText: 'CrashLoopBackOff' })
    await expect(item).toBeVisible()
    await item.click()
    const view = page.getByTestId('k8s-view')
    await expect(view.getByTestId('k8s-describe')).toContainText('web-2')
    // Tab cluster đang mở không báo trùng (cluster đã được theo dõi nền).
    await page.getByTestId('open-home').click()
    await expect(page.getByTestId('home-attention-item').filter({ hasText: 'web-2' })).toHaveCount(
      1
    )
    // Bấm hàng → về tab cluster đang mở (không mở thêm).
    await row.getByRole('button').first().click()
    await expect(view).toBeVisible()

    // Tắt theo dõi cluster này → hàng biến mất.
    await openArea(page, 'k8s')
    await context.click({ button: 'right' })
    await page.getByTestId('menu-monitor-home').click()
    await page.getByTestId('open-home').click()
    await expect(page.getByTestId('home-infra')).toHaveCount(0)
  } finally {
    await launched.close()
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Home › Needs attention: pod lỗi của cluster đang mở; bấm mở đúng pod; tắt trong Settings', async () => {
  test.setTimeout(60_000)
  const server = await startApiTestServer()
  const dir = mkdtempSync(join(tmpdir(), 'sh-kube-'))
  const file = join(dir, 'config')
  writeFileSync(file, kubeconfig(server))
  const launched = await launchApp({ KUBECONFIG: file })
  const { page } = launched
  try {
    await enableK8s(page)
    await page.locator('[data-testid="k8s-context"][data-name="test"]').dblclick()
    const view = page.getByTestId('k8s-view')
    await expect(view.getByTestId('k8s-row').first()).toBeVisible()
    await page.getByTestId('open-home').click()
    const attention = page.getByTestId('home-attention')
    const item = attention
      .getByTestId('home-attention-item')
      .filter({ hasText: 'web-2' })
      .filter({ hasText: 'CrashLoopBackOff' })
    await expect(item).toBeVisible({ timeout: 15_000 })
    await expect(item).toHaveAttribute('data-severity', 'danger')
    await expect(item).toContainText('test / shop')
    // Bấm → về tab cluster, mở chi tiết pod.
    await item.click()
    await expect(view.getByTestId('k8s-describe')).toContainText('web-2')
    // Tắt trong Settings → mục biến mất.
    await page.getByTestId('open-settings').click()
    await page.getByTestId('settings-nav-appearance').click()
    await page.getByTestId('setting-home-attention').click()
    await page.getByTestId('open-home').click()
    await expect(page.getByTestId('home-attention')).toHaveCount(0)
  } finally {
    await launched.close()
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Kubernetes: traffic từ Hubble (Cilium, không cần Caretta) — kết nối / giây, tên miền đích ngoài', async () => {
  test.setTimeout(60_000)
  const server = await startApiTestServer()
  server.enableHubble()
  const web = { ns: 'shop', pod: 'web-1', workload: ['Deployment', 'web'] as [string, string] }
  // Luồng kết nối đều đặn: web gọi api.stripe.com, ingress gọi web.
  const timer = setInterval(() => {
    server.emitFlow(
      hubbleFlow({ from: web, to: { ip: '104.26.12.64', names: ['api.stripe.com'] }, port: 443 })
    )
    server.emitFlow(
      hubbleFlow({
        from: {
          ns: 'ingress-nginx',
          pod: 'ctrl',
          workload: ['Deployment', 'ingress-nginx-controller']
        },
        to: web,
        port: 8080
      })
    )
  }, 200)
  const dir = mkdtempSync(join(tmpdir(), 'sh-kube-'))
  const file = join(dir, 'config')
  writeFileSync(file, kubeconfig(server))
  const launched = await launchApp({ KUBECONFIG: file })
  const { page } = launched
  try {
    await enableK8s(page)
    await page.locator('[data-testid="k8s-context"][data-name="test"]').dblclick()
    const view = page.getByTestId('k8s-view')
    await page.getByTestId('k8s-nav-deployments.apps').click()
    await view.locator('[data-testid="k8s-row"][data-name="shop/web"]').click()
    await page.keyboard.press('d')
    const detail = view.getByTestId('k8s-describe')
    await detail.getByTestId('k8s-detail-tab-traffic').click()
    const traffic = detail.getByTestId('k8s-traffic')
    await expect(traffic).toHaveAttribute('data-status', 'live', { timeout: 20_000 })
    await expect(
      traffic.locator('[data-testid="k8s-traffic-peer"][data-name="ingress-nginx-controller"]')
    ).toHaveCount(1)
    // Đích đi ra nằm ở tab Connections (quan sát, chưa khai báo ở đâu → Undeclared).
    await expect(traffic.getByTestId('k8s-traffic-outgoing-pointer')).toBeVisible()
    await detail.getByTestId('k8s-traffic-open-connections').click()
    const stripe = detail.locator(
      '[data-testid="k8s-detail-conn-row"][data-label^="api.stripe.com"]'
    )
    await expect(stripe).toHaveCount(1)
    await expect(stripe).toContainText('conn/s')
    await expect(stripe).toHaveAttribute('data-status', 'undeclared')
  } finally {
    clearInterval(timer)
    await launched.close()
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Kubernetes: Connections — khai báo (env) ghép với traffic quan sát: Active / Not seen / Undeclared', async () => {
  test.setTimeout(90_000)
  const server = await startApiTestServer()
  server.enableHubble()
  // web khai báo: api.stripe.com (có traffic), 203.0.113.99:9042 (không bao giờ thấy).
  const web = server.get('deployments', 'shop', 'web') as unknown as {
    spec: { template: { spec: { containers: { env?: unknown[] }[] } } }
  }
  const container = web.spec.template.spec.containers[0]
  if (container)
    container.env = [
      { name: 'PAYMENTS_URL', value: 'https://api.stripe.com/v1' },
      { name: 'LEGACY_ADDR', value: '203.0.113.99:9042' }
    ]
  server.upsert('deployments', web as never)
  const from = { ns: 'shop', pod: 'web-1', workload: ['Deployment', 'web'] as [string, string] }
  // web gọi api.stripe.com (đã khai báo) và 198.51.100.7:6379 (không khai báo ở đâu).
  const timer = setInterval(() => {
    server.emitFlow(
      hubbleFlow({ from, to: { ip: '104.26.12.64', names: ['api.stripe.com'] }, port: 443 })
    )
    server.emitFlow(hubbleFlow({ from, to: { ip: '198.51.100.7', names: [] }, port: 6379 }))
  }, 200)
  const dir = mkdtempSync(join(tmpdir(), 'sh-kube-'))
  const file = join(dir, 'config')
  writeFileSync(file, kubeconfig(server))
  const launched = await launchApp({ KUBECONFIG: file })
  const { page } = launched
  try {
    await enableK8s(page)
    await page.locator('[data-testid="k8s-context"][data-name="test"]').dblclick()
    const view = page.getByTestId('k8s-view')
    // Cửa sổ hẹp → thanh Map gom các chế độ xem thành menu (không có nút theo testid).
    await setWindowSize(launched, 1366, 820)
    // Chi tiết Deployment web › Connections.
    await page.getByTestId('k8s-nav-deployments.apps').click()
    await view.locator('[data-testid="k8s-row"][data-name="shop/web"]').click()
    await page.keyboard.press('d')
    const detail = view.getByTestId('k8s-describe')
    await detail.getByTestId('k8s-detail-tab-connections').click()
    const conns = detail.getByTestId('k8s-detail-connections')
    const row = (label: string) =>
      conns.locator(`[data-testid="k8s-detail-conn-row"][data-label^="${label}"]`)
    await expect(row('api.stripe.com')).toHaveAttribute('data-status', 'active', {
      timeout: 30_000
    })
    await expect(row('api.stripe.com')).toContainText('conn/s')
    await expect(row('203.0.113.99')).toHaveAttribute('data-status', 'declared')
    await expect(row('198.51.100.7')).toHaveAttribute('data-status', 'undeclared')
    await expect(row('198.51.100.7')).toContainText('not declared anywhere')
    // Không lộ giá trị env ngoài host / cổng.
    await expect(conns).not.toContainText('/v1')

    // Map › Connections: cùng dữ liệu cho mọi workload, lọc theo trạng thái.
    await page.keyboard.press('Escape')
    await expect(detail).toBeHidden()
    await page.getByTestId('k8s-nav-map').click()
    await expect(view.getByTestId('k8s-map')).toBeVisible()
    await view.getByTestId('k8s-map').getByTestId('k8s-map-view-connections').click()
    const map = view.getByTestId('k8s-connections')
    const mrow = (label: string) =>
      map.locator(`[data-testid="k8s-conn-row"][data-label^="${label}"]`)
    await expect(mrow('api.stripe.com')).toHaveAttribute('data-status', 'active', {
      timeout: 30_000
    })
    await expect(map.getByTestId('k8s-conn-traffic-note')).toContainText('Hubble')
    // Chọn / copy được giá trị trong bảng (trước đây toàn app user-select: none).
    await mrow('api.stripe.com').getByText('api.stripe.com:443').dblclick()
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain('stripe')
    await map.getByTestId('k8s-conn-filter-declared').click()
    await expect(map.getByTestId('k8s-conn-row')).toHaveCount(1)
    await expect(mrow('203.0.113.99')).toBeVisible()
    await map.getByTestId('k8s-conn-filter-undeclared').click()
    await expect(map.getByTestId('k8s-conn-row')).toHaveCount(1)
    await expect(mrow('198.51.100.7')).toBeVisible()
  } finally {
    clearInterval(timer)
    await launched.close()
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Kubernetes: traffic live từ Caretta — đường traffic trên bản đồ, tab Traffic của Deployment', async () => {
  test.setTimeout(60_000)
  const server = await startApiTestServer()
  server.enableCaretta()
  const dir = mkdtempSync(join(tmpdir(), 'sh-kube-'))
  const file = join(dir, 'config')
  writeFileSync(file, kubeconfig(server))
  const launched = await launchApp({ KUBECONFIG: file })
  const { page } = launched
  try {
    await enableK8s(page)
    await page.locator('[data-testid="k8s-context"][data-name="test"]').dblclick()
    const view = page.getByTestId('k8s-view')
    await setWindowSize(launched, 1366, 820)
    // Thêm namespace default (web ở shop gửi tới pod tool ở default).
    await view.getByTestId('k8s-namespace').click()
    await view.getByTestId('k8s-ns-default').click()
    await expect(view.getByTestId('k8s-ns-default')).toBeChecked()
    await page.keyboard.press('Escape')
    await page.getByTestId('k8s-nav-map').click()
    const map = view.getByTestId('k8s-map')
    // Lấy hai mẫu (5 s) → live; traffic shop → default: nối đúng thẻ web → thẻ pod lẻ của default
    // (không gộp thành đường giữa hai đảo).
    await expect(map.getByTestId('k8s-map-traffic-status')).toHaveAttribute('data-status', 'live', {
      timeout: 15_000
    })
    // Topology: tốc độ vào / ra ngay trên thẻ workload (lớp phủ traffic). Khung hẹp (sidebar host
    // đầy đủ) chưa thấy làn Workloads ở zoom dễ đọc — tìm để bay tới thẻ (chỉ vẽ phần đang thấy).
    await map.getByTestId('k8s-topo-search').fill('web')
    await map.getByTestId('k8s-topo-result').filter({ hasText: 'Deployment' }).first().click()
    await expect(
      map
        .locator('[data-testid="k8s-topo-node"][data-kind="workload"][data-name="web"]')
        .getByTestId('k8s-topo-rate')
    ).toContainText('MB/s')
    // Bảng chi tiết của thẻ vừa chọn: ai gọi tới / gọi tới ai (kèm tốc độ) — rồi mở chi tiết.
    const panel = view.getByTestId('k8s-topo-panel')
    await expect(panel.getByTestId('k8s-topo-traffic')).toContainText('db.example.com')
    await expect(panel.getByTestId('k8s-topo-traffic')).toContainText('MB/s')

    // Tab Traffic của Deployment: vào (Internet → Service web, quy về Deployment), ra (DB, tool).
    await panel.getByTestId('k8s-topo-open').click()
    const detail = view.getByTestId('k8s-describe')
    await detail.getByTestId('k8s-detail-tab-traffic').click()
    const traffic = detail.getByTestId('k8s-traffic')
    await expect(traffic).toHaveAttribute('data-status', 'live', { timeout: 15_000 })
    await expect(
      traffic.locator('[data-testid="k8s-traffic-peer"][data-name="203.0.113.7"]')
    ).toHaveCount(1)
    // Bản đồ nhỏ: bên gọi (Internet) trái, web giữa, bên được gọi (DB, tool) phải.
    const focusMap = traffic.getByTestId('k8s-traffic-focus-map')
    await expect(
      focusMap.locator('[data-testid="k8s-traffic-node"][data-name="db.example.com"]')
    ).toHaveCount(1)
    await expect(
      focusMap.locator('[data-testid="k8s-traffic-node"][data-name="203.0.113.7"]')
    ).toHaveCount(1)
    // Đích đi ra (DB, tool) nằm ở tab Connections: quan sát được, chưa khai báo ở đâu → Undeclared.
    await traffic.getByTestId('k8s-traffic-open-connections').click()
    const conns = detail.getByTestId('k8s-detail-connections')
    await expect(
      conns.locator('[data-testid="k8s-detail-conn-row"][data-label^="db.example.com"]')
    ).toContainText(':5432')
    await expect(
      conns.locator('[data-testid="k8s-detail-conn-row"][data-label*="/tool"]')
    ).toHaveCount(1)
    await detail.getByTestId('k8s-detail-tab-traffic').click()

    // Topology của Deployment: thêm bên gọi tới / được gọi theo Caretta (namespace khác, ngoài cluster).
    await detail.getByTestId('k8s-detail-tab-topology').click()
    const topo = detail.getByTestId('k8s-topology')
    await expect(
      topo.locator('[data-testid="k8s-topology-node"][data-name="db.example.com"]')
    ).toHaveCount(1)
    const liveChip = topo.locator('[data-testid="k8s-topology-filter"][data-category="live"]')
    await expect(liveChip).toBeVisible()
    // Ẩn live traffic → chip vẫn còn (gạch ngang) để bật lại; bật lại → node traffic quay về.
    await liveChip.click()
    await expect(liveChip).toHaveAttribute('aria-pressed', 'false')
    await expect(
      topo.locator('[data-testid="k8s-topology-node"][data-name="db.example.com"]')
    ).toHaveCount(0)
    await liveChip.click()
    await expect(liveChip).toHaveAttribute('aria-pressed', 'true')
    await expect(
      topo.locator('[data-testid="k8s-topology-node"][data-name="db.example.com"]')
    ).toHaveCount(1)

    // Map → Traffic: service map dựng từ Caretta trên mọi namespace (luồng đo dùng chung → có ngay).
    await page.keyboard.press('Escape')
    await page.getByTestId('k8s-nav-map').click()
    await map.getByTestId('k8s-map-view-traffic').click()
    const tmap = view.getByTestId('k8s-traffic-map')
    await expect(tmap.locator('[data-testid="k8s-traffic-node"][data-name="web"]')).toHaveCount(1)
    await expect(
      tmap.locator('[data-testid="k8s-traffic-node"][data-name="db.example.com"]')
    ).toHaveCount(1)
    // Phạm vi = namespace đang chọn ở bộ chọn namespace (shop, default).
    await expect(view.getByTestId('k8s-traffic-scope')).toHaveAttribute('data-scope', /shop/)
    await tmap.locator('[data-testid="k8s-traffic-node"][data-name="web"]').click()
    const tpanel = view.getByTestId('k8s-traffic-panel')
    await expect(tpanel).toContainText('Calls')
    await expect(tpanel).toContainText('db.example.com')
    await expect(tpanel).toContainText('MB/s')
  } finally {
    await launched.close()
    await server.close()
  }
})

test('Kubernetes: service map — phạm vi theo namespace đang chọn, gộp External, mọi kết nối idle vẫn vẽ cấu trúc', async () => {
  test.setTimeout(60_000)
  const server = await startApiTestServer()
  server.enableCaretta({ realistic: true, idle: true })
  const dir = mkdtempSync(join(tmpdir(), 'sh-kube-'))
  const file = join(dir, 'config')
  writeFileSync(file, kubeconfig(server))
  const launched = await launchApp({ KUBECONFIG: file })
  const { page } = launched
  try {
    await enableK8s(page)
    await page.locator('[data-testid="k8s-context"][data-name="test"]').dblclick()
    const view = page.getByTestId('k8s-view')
    await setWindowSize(launched, 1366, 820)
    // Chỉ console-stg (bỏ shop của context).
    await view.getByTestId('k8s-namespace').click()
    await view.getByTestId('k8s-ns-shop').click()
    await view.getByTestId('k8s-ns-console-stg').click()
    await page.keyboard.press('Escape')
    await page.getByTestId('k8s-nav-map').click()
    const map = view.getByTestId('k8s-map')
    await map.getByTestId('k8s-map-view-traffic').click()
    const tmap = view.getByTestId('k8s-traffic-map')
    await expect(view.getByTestId('k8s-traffic-scope')).toHaveAttribute(
      'data-scope',
      'console-stg',
      {
        timeout: 15_000
      }
    )
    // Mọi kết nối idle: không trống — báo rõ, đường vẽ mờ (đứt nét).
    await expect(tmap.getByTestId('k8s-traffic-all-idle')).toBeVisible({ timeout: 15_000 })
    await expect(
      tmap.locator('[data-testid="k8s-traffic-edge"][data-idle="true"]').first()
    ).toBeAttached()
    // Đang giới hạn top-N → xem hết (idle: không có tốc độ để xếp hạng).
    if (await tmap.getByTestId('k8s-traffic-more').isVisible())
      await tmap.getByTestId('k8s-traffic-more').click()
    // Ngoài phạm vi gộp theo namespace; 60 IP Internet → ingress không làm rối bản đồ console-stg.
    await expect(
      tmap.locator('[data-testid="k8s-traffic-node"][data-id="n:ingress-nginx"]')
    ).toHaveCount(1)
    await expect(
      tmap.locator('[data-testid="k8s-traffic-node"][data-kind="external"]')
    ).toHaveCount(2)
    // Mở External (theo /16 · tên miền) từ bảng bên phải.
    await tmap.getByTestId('k8s-traffic-search').fill('amazonaws')
    await tmap.getByTestId('k8s-traffic-search').press('Enter')
    await view.getByTestId('k8s-traffic-panel-expand').click()
    await expect(
      tmap.locator('[data-testid="k8s-traffic-node"][data-name="52.219.0.0/16"]')
    ).toHaveCount(1)
    await tmap.getByTestId('k8s-traffic-search').fill('')
    // Mọi namespace: Internet → ingress hiện ra (gộp External clients).
    await tmap.getByTestId('k8s-traffic-collapse-all').click()
    await view.getByTestId('k8s-traffic-scope-toggle').click()
    await expect(view.getByTestId('k8s-traffic-scope')).toHaveAttribute('data-scope', '')
    await expect(
      tmap.locator('[data-testid="k8s-traffic-node"][data-name="ingress-nginx-controller"]')
    ).toHaveCount(1)
  } finally {
    await launched.close()
    await server.close()
  }
})

test('Kubernetes: Session Host chết giữa chừng → tab tự kết nối lại, không treo "Loading…"', async () => {
  test.setTimeout(60_000)
  const server = await startApiTestServer()
  const dir = mkdtempSync(join(tmpdir(), 'sh-kube-'))
  const file = join(dir, 'config')
  writeFileSync(file, kubeconfig(server))
  const launched = await launchApp({ KUBECONFIG: file })
  const { page } = launched
  try {
    await enableK8s(page)
    await page.locator('[data-testid="k8s-context"][data-name="test"]').dblclick()
    const view = page.getByTestId('k8s-view')
    await expect(view.locator('[data-testid="k8s-row"][data-name="shop/web-1"]')).toBeVisible()
    await page.evaluate(() => window.shellhouse.crashSessionHostForTest())
    // Phiên mới được mở tự động; bảng tải lại và thao tác tiếp được.
    await expect(view.locator('[data-testid="k8s-row"][data-name="shop/web-1"]')).toBeVisible({
      timeout: 20_000
    })
    await page.getByTestId('k8s-nav-deployments.apps').click()
    await expect(view.locator('[data-testid="k8s-row"][data-name="shop/web"]')).toBeVisible({
      timeout: 20_000
    })
  } finally {
    await launched.close()
    await server.close()
  }
})

test('Kubernetes: tạo Deployment + Service bằng form (kiểu Rancher / Lens), kiểm tra lỗi, toast', async () => {
  test.setTimeout(60_000)
  const server = await startApiTestServer()
  const dir = mkdtempSync(join(tmpdir(), 'sh-kube-'))
  const file = join(dir, 'config')
  writeFileSync(file, kubeconfig(server))
  const launched = await launchApp({ KUBECONFIG: file })
  const { page } = launched
  try {
    await enableK8s(page)
    await page.locator('[data-testid="k8s-context"][data-name="test"]').dblclick()
    const view = page.getByTestId('k8s-view')
    await setWindowSize(launched, 1366, 820)
    await expect(view.locator('[data-testid="k8s-row"][data-name="shop/web-1"]')).toBeVisible()
    // Trang trống có hành động gợi ý: Jobs (chưa có) → "Create Job" mở đúng form.
    await page.getByTestId('k8s-nav-jobs.batch').click()
    await view.getByTestId('k8s-empty-create').click()
    await expect(
      page.getByTestId('k8s-create-dialog').getByTestId('k8s-create-kind-Job')
    ).toHaveAttribute('aria-current', 'true')
    await page.keyboard.press('Escape')
    // Lọc không ra gì → "Clear filter".
    await view.getByTestId('k8s-filter').fill('khong-co-gi')
    await view.getByRole('button', { name: 'Clear filter' }).click()
    await expect(view.getByTestId('k8s-filter')).toHaveValue('')
    await page.getByTestId('k8s-nav-deployments.apps').click()
    await view.getByTestId('k8s-create').click()
    const dialog = page.getByTestId('k8s-create-dialog')
    // Đang xem Deployments → form Deployment; namespace mặc định = namespace đang xem.
    await expect(dialog.getByTestId('k8s-create-kind-Deployment')).toHaveAttribute(
      'aria-current',
      'true'
    )
    await expect(dialog.getByTestId('k8s-form-namespace')).toHaveValue('shop')

    // Để trống → báo lỗi tại chỗ, không gửi gì.
    await dialog.getByTestId('k8s-create-submit').click()
    await expect(dialog.getByTestId('k8s-create-invalid')).toContainText('Fix 2 fields')
    await expect(dialog.getByTestId('k8s-form-error').first()).toBeVisible()

    await dialog.getByTestId('k8s-form-name').fill('api')
    await dialog.getByTestId('k8s-form-image').fill('ghcr.io/acme/api:1.2')
    await dialog.getByTestId('k8s-form-replicas').fill('2')
    await dialog.getByTestId('k8s-form-add-port').click()
    await dialog.getByTestId('k8s-form-port').fill('8080')
    await dialog.getByTestId('k8s-form-expose').check()
    // Port của Service lấy sẵn từ port container.
    await expect(dialog.getByTestId('k8s-form-service-port')).toHaveValue('8080')
    await dialog.getByTestId('k8s-form-service-port').fill('80')
    await expect(dialog.getByTestId('k8s-create-yaml')).toContainText('kind: Service')
    await expect(dialog.getByTestId('k8s-create-yaml')).not.toContainText('&a1')
    await dialog.getByTestId('k8s-create-submit').click()

    await expect(dialog).toHaveCount(0)
    const t = page.getByTestId('toast').filter({ hasText: 'Created api' })
    await expect(t).toHaveAttribute('data-tone', 'success')
    await expect(t).toContainText('shop/service/api')
    const deploy = server.get('deployments', 'shop', 'api')
    expect(deploy?.spec).toMatchObject({
      replicas: 2,
      selector: { matchLabels: { app: 'api' } },
      template: {
        spec: {
          containers: [
            { name: 'app', image: 'ghcr.io/acme/api:1.2', ports: [{ containerPort: 8080 }] }
          ]
        }
      }
    })
    expect(server.get('services', 'shop', 'api')?.spec).toMatchObject({
      selector: { app: 'api' },
      ports: [{ port: 80, targetPort: 'http' }]
    })
    // Mở luôn đối tượng vừa tạo.
    await expect(view.getByTestId('k8s-describe')).toContainText('api')

    // Tạo trùng tên → hỏi trước (server-side apply sẽ sửa đè đối tượng đang có).
    await view.getByTestId('k8s-create').click()
    const again = page.getByTestId('k8s-create-dialog')
    await again.getByTestId('k8s-form-name').fill('api')
    await again.getByTestId('k8s-form-image').fill('nginx:1.27')
    await again.getByTestId('k8s-create-submit').click()
    await expect(page.getByTestId('k8s-create-exists')).toContainText('Deployment shop/api')
    await page.getByTestId('confirm-cancel').click()
    await expect(again).toBeVisible()
    // Đã điền mà đóng → hỏi trước khi bỏ.
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('k8s-create-discard')).toBeVisible()
    await page.getByTestId('confirm-ok').click()
    await expect(again).toHaveCount(0)

    // "Edit as YAML": chuyển sang trình sửa YAML, giữ nội dung form (không đóng mất).
    await view.getByTestId('k8s-create').click()
    await page.getByTestId('k8s-create-dialog').getByTestId('k8s-form-name').fill('worker')
    await page.getByTestId('k8s-create-dialog').getByTestId('k8s-create-edit-yaml').click()
    await expect(page.getByTestId('k8s-create-dialog')).toHaveCount(0)
    const yamlEditor = page.getByTestId('k8s-yaml-editor')
    await expect(yamlEditor).toBeVisible()
    // Editor CodeMirror (nạp lười): nội dung nằm trong .cm-content.
    const code = yamlEditor.getByTestId('k8s-yaml-text').locator('.cm-content')
    await expect(code).toContainText('name: worker')
    // Chưa áp dụng mà đóng → hỏi trước (nội dung từ form là thay đổi chưa lưu).
    await code.press('Escape')
    await expect(page.getByTestId('confirm-dialog')).toContainText('Discard your changes?')
    await page.getByTestId('confirm-cancel').click()
    await expect(yamlEditor).toBeVisible()
    // Xem trước (dry run) rồi mới áp dụng: đối tượng mới → "create", diff có dòng thêm.
    await yamlEditor.getByTestId('k8s-yaml-apply').click()
    await expect(yamlEditor.getByTestId('k8s-yaml-preview')).toBeVisible()
    await expect(yamlEditor.getByTestId('k8s-yaml-diff')).toContainText('name: worker')
    await yamlEditor.getByTestId('k8s-yaml-back').click()
    await expect(code).toBeVisible()
    await yamlEditor.getByTestId('k8s-yaml-apply').click()
    await yamlEditor.getByTestId('k8s-yaml-apply').click()
    await expect(yamlEditor).toHaveCount(0)
  } finally {
    await launched.close()
    await server.close()
  }
})

test('Kubernetes trên Production: lưu YAML sửa và Apply phải gõ lại tên đối tượng', async () => {
  test.setTimeout(60_000)
  const server = await startApiTestServer()
  const dir = mkdtempSync(join(tmpdir(), 'sh-kube-'))
  const file = join(dir, 'config')
  writeFileSync(file, kubeconfig(server))
  const launched = await launchApp({ KUBECONFIG: file })
  const { page } = launched
  try {
    await enableK8s(page)
    const context = page.locator('[data-testid="k8s-context"][data-name="test"]')
    await context.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Context settings…' }).click()
    await page.getByTestId('k8s-env-prod').click()
    await page.getByTestId('k8s-context-save').click()
    await context.dblclick()
    const view = page.getByTestId('k8s-view')
    await setWindowSize(launched, 1366, 820)
    const writes = (): number =>
      server.requests.filter((r) => /^(PUT|PATCH|POST) /.test(r) && !/dryRun/.test(r)).length

    // Sửa YAML Deployment: xem diff xong, bước ghi bị chặn tới khi gõ đúng tên.
    await page.getByTestId('k8s-nav-deployments.apps').click()
    const row = view.locator('[data-testid="k8s-row"][data-name="shop/web"]')
    await row.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Edit YAML' }).click()
    const editor = page.getByTestId('k8s-yaml-editor')
    const code = editor.getByTestId('k8s-yaml-text').locator('.cm-content')
    await expect(code).toContainText('name: web')
    // Thêm một annotation thật (comment không tạo khác biệt nên không có gì để lưu).
    const original = await code.innerText()
    const changed = original.replace(
      /^(\s*)(deployment\.kubernetes\.io\/revision:.*)$/m,
      '$1$2\n$1team: sre'
    )
    expect(changed).not.toBe(original)
    await code.click()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.insertText(changed)
    await editor.getByTestId('k8s-yaml-apply').click()
    await expect(editor.getByTestId('k8s-yaml-preview')).toBeVisible()
    const before = writes()
    await editor.getByTestId('k8s-yaml-apply').click()
    const ok = page.getByTestId('k8s-confirm-ok')
    await expect(ok).toBeDisabled()
    await page.getByTestId('k8s-confirm-typed').fill('web-x')
    await expect(ok).toBeDisabled()
    expect(writes()).toBe(before)
    await page.getByTestId('k8s-confirm-typed').fill('web')
    await ok.click()
    await expect(editor).toHaveCount(0)
    expect(writes()).toBeGreaterThan(before)

    // Form "Create" trùng tên đối tượng đang chạy (server-side apply sửa đè) → cũng gõ lại tên.
    await view.getByTestId('k8s-create').click()
    const form = page.getByTestId('k8s-create-dialog')
    await form.getByTestId('k8s-form-name').fill('web')
    await form.getByTestId('k8s-form-image').fill('nginx:1.27')
    const beforeCreate = writes()
    await form.getByTestId('k8s-create-submit').click()
    await expect(page.getByTestId('k8s-confirm')).toContainText('Deployment shop/web')
    await expect(page.getByTestId('k8s-create-exists')).toHaveCount(0)
    await expect(page.getByTestId('k8s-confirm-ok')).toBeDisabled()
    await page.getByTestId('k8s-confirm-typed').fill('web')
    await page.getByTestId('k8s-confirm-ok').click()
    await expect(form).toHaveCount(0)
    expect(writes()).toBeGreaterThan(beforeCreate)
  } finally {
    await launched.close()
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
