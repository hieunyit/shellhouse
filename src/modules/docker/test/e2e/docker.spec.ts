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
    await view.getByTestId('docker-nav-volumes').click()
    await view.getByTestId('docker-new-volume').click()
    await page.getByTestId('docker-volume-name').fill('pgdata')
    await page.getByTestId('docker-volume-create').click()
    await expect(view.locator('[data-testid="docker-volume"][data-name="pgdata"]')).toBeVisible()

    // Tổng quan: build cache có nút dọn (xem trước dung lượng).
    await view.getByTestId('docker-nav-overview').click()
    await expect(view.getByTestId('docker-ov-row-buildCache')).toContainText('reclaimable')
    await view.getByTestId('docker-ov-prune-buildCache').click()
    await expect(page.getByTestId('docker-prune-dialog')).toContainText('cache-free')
    await page.getByTestId('docker-prune-confirm').click()
    await expect.poll(() => engine.buildCache.length).toBe(1)

    // Log của cả Compose project: một tab, dòng có tiền tố service.
    await view.getByTestId('docker-nav-compose').click()
    await view
      .locator('[data-testid="docker-project"][data-name="shop"]')
      .getByTestId('docker-compose-logs')
      .click()
    await expect(page.getByTestId('tab').last()).toContainText('shop (logs)')
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
    await view.getByTestId('docker-nav-volumes').click()
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
    await view.getByTestId('docker-nav-compose').click()
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
    await expect(page.getByTestId('tab').last()).toContainText('Docker · Ubuntu (WSL)')
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
