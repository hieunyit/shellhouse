import { useState } from 'react'
import { Upload } from 'lucide-react'
import { BUILTIN_THEMES, importItermColors, importWindowsTerminal } from '@shared/themes'
import { useSettings } from '../../stores/settings'
import { Checkbox, Field, Input, Notice, SectionTitle, Select } from '../ui'

export function TerminalSection(): React.JSX.Element {
  const { settings, update } = useSettings()
  const t = settings.terminal
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
      setMessage({ ok: true, text: `Imported theme “${theme.name}”.` })
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <div className="flex flex-col gap-6" data-testid="settings-terminal">
      <section className="flex flex-col gap-3">
        <SectionTitle>Colors</SectionTitle>
        <Field label="Color theme">
          <Select
            data-testid="setting-theme"
            value={t.themeId}
            onChange={(e) => void update({ terminal: { themeId: e.target.value } })}
          >
            <option value="system">Match app (light / dark)</option>
            {themes.map((th) => (
              <option key={th.id} value={th.id}>
                {th.name}
              </option>
            ))}
          </Select>
        </Field>
        {t.themeId === 'system' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="When dark">
              <Select
                value={t.darkThemeId}
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
            <Field label="When light">
              <Select
                value={t.lightThemeId}
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
            <Upload size={14} /> Import theme…
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
            Windows Terminal (.json) or iTerm2 (.itermcolors)
          </span>
        </div>
        {message && (
          <Notice tone={message.ok ? 'success' : 'danger'} testId="theme-message">
            {message.text}
          </Notice>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <SectionTitle>Text</SectionTitle>
        <Field label="Font family">
          <Input
            placeholder="Default (Cascadia Mono, Menlo, …)"
            value={t.fontFamily}
            onChange={(e) => void update({ terminal: { fontFamily: e.target.value } })}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Font size">
            <Input
              type="number"
              min={8}
              max={32}
              data-testid="setting-font-size"
              value={t.fontSize}
              onChange={(e) => void update({ terminal: { fontSize: Number(e.target.value) } })}
            />
          </Field>
          <Field label="Line height">
            <Input
              type="number"
              min={1}
              max={2}
              step={0.1}
              value={t.lineHeight}
              onChange={(e) => void update({ terminal: { lineHeight: Number(e.target.value) } })}
            />
          </Field>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <SectionTitle>Behavior</SectionTitle>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Cursor style">
            <Select
              value={t.cursorStyle}
              onChange={(e) =>
                void update({ terminal: { cursorStyle: e.target.value as typeof t.cursorStyle } })
              }
            >
              <option value="block">Block</option>
              <option value="bar">Bar</option>
              <option value="underline">Underline</option>
            </Select>
          </Field>
          <Field label="Scrollback lines">
            <Input
              type="number"
              min={1000}
              max={100000}
              step={1000}
              value={t.scrollback}
              onChange={(e) => void update({ terminal: { scrollback: Number(e.target.value) } })}
            />
          </Field>
        </div>
        <Checkbox
          label="Blinking cursor"
          checked={t.cursorBlink}
          onChange={(e) => void update({ terminal: { cursorBlink: e.target.checked } })}
        />
        <Checkbox
          label="Copy on select"
          checked={t.copyOnSelect}
          onChange={(e) => void update({ terminal: { copyOnSelect: e.target.checked } })}
        />
        <Checkbox
          label="Screen reader mode"
          description="Lets screen readers announce terminal output. Uses more CPU on busy output."
          checked={t.screenReaderMode}
          data-testid="setting-screen-reader"
          onChange={(e) => void update({ terminal: { screenReaderMode: e.target.checked } })}
        />
      </section>
    </div>
  )
}
