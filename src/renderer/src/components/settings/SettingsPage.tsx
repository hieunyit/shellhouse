import { useEffect, useRef } from 'react'
import { t } from '@shared/i18n'
import { Diagnostics } from '../Diagnostics'
import { cx } from '../ui'
import { Settings } from 'lucide-react'
import { ICON_SM } from '../../ds/utils'
import { AreaHeader } from '../AreaHeader'
import {
  resolveSettingsSection,
  settingsDescription,
  settingsTitle,
  type SettingsSectionId
} from './settings-sections'
import { AppearanceSection } from './AppearanceSection'
import { EnvironmentsSection } from './EnvironmentsSection'
import { FilesSection } from './FilesSection'
import { KeychainSection } from './KeychainSection'
import { SecuritySection } from './SecuritySection'
import { ShortcutsSection } from './ShortcutsSection'
import { TerminalSection } from './TerminalSection'
import { UpdatesSection } from './UpdatesSection'
import { AboutSection } from './AboutSection'
import { ModulesSection } from './ModulesSection'

export type { SettingsSectionId } from './settings-sections'

/**
 * Trang Cài đặt (vùng chính của khu vực Settings): tiêu đề + nội dung của mục đang chọn, không khung
 * thẻ. Mục lục nằm ở Explorer (`SettingsNav`).
 */
export function SettingsPage({
  section: requested,
  onSection
}: {
  section: SettingsSectionId
  onSection: (section: SettingsSectionId) => void
}): React.JSX.Element {
  const resolved = resolveSettingsSection(requested)
  const section = resolved.section
  const rootRef = useRef<HTMLDivElement>(null)
  // Mở bằng phím tắt / bảng lệnh: đưa focus vào trang (người dùng bàn phím đi tiếp bằng Tab).
  useEffect(() => {
    const root = rootRef.current
    if (root && !root.contains(document.activeElement)) root.focus({ preventScroll: true })
  }, [])
  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="flex h-full min-h-0 flex-col bg-ds-surface-0 outline-none"
      data-testid="settings-dialog"
      data-section={section}
      role="region"
      aria-label={t('Settings')}
    >
      <AreaHeader icon={<Settings {...ICON_SM} />} title={t('Settings')}>
        <span className="text-ds-base text-ds-fg-3">/</span>
        <span className="truncate text-ds-base font-medium text-ds-fg-2">
          {settingsTitle(section)}
        </span>
      </AreaHeader>
      <div
        className={cx(
          'min-h-0 flex-1',
          // Keychain tự chia hai khung, tự cuộn từng khung.
          section === 'keychain' ? 'flex flex-col overflow-hidden' : 'overflow-auto'
        )}
      >
        <div
          className={cx(
            section === 'keychain'
              ? 'flex min-h-0 flex-1 flex-col'
              : 'mx-auto w-full max-w-3xl px-8 pt-6 pb-10'
          )}
        >
          {section !== 'keychain' && (
            <div className="mb-6">
              <h2 className="text-ds-xl font-semibold tracking-[-0.018em] text-ds-fg">
                {settingsTitle(section)}
              </h2>
              {settingsDescription(section) && (
                <p className="mt-1 text-ds-base text-ds-fg-3">{settingsDescription(section)}</p>
              )}
            </div>
          )}
          {section === 'appearance' && <AppearanceSection />}
          {section === 'environments' && <EnvironmentsSection />}
          {section === 'terminal' && <TerminalSection />}
          {section === 'files' && <FilesSection />}
          {section === 'modules' && <ModulesSection />}
          {section === 'security' && <SecuritySection />}
          {section === 'keychain' && (
            <KeychainSection key={requested} filter={resolved.keychainFilter} />
          )}
          {section === 'shortcuts' && <ShortcutsSection />}
          {section === 'updates' && <UpdatesSection />}
          {section === 'diagnostics' && <Diagnostics />}
          {section === 'about' && (
            <AboutSection
              onCheckUpdates={() => {
                onSection('updates')
                void window.shellhouse.checkForUpdates()
              }}
            />
          )}
        </div>
      </div>
    </div>
  )
}
