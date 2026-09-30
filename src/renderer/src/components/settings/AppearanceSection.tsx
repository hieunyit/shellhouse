import { Monitor, Moon, Sun } from 'lucide-react'
import { useSettings } from '../../stores/settings'
import { Checkbox, cx, SectionTitle } from '../ui'

const OPTIONS = [
  { value: 'system', label: 'System', icon: Monitor, hint: 'Follow the operating system' },
  { value: 'light', label: 'Light', icon: Sun, hint: 'Always light' },
  { value: 'dark', label: 'Dark', icon: Moon, hint: 'Always dark' }
] as const

export function AppearanceSection(): React.JSX.Element {
  const { settings, update } = useSettings()
  const current = settings.appearance.theme
  return (
    <div data-testid="settings-appearance">
      <SectionTitle description="The terminal color theme follows this too when set to “Match app”.">
        Theme
      </SectionTitle>
      <div className="grid grid-cols-3 gap-3" role="radiogroup">
        {OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={current === o.value}
            data-testid={`appearance-${o.value}`}
            className={cx(
              'flex flex-col items-start gap-3 rounded-xl border p-3 text-left transition-colors',
              current === o.value ? 'border-accent bg-accent-soft' : 'border-line hover:bg-hover'
            )}
            onClick={() => void update({ appearance: { theme: o.value } })}
          >
            <Preview mode={o.value} />
            <span className="flex items-center gap-2 text-[13px] font-medium text-fg">
              <o.icon size={14} /> {o.label}
            </span>
            <span className="-mt-2 text-xs text-muted">{o.hint}</span>
          </button>
        ))}
      </div>
      <div className="mt-6">
        <SectionTitle description="Shortcuts at the top of the sidebar. The hosts stay in their groups either way.">
          Sidebar
        </SectionTitle>
        <div className="flex flex-col gap-3">
          <Checkbox
            label="Show Favorites"
            checked={settings.appearance.showFavorites}
            data-testid="setting-show-favorites"
            onChange={(e) => void update({ appearance: { showFavorites: e.target.checked } })}
          />
          <Checkbox
            label="Show Recent (last 5 hosts you connected to)"
            checked={settings.appearance.showRecent}
            data-testid="setting-show-recent"
            onChange={(e) => void update({ appearance: { showRecent: e.target.checked } })}
          />
        </div>
      </div>
    </div>
  )
}

/** Hình minh hoạ nhỏ của cửa sổ app ở chế độ sáng / tối. */
function Preview({ mode }: { mode: 'system' | 'light' | 'dark' }): React.JSX.Element {
  const pane = (dark: boolean): React.JSX.Element => (
    <div className={cx('flex h-full flex-1 overflow-hidden', dark ? 'bg-[#14171b]' : 'bg-white')}>
      <div
        className={cx(
          'w-1/3 border-r',
          dark ? 'border-[#262b33] bg-[#1a1d22]' : 'border-[#e2e5ea] bg-[#f4f5f7]'
        )}
      />
      <div className="flex-1 p-1.5">
        <div className={cx('mb-1 h-1 w-3/4 rounded', dark ? 'bg-[#2cc9b5]' : 'bg-[#0f766e]')} />
        <div className={cx('h-1 w-1/2 rounded', dark ? 'bg-[#353b45]' : 'bg-[#cdd2d9]')} />
      </div>
    </div>
  )
  return (
    <div className="flex h-16 w-full overflow-hidden rounded-md border border-line">
      {mode === 'system' ? (
        <>
          {pane(false)}
          {pane(true)}
        </>
      ) : (
        pane(mode === 'dark')
      )}
    </div>
  )
}
