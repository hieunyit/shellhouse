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

    // Watch: pod mới xuất hiện không cần tải lại.
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
    await page.getByTestId('k8s-nav-group-Storage').click()
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

test('Kubernetes: bản đồ cluster — tìm và bay tới, quan hệ, lỗi tiếp theo, zoom, mở chi tiết', async () => {
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
    // Mặc định là Topology — chuyển sang bản đồ workload.
    await expect(map.getByTestId('k8s-map-view-topology')).toHaveAttribute('aria-checked', 'true')
    await map.getByTestId('k8s-map-view-workloads').click()
    await expect(map.getByTestId('k8s-map-summary')).toContainText('workloads')
    await expect(map.getByTestId('k8s-map-summary')).toContainText('pods')

    // Tìm → bay tới + chọn; bảng bên phải: pod của deployment, service gửi traffic tới.
    await map.getByTestId('k8s-map-search').fill('web')
    const result = map
      .getByTestId('k8s-map-result')
      .filter({ hasText: 'Workload' })
      .filter({ hasText: 'web' })
      .first()
    await result.click()
    const panel = view.getByTestId('k8s-map-panel')
    await expect(panel).toContainText('web')
    await expect(panel).toContainText('Deployment · shop')
    await expect(panel.getByTestId('k8s-map-details')).toContainText('Pods 2')
    await expect(panel.locator('[data-testid="k8s-map-link"][data-name="web"]')).toContainText(
      'Service'
    )
    // Icon công nghệ (image nginx) + blast radius của workload.
    await expect(panel.getByTestId('k8s-map-tech')).toContainText('NGINX')
    await expect(panel.getByTestId('k8s-map-impact-summary')).toContainText('2 pods')
    await expect(panel.getByTestId('k8s-map-impact-summary')).toContainText('1 service')
    await panel.getByTestId('k8s-map-impact-toggle').click()
    await expect(panel.getByTestId('k8s-map-impact-toggle')).toHaveAttribute('aria-pressed', 'true')

    // Bấm service trong bảng → chọn service; quay lại.
    await panel.locator('[data-testid="k8s-map-link"][data-name="web"]').click()
    await expect(panel).toContainText('Service · shop')

    // Gateway API: Gateway → HTTPRoute (đổi gateway → route gắn vào bị ảnh hưởng).
    await map.getByTestId('k8s-map-search').fill('public')
    await map.getByTestId('k8s-map-result').filter({ hasText: 'Gateway' }).first().click()
    await expect(panel).toContainText('Gateway · shop')
    await expect(panel.locator('[data-testid="k8s-map-link"][data-name="web"]')).toContainText(
      'HTTPRoute'
    )
    await expect(panel.getByTestId('k8s-map-impact-summary')).toContainText('1 route')

    // Lỗi tiếp theo: deployment web (1/2 ready) + pod CrashLoopBackOff.
    await map.getByTestId('k8s-map-next-problem').click()
    await expect(panel).toContainText('Deployment · shop')

    // Zoom: phím + và nút Fit đổi tỉ lệ.
    const zoom = map.getByTestId('k8s-map-zoom')
    const before = await zoom.textContent()
    await map.getByTestId('k8s-map-canvas').focus()
    await page.keyboard.press('+')
    await expect(zoom).not.toHaveText(before ?? '')
    await map.getByTestId('k8s-map-fit').click()

    // Mở chi tiết → bảng Deployments, chi tiết của web.
    await panel.getByTestId('k8s-map-open').click()
    await expect(page.getByTestId('k8s-nav-deployments.apps')).toHaveAttribute(
      'aria-current',
      'true'
    )
    await expect(view.getByTestId('k8s-describe')).toContainText('web')
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
    await expect(map.getByTestId('k8s-topo-result').first()).toBeVisible()
    await map.getByTestId('k8s-topo-search').press('Enter')
    await expect(panel).toContainText('Deployment · shop')
    await expect(panel.getByTestId('k8s-topo-problems')).toContainText('at its maximum')

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

test('Kubernetes: bản đồ cluster lớn — gom vùng theo nhãn, lọc nhãn, gập namespace, xem theo node', async () => {
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
    await map.getByTestId('k8s-map-view-workloads').click()
    const summary = map.getByTestId('k8s-map-summary')
    await expect(summary).toContainText('2 workloads')

    // Gom vùng theo nhãn team của namespace (gợi ý tự có trong danh sách) — trong menu View.
    await map.getByTestId('k8s-map-options').click()
    await map.getByTestId('k8s-map-grouping').selectOption('label:team')
    await expect(map.locator('[data-testid="k8s-map-region"][data-name="commerce"]')).toBeVisible()
    await map.getByTestId('k8s-map-grouping').selectOption('__custom')
    await map.getByTestId('k8s-map-grouping-custom').fill('tier')
    await map.getByTestId('k8s-map-grouping-custom').press('Enter')
    await expect(map.getByTestId('k8s-map-grouping')).toHaveValue('label:tier')
    await expect(map.locator('[data-testid="k8s-map-region"][data-name="Other"]')).toBeVisible()
    await map.getByTestId('k8s-map-grouping').selectOption('purpose')

    // Lọc theo nhãn kiểu kubectl.
    const filter = map.getByTestId('k8s-map-label-filter')
    await filter.fill('app=nothing')
    await expect(summary).toContainText('0 workloads')
    await filter.fill('a=b=c')
    await expect(filter).toHaveAttribute('aria-invalid', 'true')
    await filter.fill('app in (web, api)')
    await expect(filter).toHaveAttribute('aria-invalid', 'false')
    await expect(summary).toContainText('1 workload ·')
    await filter.press('Escape')
    await expect(filter).toHaveValue('')
    await expect(summary).toContainText('2 workloads')

    // Gập namespace shop (bảng bên) → workload không còn trên bản đồ; tìm vẫn thấy và mở lại.
    await map.getByTestId('k8s-map-search').fill('shop')
    await map.getByTestId('k8s-map-result').filter({ hasText: 'Namespace' }).first().click()
    const panel = view.getByTestId('k8s-map-panel')
    await panel.getByTestId('k8s-map-panel-fold').click()
    await expect(summary).toContainText('0 workloads')
    await expect(panel.getByTestId('k8s-map-panel-fold')).toContainText('Expand')
    await map.getByTestId('k8s-map-search').fill('web')
    await map.getByTestId('k8s-map-result').filter({ hasText: '(collapsed)' }).first().click()
    await expect(summary).toContainText('2 workloads')
    await expect(panel).toContainText('Deployment')
    // Gập hết / mở hết (menu View).
    await map.getByTestId('k8s-map-options').click()
    await map.getByTestId('k8s-map-fold-all').click()
    await expect(summary).toContainText('0 workloads')
    await map.getByTestId('k8s-map-options').click()
    await expect(map.getByTestId('k8s-map-fold-all')).toContainText('Expand all')
    await map.getByTestId('k8s-map-fold-all').click()
    await expect(summary).toContainText('2 workloads')

    // Xem theo node: cấp phát / dùng thật, node hỏng nổi lên đầu, bấm pod mở chi tiết.
    await map.getByTestId('k8s-map-view-nodes').click()
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
    await map.getByTestId('k8s-map-view-workloads').click()
    await map.getByTestId('k8s-map-search').fill('web')
    await map.getByTestId('k8s-map-result').filter({ hasText: 'Workload' }).first().click()
    await expect(
      map.locator(
        '[data-testid="k8s-map-traffic-edge"][data-source="w:deployments.apps:shop/web"][data-target="w:pods:default/standalone"]'
      )
    ).toHaveCount(1)
    const panel = view.getByTestId('k8s-map-panel')
    await expect(panel.getByTestId('k8s-map-node-traffic')).toContainText('db.example.com')
    await expect(panel.getByTestId('k8s-map-node-traffic')).toContainText('MB/s')

    // Tab Traffic của Deployment: vào (Internet → Service web, quy về Deployment), ra (DB, tool).
    await panel.getByTestId('k8s-map-open').click()
    const detail = view.getByTestId('k8s-describe')
    await detail.getByTestId('k8s-detail-tab-traffic').click()
    const traffic = detail.getByTestId('k8s-traffic')
    await expect(traffic).toHaveAttribute('data-status', 'live', { timeout: 15_000 })
    await expect(
      traffic.locator('[data-testid="k8s-traffic-peer"][data-name="203.0.113.7"]')
    ).toHaveCount(1)
    await expect(
      traffic.locator('[data-testid="k8s-traffic-peer"][data-name="db.example.com"]')
    ).toContainText(':5432')
    await expect(traffic.locator('[data-testid="k8s-traffic-peer"][data-name="tool"]')).toHaveCount(
      1
    )
    // Bản đồ nhỏ: bên gọi (Internet) trái, web giữa, bên được gọi (DB, tool) phải.
    const focusMap = traffic.getByTestId('k8s-traffic-focus-map')
    await expect(
      focusMap.locator('[data-testid="k8s-traffic-node"][data-name="db.example.com"]')
    ).toHaveCount(1)
    await expect(
      focusMap.locator('[data-testid="k8s-traffic-node"][data-name="203.0.113.7"]')
    ).toHaveCount(1)

    // Topology của Deployment: thêm bên gọi tới / được gọi theo Caretta (namespace khác, ngoài cluster).
    await detail.getByTestId('k8s-detail-tab-topology').click()
    const topo = detail.getByTestId('k8s-topology')
    await expect(
      topo.locator('[data-testid="k8s-topology-node"][data-name="db.example.com"]')
    ).toHaveCount(1)
    await expect(
      topo.locator('[data-testid="k8s-topology-filter"][data-category="live"]')
    ).toBeVisible()

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
