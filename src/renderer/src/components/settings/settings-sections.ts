import {
  Activity,
  Download,
  Globe,
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
  'network',
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
      { id: 'network', title: () => t('Network'), icon: Globe },
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

/** Dòng mô tả dưới tiêu đề của từng mục (thiết kế v0.5). */
export function settingsDescription(section: SettingsSection): string {
  switch (section) {
    case 'appearance':
      return t('Theme, density, language and what the sidebar shows.')
    case 'terminal':
      return t('Font, colors and behavior for SSH, Telnet, serial and local terminals.')
    case 'shortcuts':
      return t('Keyboard shortcuts for tabs, panes and the command palette.')
    case 'files':
      return t('File manager and transfer behavior for SFTP and S3.')
    case 'environments':
      return t('Labels, colors and safety rules for production, staging and other environments.')
    case 'keychain':
      return t('Shared accounts and SSH keys, stored in the encrypted vault.')
    case 'security':
      return t('Vault, auto-lock and how secrets are stored.')
    case 'modules':
      return t('Turn on Kubernetes, Docker, S3 and other tools.')
    case 'network':
      return t('Proxy and certificates for S3, Kubernetes and updates.')
    case 'updates':
      return t('Release channel and automatic updates.')
    case 'diagnostics':
      return t('Logs and performance information for troubleshooting.')
    case 'about':
      return t('Version, licenses and links.')
    default:
      return ''
  }
}
