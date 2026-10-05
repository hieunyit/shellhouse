import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { startTestSshServer } from '../integration/ssh-test-server'
import { activeTab, launchApp, test, waitForText } from '../e2e/fixtures'
import { startApiTestServer, TEST_CA, TOKEN } from '../../src/modules/k8s/test/api-test-server'
import { startEngineTestServer } from '../../src/modules/docker/test/engine-test-server'

/**
 * Khung app mới (thiết kế v0.5 — design/shellhouse-v0.5): chụp từng khu vực của activity bar ở cả
 * tối và sáng, 1440×900, để đối chiếu với prototype.
 *   pnpm build && pnpm screens test/screens/shell.spec.ts   → screens/shell-<theme>-<tên>.png
 * Mỗi ảnh độc lập: bước lỗi chỉ bỏ ảnh đó (ghi ra console).
 */
const OUT = 'screens'
const PREFIX = process.env['SHELLHOUSE_LANG'] === 'vi' ? 'vi-' : ''
test.setTimeout(300_000)

/** Mở Settings (đang ở Settings thì giữ — bấm lại sẽ ẩn mục lục). */
async function openSettings(page: Page): Promise<void> {
  if (!(await page.getByTestId('settings-dialog').isVisible()))
    await page.getByTestId('open-settings').click()
}

async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await openSettings(page)
  await page.getByTestId('settings-nav-appearance').click()
  await page.getByTestId(`appearance-${theme}`).click()
}

async function enableModule(page: Page, id: string): Promise<void> {
  await openSettings(page)
  await page.getByTestId('settings-nav-modules').click()
  await page.getByTestId(`module-toggle-${id}`).click()
  await page.getByTestId('module-enable-confirm').click()
}

function kubeconfig(url: string): string {
  return `apiVersion: v1
kind: Config
current-context: test
clusters:
- name: fake
  cluster:
    server: ${url}
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

for (const theme of ['dark', 'light'] as const) {
  test(`khung app v0.5 (${theme})`, async () => {
    mkdirSync(OUT, { recursive: true })
    const ssh = await startTestSshServer([{ username: 'demo', password: 'pw' }], {
      execHome: mkdtempSync(join(tmpdir(), 'sh-shell-')),
      sftpRoot: mkdtempSync(join(tmpdir(), 'sh-shell-sftp-'))
    })
    const k8s = await startApiTestServer()
    k8s.seedDemo()
    const engine = await startEngineTestServer()
    const dir = mkdtempSync(join(tmpdir(), 'sh-shell-kube-'))
    writeFileSync(join(dir, 'config'), kubeconfig(k8s.url))
    const launched = await launchApp({
      KUBECONFIG: join(dir, 'config'),
      DOCKER_HOST: `unix://${engine.path}`
    })
    const { page } = launched
    await page.setViewportSize({ width: 1440, height: 900 })
    page.setDefaultTimeout(10_000)
    const shot = async (name: string, steps: () => Promise<void> = () => Promise.resolve()) => {
      try {
        await steps()
        await page.waitForTimeout(400)
        await page.screenshot({ path: join(OUT, `${PREFIX}shell-${theme}-${name}.png`) })
      } catch (e) {
        console.log(`SKIP shell-${theme}-${name}: ${String(e).split('\n')[0] ?? ''}`)
      }
    }
    try {
      // Dữ liệu mẫu giống prototype: Production (đỏ) › Web / Databases, Staging (vàng), Development.
      const groups: Record<string, string> = {}
      for (const [name, parent, color] of [
        ['Production', null, 'red'],
        ['Web', 'Production', null],
        ['Databases', 'Production', null],
        ['Staging', null, 'yellow'],
        ['Development', null, 'blue']
      ] as const) {
        const r = await page.evaluate(
          ([n, p, c]) =>
            window.shellhouse.saveGroup({ parentId: p, name: n, defaults: c ? { color: c } : {} }),
          [name, parent ? (groups[parent] ?? null) : null, color] as const
        )
        if (r.ok && r.id) groups[name] = r.id
      }
      for (const [label, group, hostname] of [
        ['prod-web-01', 'Web', '127.0.0.1'],
        ['prod-web-02', 'Web', '10.10.1.12'],
        ['prod-db-01', 'Databases', '10.10.1.21'],
        ['stg-web-01', 'Staging', '10.20.1.11'],
        ['dev-box', 'Development', '192.168.1.20']
      ] as const) {
        await page.evaluate(
          ([l, g, h, port]) =>
            window.shellhouse.saveHost({
              groupId: g,
              label: l,
              hostname: h,
              port: h === '127.0.0.1' ? port : 22,
              username: 'demo',
              auth: 'password',
              password: 'pw',
              keyId: null,
              keyFile: null,
              proxyJump: null,
              jumpHostIds: [],
              mode: 'builtin',
              tags: [],
              color: null
            }),
          [label, groups[group] ?? null, hostname, ssh.port] as const
        )
      }
      const tree = await page.evaluate(() => window.shellhouse.hostTree())
      await page.evaluate(
        (ids) => window.shellhouse.setFavorite(ids, true),
        tree.hosts.filter((h) => h.label !== 'dev-box').map((h) => h.id)
      )
      await setTheme(page, theme)
      await shot('07-settings-appearance')
      await enableModule(page, 'k8s')
      await enableModule(page, 'docker')
      await shot('07b-settings-modules')

      await shot('01-home', async () => {
        await page.getByTestId('open-home').click()
      })

      await shot('02-hosts-terminal', async () => {
        await page.getByTestId('activity-hosts').click()
        await page.locator('[data-testid="host-row"][data-host-label="prod-web-01"]').dblclick()
        const tab = await activeTab(page)
        await page.getByTestId('hostkey-accept').click()
        await waitForText(page, tab, 'welcome to test server')
        await page.evaluate((id) => {
          window.__shellhouseTest.sendInput(id, 'ls -la /\r')
        }, tab)
      })
      await shot('02b-hosts-sftp', async () => {
        await page.getByTestId('toggle-sftp').last().click()
        await page.waitForTimeout(600)
      })
      await shot('02c-quick-connect', async () => {
        await page.getByTestId('titlebar-connect').click()
        await page.getByTestId('quick-connect').fill('prod')
      })
      // Esc đầu xoá chữ đã gõ, Esc sau mới đóng Quick connect.
      for (let i = 0; i < 3 && (await page.getByTestId('quick-connect').isVisible()); i++)
        await page.keyboard.press('Escape')
      await shot('02d-files', async () => {
        await page.getByTestId('activity-files').click()
        await page.locator('[data-testid="explorer"][data-area="files"]').waitFor()
      })
      await shot('02e-files-local', async () => {
        await page.getByTestId('explorer-files-local').click()
        await page.waitForTimeout(600)
      })

      await shot('03-k8s-empty', async () => {
        await page.getByTestId('activity-k8s').click()
      })
      await shot('03b-k8s-cluster', async () => {
        await page.locator('[data-testid="k8s-context"][data-name="test"]').dblclick()
        await page.getByTestId('k8s-view').waitFor()
        await page.waitForTimeout(1500)
      })
      await shot('04-docker', async () => {
        await page.getByTestId('activity-docker').click()
        await page.waitForTimeout(1000)
      })
      await shot('05-transfers', async () => {
        await page.getByTestId('activity-transfers').click()
      })
      await shot('06-palette', async () => {
        await page.getByTestId('command-center').click()
      })
      await page.keyboard.press('Escape')
    } finally {
      await launched.close()
      await ssh.close()
      await k8s.close()
      await engine.close()
    }
  })
}
