import { useState } from 'react'
import {
  Activity,
  Download,
  FolderOpen,
  Info,
  Keyboard,
  KeyRound,
  Palette,
  Puzzle,
  Shield,
  SquareTerminal
} from 'lucide-react'
import { t } from '@shared/i18n'
import { Diagnostics } from '../Diagnostics'
import { cx, Modal } from '../ui'
import type { KeychainFilter } from '../accounts/keychain-logic'
import {
  resolveSettingsSection,
  type SettingsSection,
  type SettingsSectionId
} from './settings-sections'
import { AppearanceSection } from './AppearanceSection'
import { FilesSection } from './FilesSection'
import { KeychainSection } from './KeychainSection'
import { SecuritySection } from './SecuritySection'
import { ShortcutsSection } from './ShortcutsSection'
import { TerminalSection } from './TerminalSection'
import { UpdatesSection } from './UpdatesSection'
import { AboutSection } from './AboutSection'
import { ModulesSection } from './ModulesSection'

// Tiêu đề là hàm: dịch lúc render, không ở cấp module.
const SECTIONS: readonly {
  id: SettingsSection
  title: () => string
  icon: typeof Palette
}[] = [
  { id: 'appearance', title: () => t('Appearance'), icon: Palette },
  { id: 'terminal', title: () => t('Terminal'), icon: SquareTerminal },
  { id: 'files', title: () => t('Files'), icon: FolderOpen },
  { id: 'modules', title: () => t('Modules'), icon: Puzzle },
  { id: 'security', title: () => t('Security'), icon: Shield },
  { id: 'keychain', title: () => t('Keychain'), icon: KeyRound },
  { id: 'shortcuts', title: () => t('Shortcuts'), icon: Keyboard },
  { id: 'updates', title: () => t('Updates'), icon: Download },
  { id: 'diagnostics', title: () => t('Diagnostics'), icon: Activity },
  { id: 'about', title: () => t('About'), icon: Info }
]
export type { SettingsSectionId } from './settings-sections'

export function SettingsDialog({
  onClose,
  initial = 'appearance'
}: {
  onClose: () => void
  initial?: SettingsSectionId
}): React.JSX.Element {
  const resolved = resolveSettingsSection(initial)
  const [section, setSection] = useState<SettingsSection>(resolved.section)
  const [keychainFilter, setKeychainFilter] = useState<KeychainFilter>(resolved.keychainFilter)
  return (
    <Modal
      title={t('Settings')}
      onClose={onClose}
      width="max-w-4xl"
      testId="settings-dialog"
      bodyClassName="px-0 pb-0"
    >
      <div className="flex h-[34rem] border-t border-line">
        <nav className="flex w-48 shrink-0 flex-col gap-0.5 border-r border-line bg-subtle p-2">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              data-testid={`settings-nav-${s.id}`}
              aria-current={section === s.id}
              className={cx(
                'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors',
                section === s.id
                  ? 'bg-surface font-medium text-fg shadow-sm'
                  : 'text-muted hover:bg-hover hover:text-fg'
              )}
              onClick={() => {
                setSection(s.id)
                setKeychainFilter('all')
              }}
            >
              <s.icon size={15} />
              {s.title()}
            </button>
          ))}
        </nav>
        <div
          className={cx(
            'min-w-0 flex-1',
            // Keychain tự chia hai khung, tự cuộn từng khung.
            section === 'keychain' ? 'overflow-hidden' : 'overflow-auto p-6'
          )}
        >
          {section === 'appearance' && <AppearanceSection />}
          {section === 'terminal' && <TerminalSection />}
          {section === 'files' && <FilesSection />}
          {section === 'modules' && <ModulesSection />}
          {section === 'security' && <SecuritySection />}
          {section === 'keychain' && <KeychainSection filter={keychainFilter} />}
          {section === 'shortcuts' && <ShortcutsSection />}
          {section === 'updates' && <UpdatesSection />}
          {section === 'diagnostics' && <Diagnostics />}
          {section === 'about' && (
            <AboutSection
              onCheckUpdates={() => {
                setSection('updates')
                void window.shellhouse.checkForUpdates()
              }}
            />
          )}
        </div>
      </div>
    </Modal>
  )
}
