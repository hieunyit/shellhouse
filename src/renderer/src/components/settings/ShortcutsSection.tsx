import { useState } from 'react'
import { RotateCcw, X } from 'lucide-react'
import {
  COMMANDS,
  eventToKeybinding,
  findConflicts,
  keybindingFor,
  reservedForTerminal
} from '@shared/commands'
import { t } from '@shared/i18n'
import { commandTitle, displayKeybinding, isMac } from '../../lib/keybindings'
import { useSettings } from '../../stores/settings'
import { cx, IconButton, SectionTitle } from '../ui'

export function ShortcutsSection(): React.JSX.Element {
  const { settings, update } = useSettings()
  const overrides = settings.keybindings
  const [recording, setRecording] = useState<string | null>(null)
  const conflicts = findConflicts(overrides, isMac)

  const set = (id: string, key: string | null): void => {
    const next = Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== id))
    if (key !== null) next[id] = key
    void update({ keybindings: next })
  }

  return (
    <div data-testid="settings-shortcuts">
      <SectionTitle
        description={t('Click a shortcut, then press the new key combination. Esc cancels.')}
      >
        {t('Keyboard shortcuts')}
      </SectionTitle>
      <div className="overflow-hidden rounded-lg border border-line">
        {COMMANDS.map((cmd) => {
          const key = keybindingFor(cmd.id, overrides, isMac)
          const conflict = key ? conflicts.get(key) : undefined
          return (
            <div
              key={cmd.id}
              className="flex items-center gap-2 border-b border-line px-3 py-2 text-[13px] last:border-b-0"
              data-testid="shortcut-row"
              data-command={cmd.id}
            >
              <span className="flex-1">{commandTitle(cmd.id)}</span>
              {conflict && (
                <span className="text-xs text-danger">
                  {t('Also used by {names}', {
                    names: conflict
                      .filter((c) => c !== cmd.id)
                      .map((c) => commandTitle(c))
                      .join(', ')
                  })}
                </span>
              )}
              {key && reservedForTerminal(key) && (
                <span className="text-xs text-warning">{t('Terminals need this key')}</span>
              )}
              <button
                type="button"
                data-testid="shortcut-key"
                data-capture-keys={recording === cmd.id}
                className={cx(
                  'min-w-36 rounded-md border px-2 py-1 font-mono text-xs',
                  recording === cmd.id
                    ? 'border-accent bg-accent-soft text-accent'
                    : 'border-line bg-subtle text-fg hover:border-line-strong'
                )}
                onClick={() => {
                  setRecording(cmd.id)
                }}
                onKeyDown={(e) => {
                  if (recording !== cmd.id) return
                  e.preventDefault()
                  e.stopPropagation()
                  if (e.key === 'Escape') {
                    setRecording(null)
                    return
                  }
                  const combo = eventToKeybinding(e.nativeEvent)
                  if (!combo) return
                  set(cmd.id, combo)
                  setRecording(null)
                }}
                onBlur={() => {
                  setRecording(null)
                }}
              >
                {recording === cmd.id ? t('Press keys…') : displayKeybinding(key)}
              </button>
              <IconButton
                label={t('Remove shortcut')}
                size="sm"
                onClick={() => {
                  set(cmd.id, '')
                }}
              >
                <X size={13} />
              </IconButton>
              <IconButton
                label={t('Reset to default')}
                size="sm"
                onClick={() => {
                  set(cmd.id, null)
                }}
              >
                <RotateCcw size={12} />
              </IconButton>
            </div>
          )
        })}
      </div>
    </div>
  )
}
