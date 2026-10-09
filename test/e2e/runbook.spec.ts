import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { startEngineTestServer } from '../../src/modules/docker/test/engine-test-server'
import {
  startApiTestServer,
  TEST_CA,
  TOKEN,
  type ApiTestServer
} from '../../src/modules/k8s/test/api-test-server'
import { startTestSshServer } from '../integration/ssh-test-server'
import { expect, isWindows, launchApp, openArea, setWindowSize, test } from './fixtures'

/**
 * Runbook (ADR-016): soạn → lưu → chạy các bước HTTP / Docker / Kubernetes / lệnh SSH; lỗi dừng
 * runbook; biến; Production gõ lại tên; môi trường chỉ đọc chặn lệnh. Đặt ở test/e2e vì cần giả lập
 * của nhiều module (module không import module khác).
 */

/** Bật các module trong một lần vào Settings › Modules (xác nhận quyền từng module). */
async function enableModules(page: Page, ids: string[]): Promise<void> {
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-nav-modules').click()
  for (const id of ids) {
    await page.getByTestId(`module-toggle-${id}`).click()
    await page.getByTestId('module-enable-confirm').click()
    await expect(page.getByTestId(`module-toggle-${id}`)).toHaveAttribute('aria-checked', 'true')
  }
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

async function webServer(): Promise<{
  port: number
  /** Số lần đã gọi một đường dẫn. */
  hits(path: string): number
  close(): Promise<void>
}> {
  const sockets = new Set<{ destroy(): void }>()
  const hits = new Map<string, number>()
  const server: Server = createServer((req, res) => {
    const path = req.url ?? ''
    hits.set(path, (hits.get(path) ?? 0) + 1)
    if (path === '/slow') {
      setTimeout(() => res.end('late'), 15_000)
      return
    }
    if (path === '/auth') {
      // Cần token đúng — giá trị bí mật lưu trong vault, chỉ Session Host thấy.
      res.statusCode = req.headers['x-token'] === 's3cret-token' ? 200 : 401
      res.end(res.statusCode === 200 ? 'authorized' : 'no token')
      return
    }
    if (path === '/down') {
      res.statusCode = 503
      res.end('upstream down')
    } else res.end('{"ok":true}')
  })
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as { port: number }).port,
    hits: (path) => hits.get(path) ?? 0,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy()
        server.close(() => {
          resolve()
        })
      })
  }
}

/** Tab runbook đang hiện (tab khác vẫn giữ trong DOM). */
const view = (page: Page) => page.locator('[data-testid="runbook-view"][data-active="true"]')
const stepAt = (page: Page, i: number) => view(page).getByTestId('runbook-step').nth(i)

async function addStep(page: Page, label: string): Promise<void> {
  await view(page).getByTestId('runbook-add-step').click()
  await page.getByRole('menuitem', { name: label }).click()
}

async function newRunbook(page: Page, name: string): Promise<void> {
  await page.getByTestId('runbook-new').click()
  await view(page).getByTestId('runbook-name').fill(name)
}

async function run(page: Page): Promise<void> {
  await view(page).getByTestId('runbook-run').click()
  await page.getByTestId('runbook-run-confirm').click()
}

const summary = (page: Page) => view(page).getByTestId('runbook-summary-text')

test('Runbook: HTTP + Docker + Kubernetes + lệnh SSH chạy một cú nhấp; lỗi dừng; biến; lịch sử', async () => {
  test.setTimeout(150_000)
  test.skip(isWindows, 'Engine giả dùng unix socket; SSH giả chạy /bin/sh')
  const web = await webServer()
  const engine = await startEngineTestServer()
  const k8s = await startApiTestServer()
  k8s.seedDemo()
  k8s.upsert('deployments', {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'ready-app', namespace: 'shop' },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: 'r' } },
      template: {
        metadata: { labels: { app: 'r' } },
        spec: { containers: [{ name: 'c', image: 'x' }] }
      }
    },
    status: { replicas: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 }
  })
  const home = mkdtempSync(join(tmpdir(), 'sh-runbook-home-'))
  const ssh = await startTestSshServer([{ username: 'u', password: 'p' }], { execHome: home })
  const dir = mkdtempSync(join(tmpdir(), 'sh-runbook-kube-'))
  const kubeFile = join(dir, 'config')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(kubeFile, kubeconfig(k8s))
  chmodSync(kubeFile, 0o600)
  const launched = await launchApp({ DOCKER_HOST: `unix://${engine.path}`, KUBECONFIG: kubeFile })
  const { page } = launched
  try {
    const saved = await page.evaluate(
      (port) =>
        window.shellhouse.saveHost({
          groupId: null,
          label: 'build-box',
          hostname: '127.0.0.1',
          port,
          username: 'u',
          auth: 'auto',
          keyId: null,
          keyFile: null,
          proxyJump: null,
          jumpHostIds: [],
          mode: 'builtin',
          tags: [],
          color: null
        }),
      ssh.port
    )
    if (!saved.ok) throw new Error(saved.message)
    await enableModules(page, ['docker', 'k8s', 'runbook'])
    await setWindowSize(launched, 1366, 900)
    await openArea(page, 'runbook')
    await expect(page.getByTestId('runbook-section-empty')).toBeVisible()

    // ——— Soạn: bốn loại bước ———
    await newRunbook(page, 'After deploy')
    await expect(view(page).getByTestId('runbook-empty')).toBeVisible()
    await view(page).getByTestId('runbook-description').fill('Checks after every release')

    await addStep(page, 'HTTP check')
    await stepAt(page, 0)
      .getByTestId('runbook-http-url')
      .fill(`http://127.0.0.1:${String(web.port)}/health`)
    await stepAt(page, 0).getByTestId('runbook-http-contains').fill('"ok":true')

    await addStep(page, 'Docker: container is healthy')
    await stepAt(page, 1).getByTestId('runbook-docker-container').fill('web')
    await stepAt(page, 1).getByTestId('runbook-docker-expect').selectOption('healthy')

    await addStep(page, 'Kubernetes: rollout is ready')
    await stepAt(page, 2).getByTestId('runbook-k8s-context').selectOption({ label: 'test' })
    await stepAt(page, 2).getByTestId('runbook-k8s-namespace').fill('shop')
    await stepAt(page, 2).getByTestId('runbook-k8s-name').fill('ready-app')

    await addStep(page, 'Command on a server')
    await stepAt(page, 3)
      .getByTestId('runbook-command-host')
      .selectOption({ label: 'build-box · u@127.0.0.1' })
    await stepAt(page, 3).getByTestId('runbook-command-text').fill('echo sum-$((40+2))')
    await stepAt(page, 3).getByTestId('runbook-command-contains').fill('sum-42')

    await expect(view(page).getByTestId('runbook-dirty')).toBeVisible()
    await view(page).getByTestId('runbook-save').click()
    await expect(view(page).getByTestId('runbook-dirty')).toHaveCount(0)
    await expect(
      page.locator('[data-testid="runbook-row"][data-name="After deploy"]')
    ).toBeVisible()

    // ——— Chạy: cả bốn bước đạt (SSH hỏi host key + mật khẩu như mọi kết nối khác) ———
    await view(page).getByTestId('runbook-run').click()
    await page.getByTestId('runbook-run-confirm').click()
    await page.getByTestId('hostkey-accept').click()
    await page.getByTestId('prompt-input').fill('p')
    await page.getByTestId('prompt-submit').click()
    await expect(summary(page)).toHaveAttribute('data-ok', 'true', { timeout: 60_000 })
    await expect(summary(page)).toContainText('All 4 steps passed')
    for (let i = 0; i < 4; i++) await expect(stepAt(page, i)).toHaveAttribute('data-status', 'pass')
    await expect(stepAt(page, 0).getByTestId('runbook-step-detail')).toHaveText('HTTP 200')
    await expect(stepAt(page, 1).getByTestId('runbook-step-detail')).toContainText('healthy')
    await expect(stepAt(page, 2).getByTestId('runbook-step-detail')).toHaveText(
      '1/1 replicas ready, 1 updated'
    )
    await expect(stepAt(page, 3).getByTestId('runbook-step-output')).toHaveText('sum-42')
    await expect(view(page).getByTestId('runbook-history-row')).toHaveCount(1)

    // ——— Lỗi dừng runbook: bước 2 (cần 2/2 nhưng chỉ 1 sẵn sàng) lỗi → các bước sau "skipped" ———
    await stepAt(page, 2).getByTestId('runbook-k8s-name').fill('web')
    await stepAt(page, 2).getByTestId('runbook-step-timeout').fill('3')
    await run(page)
    await expect(summary(page)).toHaveAttribute('data-ok', 'false', { timeout: 60_000 })
    await expect(stepAt(page, 2)).toHaveAttribute('data-status', 'fail')
    await expect(stepAt(page, 2).getByTestId('runbook-step-detail')).toHaveText(
      '1/2 replicas ready, 2 updated'
    )
    await expect(stepAt(page, 3)).toHaveAttribute('data-status', 'skipped')
    await expect(summary(page)).toContainText('2 passed, 1 failed, 1 skipped')

    // "Keep going" → bước sau vẫn chạy (SSH đã nhớ host key / phiên mới hỏi lại mật khẩu).
    await stepAt(page, 2).getByTestId('runbook-step-continue').check()
    await run(page)
    await page.getByTestId('prompt-input').fill('p')
    await page.getByTestId('prompt-submit').click()
    await expect(summary(page)).toHaveAttribute('data-ok', 'false', { timeout: 60_000 })
    await expect(stepAt(page, 3)).toHaveAttribute('data-status', 'pass')

    // Chép kết quả vào clipboard.
    await view(page).getByTestId('runbook-copy-results').click()
  } finally {
    await launched.close()
    await ssh.close()
    await k8s.close()
    await engine.close()
    await web.close()
    rmSync(home, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Runbook: HTTP lỗi dừng / tiếp tục, biến {{x}} bắt buộc, Docker không có healthcheck', async () => {
  test.setTimeout(90_000)
  test.skip(isWindows, 'Engine giả dùng unix socket')
  const web = await webServer()
  const engine = await startEngineTestServer()
  const launched = await launchApp({ DOCKER_HOST: `unix://${engine.path}` })
  const { page } = launched
  try {
    await enableModules(page, ['docker', 'runbook'])
    await setWindowSize(launched, 1366, 900)
    await openArea(page, 'runbook')

    await newRunbook(page, 'Smoke')
    await addStep(page, 'HTTP check')
    await stepAt(page, 0).getByTestId('runbook-http-url').fill(`http://127.0.0.1:{{port}}/down`)
    await addStep(page, 'HTTP check')
    await stepAt(page, 1).getByTestId('runbook-http-url').fill(`http://127.0.0.1:{{port}}/health`)
    await view(page).getByTestId('runbook-save').click()

    // Biến bắt buộc: chưa nhập thì không chạy được.
    await view(page).getByTestId('runbook-run').click()
    await expect(page.getByTestId('runbook-run-confirm')).toBeDisabled()
    await page.getByTestId('runbook-var-port').fill(String(web.port))
    await expect(page.getByTestId('runbook-run-confirm')).toBeEnabled()
    await page.getByTestId('runbook-run-confirm').click()
    await expect(summary(page)).toHaveAttribute('data-ok', 'false', { timeout: 30_000 })
    await expect(stepAt(page, 0).getByTestId('runbook-step-detail')).toHaveText(
      'HTTP 503 (expected 200)'
    )
    await expect(stepAt(page, 0).getByTestId('runbook-step-output')).toHaveText('upstream down')
    await expect(stepAt(page, 1)).toHaveAttribute('data-status', 'skipped')

    // Tiếp tục khi lỗi: bước 2 vẫn chạy và đạt.
    await stepAt(page, 0).getByTestId('runbook-step-continue').check()
    await view(page).getByTestId('runbook-run').click()
    await page.getByTestId('runbook-var-port').fill(String(web.port))
    await page.getByTestId('runbook-run-confirm').click()
    await expect(stepAt(page, 1)).toHaveAttribute('data-status', 'pass', { timeout: 30_000 })
    await expect(summary(page)).toContainText('1 passed, 1 failed, 0 skipped')

    // Chạy lại bước lỗi: chỉ bước 1 chạy lại; bước 2 giữ kết quả đạt, không gọi lại.
    const healthHits = web.hits('/health')
    await view(page).getByTestId('runbook-rerun-failed').click()
    await expect(page.getByTestId('runbook-run-dialog')).toContainText('1 step, in order')
    await page.getByTestId('runbook-var-port').fill(String(web.port))
    await page.getByTestId('runbook-run-confirm').click()
    await expect(stepAt(page, 0)).toHaveAttribute('data-status', 'fail', { timeout: 30_000 })
    await expect(summary(page)).toContainText('1 passed, 1 failed, 0 skipped')
    await expect(stepAt(page, 1)).toHaveAttribute('data-status', 'pass')
    expect(web.hits('/health')).toBe(healthHits)

    // Thu gọn bước: ẩn form, vẫn thấy kết quả.
    await stepAt(page, 0).getByTestId('runbook-step-toggle').click()
    await expect(stepAt(page, 0)).toHaveAttribute('data-expanded', 'false')
    await expect(stepAt(page, 0).getByTestId('runbook-http-url')).toHaveCount(0)
    await expect(stepAt(page, 0).getByTestId('runbook-step-result')).toBeVisible()
    await stepAt(page, 0).getByTestId('runbook-step-toggle').click()

    // Dừng giữa chừng → báo "Stopped", không ghi lịch sử.
    const historyRows = await view(page).getByTestId('runbook-history-row').count()
    await stepAt(page, 0).getByTestId('runbook-http-url').fill('http://127.0.0.1:{{port}}/slow')
    await view(page).getByTestId('runbook-run').click()
    await page.getByTestId('runbook-var-port').fill(String(web.port))
    await page.getByTestId('runbook-run-confirm').click()
    await expect(stepAt(page, 0)).toHaveAttribute('data-status', 'running')
    await view(page).getByTestId('runbook-stop').click()
    await expect(summary(page)).toHaveAttribute('data-stopped', 'true')
    await expect(summary(page)).toContainText('Stopped')
    await expect(view(page).getByTestId('runbook-history-row')).toHaveCount(historyRows)
    await stepAt(page, 0).getByTestId('runbook-http-url').fill('http://127.0.0.1:{{port}}/down')

    // Docker: container không có healthcheck mà đòi "healthy" → lỗi rõ, không chờ hết giờ.
    await addStep(page, 'Docker: container is healthy')
    await stepAt(page, 2).getByTestId('runbook-docker-container').fill('db')
    await stepAt(page, 2).getByTestId('runbook-docker-expect').selectOption('healthy')
    await stepAt(page, 0)
      .getByTestId('runbook-http-url')
      .fill(`http://127.0.0.1:${String(web.port)}/health`)
    await stepAt(page, 1)
      .getByTestId('runbook-http-url')
      .fill(`http://127.0.0.1:${String(web.port)}/health`)
    await run(page)
    await expect(stepAt(page, 2)).toHaveAttribute('data-status', 'fail', { timeout: 30_000 })
    await expect(stepAt(page, 2).getByTestId('runbook-step-detail')).toContainText(
      'no health check'
    )

    // Xoá bước, sắp xếp lại; chưa lưu thì báo "Unsaved changes".
    await stepAt(page, 2).getByTestId('runbook-step-remove').click()
    await expect(view(page).getByTestId('runbook-step')).toHaveCount(2)
    await stepAt(page, 1).getByTestId('runbook-step-up').click()
    await expect(view(page).getByTestId('runbook-dirty')).toBeVisible()
    await view(page).getByTestId('runbook-save').click()
    await expect(view(page).getByTestId('runbook-dirty')).toHaveCount(0)

    // Đóng tab khi còn thay đổi chưa lưu → hỏi; Cancel giữ tab.
    await view(page).getByTestId('runbook-description').fill('edited')
    const tab = page.getByTestId('tab').filter({ hasText: 'Smoke' })
    await tab.getByTestId('tab-close').click()
    await page.getByTestId('close-tab-confirm').getByTestId('confirm-cancel').click()
    await expect(view(page)).toBeVisible()
    await tab.getByTestId('tab-close').click()
    await page.getByTestId('close-tab-confirm').getByTestId('confirm-ok').click()
    await expect(view(page)).toHaveCount(0)
  } finally {
    await launched.close()
    await engine.close()
    await web.close()
  }
})

test('Runbook: Production gõ lại tên; môi trường chỉ đọc chặn lệnh nhưng vẫn chạy kiểm tra', async () => {
  test.setTimeout(120_000)
  test.skip(isWindows, 'Engine giả dùng unix socket; SSH giả chạy /bin/sh')
  const web = await webServer()
  const home = mkdtempSync(join(tmpdir(), 'sh-runbook-home-'))
  const ssh = await startTestSshServer([{ username: 'u', password: 'p' }], { execHome: home })
  const launched = await launchApp()
  const { page } = launched
  try {
    // Host đỏ = Production (suy từ màu cũ).
    const saved = await page.evaluate(
      (port) =>
        window.shellhouse.saveHost({
          groupId: null,
          label: 'prod-box',
          hostname: '127.0.0.1',
          port,
          username: 'u',
          auth: 'auto',
          keyId: null,
          keyFile: null,
          proxyJump: null,
          jumpHostIds: [],
          mode: 'builtin',
          tags: [],
          color: 'red'
        }),
      ssh.port
    )
    if (!saved.ok) throw new Error(saved.message)
    await enableModules(page, ['runbook'])
    await setWindowSize(launched, 1366, 900)
    await openArea(page, 'runbook')

    await newRunbook(page, 'Prod check')
    await addStep(page, 'HTTP check')
    await stepAt(page, 0)
      .getByTestId('runbook-http-url')
      .fill(`http://127.0.0.1:${String(web.port)}/health`)
    await addStep(page, 'Command on a server')
    await stepAt(page, 1)
      .getByTestId('runbook-command-host')
      .selectOption({ label: 'prod-box · u@127.0.0.1' })
    await stepAt(page, 1).getByTestId('runbook-command-text').fill('echo alive')
    // Bước lệnh thứ hai trên cùng host: dùng chung phiên → không hỏi mật khẩu lần nữa.
    await addStep(page, 'Command on a server')
    await stepAt(page, 2)
      .getByTestId('runbook-command-host')
      .selectOption({ label: 'prod-box · u@127.0.0.1' })
    await stepAt(page, 2).getByTestId('runbook-command-text').fill('echo again')
    await view(page).getByTestId('runbook-save').click()

    // Đích là Production → phải gõ lại tên runbook; gõ sai thì không chạy.
    await view(page).getByTestId('runbook-run').click()
    await expect(page.getByTestId('runbook-run-production')).toBeVisible()
    const confirm = page.getByTestId('runbook-run-confirm')
    await expect(confirm).toBeDisabled()
    await page.getByTestId('runbook-run-typed').fill('Prod chec')
    await expect(confirm).toBeDisabled()
    await page.getByTestId('runbook-run-typed').fill('Prod check')
    await expect(confirm).toBeEnabled()
    await confirm.click()
    await page.getByTestId('hostkey-accept').click()
    await page.getByTestId('prompt-input').fill('p')
    await page.getByTestId('prompt-submit').click()
    await expect(summary(page)).toHaveAttribute('data-ok', 'true', { timeout: 60_000 })
    await expect(stepAt(page, 2).getByTestId('runbook-step-output')).toHaveText('again')

    // Production chỉ đọc → bước lệnh bị chặn, bước HTTP (chỉ đọc) vẫn chạy.
    await page.evaluate(() =>
      window.shellhouse.updateSettings({
        environments: [
          {
            id: 'prod',
            name: 'Production',
            short: 'Prod',
            description: '',
            highlight: true,
            topLine: true,
            confirm: 'type',
            readOnly: true
          }
        ]
      })
    )
    await view(page).getByTestId('runbook-run').click()
    await expect(page.getByTestId('runbook-run-blocked')).toContainText('echo alive')
    await page.getByTestId('runbook-run-typed').fill('Prod check')
    await page.getByTestId('runbook-run-confirm').click()
    await expect(summary(page)).toHaveAttribute('data-ok', 'false', { timeout: 30_000 })
    await expect(stepAt(page, 0)).toHaveAttribute('data-status', 'pass')
    await expect(stepAt(page, 1)).toHaveAttribute('data-status', 'blocked')
    // Bước bị chặn dừng runbook như bước lỗi.
    await expect(stepAt(page, 2)).toHaveAttribute('data-status', 'skipped')
    await expect(stepAt(page, 1).getByTestId('runbook-step-detail')).toContainText(
      'read-only environment Production'
    )

    // Xoá runbook qua thanh bên (hỏi lại).
    await page
      .locator('[data-testid="runbook-row"][data-name="Prod check"]')
      .click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Delete' }).click()
    await page.getByTestId('confirm-ok').click()
    await expect(page.locator('[data-testid="runbook-row"]')).toHaveCount(0)
    // Tab của runbook đã xoá đóng theo.
    await expect(view(page)).toHaveCount(0)
  } finally {
    await launched.close()
    await ssh.close()
    await web.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('Runbook: header bí mật (vault), xuất / nhập file, nhân bản, xem lại chi tiết lần chạy cũ', async () => {
  test.setTimeout(90_000)
  const web = await webServer()
  const dir = mkdtempSync(join(tmpdir(), 'sh-runbook-files-'))
  const launched = await launchApp()
  const { page, app } = launched
  try {
    await enableModules(page, ['runbook'])
    await setWindowSize(launched, 1366, 900)
    await openArea(page, 'runbook')

    // ——— HTTP có header bí mật: gõ giá trị → vào vault, giao diện chỉ còn "đã lưu" ———
    await newRunbook(page, 'Api check')
    await addStep(page, 'HTTP check')
    const step = stepAt(page, 0)
    await step.getByTestId('runbook-http-url').fill(`http://127.0.0.1:${String(web.port)}/auth`)
    await step.getByTestId('runbook-http-add-header').click()
    await step.getByTestId('runbook-header-name').fill('X-Token')
    await step.getByTestId('runbook-header-secret-toggle').click()
    await step.getByTestId('runbook-header-secret').fill('s3cret-token')
    await step.getByTestId('runbook-header-secret').press('Enter')
    await expect(step.getByTestId('runbook-header-secret-stored')).toBeVisible()
    await view(page).getByTestId('runbook-save').click()
    await expect(view(page).getByTestId('runbook-dirty')).toHaveCount(0)
    await run(page)
    await expect(summary(page)).toHaveAttribute('data-ok', 'true', { timeout: 30_000 })
    await expect(step.getByTestId('runbook-step-detail')).toHaveText('HTTP 200')
    // Bí mật không nằm trong dữ liệu runbook mà renderer giữ.
    expect(
      await page.evaluate(() =>
        window.shellhouse.invokeModule('runbook', 'list', []).then((r) => JSON.stringify(r))
      )
    ).not.toContain('s3cret-token')

    // ——— Lịch sử: mở một lần chạy cũ xem từng bước ———
    await view(page).getByTestId('runbook-history').locator('summary').first().click()
    await view(page).getByTestId('runbook-history-row').first().locator('summary').click()
    await expect(view(page).getByTestId('runbook-history-detail').first()).toContainText('HTTP 200')

    // ——— Xuất ra file: có tên header, không có giá trị bí mật ———
    const exported = join(dir, 'api.runbook.json')
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: file })
    }, exported)
    await view(page).getByTestId('runbook-export').click()
    await expect(page.getByTestId('toast').filter({ hasText: 'Saved to' })).toBeVisible()
    const text = readFileSync(exported, 'utf8')
    expect(text).toContain('"X-Token"')
    expect(text).not.toContain('s3cret-token')
    expect(text).not.toContain('secretId')

    // ——— Nhập lại: tên trùng → "(2)"; báo phải nhập lại giá trị bí mật ———
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [file] })
    }, exported)
    await page.getByTestId('runbook-more').click()
    await page.getByRole('menuitem', { name: 'Import runbooks…' }).click()
    await expect(
      page.locator('[data-testid="runbook-row"][data-name="Api check (2)"]')
    ).toBeVisible()
    await expect(
      page.getByTestId('toast').filter({ hasText: 'secret header value is not in the file' })
    ).toBeVisible()
    // Runbook nhập mở sẵn; bước có header bí mật chưa có giá trị → chưa đủ.
    await expect(view(page).getByTestId('runbook-name')).toHaveValue('Api check (2)')
    await expect(stepAt(page, 0).getByTestId('runbook-step-incomplete')).toBeVisible()

    // ——— Nhân bản từ thanh bên ———
    await page
      .locator('[data-testid="runbook-row"][data-name="Api check"]')
      .click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Duplicate' }).click()
    await expect(
      page.locator('[data-testid="runbook-row"][data-name="Api check (copy)"]')
    ).toBeVisible()
    await expect(view(page).getByTestId('runbook-name')).toHaveValue('Api check (copy)')
    // Bản sao dùng được ngay bí mật đã lưu.
    await stepAt(page, 0).getByTestId('runbook-step-toggle').click()
    await expect(stepAt(page, 0).getByTestId('runbook-header-secret-stored')).toBeVisible()
    await run(page)
    await expect(summary(page)).toHaveAttribute('data-ok', 'true', { timeout: 30_000 })
  } finally {
    await launched.close()
    await web.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
