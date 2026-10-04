import type { KeychainFilter } from '../accounts/keychain-logic'

/** Các mục của trang Cài đặt (thứ tự trên thanh bên). */
export const SETTINGS_SECTIONS = [
  'appearance',
  'terminal',
  'files',
  'modules',
  'security',
  'keychain',
  'shortcuts',
  'updates',
  'diagnostics',
  'about'
] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

/**
 * Mục mở được từ ngoài. 'accounts' / 'keys' là tên cũ (trước khi gộp thành Keychain) — vẫn nhận, mở
 * Keychain với bộ lọc tương ứng.
 */
export type SettingsSectionId = SettingsSection | 'accounts' | 'keys'

/** Tên mục cũ → mục hiện tại + bộ lọc Keychain chọn sẵn. */
export function resolveSettingsSection(id: SettingsSectionId): {
  section: SettingsSection
  keychainFilter: KeychainFilter
} {
  if (id === 'accounts') return { section: 'keychain', keychainFilter: 'accounts' }
  if (id === 'keys') return { section: 'keychain', keychainFilter: 'keys' }
  return { section: id, keychainFilter: 'all' }
}
