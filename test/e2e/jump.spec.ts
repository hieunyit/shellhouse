import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { startTestSshServer, type TestSshServer } from '../integration/ssh-test-server'
import { activeTab, expect, launchApp, sendLine, test, waitForText } from './fixtures'

const servers: TestSshServer[] = []
test.afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
})

async function createHost(
  page: Page,
  opts: {
    label: string
    port: number
    username: string
    password?: string
    jumpLabel?: string
    system?: boolean
  }
): Promise<void> {
  await page.getByTestId('add-host').click()
  const form = page.getByTestId('host-form')
  await form.getByTestId('host-hostname').fill('127.0.0.1')
  await form.getByTestId('host-port').fill(String(opts.port))
  await form.getByTestId('host-username').fill(opts.username)
  await form.getByTestId('host-label').fill(opts.label)
  if (opts.password) {
    await form.getByTestId('host-auth-password').check()
    await form.getByTestId('host-password').fill(opts.password)
  }
  if (opts.jumpLabel) {
    await form.getByTestId('jump-add').click()
    await form.getByTestId('jump-add-search').fill(opts.jumpLabel)
    await form.locator(`[data-testid="jump-option"][data-name="${opts.jumpLabel}"]`).click()
    await expect(form.getByTestId('jump-list')).toContainText(opts.jumpLabel)
  }
  if (opts.system) {
    await form.getByTestId('host-advanced').click()
    await form.getByTestId('host-mode-system').check()
  }
  await form.getByTestId('host-save').click()
  await expect(form).toHaveCount(0)
}

test('ProxyJump: host đích đi qua bastion; mỗi chặng xác nhận host key, mật khẩu lấy từ vault', async ({
  page
}) => {
  const bastion = await startTestSshServer([{ username: 'jump', password: 'pw-bastion' }])
  const target = await startTestSshServer([{ username: 'app', password: 'pw-app' }])
  servers.push(bastion, target)
  await createHost(page, {
    label: 'bastion',
    port: bastion.port,
    username: 'jump',
    password: 'pw-bastion'
  })
  await createHost(page, {
    label: 'app-server',
    port: target.port,
    username: 'app',
    password: 'pw-app',
    jumpLabel: 'bastion'
  })

  await page.locator('[data-testid="host-row"][data-host-label="app-server"]').dblclick()
  const tab = await activeTab(page)
  // Host key của bastion rồi của đích — hai hộp thoại riêng.
  await expect(page.getByTestId('hostkey-new')).toContainText(`127.0.0.1:${bastion.port}`)
  await page.getByTestId('hostkey-accept').click()
  await expect(page.getByTestId('hostkey-new')).toContainText(`127.0.0.1:${target.port}`)
  await page.getByTestId('hostkey-accept').click()

  await waitForText(page, tab, 'welcome to test server')
  await expect(page.getByTestId('prompt-dialog')).toHaveCount(0)
  await sendLine(page, tab, 'echo qua-bastion')
  await waitForText(page, tab, 'qua-bastion\n')
  expect(bastion.events.directTcpip).toEqual([{ destIP: '127.0.0.1', destPort: target.port }])
})

test('chế độ tương thích: chạy OpenSSH thật, mật khẩu gõ trong terminal', async () => {
  const target = await startTestSshServer([{ username: 'legacy', password: 'pw-openssh' }])
  servers.push(target)
  // Không đụng ~/.ssh/known_hosts thật; không dùng agent/key của máy chạy test.
  const scratch = mkdtempSync(join(tmpdir(), 'shellhouse-kh-'))
  const launched = await launchApp({
    SHELLHOUSE_TEST_SSH_OPTIONS: JSON.stringify([
      `UserKnownHostsFile=${join(scratch, 'known_hosts')}`,
      'StrictHostKeyChecking=accept-new',
      'PubkeyAuthentication=no',
      'IdentityAgent=none',
      'PreferredAuthentications=password'
    ])
  })
  try {
    const { page } = launched
    await createHost(page, {
      label: 'openssh',
      port: target.port,
      username: 'legacy',
      system: true
    })
    await page.locator('[data-testid="host-row"][data-host-label="openssh"]').dblclick()
    const tab = await activeTab(page)
    // OpenSSH tự hỏi mật khẩu ngay trong terminal (không phải hộp thoại của app).
    await waitForText(page, tab, 'password:', 15_000)
    await expect(page.getByTestId('prompt-dialog')).toHaveCount(0)
    await sendLine(page, tab, 'pw-openssh')
    await waitForText(page, tab, 'welcome to test server')
    await sendLine(page, tab, 'echo tu-openssh')
    await waitForText(page, tab, 'tu-openssh\n')
    expect(await page.evaluate((id) => window.__shellhouseTest.bufferText(id), tab)).not.toContain(
      'pw-openssh'
    )
  } finally {
    await launched.close()
    rmSync(scratch, { recursive: true, force: true })
  }
})
