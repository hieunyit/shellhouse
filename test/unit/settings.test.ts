import { describe, expect, it } from 'vitest'
import { applyPatch, DEFAULT_SETTINGS, parseSettings } from '@shared/settings'

describe('settings', () => {
  it('mặc định hợp lý', () => {
    expect(DEFAULT_SETTINGS.terminal).toMatchObject({
      themeId: 'system',
      fontSize: 14,
      scrollback: 10_000
    })
    expect(DEFAULT_SETTINGS.security).toEqual({
      autoLockMinutes: 15,
      lockOnSuspend: true,
      rememberOnDevice: false
    })
    expect(DEFAULT_SETTINGS.updates.channel).toBe('stable')
  })

  it('trường hỏng rơi về mặc định, trường khác giữ nguyên', () => {
    const s = parseSettings({
      terminal: { fontSize: 999, cursorStyle: 'kỳ-lạ', scrollback: 5000 },
      security: 'rác',
      keybindings: { 'tab.new': 'Ctrl+Shift+N' }
    })
    expect(s.terminal.fontSize).toBe(14)
    expect(s.terminal.cursorStyle).toBe('block')
    expect(s.terminal.scrollback).toBe(5000)
    expect(s.security).toEqual(DEFAULT_SETTINGS.security)
    expect(s.keybindings).toEqual({ 'tab.new': 'Ctrl+Shift+N' })
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS)
  })

  it('patch chỉ đổi phần được gửi', () => {
    const next = applyPatch(DEFAULT_SETTINGS, {
      terminal: { fontSize: 16 },
      security: { autoLockMinutes: 0 }
    })
    expect(next.terminal.fontSize).toBe(16)
    expect(next.terminal.cursorBlink).toBe(DEFAULT_SETTINGS.terminal.cursorBlink)
    expect(next.security).toMatchObject({ autoLockMinutes: 0, lockOnSuspend: true })
  })
})

describe('SettingsPatch (renderer → main)', () => {
  it('bỏ files.editor và security.rememberOnDevice; giữ các trường khác', async () => {
    const { SettingsPatch } = await import('@shared/settings')
    const patch = SettingsPatch.parse({
      files: { editor: '/tmp/evil.sh', inApp: false },
      security: { rememberOnDevice: true, autoLockMinutes: 5 }
    })
    expect(patch).toEqual({ files: { inApp: false }, security: { autoLockMinutes: 5 } })
    const next = applyPatch(DEFAULT_SETTINGS, patch)
    expect(next.files.editor).toBe('')
    expect(next.security.rememberOnDevice).toBe(false)
    // Main vẫn đặt được (qua hộp thoại / vault:setRemember).
    expect(applyPatch(DEFAULT_SETTINGS, { files: { editor: '/usr/bin/code' } }).files.editor).toBe(
      '/usr/bin/code'
    )
  })

  it('bỏ logging.directory và network.updatesInsecure (chỉ main đặt qua hộp thoại)', async () => {
    const { SettingsPatch } = await import('@shared/settings')
    const patch = SettingsPatch.parse({
      logging: { directory: '/home/u/.config/autostart', mode: 'all' },
      network: { updatesInsecure: true, proxyMode: 'none' }
    })
    expect(patch).toEqual({ logging: { mode: 'all' }, network: { proxyMode: 'none' } })
    const next = applyPatch(DEFAULT_SETTINGS, patch)
    expect(next.logging.directory).toBe('')
    expect(next.network.updatesInsecure).toBe(false)
    const byMain = applyPatch(DEFAULT_SETTINGS, {
      logging: { directory: '/home/u/logs' },
      network: { updatesInsecure: true }
    })
    expect(byMain.logging.directory).toBe('/home/u/logs')
    expect(byMain.network.updatesInsecure).toBe(true)
  })
})

describe('SettingsService', () => {
  it('lưu và đọc lại; JSON hỏng trong DB → mặc định', async () => {
    const { openDatabase } = await import('../../src/main/store/db')
    const { migrate } = await import('../../src/main/store/migrate')
    const { MIGRATIONS } = await import('../../src/main/store/migrations')
    const { SettingsService } = await import('../../src/main/settings')
    const db = openDatabase(':memory:')
    await migrate(db, MIGRATIONS)
    const a = new SettingsService(db)
    const seen: number[] = []
    a.onChange((s) => seen.push(s.terminal.fontSize))
    a.update({ terminal: { fontSize: 18 } })
    expect(new SettingsService(db).get().terminal.fontSize).toBe(18)
    expect(seen).toEqual([18])
    db.prepare("UPDATE settings SET value = '{không phải json' WHERE key = 'app'").run()
    expect(new SettingsService(db).get()).toEqual(DEFAULT_SETTINGS)
  })
})
