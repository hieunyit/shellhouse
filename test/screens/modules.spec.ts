import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { isWindows, launchApp, test } from '../e2e/fixtures'
import {
  startApiTestServer,
  TEST_CA,
  TOKEN,
  type ApiTestServer
} from '../../src/modules/k8s/test/api-test-server'
import {
  startEngineTestServer,
  type EngineTestServer
} from '../../src/modules/docker/test/engine-test-server'
import { startS3TestServer } from '../../src/modules/s3/test/s3-test-server'

/**
 * Chụp màn hình các module (Kubernetes, Docker, S3) ở cả sáng và tối để rà soát giao diện.
 *   pnpm build && pnpm screens      → ảnh trong screens/<theme>-m-<tên>.png
 *   SHELLHOUSE_LANG=vi …             → giao diện tiếng Việt: screens/vi-<theme>-m-<tên>.png
 * Mỗi ảnh chụp độc lập: một bước lỗi chỉ bỏ ảnh đó (ghi ra console), không dừng cả lượt.
 * Bộ chọn chỉ dùng data-testid / data-* (không dựa chữ hiển thị) — chạy được với mọi ngôn ngữ.
 */
const OUT = 'screens'
/** launchApp đọc SHELLHOUSE_LANG (mặc định en); ảnh tiếng Việt có tiền tố riêng, không đè ảnh tiếng Anh. */
const PREFIX = process.env['SHELLHOUSE_LANG'] === 'vi' ? 'vi-' : ''
test.setTimeout(600_000)

async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-nav-appearance').click()
  await page.getByTestId(`appearance-${theme}`).click()
  await page.keyboard.press('Escape')
}

async function enableModule(page: Page, id: string): Promise<void> {
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-nav-modules').click()
  await page.getByTestId(`module-toggle-${id}`).click()
  await page.getByTestId('module-enable-confirm').click()
  await page.keyboard.press('Escape')
  // Khung v0.5: cluster / endpoint / tài khoản nằm trong khu vực riêng của module.
  await page.getByTestId(`activity-${id}`).click()
}

function shooter(page: Page, theme: string) {
  return async (name: string, steps: () => Promise<void>, target?: Locator): Promise<void> => {
    try {
      await steps()
      await page.waitForTimeout(500)
      await (target ?? page).screenshot({ path: join(OUT, `${PREFIX}${theme}-m-${name}.png`) })
    } catch (e) {
      console.log(`SKIP ${PREFIX}${theme}-m-${name}: ${String(e).split('\n')[0] ?? ''}`)
    }
  }
}

/** Thêm vài Compose project giống thật (nhiều service, replica, project đã dừng) cho ảnh chụp. */
function seedDockerProjects(engine: EngineTestServer): void {
  const base = engine.containers[0]
  if (!base) return
  const now = Math.floor(Date.now() / 1000)
  const add = (
    name: string,
    project: string,
    service: string,
    extra: Partial<typeof base> = {}
  ): void => {
    engine.containers.push({
      ...base,
      Id: `${name}-${'0'.repeat(40)}`.slice(0, 64),
      Names: [`/${name}`],
      Status: 'Up 3 days',
      Created: now - 3 * 86_400,
      Ports: [],
      Labels: {
        'com.docker.compose.project': project,
        'com.docker.compose.service': service,
        'com.docker.compose.project.working_dir': `/srv/${project}`,
        'com.docker.compose.project.config_files': `/srv/${project}/compose.yaml`
      },
      ...extra
    })
  }
  add('monitoring-prometheus-1', 'monitoring', 'prometheus', {
    Image: 'prom/prometheus:v2.54.1',
    Ports: [{ IP: '0.0.0.0', PrivatePort: 9090, PublicPort: 9090, Type: 'tcp' }],
    Status: 'Up 3 days (healthy)'
  })
  add('monitoring-grafana-1', 'monitoring', 'grafana', {
    Image: 'grafana/grafana:11.2.0',
    Ports: [{ IP: '0.0.0.0', PrivatePort: 3000, PublicPort: 3000, Type: 'tcp' }],
    Status: 'Up 3 days (unhealthy)'
  })
  add('monitoring-node-exporter-1', 'monitoring', 'node-exporter', {
    Image: 'prom/node-exporter:v1.8.2'
  })
  add('monitoring-node-exporter-2', 'monitoring', 'node-exporter', {
    Image: 'prom/node-exporter:v1.8.2',
    State: 'exited',
    Status: 'Exited (1) 2 hours ago'
  })
  add('blog-wordpress-1', 'blog', 'wordpress', {
    Image: 'wordpress:6.6-apache',
    State: 'exited',
    Status: 'Exited (0) 5 days ago',
    Created: now - 12 * 86_400
  })
  add('blog-mariadb-1', 'blog', 'mariadb', {
    Image: 'mariadb:11.4',
    State: 'exited',
    Status: 'Exited (0) 5 days ago',
    Created: now - 12 * 86_400
  })
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

for (const theme of ['light', 'dark'] as const) {
  test(`module — Kubernetes (${theme})`, async () => {
    mkdirSync(OUT, { recursive: true })
    const server = await startApiTestServer()
    server.enableCaretta({ realistic: true })
    server.enablePrometheus()
    // Cluster mẫu giống thật (nhiều namespace, Ingress / TLS, Service đủ loại, lỗi cấu hình…).
    server.seedDemo()
    const dir = mkdtempSync(join(tmpdir(), 'sh-scr-kube-'))
    writeFileSync(join(dir, 'config'), kubeconfig(server))
    const launched = await launchApp({ KUBECONFIG: join(dir, 'config') })
    const { page } = launched
    await page.setViewportSize({ width: 1440, height: 880 })
    page.setDefaultTimeout(10_000)
    const shot = shooter(page, theme)
    try {
      await setTheme(page, theme)
      await enableModule(page, 'k8s')
      await page.locator('[data-testid="k8s-context"][data-name="test"]').dblclick()
      const view = page.getByTestId('k8s-view')
      await view.getByTestId('k8s-namespace').click()
      await view.getByTestId('k8s-ns-default').click()
      await page.keyboard.press('Escape')
      const nav = async (id: string, group?: string): Promise<void> => {
        const item = page.getByTestId(`k8s-nav-${id}`)
        if (group && !(await item.isVisible()))
          await page.getByTestId(`k8s-nav-group-${group}`).click()
        await item.click()
        await page.waitForTimeout(700)
      }
      await shot('k8s-01-overview', () => nav('overview'))
      await shot('k8s-02-pods', () => nav('pods'))
      await shot('k8s-03-deployments', () => nav('deployments.apps'))
      await shot('k8s-04-services', () => nav('services', 'Service Discovery'))
      await shot('k8s-05-secrets', () => nav('secrets', 'Config'))
      await shot('k8s-06-nodes', () => nav('nodes', 'Cluster'))
      await shot('k8s-07-helm', () => nav('helm-releases', 'Apps'))
      // Chi tiết Deployment: các tab.
      const detail = view.getByTestId('k8s-describe')
      await shot('k8s-10-deploy-overview', async () => {
        await nav('deployments.apps')
        // Deployment có đủ mục (Status, Resources, Pods, ReplicaSets) — không phải dòng đầu bị lỗi.
        await view.locator('[data-testid="k8s-row"][data-name="shop/web"]').dblclick()
        await detail.waitFor()
        await detail.getByTestId('k8s-detail-tab-overview').click()
        await page.waitForTimeout(600)
      })
      for (const tab of ['metrics', 'topology', 'traffic', 'events']) {
        await shot(`k8s-11-deploy-${tab}`, async () => {
          await detail.getByTestId(`k8s-detail-tab-${tab}`).click()
          await page.waitForTimeout(tab === 'traffic' || tab === 'metrics' ? 4000 : 800)
        })
      }
      await page.keyboard.press('Escape')
      await shot('k8s-12-pod-detail', async () => {
        await nav('pods')
        await view.getByTestId('k8s-row').first().dblclick()
        await detail.waitFor()
        await detail.getByTestId('k8s-detail-tab-overview').click()
        await page.waitForTimeout(600)
      })
      await page.keyboard.press('Escape')
      await shot('k8s-14-secret-data', async () => {
        await nav('secrets', 'Config')
        await view.getByTestId('k8s-row').first().dblclick()
        await detail.waitFor()
      })
      await page.keyboard.press('Escape')
      // Bản đồ: Topology tĩnh (mặc định) — namespace shop, payments, monitoring.
      const map = view.getByTestId('k8s-map')
      await view.getByTestId('k8s-namespace').click()
      for (const ns of ['payments', 'monitoring']) await view.getByTestId(`k8s-ns-${ns}`).click()
      await page.keyboard.press('Escape')
      await shot('k8s-19-topology', async () => {
        await nav('map')
        await map.getByTestId('k8s-topo-canvas').waitFor()
        await page.waitForTimeout(2500)
      })
      // Menu namespace mở trên bản đồ: nằm trên thanh công cụ Map, không bị che mục đầu.
      await shot('k8s-19-topology-nsmenu', async () => {
        await view.getByTestId('k8s-namespace').click()
        await view.getByTestId('k8s-namespace-menu').waitFor()
      })
      await page.keyboard.press('Escape')
      await shot('k8s-19-topology-selected', async () => {
        await map.getByTestId('k8s-topo-search').fill('storefront')
        await map.getByTestId('k8s-topo-result').first().click()
        await page.waitForTimeout(1200)
      })
      await shot('k8s-19-topology-problems', async () => {
        await page.keyboard.press('Escape')
        await map.getByTestId('k8s-topo-problems').click()
        await page.waitForTimeout(800)
      })
      await shot('k8s-19-topology-focus', async () => {
        await page.keyboard.press('Escape')
        await map.getByTestId('k8s-topo-search').fill('api')
        await map.locator('[data-testid="k8s-topo-result"][data-kind="service"]').first().click()
        await view.getByTestId('k8s-topo-focus').click()
        await page.waitForTimeout(1200)
      })
      await shot('k8s-19-topology-pods', async () => {
        await view.getByTestId('k8s-topo-focus').click()
        await page.keyboard.press('Escape')
        await map.getByTestId('k8s-topo-search').fill('web')
        await map
          .locator('[data-testid="k8s-topo-result"][data-ref="deployments.apps"]')
          .first()
          .click()
        await page.waitForTimeout(800)
        await map
          .locator(
            '[data-testid="k8s-topo-node"][data-kind="pods"][data-name="wl:deployments.apps:shop/web"]'
          )
          .getByTestId('k8s-topo-pods-toggle')
          .click()
        await map.getByTestId('k8s-topo-pod').first().click()
        await page.waitForTimeout(1000)
      })
      await shot('k8s-19-topology-deps', async () => {
        await page.keyboard.press('Escape')
        await map.getByTestId('k8s-topo-view').click()
        await map.getByTestId('k8s-topo-deps').click()
        await page.keyboard.press('Escape')
        await map.getByTestId('k8s-topo-search').fill('api')
        await map
          .locator('[data-testid="k8s-topo-result"][data-ref="deployments.apps"]')
          .first()
          .click()
        await page.waitForTimeout(1200)
      })
      await shot('k8s-19-topology-fit', async () => {
        await page.keyboard.press('Escape')
        await map.getByTestId('k8s-topo-view').click()
        await map.getByTestId('k8s-topo-deps').click()
        await page.keyboard.press('Escape')
        await map.getByTestId('k8s-topo-fit').click()
        await page.waitForTimeout(1200)
      })
      await shot('k8s-20-map', async () => {
        await map.getByTestId('k8s-map-view-workloads').click()
        await map.getByTestId('k8s-map-canvas').waitFor()
        await page.waitForTimeout(2500)
      })
      await shot('k8s-20-map-zoomed', async () => {
        await map.getByTestId('k8s-map-search').fill('checkout')
        await map.locator('[data-testid="k8s-map-result"][data-kind="workload"]').first().click()
        await page.waitForTimeout(1200)
        await map.getByTestId('k8s-map-canvas').focus()
        await page.keyboard.press('Escape')
        await page.keyboard.press('+')
        await page.waitForTimeout(800)
      })
      await shot('k8s-21-map-selected', async () => {
        await map.getByTestId('k8s-map-search').fill('web')
        await map.getByTestId('k8s-map-result').first().click()
        await page.waitForTimeout(1500)
      })
      await shot('k8s-22-map-nodes', async () => {
        await map.getByTestId('k8s-map-view-nodes').click()
        await page.waitForTimeout(1500)
      })
      await shot('k8s-23-map-traffic', async () => {
        await map.getByTestId('k8s-map-view-traffic').click()
        await page.waitForTimeout(4000)
      })
      // Service map trên cluster giống thật: chỉ chọn console-stg (ingress-nginx, kube-system,
      // monitoring gộp theo namespace; địa chỉ ngoài cluster gộp "External (N)").
      await shot('k8s-24-traffic-scope', async () => {
        await view.getByTestId('k8s-namespace').click()
        for (const ns of ['shop', 'default', 'payments', 'monitoring'])
          if (await view.getByTestId(`k8s-ns-${ns}`).isChecked())
            await view.getByTestId(`k8s-ns-${ns}`).click()
        await view.getByTestId('k8s-ns-console-stg').click()
        await page.keyboard.press('Escape')
        await page.waitForTimeout(1500)
      })
      const tmap = view.getByTestId('k8s-traffic-map')
      await shot('k8s-25-traffic-selected', async () => {
        await tmap.locator('[data-testid="k8s-traffic-node"][data-name="console-api"]').click()
        await page.waitForTimeout(800)
      })
      await shot('k8s-26-traffic-external', async () => {
        // Tìm → chọn + đưa vào giữa khung; mở External theo nhóm (/16, tên miền).
        await tmap.getByTestId('k8s-traffic-search').fill('amazonaws')
        await tmap.getByTestId('k8s-traffic-search').press('Enter')
        await view.getByTestId('k8s-traffic-panel-expand').click()
        await tmap.getByTestId('k8s-traffic-search').fill('')
        await page.waitForTimeout(1200)
      })
      await shot('k8s-27-traffic-all-ns', async () => {
        await tmap.getByTestId('k8s-traffic-scope-toggle').click()
        await page.waitForTimeout(1500)
      })
      // Tab Traffic của Deployment: bản đồ nhỏ (bên gọi | workload | bên được gọi) trên danh sách.
      await shot('k8s-13-deploy-traffic-map', async () => {
        await nav('deployments.apps')
        await view
          .locator('[data-testid="k8s-row"][data-name="console-stg/console-api"]')
          .dblclick()
        await detail.getByTestId('k8s-detail-tab-traffic').click()
        await detail.getByTestId('k8s-traffic-focus-map').waitFor()
        await page.waitForTimeout(1500)
      })
      await page.keyboard.press('Escape')
      // Tạo tài nguyên.
      await shot('k8s-30-create', async () => {
        await nav('deployments.apps')
        await view.getByTestId('k8s-create').click()
        await page.getByTestId('k8s-create-dialog').waitFor()
      })
      await page.keyboard.press('Escape')
    } finally {
      await launched.close()
      await server.close()
    }
  })

  test(`module — Docker (${theme})`, async () => {
    test.skip(isWindows, 'Engine giả dùng unix socket')
    mkdirSync(OUT, { recursive: true })
    const engine = await startEngineTestServer()
    seedDockerProjects(engine)
    const launched = await launchApp({ DOCKER_HOST: `unix://${engine.path}` })
    const { page } = launched
    await page.setViewportSize({ width: 1440, height: 880 })
    page.setDefaultTimeout(10_000)
    const shot = shooter(page, theme)
    try {
      await setTheme(page, theme)
      await enableModule(page, 'docker')
      await page.getByTestId('docker-endpoint').first().dblclick()
      const view = page.getByTestId('docker-view')
      await shot('docker-01-containers', async () => {
        await view.getByTestId('docker-container').first().waitFor()
      })
      await shot('docker-02-detail', async () => {
        await view.locator('[data-testid="docker-container"][data-name="web"]').click()
        await page.waitForTimeout(2000)
      })
      await shot('docker-03-overview', () => page.getByTestId('docker-nav-overview').click())
      await shot('docker-04-images', () => page.getByTestId('docker-nav-images').click())
      await shot('docker-05-compose', () => page.getByTestId('docker-nav-compose').click())
      // Compose ở các độ rộng hay gặp (laptop 1366, màn hình 1920).
      for (const width of [1366, 1920]) {
        await shot(`docker-05-compose-${String(width)}`, async () => {
          await page.setViewportSize({ width, height: 880 })
        })
      }
      await page.setViewportSize({ width: 1440, height: 880 })
      await shot('docker-05-compose-collapsed', async () => {
        await view.getByTestId('docker-compose-expand-all').click()
      })
      await view.getByTestId('docker-compose-expand-all').click()
      await shot('docker-05-compose-menu', async () => {
        await view
          .locator('[data-testid="docker-project"][data-name="shop"]')
          .getByTestId('docker-compose-more')
          .click()
      })
      await page.keyboard.press('Escape')
      // Chọn nhiều dòng → thanh thao tác hàng loạt, hộp xác nhận tóm tắt mục bị bỏ qua.
      await shot('docker-08-bulk', async () => {
        await page.getByTestId('docker-nav-containers').click()
        await view.getByTestId('docker-select-all').click()
      })
      await shot('docker-09-bulk-dialog', async () => {
        await view.getByTestId('docker-bulk-stop').click()
        await page.getByTestId('docker-bulk-dialog').waitFor()
      })
      await page.keyboard.press('Escape')
      await view.getByTestId('docker-bulk-clear').click()
      await shot('docker-06-run', async () => {
        await page.getByTestId('docker-nav-containers').click()
        await view.getByTestId('docker-run').click()
        await page.getByTestId('docker-run-dialog').waitFor()
      })
      await page.keyboard.press('Escape')
      await shot('docker-07-logs', async () => {
        await view
          .locator('[data-testid="docker-container"][data-name="web"]')
          .getByTestId('docker-row-logs')
          .click()
        await page.getByTestId('docker-logs').waitFor()
        // Vài dòng error / warn để thấy màu theo mức và chip lọc; tô chỗ khớp khi tìm.
        const id = engine.containers.find((c) => c.Names[0] === '/web')?.Id ?? ''
        engine.log(id, 1, '2026-10-06T10:00:00Z INFO GET /api/products 200 38ms\n')
        engine.log(id, 1, '2026-10-06T10:00:01Z WARN slow query catalog.search 1.9s\n')
        engine.log(id, 1, '2026-10-06T10:00:02Z ERROR db: connection refused (10.0.0.5:5432)\n')
        engine.log(id, 1, '2026-10-06T10:00:03Z INFO GET /api/cart 200 12ms\n')
        await page.getByTestId('docker-log-line').filter({ hasText: '/api/cart' }).waitFor()
      })
      await shot('docker-07b-logs-search', async () => {
        await page.getByTestId('docker-logs-regex').click()
        await page.getByTestId('docker-logs-search').fill('/api/\\w+|refused')
      })
    } finally {
      await launched.close()
      await engine.close()
    }
  })

  test(`module — S3 (${theme})`, async () => {
    mkdirSync(OUT, { recursive: true })
    const server = await startS3TestServer(['demo', 'backups', 'logs'])
    const launched = await launchApp()
    const { page } = launched
    await page.setViewportSize({ width: 1440, height: 880 })
    page.setDefaultTimeout(10_000)
    const shot = shooter(page, theme)
    try {
      await setTheme(page, theme)
      await shot('s3-01-account-form', async () => {
        await page.getByTestId('activity-s3').click()
        await page.getByTestId('s3-add-account').click()
        const form = page.getByTestId('s3-account-form')
        await form.getByTestId('s3-account-name').fill('MinIO test')
        await form.getByTestId('s3-account-endpoint').fill(server.endpoint)
        await form.getByTestId('s3-account-key').fill(server.accessKeyId)
        await form.getByTestId('s3-account-secret').fill(server.secretAccessKey)
        await form.getByTestId('s3-account-path-style').check()
      })
      await page.getByTestId('s3-account-save').click()
      await page.locator('[data-testid="s3-account"][data-name="MinIO test"]').dblclick()
      const view = page.getByTestId('s3-view')
      await shot('s3-02-buckets', () => view.getByTestId('s3-bucket').first().waitFor())
      await shot('s3-03-objects', async () => {
        await view.locator('[data-testid="s3-bucket"][data-name="demo"]').dblclick()
        for (const f of ['reports', 'images']) {
          await view.getByTestId('s3-mkdir').click()
          await page.getByTestId('s3-dialog-input').fill(f)
          await page.getByTestId('s3-dialog-submit').click()
        }
      })
      await shot('s3-04-sync', async () => {
        await view.getByTestId('s3-crumb-account').click()
        await view.locator('[data-testid="s3-bucket"][data-name="demo"]').click()
        await view.getByTestId('s3-sync-bucket').click()
        await page.getByTestId('s3-sync-dialog').waitFor()
      })
      await page.keyboard.press('Escape')
    } finally {
      await launched.close()
      await server.close()
    }
  })
}

/**
 * Bản đồ K8s ở cửa sổ hẹp (sidebar host đầy đủ + danh sách tài nguyên): thanh công cụ không bị
 * bảng chi tiết che, các nút gọn dần, không đè nhau — ảnh screens/narrow-m-k8s-map-<rộng>-*.png.
 */
test('module — Kubernetes map at narrow widths', async () => {
  mkdirSync(OUT, { recursive: true })
  const server = await startApiTestServer()
  server.enableCaretta()
  server.seedDemo()
  const dir = mkdtempSync(join(tmpdir(), 'sh-scr-kube-'))
  writeFileSync(join(dir, 'config'), kubeconfig(server))
  const launched = await launchApp({ KUBECONFIG: join(dir, 'config') })
  const { page } = launched
  await page.setViewportSize({ width: 1366, height: 820 })
  page.setDefaultTimeout(10_000)
  try {
    await enableModule(page, 'k8s')
    await page.locator('[data-testid="k8s-context"][data-name="test"]').dblclick()
    const view = page.getByTestId('k8s-view')
    await view.getByTestId('k8s-namespace').click()
    for (const ns of ['default', 'payments']) await view.getByTestId(`k8s-ns-${ns}`).click()
    await page.keyboard.press('Escape')
    await page.getByTestId('k8s-nav-map').click()
    const map = view.getByTestId('k8s-map')
    await map.getByTestId('k8s-topo-canvas').waitFor()
    for (const width of [1366, 1180, 1024, 900]) {
      const shot = shooter(page, `narrow-${String(width)}`)
      await page.setViewportSize({ width, height: 820 })
      await page.waitForTimeout(400)
      const pick = async (name: string): Promise<void> => {
        const compact = await map.getByTestId('k8s-map-view-menu').count()
        if (compact) await map.getByTestId('k8s-map-view-menu').click()
        await map.getByTestId(`k8s-map-view-${name}`).click()
      }
      await shot('k8s-map-topology', async () => {
        await pick('topology')
        await page.keyboard.press('Escape')
        await page.waitForTimeout(1500)
      })
      await shot('k8s-map-topology-focus', async () => {
        await map.getByTestId('k8s-topo-search').fill('storefront')
        await map.getByTestId('k8s-topo-result').first().click()
        await view.getByTestId('k8s-topo-focus').click()
        await page.waitForTimeout(1200)
      })
      await page.keyboard.press('Escape')
      await shot('k8s-map-workloads', async () => {
        await pick('workloads')
        await map.getByTestId('k8s-map-search').fill('web')
        await map.locator('[data-testid="k8s-map-result"][data-kind="workload"]').first().click()
        await page.waitForTimeout(1500)
      })
      await shot('k8s-map-workloads-view-menu', async () => {
        await map.getByTestId('k8s-map-options').click()
        await page.waitForTimeout(400)
      })
      await page.keyboard.press('Escape')
    }
  } finally {
    await launched.close()
    await server.close()
  }
})

/**
 * Topology: định tuyến cạnh giống cluster thật — 2 Ingress × 2 luật, luật của frontend trỏ chéo sang
 * backend. Mỗi cạnh một làn dọc riêng, không chung đoạn dọc với cạnh khác đích.
 */
test('module — Kubernetes topology edge routing', async () => {
  mkdirSync(OUT, { recursive: true })
  const server = await startApiTestServer()
  const ns = 'routing-stg'
  server.upsert('namespaces', { metadata: { name: ns }, status: { phase: 'Active' } })
  for (const app of ['console-backend', 'console-frontend']) {
    server.upsert('deployments', {
      metadata: { name: app, namespace: ns },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app } },
        template: {
          metadata: { labels: { app } },
          spec: { containers: [{ name: app, image: `registry.example.com/${app}:1.4.2` }] }
        }
      },
      status: { replicas: 1, readyReplicas: 1, availableReplicas: 1, updatedReplicas: 1 }
    })
    server.upsert('services', {
      metadata: { name: `${app}-service`, namespace: ns },
      spec: {
        type: 'ClusterIP',
        clusterIP: app === 'console-backend' ? '10.43.20.11' : '10.43.20.12',
        selector: { app },
        ports: [{ port: 80, targetPort: 8080, protocol: 'TCP' }]
      }
    })
  }
  const path = (p: string, svc: string): unknown => ({
    path: p,
    pathType: 'Prefix',
    backend: { service: { name: svc, port: { number: 80 } } }
  })
  server.upsert('ingresses', {
    metadata: { name: 'console-backend-ingress', namespace: ns },
    spec: {
      ingressClassName: 'nginx',
      rules: [
        { host: 'api.stg.example.com', http: { paths: [path('/', 'console-backend-service')] } },
        {
          host: 'api-internal.stg.example.com',
          http: { paths: [path('/', 'console-backend-service')] }
        }
      ]
    }
  })
  server.upsert('ingresses', {
    metadata: { name: 'console-frontend-ingress', namespace: ns },
    spec: {
      ingressClassName: 'nginx',
      rules: [
        {
          host: 'console.stg.example.com',
          http: {
            paths: [path('/', 'console-frontend-service'), path('/api', 'console-backend-service')]
          }
        }
      ]
    }
  })
  const dir = mkdtempSync(join(tmpdir(), 'sh-scr-kube-'))
  writeFileSync(join(dir, 'config'), kubeconfig(server))
  const launched = await launchApp({ KUBECONFIG: join(dir, 'config') })
  const { page } = launched
  await page.setViewportSize({ width: 1440, height: 880 })
  page.setDefaultTimeout(10_000)
  const shot = shooter(page, 'light')
  try {
    await enableModule(page, 'k8s')
    await page.locator('[data-testid="k8s-context"][data-name="test"]').dblclick()
    const view = page.getByTestId('k8s-view')
    await view.getByTestId('k8s-namespace').click()
    await view.getByTestId(`k8s-ns-${ns}`).click()
    await page.keyboard.press('Escape')
    await page.getByTestId('k8s-nav-map').click()
    const map = view.getByTestId('k8s-map')
    await shot('k8s-19-topology-routing', async () => {
      await map.getByTestId('k8s-topo-canvas').waitFor()
      await page.waitForTimeout(2000)
    })
    // Phóng to quanh khe Entry → Services để thấy từng làn dọc.
    await shot('k8s-19-topology-routing-zoom', async () => {
      await page.mouse.move(770, 360)
      await page.keyboard.down('Control')
      for (let i = 0; i < 6; i++) {
        await page.mouse.wheel(0, -100)
        await page.waitForTimeout(120)
      }
      await page.keyboard.up('Control')
      await page.waitForTimeout(800)
    })
  } finally {
    await launched.close()
    await server.close()
  }
})
