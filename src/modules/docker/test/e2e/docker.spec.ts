import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { startTestSshServer } from '../../../../../test/integration/ssh-test-server'
import {
  activeTab,
  expect,
  isWindows,
  launchApp,
  test,
  waitForText
} from '../../../../../test/e2e/fixtures'
import { startEngineTestServer } from '../engine-test-server'

/** Bật module Docker qua Settings → Modules (xác nhận quyền lần đầu). */
async function enableDocker(page: Page): Promise<void> {
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-nav-modules').click()
  await page.getByTestId('module-toggle-docker').click()
  await expect(page.getByTestId('module-enable-dialog')).toContainText(
    'Connects to /var/run/docker.sock on SSH hosts you open it for'
  )
  await page.getByTestId('module-enable-confirm').click()
  await expect(page.getByTestId('module-toggle-docker')).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
}

test('Docker trên máy này (Engine giả qua DOCKER_HOST): danh sách, stats, restart, log, chỉ đọc, dọn image', async () => {
  // Nhiều bước + khởi động Electron (runner macOS lần đầu ~25 giây).
  test.setTimeout(60_000)
  test.skip(isWindows, 'Engine giả dùng unix socket')
  const engine = await startEngineTestServer()
  const launched = await launchApp({ DOCKER_HOST: `unix://${engine.path}` })
  const { page } = launched
  try {
    await expect(page.getByTestId('docker-section')).toHaveCount(0)
    await enableDocker(page)
    const local = page.locator('[data-testid="docker-endpoint"][data-name="This computer"]')
    await local.dblclick()
    const view = page.getByTestId('docker-view')
    await expect(page.getByTestId('tab').last()).toContainText('Docker · This computer')
    const rows = view.getByTestId('docker-container')
    await expect(rows).toHaveCount(3)
    await expect(view.getByTestId('docker-engine-info')).toContainText('Docker Engine 27.1.1')

    // Chọn container đang chạy → bảng chi tiết có CPU / RAM sống.
    const web = view.locator('[data-testid="docker-container"][data-name="web"]')
    await web.click()
    await expect(view.getByTestId('docker-stats')).toContainText('%')
    await expect(view.getByTestId('docker-stats')).toContainText('MB')

    // Restart nhanh trên dòng → Engine nhận lệnh.
    await web.getByTestId('docker-row-restart').click()
    await expect
      .poll(() => engine.requests.some((r) => /\/containers\/web-[^/]+\/restart/.test(r)))
      .toBe(true)

    // Log: tab riêng; stdout / stderr; dòng mới tới ngay.
    await web.getByTestId('docker-row-logs').click()
    const logs = page.getByTestId('docker-logs')
    await expect(logs).toContainText('hello from stdout')
    await expect(logs).toContainText('warning on stderr')
    engine.log(engine.containers[0]?.Id ?? '', 1, 'dòng log mới\n')
    await expect(logs).toContainText('dòng log mới')
    await page.getByTestId('docker-logs-search').fill('warning')
    await expect(page.getByTestId('docker-log-line')).toHaveCount(1)

    // Dọn image dangling: xem trước danh sách rồi mới xoá.
    await page.getByTestId('tab').filter({ hasText: 'Docker · This computer' }).click()
    await view.getByTestId('docker-nav-images').click()
    await expect(view.getByTestId('docker-image')).toHaveCount(3)
    await view.getByTestId('docker-prune').click()
    await expect(page.getByTestId('docker-prune-list')).toContainText('dangling1')
    await page.getByTestId('docker-prune-confirm').click()
    await expect(view.getByTestId('docker-image')).toHaveCount(2)

    // Chế độ chỉ đọc: ẩn mọi thao tác thay đổi.
    await local.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Read-only mode' }).click()
    await expect(view.getByTestId('docker-read-only')).toBeVisible()
    await expect(view.getByTestId('docker-prune')).toHaveCount(0)
    await view.getByTestId('docker-nav-containers').click()
    await expect(rows).toHaveCount(3)
    await expect(view.getByTestId('docker-row-restart')).toHaveCount(0)

    // Compose: nhóm theo project.
    await view.getByTestId('docker-nav-compose').click()
    await expect(view.locator('[data-testid="docker-project"][data-name="shop"]')).toContainText(
      '2/2 running'
    )
  } finally {
    await launched.close()
    await engine.close()
  }
})

test('Docker: tổng quan, lọc trạng thái, chạy container mới, log cả Compose project, phím tắt', async () => {
  // Nhiều bước + khởi động Electron (runner macOS lần đầu ~25 giây).
  test.setTimeout(60_000)
  test.skip(isWindows, 'Engine giả dùng unix socket')
  const engine = await startEngineTestServer()
  const launched = await launchApp({ DOCKER_HOST: `unix://${engine.path}` })
  const { page } = launched
  try {
    await enableDocker(page)
    await page.locator('[data-testid="docker-endpoint"][data-name="This computer"]').dblclick()
    const view = page.getByTestId('docker-view')
    const rows = view.getByTestId('docker-container')
    await expect(rows).toHaveCount(3)

    // Tổng quan: số container đang chạy + dung lượng đĩa; bấm thẻ → danh sách đã lọc.
    await view.getByTestId('docker-nav-overview').click()
    await expect(view.getByTestId('docker-ov-disk')).toContainText('reclaimable')
    const runningCount = engine.containers.filter((c) => c.State === 'running').length
    await expect(view.getByTestId('docker-ov-running')).toContainText(String(runningCount))
    await view.getByTestId('docker-ov-running').click()
    await expect(view.getByTestId('docker-status-running')).toHaveAttribute('aria-checked', 'true')
    await expect(rows).toHaveCount(runningCount)
    await view.getByTestId('docker-status-all').click()
    await expect(rows).toHaveCount(3)

    // Run: image có sẵn, cổng, biến môi trường → Engine nhận đúng cấu hình.
    await view.getByTestId('docker-run').click()
    await page.getByTestId('docker-run-image').fill('nginx:1.27')
    await page.getByTestId('docker-run-name').fill('edge')
    await page.getByTestId('docker-run-add-port').click()
    await page.getByTestId('docker-run-port-host').fill('8088')
    await page.getByTestId('docker-run-port-container').fill('80')
    await page.getByTestId('docker-run-env').fill('MODE=prod')
    await page.getByTestId('docker-run-submit').click()
    await expect(page.getByTestId('docker-run-dialog')).toHaveCount(0)
    await expect(view.locator('[data-testid="docker-container"][data-name="edge"]')).toBeVisible()
    expect(engine.created[0]).toMatchObject({
      Image: 'nginx:1.27',
      Env: ['MODE=prod'],
      HostConfig: { PortBindings: { '80/tcp': [{ HostPort: '8088' }] } }
    })

    // Phím tắt trên dòng đang chọn: r = restart.
    await view.locator('[data-testid="docker-container"][data-name="web"]').click()
    await expect(view.getByTestId('docker-detail')).toBeVisible()
    await page.keyboard.press('r')
    await expect
      .poll(() => engine.requests.some((r) => /\/containers\/web-[^/]+\/restart/.test(r)))
      .toBe(true)

    // Log của cả Compose project: một tab, dòng có tiền tố service.
    await view.getByTestId('docker-nav-compose').click()
    await view
      .locator('[data-testid="docker-project"][data-name="shop"]')
      .getByTestId('docker-compose-logs')
      .click()
    await expect(page.getByTestId('tab').last()).toContainText('shop (logs)')
    await expect(page.getByTestId('docker-logs')).toContainText('hello from stdout')
  } finally {
    await launched.close()
    await engine.close()
  }
})

test('Docker qua SSH: menu host "Docker…", socket qua streamlocal, shell vào container thành tab terminal', async () => {
  // Nhiều bước + khởi động Electron (runner macOS lần đầu ~25 giây).
  test.setTimeout(60_000)
  test.skip(isWindows, 'Engine giả dùng unix socket; exec của server test dùng /bin/sh')
  const engine = await startEngineTestServer()
  // `docker` giả trên "server": in tên container rồi chạy sh.
  const bin = mkdtempSync(join(tmpdir(), 'sh-fake-docker-'))
  const home = mkdtempSync(join(tmpdir(), 'sh-exec-home-'))
  writeFileSync(
    join(bin, 'docker'),
    '#!/bin/sh\n# docker exec -it -e TERM=... <id> sh -c ...\necho "inside container $5"\nexec /bin/sh\n'
  )
  chmodSync(join(bin, 'docker'), 0o755)
  const ssh = await startTestSshServer([{ username: 'u', password: 'p' }], {
    streamLocal: { '/var/run/docker.sock': engine.path },
    execHome: home,
    execPath: bin
  })
  const launched = await launchApp()
  const { page } = launched
  try {
    const saved = await page.evaluate(
      (port) =>
        window.shellhouse.saveHost({
          groupId: null,
          label: 'docker-box',
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
    await enableDocker(page)

    const host = page.locator('[data-testid="host-row"][data-host-label="docker-box"]')
    await host.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Docker…' }).click()
    // Tab Docker tự mở kết nối SSH: hỏi host key + mật khẩu như tab terminal.
    await page.getByTestId('hostkey-accept').click()
    await page.getByTestId('prompt-input').fill('p')
    await page.getByTestId('prompt-submit').click()
    const view = page.getByTestId('docker-view')
    await expect(view.getByTestId('docker-container')).toHaveCount(3)
    expect(ssh.events.streamLocal).toContain('/var/run/docker.sock')
    // Host được thêm vào mục Docker ở thanh bên.
    await expect(
      page.locator('[data-testid="docker-endpoint"][data-name="docker-box"]')
    ).toBeVisible()

    // Shell vào container → tab terminal (kết nối SSH riêng, `docker exec -it` trong PTY).
    await view
      .locator('[data-testid="docker-container"][data-name="web"]')
      .getByTestId('docker-row-shell')
      .click()
    await expect(page.getByTestId('tab').last()).toContainText('web (shell)')
    await page.getByTestId('prompt-input').fill('p')
    await page.getByTestId('prompt-submit').click()
    const tab = await activeTab(page)
    await waitForText(page, tab, 'inside container web-')
    await page.evaluate((id) => {
      // Server test chạy lệnh qua pipe (không có PTY thật đổi \r thành \n) → gửi \n.
      window.__shellhouseTest.sendInput(id, 'echo ok-$((40+2))\n')
    }, tab)
    await waitForText(page, tab, 'ok-42')
  } finally {
    await launched.close()
    await ssh.close()
    await engine.close()
    rmSync(bin, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('gợi ý đúng lúc: có socket Docker trên máy → một dòng gợi ý ở thanh bên; Enable bật module', async () => {
  const launched = await launchApp({
    SHELLHOUSE_TEST_DETECT: JSON.stringify(['/var/run/docker.sock'])
  })
  const { page } = launched
  try {
    await page.evaluate(() =>
      window.shellhouse.updateSettings({ moduleOptions: { suggest: true } })
    )
    // Bật gợi ý → hiện ngay (không cần mở lại app), kể cả khi dấu hiệu tới trước cài đặt.
    const suggestion = page.getByTestId('module-suggestion')
    await expect(suggestion).toContainText('Docker detected on this computer')
    await page.getByTestId('module-suggestion-enable').click()
    await page.getByTestId('module-enable-confirm').click()
    await expect(page.getByTestId('docker-section')).toBeVisible()
    // Đã gợi ý → không hiện lại (tối đa một lần / 30 ngày).
    const entry = await page.evaluate(() =>
      window.shellhouse.getSettings().then((s) => s.modules['docker'])
    )
    expect(entry?.suggestedAt).toBeGreaterThan(0)
  } finally {
    await launched.close()
  }
})
