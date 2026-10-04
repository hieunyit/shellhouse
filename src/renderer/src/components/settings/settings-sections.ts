import {
  Activity,
  Download,
  FolderOpen,
  Info,
  Keyboard,
  KeyRound,
  Layers,
  Palette,
  Puzzle,
  Shield,
  SquareTerminal
} from 'lucide-react'
import { t } from '@shared/i18n'
import type { KeychainFilter } from '../accounts/keychain-logic'

/** Các mục của trang Cài đặt (thứ tự trên thanh bên). */
export const SETTINGS_SECTIONS = [
  'appearance',
  'environments',
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

/**
 * Mục lục của trang Cài đặt (Explorer của khu vực Settings), 3 nhóm: chung · thông tin đăng nhập ·
 * ứng dụng. Tiêu đề là hàm: dịch lúc render, không ở cấp module.
 */
export const SETTINGS_NAV: readonly {
  group: () => string
  items: readonly { id: SettingsSection; title: () => string; icon: typeof Palette }[]
}[] = [
  {
    group: () => t('General'),
    items: [
      { id: 'appearance', title: () => t('Appearance'), icon: Palette },
      { id: 'terminal', title: () => t('Terminal'), icon: SquareTerminal },
      { id: 'shortcuts', title: () => t('Shortcuts'), icon: Keyboard },
      { id: 'files', title: () => t('Files'), icon: FolderOpen }
    ]
  },
  {
    group: () => t('Workspace'),
    items: [{ id: 'environments', title: () => t('Environments'), icon: Layers }]
  },
  {
    group: () => t('Credentials'),
    items: [
      { id: 'keychain', title: () => t('Keychain'), icon: KeyRound },
      { id: 'security', title: () => t('Security'), icon: Shield }
    ]
  },
  {
    group: () => t('App'),
    items: [
      { id: 'modules', title: () => t('Modules'), icon: Puzzle },
      { id: 'updates', title: () => t('Updates'), icon: Download },
      { id: 'diagnostics', title: () => t('Diagnostics'), icon: Activity },
      { id: 'about', title: () => t('About'), icon: Info }
    ]
  }
]

export function settingsTitle(section: SettingsSection): string {
  for (const g of SETTINGS_NAV) for (const i of g.items) if (i.id === section) return i.title()
  return t('Settings')
}
