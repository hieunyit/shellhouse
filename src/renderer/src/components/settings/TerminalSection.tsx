import { useState } from 'react'
import { Upload } from 'lucide-react'
import { BUILTIN_THEMES, importItermColors, importWindowsTerminal } from '@shared/themes'
import { t } from '@shared/i18n'
import { forgetHistory } from '../../terminal/suggestions'
import { useSettings } from '../../stores/settings'
import { useShells } from '../../stores/shells'
import { Button, Checkbox, Field, Input, Notice, SectionTitle, Segmented, Select } from '../ui'
import { confirmAction } from '../../stores/confirm'

export function TerminalSection(): React.JSX.Element {
  const { settings, update } = useSettings()
  const shells = useShells((s) => s.shells)
  const term = settings.terminal
  const themes = [...BUILTIN_THEMES, ...settings.customThemes]
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const importTheme = async (file: File): Promise<void> => {
    try {
      const text = await file.text()
      const theme = file.name.endsWith('.itermcolors')
        ? importItermColors(text, file.name.replace(/\.itermcolors$/, ''))
        : importWindowsTerminal(text)
      const others = settings.customThemes.filter((c) => c.id !== theme.id)
      await update({ customThemes: [...others, theme], terminal: { themeId: theme.id } })
      setMessage({ ok: true, text: t('Imported theme “{name}”.', { name: theme.name }) })
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <div className="flex flex-col gap-6" data-testid="settings-terminal">
      <section className="flex flex-col gap-3">
        <SectionTitle>{t('Colors')}</SectionTitle>
        <Field label={t('Color theme')}>
          <Select
            data-testid="setting-theme"
            value={term.themeId}
            onChange={(e) => void update({ terminal: { themeId: e.target.value } })}
          >
            <option value="system">{t('Match app (light / dark)')}</option>
            {themes.map((th) => (
              <option key={th.id} value={th.id}>
                {th.name}
              </option>
            ))}
          </Select>
        </Field>
        {term.themeId === 'system' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('When dark')}>
              <Select
                value={term.darkThemeId}
                onChange={(e) => void update({ terminal: { darkThemeId: e.target.value } })}
              >
                {themes
                  .filter((th) => th.dark)
                  .map((th) => (
                    <option key={th.id} value={th.id}>
                      {th.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label={t('When light')}>
              <Select
                value={term.lightThemeId}
                onChange={(e) => void update({ terminal: { lightThemeId: e.target.value } })}
              >
                {themes
                  .filter((th) => !th.dark)
                  .map((th) => (
                    <option key={th.id} value={th.id}>
                      {th.name}
                    </option>
                  ))}
              </Select>
            </Field>
          </div>
        )}
        <div className="flex items-center gap-3">
          <label className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border border-line bg-surface px-3 text-[13px] font-medium hover:bg-hover">
            <Upload size={14} /> {t('Import theme…')}
            <input
              type="file"
              accept=".json,.itermcolors"
              className="hidden"
              data-testid="theme-import"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void importTheme(file)
                e.target.value = ''
              }}
            />
          </label>
          <span className="text-xs text-faint">
            {t('Windows Terminal (.json) or iTerm2 (.itermcolors)')}
          </span>
        </div>
        {message && (
          <Notice tone={message.ok ? 'success' : 'danger'} testId="theme-message">
            {message.text}
          </Notice>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <SectionTitle>{t('Text')}</SectionTitle>
        <Field label={t('Font family')}>
          <Input
            placeholder={t('Default (JetBrains Mono)')}
            value={term.fontFamily}
            onChange={(e) => void update({ terminal: { fontFamily: e.target.value } })}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('Font size')}>
            <Input
              type="number"
              min={8}
              max={32}
              data-testid="setting-font-size"
              value={term.fontSize}
              onChange={(e) => void update({ terminal: { fontSize: Number(e.target.value) } })}
            />
          </Field>
          <Field label={t('Line height')}>
            <Input
              type="number"
              min={1}
              max={2}
              step={0.05}
              value={term.lineHeight}
              onChange={(e) => void update({ terminal: { lineHeight: Number(e.target.value) } })}
            />
          </Field>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <SectionTitle>{t('Behavior')}</SectionTitle>
        <Field label={t('Shell for new terminals')}>
          <Select
            data-testid="setting-default-shell"
            value={term.defaultShell}
            onChange={(e) => {
              void update({ terminal: { defaultShell: e.target.value } }).then(() =>
                useShells.getState().load()
              )
            }}
          >
            <option value="">{t('Automatic')}</option>
            {shells.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('Cursor style')}>
            <Select
              value={term.cursorStyle}
              onChange={(e) =>
                void update({
                  terminal: { cursorStyle: e.target.value as typeof term.cursorStyle }
                })
              }
            >
              <option value="block">{t('Block')}</option>
              <option value="bar">{t('Bar')}</option>
              <option value="underline">{t('Underline')}</option>
            </Select>
          </Field>
          <Field label={t('Scrollback lines')}>
            <Input
              type="number"
              min={1000}
              max={100000}
              step={1000}
              value={term.scrollback}
              onChange={(e) => void update({ terminal: { scrollback: Number(e.target.value) } })}
            />
          </Field>
        </div>
        <Checkbox
          label={t('Blinking cursor')}
          checked={term.cursorBlink}
          onChange={(e) => void update({ terminal: { cursorBlink: e.target.checked } })}
        />
        <Field label={t('Right-click in the terminal')}>
          <Segmented
            value={term.rightClick}
            onChange={(v) => void update({ terminal: { rightClick: v } })}
            testIdPrefix="setting-right-click"
            options={[
              { value: 'menu', label: t('Show menu') },
              { value: 'paste', label: t('Copy / paste (PuTTY style)') }
            ]}
          />
        </Field>
        <Checkbox
          label={t('Copy on select')}
          checked={term.copyOnSelect}
          onChange={(e) => void update({ terminal: { copyOnSelect: e.target.checked } })}
        />
        <Checkbox
          label={t('Warn before pasting multiple lines')}
          description={t(
            'Asks first when pasted text contains line breaks and the program does not use bracketed paste — each line would run as a command.'
          )}
          checked={term.warnMultilinePaste}
          data-testid="setting-warn-multiline-paste"
          onChange={(e) => void update({ terminal: { warnMultilinePaste: e.target.checked } })}
        />
        <Checkbox
          label={t('Confirm before closing connected tabs')}
          description={t(
            'Asks before closing an SSH tab that is still connected. Tabs with running file transfers always ask.'
          )}
          checked={term.confirmCloseConnected}
          data-testid="setting-confirm-close"
          onChange={(e) => void update({ terminal: { confirmCloseConnected: e.target.checked } })}
        />
        <div className="flex items-start gap-3">
          <Checkbox
            label={t('Suggest commands from history')}
            description={t(
              'Shows the last matching command you ran on the same host in faint text after the cursor; press → to accept. Commands starting with a space and anything not shown on screen (passwords) are never saved.'
            )}
            checked={term.commandSuggestions}
            data-testid="setting-command-suggestions"
            onChange={(e) => void update({ terminal: { commandSuggestions: e.target.checked } })}
          />
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0"
            data-testid="clear-command-history"
            onClick={() => {
              void (async () => {
                const ok = await confirmAction({
                  title: t('Delete the command history of every host?'),
                  confirmLabel: t('Delete'),
                  danger: true
                })
                if (!ok) return
                forgetHistory(null)
                void window.shellhouse.clearCommandHistory(null)
              })()
            }}
          >
            {t('Clear history')}
          </Button>
        </div>
        <Checkbox
          label={t('Show server statistics')}
          description={t(
            'CPU, memory, disk and network under SSH terminals (Linux servers). Measured only while the tab is visible.'
          )}
          checked={term.serverStats}
          data-testid="setting-server-stats"
          onChange={(e) => void update({ terminal: { serverStats: e.target.checked } })}
        />
        <Checkbox
          label={t('Screen reader mode')}
          description={t(
            'Lets screen readers announce terminal output. Uses more CPU on busy output.'
          )}
          checked={term.screenReaderMode}
          data-testid="setting-screen-reader"
          onChange={(e) => void update({ terminal: { screenReaderMode: e.target.checked } })}
        />
      </section>
    </div>
  )
}
