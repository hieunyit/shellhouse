import { useEffect, useState } from 'react'
import { MIN_MASTER_PASSWORD, type VaultSecurity } from '@shared/ipc'
import { t, tn } from '@shared/i18n'
import { useSettings } from '../../stores/settings'
import { Button, Checkbox, Field, Input, Notice, SectionTitle, Select } from '../ui'

export function SecuritySection(): React.JSX.Element {
  const { settings, update } = useSettings()
  const s = settings.security
  /** Giá trị vừa bấm, chờ main lưu xong (null = hiển thị theo trạng thái thật). */
  const [rememberPending, setRememberPending] = useState<boolean | null>(null)
  const [security, setSecurity] = useState<VaultSecurity | null>(null)
  const [version, setVersion] = useState(0)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [restorePassword, setRestorePassword] = useState('')
  /** Đang bật "nhớ trên máy": chờ nhập lại master password. */
  const [rememberPassword, setRememberPassword] = useState<string | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.shellhouse.vaultSecurity().then((v) => {
      if (cancelled) return
      setSecurity(v)
      setRememberPending(null) // trạng thái thật đã về → bỏ giá trị tạm (không nhấp nháy)
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
      say(false, t('The new password must be at least {n} characters.', { n: MIN_MASTER_PASSWORD }))
      return
    }
    if (next !== confirm) {
      say(false, t('The new passwords do not match.'))
      return
    }
    const result = await window.shellhouse.changeMasterPassword(current, next)
    setCurrent('')
    setNext('')
    setConfirm('')
    if (result.ok) say(true, t('Master password changed.'))
    else
      say(
        false,
        result.code === 'wrong-password' ? t('The current password is wrong.') : result.message
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
        <SectionTitle
          description={t(
            'Locking only clears the key from memory — open terminals and connections keep running.'
          )}
        >
          {t('Auto-lock')}
        </SectionTitle>
        <Field label={t('Lock after the computer is idle for')}>
          <Select
            className="w-48"
            data-testid="setting-autolock"
            value={s.autoLockMinutes}
            onChange={(e) => void update({ security: { autoLockMinutes: Number(e.target.value) } })}
          >
            <option value={0}>{t('Never')}</option>
            {[1, 5, 15, 30, 60, 120].map((m) => (
              <option key={m} value={m}>
                {tn(m, '{n} minute', '{n} minutes')}
              </option>
            ))}
          </Select>
        </Field>
        <Checkbox
          label={t('Lock when the computer sleeps or the screen locks')}
          checked={s.lockOnSuspend}
          onChange={(e) => void update({ security: { lockOnSuspend: e.target.checked } })}
        />
      </section>

      <section className="flex flex-col gap-3">
        <SectionTitle>{t('Remember on this device')}</SectionTitle>
        {security && !security.rememberAvailable && (
          <Notice tone="warning" testId="remember-unavailable">
            {security.rememberUnavailableReason}
          </Notice>
        )}
        <Checkbox
          data-testid="setting-remember"
          disabled={!security?.rememberAvailable}
          checked={rememberPending ?? security?.rememberEnabled ?? false}
          onChange={(e) => {
            const next = e.target.checked
            setRememberPending(next)
            // Bật: hỏi lại master password trước (main kiểm tra).
            if (next) {
              setRememberPassword('')
              return
            }
            // Tắt: đổi ngay trên giao diện; xoá khỏi keychain chạy nền, lỗi thì trả lại như cũ.
            setRememberPassword(null)
            void window.shellhouse.setRememberOnDevice(false, null).then((r) => {
              if (!r.ok) say(false, r.message)
              setVersion((v) => v + 1)
            })
          }}
          label={t('Open Shellhouse without the master password')}
          description={t('The vault key is kept in the operating system keychain.')}
        />
        {rememberPassword !== null && (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              const password = rememberPassword
              if (!password) return
              setRememberPassword(null)
              void window.shellhouse.setRememberOnDevice(true, password).then((r) => {
                if (!r.ok)
                  say(
                    false,
                    r.code === 'wrong-password' ? t('The master password is wrong.') : r.message
                  )
                setVersion((v) => v + 1)
              })
            }}
          >
            <Input
              type="password"
              autoFocus
              autoComplete="current-password"
              placeholder={t('Master password to confirm')}
              data-testid="remember-password"
              value={rememberPassword}
              onChange={(e) => {
                setRememberPassword(e.target.value)
              }}
            />
            <Button
              type="submit"
              variant="primary"
              data-testid="remember-confirm"
              disabled={!rememberPassword}
            >
              {t('Turn on')}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setRememberPassword(null)
                setRememberPending(null)
              }}
            >
              {t('Cancel')}
            </Button>
          </form>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <SectionTitle>{t('Change master password')}</SectionTitle>
        <Input
          type="password"
          autoComplete="current-password"
          placeholder={t('Current password')}
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
            placeholder={t('New password')}
            data-testid="pw-next"
            value={next}
            onChange={(e) => {
              setNext(e.target.value)
            }}
          />
          <Input
            type="password"
            autoComplete="new-password"
            placeholder={t('Confirm new password')}
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
          {t('Change password')}
        </Button>
      </section>

      <section className="flex flex-col gap-3">
        <SectionTitle
          description={t(
            'Contains hosts, keys and snippets. Passwords and keys stay encrypted with the current master password.'
          )}
        >
          {t('Backup')}
        </SectionTitle>
        <Button
          className="self-start"
          data-testid="backup-export"
          onClick={() => {
            void window.shellhouse.exportBackup().then((r) => {
              if (r) say(r.ok, r.ok ? t('Saved to {path}', { path: r.path }) : r.message)
            })
          }}
        >
          {t('Export backup…')}
        </Button>
        <div className="flex gap-2">
          <Input
            type="password"
            placeholder={t('Master password of the backup')}
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
            {t('Restore from file…')}
          </Button>
        </div>
      </section>
    </div>
  )
}
