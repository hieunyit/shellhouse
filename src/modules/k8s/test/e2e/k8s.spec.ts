import { connect } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

    // Mô tả: sự kiện liên quan.
    await view.locator('[data-testid="k8s-row"][data-name="shop/web-2"]').click()
    await expect(view.getByTestId('k8s-events')).toContainText('BackOff')

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

    // Scale deployment.
    await page.getByTestId('tab').filter({ hasText: 'test' }).first().click()
    await view.getByTestId('k8s-nav-deployments.apps').click()
    await view.locator('[data-testid="k8s-row"][data-name="shop/web"]').click()
    await expect(view.getByTestId('k8s-replicas')).toHaveText('2')
    await view.getByTestId('k8s-scale-up').click()
    await expect(view.getByTestId('k8s-replicas')).toHaveText('3')

    // Secret: giá trị ẩn, bấm mới hiện.
    await view.getByTestId('k8s-nav-secrets').click()
    await view.locator('[data-testid="k8s-row"][data-name="shop/db"]').click()
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
    await expect(page.getByRole('menuitem', { name: 'Delete' })).toHaveCount(0)
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
    await page.getByRole('menuitem', { name: 'Delete' }).click()
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
