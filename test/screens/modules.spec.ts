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
import { startEngineTestServer } from '../../src/modules/docker/test/engine-test-server'
import { startS3TestServer } from '../../src/modules/s3/test/s3-test-server'

/**
 * Chụp màn hình các module (Kubernetes, Docker, S3) ở cả sáng và tối để rà soát giao diện.
 *   pnpm build && pnpm screens      → ảnh trong screens/<theme>-m-<tên>.png
 * Mỗi ảnh chụp độc lập: một bước lỗi chỉ bỏ ảnh đó (ghi ra console), không dừng cả lượt.
 */
const OUT = 'screens'
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
}

function shooter(page: Page, theme: string) {
  return async (name: string, steps: () => Promise<void>, target?: Locator): Promise<void> => {
    try {
      await steps()
      await page.waitForTimeout(500)
      await (target ?? page).screenshot({ path: join(OUT, `${theme}-m-${name}.png`) })
    } catch (e) {
      console.log(`SKIP ${theme}-m-${name}: ${String(e).split('\n')[0] ?? ''}`)
    }
  }
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
    server.enableCaretta()
    server.enablePrometheus()
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
        const item = view.getByTestId(`k8s-nav-${id}`)
        if (group && !(await item.isVisible()))
          await view.getByTestId(`k8s-nav-group-${group}`).click()
        await item.click()
        await page.waitForTimeout(700)
      }
      await shot('k8s-01-overview', () => nav('overview'))
      await shot('k8s-02-pods', () => nav('pods'))
      await shot('k8s-03-deployments', () => nav('deployments.apps'))
      await shot('k8s-04-services', () => nav('services', 'Service Discovery'))
      await shot('k8s-05-secrets', () => nav('secrets', 'Storage'))
      await shot('k8s-06-nodes', () => nav('nodes', 'Cluster'))
      await shot('k8s-07-helm', () => nav('helm-releases', 'Apps'))
      // Chi tiết Deployment: các tab.
      const detail = view.getByTestId('k8s-describe')
      await shot('k8s-10-deploy-overview', async () => {
        await nav('deployments.apps')
        await view.getByTestId('k8s-row').first().dblclick()
        await detail.waitFor()
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
      })
      await page.keyboard.press('Escape')
      await shot('k8s-14-secret-data', async () => {
        await nav('secrets', 'Storage')
        await view.getByTestId('k8s-row').first().dblclick()
        await detail.waitFor()
      })
      await page.keyboard.press('Escape')
      // Bản đồ.
      const map = view.getByTestId('k8s-map')
      await shot('k8s-20-map', async () => {
        await nav('map')
        await map.waitFor()
        await page.waitForTimeout(2500)
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
    const launched = await launchApp({ DOCKER_HOST: `unix://${engine.path}` })
    const { page } = launched
    await page.setViewportSize({ width: 1440, height: 880 })
    page.setDefaultTimeout(10_000)
    const shot = shooter(page, theme)
    try {
      await setTheme(page, theme)
      await enableModule(page, 'docker')
      await page.locator('[data-testid="docker-endpoint"][data-name="This computer"]').dblclick()
      const view = page.getByTestId('docker-view')
      await shot('docker-01-containers', async () => {
        await view.getByTestId('docker-container').first().waitFor()
      })
      await shot('docker-02-detail', async () => {
        await view.locator('[data-testid="docker-container"][data-name="web"]').click()
        await page.waitForTimeout(2000)
      })
      await shot('docker-03-overview', () => view.getByTestId('docker-nav-overview').click())
      await shot('docker-04-images', () => view.getByTestId('docker-nav-images').click())
      await shot('docker-05-compose', () => view.getByTestId('docker-nav-compose').click())
      await shot('docker-06-run', async () => {
        await view.getByTestId('docker-nav-containers').click()
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
