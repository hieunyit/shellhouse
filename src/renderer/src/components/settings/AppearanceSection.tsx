import { Monitor, Moon, Sun } from 'lucide-react'
import { useSettings } from '../../stores/settings'
import { LANGUAGES, t } from '@shared/i18n'
import { systemLanguage } from '../../lib/platform'
import { Button, cx, Segmented, SettingGroup, SettingRow, Switch } from '../ui'

// Hàm (không phải hằng): dịch lúc render.
function themeOptions() {
  return [
    { value: 'system', label: t('System'), icon: Monitor, hint: t('Follow the operating system') },
    { value: 'light', label: t('Light'), icon: Sun, hint: t('Always light') },
    { value: 'dark', label: t('Dark'), icon: Moon, hint: t('Always dark') }
  ] as const
}

export function AppearanceSection(): React.JSX.Element {
  const { settings, update } = useSettings()
  const current = settings.appearance.theme
  return (
    <div data-testid="settings-appearance">
      <SettingGroup title={t('Look')}>
        <SettingRow
          title={t('Theme')}
          description={t('The terminal color theme follows this too when set to “Match app”.')}
          control={
            <div
              role="radiogroup"
              aria-label={t('Theme')}
              className="inline-flex gap-0.5 rounded-ds-md border border-ds-border-strong bg-subtle p-0.5"
            >
              {themeOptions().map((o) => (
                <button
                  key={o.value}
                  type="button"
                  role="radio"
                  aria-checked={current === o.value}
                  title={o.hint}
                  data-testid={`appearance-${o.value}`}
                  className={cx(
                    'flex h-6 items-center gap-1.5 rounded-ds-sm px-2.5 text-xs font-medium outline-none focus-visible:shadow-ds-focus',
                    current === o.value ? 'bg-ds-surface-3 text-fg' : 'text-muted hover:text-fg'
                  )}
                  onClick={() => void update({ appearance: { theme: o.value } })}
                >
                  <o.icon size={13} /> {o.label}
                </button>
              ))}
            </div>
          }
        />
        <SettingRow
          title={t('Density')}
          description={t('Compact fits more rows on screen; Comfortable is easier to read.')}
          control={
            <Segmented
              value={settings.appearance.density}
              testIdPrefix="setting-density"
              options={[
                { value: 'comfortable', label: t('Comfortable') },
                { value: 'compact', label: t('Compact') }
              ]}
              onChange={(value) => void update({ appearance: { density: value } })}
            />
          }
        />
        <LanguagePicker />
      </SettingGroup>
      <SettingGroup title={t('Sidebar')}>
        <SettingRow
          title={t('Show Favorites')}
          description={t(
            'Shortcuts at the top of the sidebar. The hosts stay in their groups either way.'
          )}
          control={
            <Switch
              label={t('Show Favorites')}
              checked={settings.appearance.showFavorites}
              data-testid="setting-show-favorites"
              onChange={(e) => void update({ appearance: { showFavorites: e.target.checked } })}
            />
          }
        />
        <SettingRow
          title={t('Show Recent (last 5 hosts you connected to)')}
          control={
            <Switch
              label={t('Show Recent (last 5 hosts you connected to)')}
              checked={settings.appearance.showRecent}
              data-testid="setting-show-recent"
              onChange={(e) => void update({ appearance: { showRecent: e.target.checked } })}
            />
          }
        />
      </SettingGroup>
      <SettingGroup title={t('Home')}>
        <SettingRow
          title={t('Show “Needs attention”')}
          description={t(
            'Failing pods, unhealthy containers and dropped sessions from the tabs you have open. Off: nothing is checked in the background.'
          )}
          control={
            <Switch
              label={t('Show “Needs attention”')}
              checked={settings.appearance.homeAttention}
              data-testid="setting-home-attention"
              onChange={(e) => void update({ appearance: { homeAttention: e.target.checked } })}
            />
          }
        />
      </SettingGroup>
      <SettingGroup title={t('Startup')}>
        <SettingRow
          title={t('When Shellhouse starts')}
          description={t('What the first tab shows.')}
          control={
            <Segmented
              value={settings.appearance.startup ?? 'home'}
              testIdPrefix="setting-startup"
              options={[
                { value: 'home', label: t('Home') },
                { value: 'terminal', label: t('Local terminal') }
              ]}
              onChange={(startup) => void update({ appearance: { startup } })}
            />
          }
        />
      </SettingGroup>
    </div>
  )
}

/**
 * Ngôn ngữ giao diện. Chuỗi được dịch lúc vẽ và nhiều chỗ tính sẵn khi nạp, nên đổi ngôn ngữ cần
 * khởi động lại app (như VS Code) — không cố vẽ lại nửa vời.
 */
function LanguagePicker(): React.JSX.Element {
  const { settings, update } = useSettings()
  const value = settings.appearance.language
  const systemName = LANGUAGES.find((l) => l.value === systemLanguage())?.label ?? 'English'
  const effective = value === 'system' ? systemLanguage() : value
  const pending = effective !== window.shellhouse.language
  return (
    <SettingRow
      title={t('Language')}
      description={t('Dates, times and numbers follow the language you pick.')}
      control={
        <Segmented
          value={value}
          testIdPrefix="setting-language"
          options={[
            { value: 'system', label: t('System ({name})', { name: systemName }) },
            ...LANGUAGES.map((l) => ({ value: l.value, label: l.label }))
          ]}
          onChange={(language) => void update({ appearance: { language } })}
        />
      }
    >
      {pending && (
        <div
          className="flex items-center gap-3 rounded-ds-lg bg-subtle px-3 py-2 text-xs text-muted"
          data-testid="language-restart"
        >
          <span className="flex-1">
            {t('Restart Shellhouse to switch the language. Open sessions will be closed.')}
          </span>
          <Button size="sm" variant="primary" onClick={() => void window.shellhouse.relaunch()}>
            {t('Restart now')}
          </Button>
        </div>
      )}
    </SettingRow>
  )
}
