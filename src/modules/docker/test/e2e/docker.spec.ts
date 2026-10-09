import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { startTestSshServer } from '../../../../../test/integration/ssh-test-server'
import {
  activeTab,
  expect,
  expectActiveTab,
  isWindows,
  launchApp,
  openArea,
  test,
  waitForText
} from '../../../../../test/e2e/fixtures'
import { startEngineTestServer } from '../engine-test-server'
import { pem, startTlsProxy } from '../tls-proxy-server'

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
  await openArea(page, 'docker')
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
    await expectActiveTab(page, 'Docker · This computer')
    const rows = view.getByTestId('docker-container')
    await expect(rows).toHaveCount(3)
    await expect(page.getByTestId('docker-engine-info')).toContainText('Docker Engine 27.1.1')

    // Chọn container đang chạy → Overview: health check một dòng (không đổ output curl thô);
    // lệnh kiểm tra + output đã làm sạch trong phần thu gọn.
    const web = view.locator('[data-testid="docker-container"][data-name="web"]')
    await web.click()
    const health = view.getByTestId('docker-detail-health')
    await expect(health.getByTestId('docker-health-summary')).toContainText(
      '3/3 recent checks passed'
    )
    await expect(health.getByTestId('docker-health-summary')).toContainText('every 30s')
    await expect(health.getByTestId('docker-health-failure')).toHaveCount(0)
    await expect(health.getByTestId('docker-health-run').first()).toBeHidden()
    await health.getByTestId('docker-health-details').locator('summary').click()
    await expect(health.getByTestId('docker-health-details')).toContainText(
      'curl -f http://localhost:8080/health'
    )
    await expect(health.getByTestId('docker-health-run').first()).toHaveText(/\{"status":"ok"\}/)
    await expect(health).not.toContainText('% Total')
    // CPU / RAM chỉ ở tab Stats (danh sách đã có cột CPU / Memory) — RAM không đặt giới hạn ghi rõ.
    await expect(view.getByTestId('docker-detail-overview')).not.toContainText('Memory')
    await view.getByTestId('docker-detail-tab-stats').click()
    await expect(view.getByTestId('docker-stats-cpu')).toContainText('%')
    await expect(view.getByTestId('docker-stats-memory')).toContainText('MB')
    await expect(view.getByTestId('docker-stats-memory')).toContainText('No limit')
    await expect(view.getByTestId('docker-stats-network')).toContainText('/s')
    await expect(view.getByTestId('docker-stats-network')).toContainText('Since start')
    await view.getByTestId('docker-detail-tab-overview').click()

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
    // Chỗ khớp được tô sáng trong dòng.
    await expect(page.getByTestId('docker-log-line').getByTestId('log-match')).toHaveText('warning')

    // Mức log: dòng ERROR / WARN tô màu; chip "N errors" / "N warnings" lọc nhanh.
    await page.getByTestId('docker-logs-search').fill('')
    const id = engine.containers[0]?.Id ?? ''
    engine.log(id, 1, '2026-10-06T10:00:00Z ERROR db: connection refused\n')
    engine.log(id, 1, 'level=warn msg="slow query" ms=1200\n')
    engine.log(id, 1, 'GET /health 200 status=503 no error\n')
    const lines = page.getByTestId('docker-log-line')
    await expect(lines.filter({ hasText: 'connection refused' })).toHaveAttribute(
      'data-level',
      'error'
    )
    await expect(lines.filter({ hasText: 'slow query' })).toHaveAttribute('data-level', 'warn')
    await expect(lines.filter({ hasText: 'no error' })).not.toHaveAttribute('data-level', /.+/)
    await page.getByTestId('docker-logs-level-error').click()
    await expect(lines).toHaveCount(1)
    await expect(lines).toContainText('connection refused')
    await page.getByTestId('docker-logs-level-error').click()

    // Regex: status=5xx; regex sai → báo lỗi, không lọc.
    await page.getByTestId('docker-logs-regex').click()
    await page.getByTestId('docker-logs-search').fill('status=5\\d\\d')
    await expect(lines).toHaveCount(1)
    await expect(lines.getByTestId('log-match')).toHaveText('status=503')
    await page.getByTestId('docker-logs-search').fill('([')
    await expect(page.getByTestId('docker-logs-regex-error')).toBeVisible()
    await page.getByTestId('docker-logs-search').fill('')

    // Dọn image dangling: xem trước danh sách rồi mới xoá.
    await page.getByTestId('tab').filter({ hasText: 'Docker · This computer' }).click()
    await page.getByTestId('docker-nav-images').click()
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
    await page.getByTestId('docker-nav-containers').click()
    await expect(rows).toHaveCount(3)
    await expect(view.getByTestId('docker-row-restart')).toHaveCount(0)

    // Compose: nhóm theo project.
    await page.getByTestId('docker-nav-compose').click()
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
    await page.getByTestId('docker-nav-overview').click()
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

    // Phím tắt trên dòng đang chọn: r = restart — hỏi lại trước (gõ nhầm phím không dừng dịch vụ).
    await view.locator('[data-testid="docker-container"][data-name="web"]').click()
    await expect(view.getByTestId('docker-detail')).toBeVisible()
    await page.keyboard.press('r')
    await expect(page.getByTestId('docker-confirm')).toContainText('Restart web?')
    await page.getByTestId('docker-confirm-ok').click()
    await expect
      .poll(() => engine.requests.some((r) => /\/containers\/web-[^/]+\/restart/.test(r)))
      .toBe(true)

    // Healthcheck hiện ở bảng chi tiết; tab Files duyệt hệ thống file của container.
    const detail = view.getByTestId('docker-detail')
    await expect(detail.getByTestId('docker-health').first()).toHaveAttribute(
      'data-health',
      'healthy'
    )
    await detail.getByTestId('docker-detail-tab-files').click()
    const etc = detail.locator('[data-testid="docker-file"][data-name="etc"]')
    await etc.dblclick()
    await expect(detail.getByTestId('docker-files-path')).toHaveValue('/etc')
    await expect(detail.locator('[data-testid="docker-file"][data-name="hosts"]')).toBeVisible()

    // Nút "⋯" trên dòng: menu có chữ, đủ thao tác (kể cả thứ không có nút nhanh).
    await view
      .locator('[data-testid="docker-container"][data-name="db"]')
      .getByTestId('docker-row-more')
      .click()
    await expect(page.getByRole('menuitem', { name: /Copy name/ })).toBeVisible()
    await page.keyboard.press('Escape')

    // Volume mới qua hộp thoại → Engine nhận đúng tên / driver.
    await page.getByTestId('docker-nav-volumes').click()
    await view.getByTestId('docker-new-volume').click()
    await page.getByTestId('docker-volume-name').fill('pgdata')
    await page.getByTestId('docker-volume-create').click()
    await expect(view.locator('[data-testid="docker-volume"][data-name="pgdata"]')).toBeVisible()

    // Tổng quan: build cache có nút dọn (xem trước dung lượng).
    await page.getByTestId('docker-nav-overview').click()
    await expect(view.getByTestId('docker-ov-row-buildCache')).toContainText('reclaimable')
    await view.getByTestId('docker-ov-prune-buildCache').click()
    await expect(page.getByTestId('docker-prune-dialog')).toContainText('cache-free')
    await page.getByTestId('docker-prune-confirm').click()
    await expect.poll(() => engine.buildCache.length).toBe(1)

    // Log của cả Compose project: một tab, dòng có tiền tố service.
    await page.getByTestId('docker-nav-compose').click()
    await view
      .locator('[data-testid="docker-project"][data-name="shop"]')
      .getByTestId('docker-compose-logs')
      .click()
    await expectActiveTab(page, 'shop (logs)')
    await expect(page.getByTestId('docker-logs')).toContainText('hello from stdout')
    // Mỗi service một màu + chip lọc (như stern): ẩn db → chỉ còn dòng của web.
    const sources = page.getByTestId('docker-log-sources')
    await expect(sources.getByTestId('docker-log-source')).toHaveCount(2)
    const lines = page.getByTestId('docker-log-line')
    await expect(lines.filter({ hasText: '[db]' }).first()).toBeVisible()
    await sources.locator('[data-testid="docker-log-source"][data-name="db"]').click()
    await expect(lines.filter({ hasText: '[db]' })).toHaveCount(0)
    await expect(lines.filter({ hasText: '[web]' }).first()).toBeVisible()
    const colors = await lines.evaluateAll((els) =>
      [...new Set(els.map((el) => el.querySelector('span')?.style.color ?? ''))].filter(Boolean)
    )
    expect(colors).toHaveLength(1)
  } finally {
    await launched.close()
    await engine.close()
  }
})

test('Docker: chọn nhiều dòng (ô chọn, Shift, Ctrl+A, Esc), thao tác hàng loạt', async () => {
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
    const bar = view.getByTestId('docker-selection-bar')
    const check = (name: string) =>
      view
        .locator(`[data-testid="docker-container"][data-name="${name}"]`)
        .getByTestId('docker-row-check')

    // Ô chọn trên dòng + Shift+bấm = cả khoảng; ô chọn tất cả ở trạng thái "một phần".
    await check('db').click()
    await expect(bar).toHaveAttribute('data-selected', '1')
    await check('web').click({ modifiers: ['Shift'] })
    await expect(bar).toHaveAttribute('data-selected', '3')
    await check('old-job').click()
    await expect(bar).toHaveAttribute('data-selected', '2')
    expect(
      await view
        .getByTestId('docker-select-all')
        .evaluate((el) => (el as HTMLInputElement).indeterminate)
    ).toBe(true)
    await page.keyboard.press('Escape')
    await expect(bar).toHaveAttribute('data-selected', '0')

    // Ctrl/Cmd+A khi bảng có focus → chọn hết; Stop chỉ tác động container đang chạy.
    await rows.first().click()
    await page.keyboard.press('ControlOrMeta+a')
    await expect(view.getByTestId('docker-bulk-count')).toContainText('3 selected')
    await view.getByTestId('docker-bulk-stop').click()
    const dialog = page.getByTestId('docker-bulk-dialog')
    await expect(dialog).toContainText('Stop 2 containers?')
    await expect(page.getByTestId('docker-bulk-skipped')).toContainText('old-job')
    await page.getByTestId('docker-bulk-ok').click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(() => engine.containers.filter((c) => c.State === 'exited').length).toBe(3)

    // Vẫn giữ lựa chọn sau thao tác không xoá → xoá hàng loạt kèm anonymous volume (docker rm -v).
    await expect(view.getByTestId('docker-bulk-count')).toContainText('3 selected')
    await view.getByTestId('docker-bulk-remove').click()
    await page.getByTestId('docker-bulk-option').check()
    await page.getByTestId('docker-bulk-ok').click()
    await expect(rows).toHaveCount(0)
    expect(
      engine.requests.filter((r) => r.startsWith('DELETE') && r.includes('v=true'))
    ).toHaveLength(3)

    // Volume: một mục lỗi (đang dùng) → kết quả từng mục, mục khác vẫn xoá.
    await page.getByTestId('docker-nav-volumes').click()
    await expect(view.getByTestId('docker-volume')).toHaveCount(3)
    await view.getByTestId('docker-select-all').click()
    await view.getByTestId('docker-bulk-remove').click()
    await page.getByTestId('docker-bulk-ok').click()
    await expect(page.getByTestId('docker-bulk-results')).toContainText('in use')
    await expect(page.locator('[data-testid="docker-bulk-result"][data-ok="true"]')).toHaveCount(2)
    await page.getByTestId('docker-bulk-close').click()
    await expect(view.getByTestId('docker-volume')).toHaveCount(1)
  } finally {
    await launched.close()
    await engine.close()
  }
})

test('Docker: Compose — bảng project, thao tác cạnh tên, service mở rộng', async () => {
  test.setTimeout(60_000)
  test.skip(isWindows, 'Engine giả dùng unix socket')
  const engine = await startEngineTestServer()
  const launched = await launchApp({ DOCKER_HOST: `unix://${engine.path}` })
  const { page } = launched
  try {
    await enableDocker(page)
    await page.locator('[data-testid="docker-endpoint"][data-name="This computer"]').dblclick()
    const view = page.getByTestId('docker-view')
    await page.getByTestId('docker-nav-compose').click()
    const shop = view.locator('[data-testid="docker-project"][data-name="shop"]')
    await expect(shop).toContainText('2/2 running')
    await expect(shop).toHaveAttribute('aria-expanded', 'true')
    const services = view.getByTestId('docker-compose-service')
    await expect(services).toHaveCount(2)
    await expect(
      view.locator('[data-testid="docker-compose-service"][data-name="db"]')
    ).toContainText('postgres:16')
    // Thu gọn / mở lại.
    await shop.getByTestId('docker-compose-toggle').click()
    await expect(services).toHaveCount(0)
    await shop.getByTestId('docker-compose-toggle').click()
    await expect(services).toHaveCount(2)

    // Menu "⋯" cạnh tên: Pull, sao chép đường dẫn, Down.
    await shop.getByTestId('docker-compose-more').click()
    await expect(page.getByRole('menuitem', { name: /Copy folder path/ })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: /Down/ })).toBeVisible()
    await page.keyboard.press('Escape')
    // Menu phải đóng hẳn trước cú bấm sau (không thì cú bấm rơi vào lớp đang đóng).
    await expect(page.getByRole('menuitem', { name: /Down/ })).toHaveCount(0)

    // Restart một service → Engine nhận lệnh cho đúng container.
    await view
      .locator('[data-testid="docker-compose-service"][data-name="db"]')
      .getByTestId('docker-compose-service-restart')
      .click()
    await expect
      .poll(() => engine.requests.some((r) => /\/containers\/db-[^/]+\/restart/.test(r)), {
        timeout: 15_000
      })
      .toBe(true)
    // Stop cả project (hỏi lại trước).
    await shop.getByTestId('docker-compose-stop').click()
    await page.getByTestId('docker-confirm-ok').click()
    await expect(shop).toContainText('0/2 running')
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
    await openArea(page, 'hosts')

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
    await expectActiveTab(page, 'web (shell)')
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
    await openArea(page, 'docker')
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

test('Docker trong WSL (Windows): gợi ý, distro đang chạy hiện ở thanh bên, ẩn / thêm lại, báo lỗi rõ khi không có WSL', async () => {
  test.setTimeout(60_000)
  const launched = await launchApp({
    SHELLHOUSE_TEST_WSL: JSON.stringify([
      { name: 'Ubuntu', running: true, version: 2 },
      { name: 'Debian', running: false, version: 2 }
    ]),
    SHELLHOUSE_TEST_DETECT: JSON.stringify(['wsl:Ubuntu:/usr/bin/docker'])
  })
  const { page } = launched
  try {
    await page.evaluate(() =>
      window.shellhouse.updateSettings({ moduleOptions: { suggest: true } })
    )
    await expect(page.getByTestId('module-suggestion')).toContainText('Docker detected')
    await page.getByTestId('module-suggestion-enable').click()
    await page.getByTestId('module-enable-confirm').click()
    await openArea(page, 'docker')

    // Distro đang chạy tự hiện; distro đang dừng nằm trong menu ＋.
    const ubuntu = page.locator('[data-testid="docker-endpoint"][data-name="Ubuntu (WSL)"]')
    await expect(ubuntu).toBeVisible()
    await expect(
      page.locator('[data-testid="docker-endpoint"][data-name="Debian (WSL)"]')
    ).toHaveCount(0)
    await ubuntu.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Hide from Docker' }).click()
    await expect(ubuntu).toHaveCount(0)
    await page.getByTestId('docker-add-server').click()
    await page.getByRole('menuitem', { name: /Ubuntu \(WSL\)/ }).click()
    await expect(ubuntu).toBeVisible()

    await ubuntu.dblclick()
    await expectActiveTab(page, 'Docker · Ubuntu (WSL)')
    // Linux / macOS không có wsl.exe: tab báo lỗi dễ hiểu (không treo). Runner Windows có wsl.exe
    // thật (distro giả không tồn tại) — phần này chỉ kiểm ở máy không có WSL.
    if (process.platform !== 'win32')
      await expect(
        page.getByRole('alert').filter({ hasText: 'WSL is not installed' })
      ).toBeVisible()
  } finally {
    await launched.close()
  }
})

test('Docker trên Production: xoá hàng loạt và dọn dẹp phải gõ lại cụm đếm, gõ sai thì không chạy', async () => {
  test.setTimeout(60_000)
  test.skip(isWindows, 'Engine giả dùng unix socket')
  const engine = await startEngineTestServer()
  const launched = await launchApp({ DOCKER_HOST: `unix://${engine.path}` })
  const { page } = launched
  try {
    await enableDocker(page)
    const local = page.locator('[data-testid="docker-endpoint"][data-name="This computer"]')
    await local.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Production' }).click()
    await local.dblclick()
    const view = page.getByTestId('docker-view')
    await expect(view.getByTestId('docker-container')).toHaveCount(3)
    const deletes = (): number => engine.requests.filter((r) => r.startsWith('DELETE')).length

    // Stop một container (bấm từ menu, không phải phím tắt) cũng phải gõ tên trên Production.
    const stops = (): number => engine.requests.filter((r) => r.includes('/stop')).length
    await view.getByTestId('docker-container').filter({ hasText: 'web' }).first().click()
    await view.getByTestId('docker-action-stop').click()
    const stopOk = page.getByTestId('docker-confirm-ok')
    await expect(stopOk).toBeDisabled()
    await page.getByTestId('docker-confirm-typed').fill('we')
    await expect(stopOk).toBeDisabled()
    await page.getByTestId('docker-confirm-typed').fill('web')
    await expect(stopOk).toBeEnabled()
    expect(stops()).toBe(0)
    await stopOk.click()
    await expect.poll(stops).toBe(1)

    // Xoá hàng loạt: nút bị khoá tới khi gõ đúng "3 containers"; dán không được.
    await view.getByTestId('docker-select-all').click()
    await view.getByTestId('docker-bulk-remove').click()
    const ok = page.getByTestId('docker-bulk-ok')
    const typed = page.getByTestId('docker-bulk-typed')
    await expect(ok).toBeDisabled()
    await typed.fill('3 container')
    await expect(ok).toBeDisabled()
    await typed.fill('3 containers')
    await expect(ok).toBeEnabled()
    expect(deletes()).toBe(0)
    await ok.click()
    await expect(view.getByTestId('docker-container')).toHaveCount(0)
    expect(deletes()).toBe(3)

    // Dọn image dangling: cũng phải gõ lại ("1 image").
    await page.getByTestId('docker-nav-images').click()
    await expect(view.getByTestId('docker-image')).toHaveCount(3)
    await view.getByTestId('docker-prune').click()
    await expect(page.getByTestId('docker-prune-list')).toContainText('dangling1')
    const confirm = page.getByTestId('docker-prune-confirm')
    await expect(confirm).toBeDisabled()
    await page.getByTestId('docker-prune-typed').fill('1 images')
    await expect(confirm).toBeDisabled()
    await page.getByTestId('docker-prune-typed').fill('1 image')
    await expect(confirm).toBeEnabled()
    await confirm.click()
    await expect(view.getByTestId('docker-image')).toHaveCount(2)
  } finally {
    await launched.close()
  }
})

test('Docker qua TCP + TLS: thêm engine bằng địa chỉ + chứng chỉ, kết nối mTLS, sửa, xoá', async () => {
  test.setTimeout(60_000)
  test.skip(isWindows, 'Engine giả dùng unix socket')
  const engine = await startEngineTestServer()
  const proxy = await startTlsProxy(engine, true)
  const launched = await launchApp()
  const { page } = launched
  try {
    await enableDocker(page)
    await page.getByTestId('docker-add-server').click()
    await page.getByRole('menuitem', { name: 'Add by address (TLS)…' }).click()
    const dialog = page.getByTestId('docker-tcp-dialog')
    await dialog.getByTestId('docker-tcp-name').fill('legacy-build')
    await dialog.getByTestId('docker-tcp-host').fill('127.0.0.1')
    await dialog.getByTestId('docker-tcp-port').fill(String(proxy.port))

    // Khoá không khớp chứng chỉ → báo ngay trong hộp thoại, chưa lưu gì.
    await dialog.getByTestId('docker-tcp-ca').fill(pem('ca.pem'))
    await dialog.getByTestId('docker-tcp-cert').fill(pem('client.pem'))
    await dialog.getByTestId('docker-tcp-key').fill(pem('other-key.pem'))
    await dialog.getByTestId('docker-tcp-save').click()
    await expect(dialog.getByTestId('docker-tcp-error')).toContainText('do not belong together')
    // Khoá đặt passphrase → hướng dẫn gỡ.
    await dialog.getByTestId('docker-tcp-key').fill(pem('encrypted-key.pem'))
    await dialog.getByTestId('docker-tcp-save').click()
    await expect(dialog.getByTestId('docker-tcp-error')).toContainText('passphrase')
    // Đúng → lưu, hộp thoại đóng, engine hiện ở thanh bên với biểu tượng riêng.
    await dialog.getByTestId('docker-tcp-key').fill(pem('client-key.pem'))
    await dialog.getByTestId('docker-tcp-save').click()
    await expect(dialog).toHaveCount(0)
    const endpoint = page.locator('[data-testid="docker-endpoint"][data-name="legacy-build"]')
    await expect(endpoint).toBeVisible()

    // Mở: mTLS tới Engine giả → danh sách container; build / shell (cần docker CLI) bị ẩn.
    await endpoint.dblclick()
    const view = page.getByTestId('docker-view')
    await expect(view.getByTestId('docker-container')).toHaveCount(3)
    await view.locator('[data-testid="docker-container"][data-name="web"]').click()
    await expect(view.getByTestId('docker-action-logs')).toBeVisible()
    await expect(view.getByTestId('docker-action-shell')).toHaveCount(0)
    await page.getByTestId('docker-nav-images').click()
    await expect(view.getByTestId('docker-build')).toHaveCount(0)
    await expect(view.getByTestId('docker-pull')).toBeVisible()

    // Sửa: đổi tên; chứng chỉ đã lưu được giữ (ô để trống, có ghi chú "Saved in the vault").
    await endpoint.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Edit connection…' }).click()
    await expect(dialog.getByTestId('docker-tcp-key')).toHaveAttribute(
      'placeholder',
      /Saved in the vault/
    )
    await expect(dialog.getByTestId('docker-tcp-key')).toHaveValue('')
    await dialog.getByTestId('docker-tcp-name').fill('legacy-build-2')
    await dialog.getByTestId('docker-tcp-save').click()
    await expect(dialog).toHaveCount(0)
    const renamed = page.locator('[data-testid="docker-endpoint"][data-name="legacy-build-2"]')
    await expect(renamed).toBeVisible()
    // Vẫn kết nối được sau khi sửa (chứng chỉ không mất).
    await renamed.dblclick()
    await expect(view.getByTestId('docker-container')).toHaveCount(3)

    // Xoá: hỏi lại, rồi biến khỏi thanh bên.
    await renamed.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Delete engine' }).click()
    await page
      .getByTestId('docker-tcp-delete-confirm')
      .getByRole('button', { name: 'Delete' })
      .click()
    await expect(renamed).toHaveCount(0)
  } finally {
    await launched.close()
    await proxy.close()
  }
})

test('Docker: build đa nền tảng (buildx) — chọn nền tảng, push với registry đã lưu, build thường vẫn như cũ', async () => {
  test.setTimeout(60_000)
  test.skip(isWindows, 'Engine giả dùng unix socket; docker giả là script sh')
  const engine = await startEngineTestServer()
  const bin = mkdtempSync(join(tmpdir(), 'sh-docker-bin-'))
  const log = join(bin, 'args.log')
  // `docker` giả: buildx có sẵn với một builder hỗ trợ thêm riscv64; build / login chỉ ghi tham số.
  writeFileSync(
    join(bin, 'docker'),
    [
      '#!/bin/sh',
      `echo "$@" >> '${log}'`,
      'case "$1 $2" in',
      '  "buildx version") echo "github.com/docker/buildx v0.17.1 abc"; exit 0;;',
      `  "buildx ls") echo '{"Name":"multi","Driver":"docker-container","Current":true,"Nodes":[{"Platforms":["linux/amd64*","linux/arm64","linux/riscv64"]}]}'; exit 0;;`,
      'esac',
      'case "$*" in',
      '  *" login "*) cat > /dev/null; echo "Login Succeeded"; exit 0;;',
      '  *build*) echo "#1 building"; echo "#2 DONE"; exit 0;;',
      'esac',
      'exit 0',
      ''
    ].join('\n')
  )
  chmodSync(join(bin, 'docker'), 0o755)
  const launched = await launchApp({
    DOCKER_HOST: `unix://${engine.path}`,
    PATH: `${bin}:${process.env['PATH'] ?? ''}`
  })
  const { page, app } = launched
  try {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = () => Promise.resolve({ response: 0, checkboxChecked: false })
    })
    await enableDocker(page)
    // Registry đã lưu (mật khẩu vào vault) — build push sẽ đăng nhập bằng nó.
    const saved = await page.evaluate(() =>
      window.shellhouse.invokeModule('docker', 'saveRegistry', [
        { name: 'GHCR', server: 'ghcr.io', username: 'me', secret: 'tok3n' }
      ])
    )
    expect(saved).toMatchObject({ ok: true })
    await page.locator('[data-testid="docker-endpoint"][data-name="This computer"]').dblclick()
    const view = page.getByTestId('docker-view')
    await page.getByTestId('docker-nav-images').click()
    await view.getByTestId('docker-build').click()
    const dialog = page.getByTestId('docker-build-dialog')
    await dialog.getByTestId('docker-build-context').fill('/srv/app')
    await dialog.getByTestId('docker-build-tags').fill('ghcr.io/me/app:1')

    // Có buildx → hiện nền tảng (kể cả riscv64 do builder báo); chọn hai → chỉ còn push / build only.
    await expect(dialog.getByTestId('docker-build-platform-linux/riscv64')).toBeVisible()
    await dialog.getByTestId('docker-build-platform-linux/amd64').check()
    await expect(dialog.getByTestId('docker-build-output')).toHaveValue('load')
    await dialog.getByTestId('docker-build-platform-linux/arm64').check()
    await expect(dialog.getByTestId('docker-build-output')).toHaveValue('push')
    expect(
      await dialog
        .getByTestId('docker-build-output')
        .evaluate((el) => (el as HTMLSelectElement).options[0]?.disabled)
    ).toBe(true)
    await dialog.getByTestId('docker-build-registry').selectOption({ label: 'GHCR (me)' })
    await dialog.getByTestId('docker-build-submit').click()
    await expect(dialog.getByTestId('docker-build-log')).toContainText('#2 DONE')
    await expect(dialog.getByTestId('docker-build-status')).toContainText('Built ghcr.io/me/app:1')

    const lines = readFileSync(log, 'utf8').trim().split('\n')
    const login = lines.find((l) => l.includes(' login '))
    expect(login).toMatch(/^--config \S+ login --username me --password-stdin ghcr\.io$/)
    expect(lines.join('\n')).not.toContain('tok3n')
    const build = lines.find((l) => l.includes('buildx build'))
    expect(build).toMatch(
      /^--config \S+ buildx build .*--platform linux\/amd64,linux\/arm64 --push .*-- \/srv\/app$/
    )
    // Cùng thư mục --config cho login và build.
    expect(login?.split(' ')[1]).toBe(build?.split(' ')[1])
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    // Không chọn nền tảng → `docker build` thường, không buildx.
    await view.getByTestId('docker-build').click()
    const again = page.getByTestId('docker-build-dialog')
    await again.getByTestId('docker-build-platform-linux/amd64').uncheck()
    await again.getByTestId('docker-build-platform-linux/arm64').uncheck()
    await again.getByTestId('docker-build-submit').click()
    await expect(again.getByTestId('docker-build-log')).toContainText('#2 DONE')
    const plain = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .filter((l) => l.startsWith('build '))
    expect(plain).toHaveLength(1)
  } finally {
    await launched.close()
    rmSync(bin, { recursive: true, force: true })
  }
})
