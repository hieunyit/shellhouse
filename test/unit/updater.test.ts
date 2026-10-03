import { beforeEach, describe, expect, it, vi } from 'vitest'

// electron-updater giả: checkForUpdates trả về promise do test điều khiển.
const updater = vi.hoisted(() => {
  const pending: { resolve: () => void; allowDowngrade: boolean }[] = []
  const fake = {
    logger: null as unknown,
    autoDownload: true,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    allowDowngrade: false,
    channel: 'latest',
    on: () => fake,
    checkForUpdates: () =>
      new Promise<void>((resolve) => {
        pending.push({ resolve, allowDowngrade: fake.allowDowngrade })
      }),
    downloadUpdate: () => Promise.resolve(),
    quitAndInstall: () => undefined
  }
  return { fake, pending }
})

vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '1.2.0-beta.9' }
}))
vi.mock('electron-log/main', () => ({
  default: { scope: () => ({ warn: () => undefined }), warn: () => undefined }
}))
vi.mock('electron-updater', () => ({ autoUpdater: updater.fake }))
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  existsSync: () => true
}))

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('Updater: beta → stable khi đang có lần kiểm tra định kỳ', () => {
  beforeEach(() => {
    updater.pending.length = 0
    Object.assign(process, { resourcesPath: '/res' })
  })

  it('lần kiểm tra đang chạy dở không xoá quyền hạ phiên bản; lần sau khi đổi kênh mới dùng nó', async () => {
    const { Updater } = await import('../../src/main/updater')
    const u = new Updater()
    u.setChannel('beta')
    // Lần kiểm tra định kỳ bắt đầu (kênh beta).
    const periodic = u.check()
    await flush()
    expect(updater.pending).toHaveLength(1)
    expect(updater.pending[0]?.allowDowngrade).toBe(false)

    // Người dùng chuyển về stable trong lúc nó còn chạy, rồi kiểm tra ngay.
    u.setChannel('stable')
    expect(updater.fake.allowDowngrade).toBe(true)
    const manual = u.check()
    await flush()
    // Lần thủ công nối đuôi, chưa gọi electron-updater.
    expect(updater.pending).toHaveLength(1)

    updater.pending[0]?.resolve()
    await periodic
    await flush()
    // Lần cũ xong KHÔNG xoá quyền → lần thủ công chạy với allowDowngrade.
    expect(updater.pending).toHaveLength(2)
    expect(updater.pending[1]?.allowDowngrade).toBe(true)

    updater.pending[1]?.resolve()
    await manual
    // Đã dùng xong → tắt.
    expect(updater.fake.allowDowngrade).toBe(false)
    const next = u.check()
    await flush()
    expect(updater.pending[2]?.allowDowngrade).toBe(false)
    updater.pending[2]?.resolve()
    await next
  })
})
