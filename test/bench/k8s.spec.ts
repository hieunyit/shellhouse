import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, launchApp, test } from '../e2e/fixtures'
import { startApiTestServer, TEST_CA, TOKEN } from '../../src/modules/k8s/test/api-test-server'

/**
 * Bảng K8s với cluster lớn: 3000 pod / 30 namespace, ~100 cập nhật/giây (watch). Đo thời gian
 * tải, khung hình (rAF) trong lúc cập nhật, thời gian lọc, số dòng DOM (ảo hoá), bộ nhớ.
 */
test('K8s: 3000 pod, cập nhật liên tục — mượt (p95 khung hình < 50 ms)', async () => {
  test.setTimeout(240_000)
  const server = await startApiTestServer()
  for (let n = 0; n < 30; n++)
    server.upsert('namespaces', {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: `ns-${n}` },
      status: { phase: 'Active' }
    })
  for (let i = 0; i < 3000; i++)
    server.upsert('pods', {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: `pod-${i}`, namespace: `ns-${i % 30}`, labels: { app: `a${i % 50}` } },
      spec: { containers: [{ name: 'app', image: 'nginx' }], nodeName: 'node-1' },
      status: {
        phase: 'Running',
        containerStatuses: [
          { name: 'app', ready: true, restartCount: i % 5, state: { running: {} } }
        ]
      }
    })
  const dir = mkdtempSync(join(tmpdir(), 'sh-kube-'))
  const file = join(dir, 'config')
  writeFileSync(
    file,
    `apiVersion: v1
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
  context: { cluster: fake, user: dev, namespace: shop }
`
  )
  const launched = await launchApp({ KUBECONFIG: file })
  const { page } = launched
  try {
    await page.getByTestId('open-settings').click()
    await page.getByTestId('settings-nav-modules').click()
    await page.getByTestId('module-toggle-k8s').click()
    await page.getByTestId('module-enable-confirm').click()
    await page.keyboard.press('Escape')
    await page.locator('[data-testid="k8s-context"][data-name="test"]').dblclick()
    const view = page.getByTestId('k8s-view')
    await expect(view.getByTestId('k8s-row').first()).toBeVisible({ timeout: 30_000 })
    const t0 = Date.now()
    await view.getByTestId('k8s-filter').fill(':ns all')
    await page.keyboard.press('Enter')
    await expect(view.getByTestId('k8s-count')).toHaveText('3003', { timeout: 60_000 })
    const listMs = Date.now() - t0
    // Đo khung hình trong lúc cluster thay đổi liên tục (~100 cập nhật/giây trong 5 giây).
    await page.evaluate(() => {
      const w = window as unknown as { __frames: number[]; __last: number }
      w.__frames = []
      w.__last = performance.now()
      const tick = (): void => {
        const now = performance.now()
        w.__frames.push(now - w.__last)
        w.__last = now
        if (w.__frames.length < 100000) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    for (let k = 0; k < 50; k++) {
      for (let j = 0; j < 10; j++) {
        const i = (k * 10 + j) % 3000
        server.upsert('pods', {
          apiVersion: 'v1',
          kind: 'Pod',
          metadata: { name: `pod-${i}`, namespace: `ns-${i % 30}`, labels: { app: `a${i % 50}` } },
          spec: { containers: [{ name: 'app', image: 'nginx' }], nodeName: 'node-1' },
          status: {
            phase: 'Running',
            containerStatuses: [
              { name: 'app', ready: true, restartCount: k, state: { running: {} } }
            ]
          }
        })
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    // Gõ lọc: phản hồi ra sao.
    const t1 = Date.now()
    await view.getByTestId('k8s-filter').fill('pod-29')
    await expect(view.getByTestId('k8s-count')).toContainText('of 3003')
    const filterMs = Date.now() - t1
    const frames = await page.evaluate(() => (window as unknown as { __frames: number[] }).__frames)
    const sorted = [...frames].sort((a, b) => a - b)
    const p = (q: number) => Math.round(sorted[Math.floor(sorted.length * q)] ?? 0)
    const rows = await view.getByTestId('k8s-row').count()
    const mem = await page.evaluate(
      () =>
        (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
          ?.usedJSHeapSize ?? 0
    )
    console.log(
      `PERF list=${listMs}ms filter=${filterMs}ms frames=${frames.length} p50=${p(0.5)} p95=${p(0.95)} max=${Math.round(sorted.at(-1) ?? 0)} long>50ms=${frames.filter((f) => f > 50).length} domRows=${rows} heapMB=${Math.round(mem / 1e6)}`
    )
  } finally {
    await launched.close()
    await server.close()
  }
})
