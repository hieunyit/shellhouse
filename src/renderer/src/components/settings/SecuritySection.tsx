import { useEffect, useState } from 'react'
import { MIN_MASTER_PASSWORD, type VaultSecurity } from '@shared/ipc'
import { useSettings } from '../../stores/settings'
import { Button, Checkbox, Field, Input, Notice, SectionTitle, Select } from '../ui'

export function SecuritySection(): React.JSX.Element {
  const { settings, update } = useSettings()
  const s = settings.security
  const [security, setSecurity] = useState<VaultSecurity | null>(null)
  const [version, setVersion] = useState(0)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [restorePassword, setRestorePassword] = useState('')
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.shellhouse.vaultSecurity().then((v) => {
      if (!cancelled) setSecurity(v)
    })
    return () => {
      cancelled = true
    }
  }, [version])

  const say = (ok: boolean, text: string): void => {
    setMessage({ ok, text })
  }

  const changePassword = async (): Promise<void> => {
    if (next.length < MIN_MASTER_PASSWORD) {
      say(false, `The new password must be at least ${MIN_MASTER_PASSWORD} characters.`)
      return
    }
    if (next !== confirm) {
      say(false, 'The new passwords do not match.')
      return
    }
    const result = await window.shellhouse.changeMasterPassword(current, next)
    setCurrent('')
    setNext('')
    setConfirm('')
    if (result.ok) say(true, 'Master password changed.')
    else
      say(
        false,
        result.code === 'wrong-password' ? 'The current password is wrong.' : result.message
      )
  }

  return (
    <div className="flex flex-col gap-7" data-testid="settings-security">
      {message && (
        <Notice tone={message.ok ? 'success' : 'danger'} testId="security-message">
          {message.text}
        </Notice>
      )}
      <section className="flex flex-col gap-3">
        <SectionTitle description="Locking only clears the key from memory — open terminals and connections keep running.">
          Auto-lock
        </SectionTitle>
        <Field label="Lock after the computer is idle for">
          <Select
            className="w-48"
            data-testid="setting-autolock"
            value={s.autoLockMinutes}
            onChange={(e) => void update({ security: { autoLockMinutes: Number(e.target.value) } })}
          >
            <option value={0}>Never</option>
            {[1, 5, 15, 30, 60, 120].map((m) => (
              <option key={m} value={m}>
                {m} minute{m === 1 ? '' : 's'}
              </option>
            ))}
          </Select>
        </Field>
        <Checkbox
          label="Lock when the computer sleeps or the screen locks"
          checked={s.lockOnSuspend}
          onChange={(e) => void update({ security: { lockOnSuspend: e.target.checked } })}
        />
      </section>

      <section className="flex flex-col gap-3">
        <SectionTitle>Remember on this device</SectionTitle>
        {security && !security.rememberAvailable && (
          <Notice tone="warning" testId="remember-unavailable">
            {security.rememberUnavailableReason}
          </Notice>
        )}
        <Checkbox
          data-testid="setting-remember"
          disabled={!security?.rememberAvailable}
          checked={security?.rememberEnabled ?? false}
          onChange={(e) => {
            void window.shellhouse.setRememberOnDevice(e.target.checked).then((r) => {
              if (!r.ok) say(false, r.message)
              setVersion((v) => v + 1)
            })
          }}
          label="Open Shellhouse without the master password"
          description="The vault key is kept in the operating system keychain."
        />
      </section>

      <section className="flex flex-col gap-3">
        <SectionTitle>Change master password</SectionTitle>
        <Input
          type="password"
          autoComplete="current-password"
          placeholder="Current password"
          data-testid="pw-current"
          value={current}
          onChange={(e) => {
            setCurrent(e.target.value)
          }}
        />
        <div className="grid grid-cols-2 gap-3">
          <Input
            type="password"
            autoComplete="new-password"
            placeholder="New password"
            data-testid="pw-next"
            value={next}
            onChange={(e) => {
              setNext(e.target.value)
            }}
          />
          <Input
            type="password"
            autoComplete="new-password"
            placeholder="Confirm new password"
            data-testid="pw-confirm"
            value={confirm}
            onChange={(e) => {
              setConfirm(e.target.value)
            }}
          />
        </div>
        <Button
          variant="primary"
          className="self-start"
          data-testid="pw-change"
          disabled={!current || !next}
          onClick={() => void changePassword()}
        >
          Change password
        </Button>
      </section>

      <section className="flex flex-col gap-3">
        <SectionTitle description="Contains hosts, keys and snippets. Passwords and keys stay encrypted with the current master password.">
          Backup
        </SectionTitle>
        <Button
          className="self-start"
          data-testid="backup-export"
          onClick={() => {
            void window.shellhouse.exportBackup().then((r) => {
              if (r) say(r.ok, r.ok ? `Saved to ${r.path}` : r.message)
            })
          }}
        >
          Export backup…
        </Button>
        <div className="flex gap-2">
          <Input
            type="password"
            placeholder="Master password of the backup"
            value={restorePassword}
            onChange={(e) => {
              setRestorePassword(e.target.value)
            }}
          />
          <Button
            disabled={!restorePassword}
            onClick={() => {
              void window.shellhouse.restoreBackup(restorePassword).then((r) => {
                setRestorePassword('')
                if (r && !r.ok) say(false, r.message)
              })
            }}
          >
            Restore from file…
          </Button>
        </div>
      </section>
    </div>
  )
}
