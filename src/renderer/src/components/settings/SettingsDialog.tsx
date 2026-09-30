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
import { Diagnostics } from '../Diagnostics'
import { cx, Modal } from '../ui'
import { AppearanceSection } from './AppearanceSection'
import { FilesSection } from './FilesSection'
import { KeysSection } from './KeysSection'
import { SecuritySection } from './SecuritySection'
import { ShortcutsSection } from './ShortcutsSection'
import { TerminalSection } from './TerminalSection'
import { UpdatesSection } from './UpdatesSection'
import { AboutSection } from './AboutSection'
import { ModulesSection } from './ModulesSection'

const SECTIONS = [
  { id: 'appearance', title: 'Appearance', icon: Palette },
  { id: 'terminal', title: 'Terminal', icon: SquareTerminal },
  { id: 'files', title: 'Files', icon: FolderOpen },
  { id: 'modules', title: 'Modules', icon: Puzzle },
  { id: 'security', title: 'Security', icon: Shield },
  { id: 'keys', title: 'SSH keys', icon: KeyRound },
  { id: 'shortcuts', title: 'Shortcuts', icon: Keyboard },
  { id: 'updates', title: 'Updates', icon: Download },
  { id: 'diagnostics', title: 'Diagnostics', icon: Activity },
  { id: 'about', title: 'About', icon: Info }
] as const
export type SettingsSectionId = (typeof SECTIONS)[number]['id']

export function SettingsDialog({
  onClose,
  initial = 'appearance'
}: {
  onClose: () => void
  initial?: SettingsSectionId
}): React.JSX.Element {
  const [section, setSection] = useState<SettingsSectionId>(initial)
  return (
    <Modal
      title="Settings"
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
              }}
            >
              <s.icon size={15} />
              {s.title}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1 overflow-auto p-6">
          {section === 'appearance' && <AppearanceSection />}
          {section === 'terminal' && <TerminalSection />}
          {section === 'files' && <FilesSection />}
          {section === 'modules' && <ModulesSection />}
          {section === 'security' && <SecuritySection />}
          {section === 'keys' && <KeysSection />}
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
