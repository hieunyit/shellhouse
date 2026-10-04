import { useRef, useState, type ReactNode, type SyntheticEvent } from 'react'
import { Logo } from './Logo'
import { KeyRound, LockKeyhole } from 'lucide-react'
import { MIN_MASTER_PASSWORD, type VaultResult } from '@shared/ipc'
import { t } from '@shared/i18n'
import { useVault } from '../stores/vault'
import { Button, Input, Notice } from './ui'

function errorText(result: Exclude<VaultResult, { ok: true }>): string {
  switch (result.code) {
    case 'wrong-password':
      return t('Wrong master password.')
    case 'too-short':
      return tooShort()
    case 'busy':
      return t('Still working, please wait.')
    default:
      return result.message
  }
}

function tooShort(): string {
  return t('Master password must be at least {n} characters.', { n: MIN_MASTER_PASSWORD })
}

/** Logo app (cùng kiểu với build/icon.png) kèm huy hiệu nhỏ cho biết đang tạo hay mở khoá. */
function Card({
  icon,
  title,
  subtitle,
  children
}: {
  icon: ReactNode
  title: string
  subtitle: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="shadow-elevated animate-dialog-in w-full max-w-sm rounded-2xl border border-line bg-elevated p-7">
      <div className="mb-6 flex flex-col items-center gap-4 text-center">
        <div className="relative">
          <Logo size={56} className="drop-shadow-md" />
          <div className="absolute -right-1.5 -bottom-1.5 flex size-6 items-center justify-center rounded-full border-2 border-elevated bg-accent-solid text-accent-fg">
            {icon}
          </div>
        </div>
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-fg">{title}</h1>
          <p className="mt-1 text-xs text-muted">{subtitle}</p>
        </div>
      </div>
      {children}
    </div>
  )
}

function CreateVault(): React.JSX.Element {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const submit = async (event: SyntheticEvent): Promise<void> => {
    event.preventDefault()
    if (password.length < MIN_MASTER_PASSWORD) {
      setError(tooShort())
      return
    }
    if (password !== confirm) {
      setError(t('The passwords do not match.'))
      return
    }
    setPending(true)
    setError(null)
    const result = await window.shellhouse.createVault(password)
    setPending(false)
    if (!result.ok) setError(errorText(result))
    setPassword('')
    setConfirm('')
  }

  return (
    <Card
      icon={<KeyRound size={12} />}
      title={t('Welcome to Shellhouse')}
      subtitle={t('Create a master password to protect your saved credentials.')}
    >
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <p className="text-xs leading-relaxed text-muted">
          {t('Your master password encrypts every password and SSH key stored in Shellhouse.')}{' '}
          <strong className="text-warning">{t('It cannot be recovered if you forget it.')}</strong>
        </p>
        <Input
          type="password"
          autoFocus
          autoComplete="new-password"
          placeholder={t('Master password')}
          data-testid="vault-password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value)
          }}
        />
        <Input
          type="password"
          autoComplete="new-password"
          placeholder={t('Confirm password')}
          data-testid="vault-confirm"
          value={confirm}
          onChange={(e) => {
            setConfirm(e.target.value)
          }}
        />
        {error && (
          <Notice tone="danger" testId="vault-error">
            {error}
          </Notice>
        )}
        <Button
          type="submit"
          variant="primary"
          disabled={pending}
          data-testid="vault-submit"
          className="mt-1"
        >
          {pending ? t('Creating…') : t('Create vault')}
        </Button>
      </form>
    </Card>
  )
}

function UnlockVault(): React.JSX.Element {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  /** Tăng mỗi lần sai → chạy lại hiệu ứng rung. */
  const [attempt, setAttempt] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const submit = async (event: SyntheticEvent): Promise<void> => {
    event.preventDefault()
    if (!password) return
    setPending(true)
    setError(null)
    const result = await window.shellhouse.unlockVault(password)
    setPending(false)
    setPassword('')
    if (!result.ok) {
      setError(errorText(result))
      setAttempt((n) => n + 1)
      inputRef.current?.focus()
    }
  }

  return (
    <Card
      icon={<LockKeyhole size={12} />}
      title={t('Shellhouse is locked')}
      subtitle={t('Enter your master password to continue.')}
    >
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <Input
          ref={inputRef}
          type="password"
          autoFocus
          autoComplete="current-password"
          placeholder={t('Master password')}
          data-testid="vault-password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value)
          }}
        />
        {error && (
          <div key={attempt} className="animate-shake">
            <Notice tone="danger" testId="vault-error">
              {error}
            </Notice>
          </div>
        )}
        <Button type="submit" variant="primary" disabled={pending} data-testid="vault-submit">
          {pending ? t('Unlocking…') : t('Unlock')}
        </Button>
        <p className="text-center text-xs text-faint">
          {t('Open sessions keep running while locked.')}
        </p>
      </form>
    </Card>
  )
}

/**
 * Chặn app cho tới khi vault được mở. Sau lần mở đầu tiên, khi khoá lại thì chỉ phủ màn hình
 * khoá lên trên — các tab terminal vẫn chạy phía dưới.
 */
export function VaultGate({ children }: { children: ReactNode }): React.JSX.Element {
  const state = useVault((s) => s.state)
  const everUnlocked = useVault((s) => s.everUnlocked)
  const overlay =
    state === 'uninitialized' ? <CreateVault /> : state === 'locked' ? <UnlockVault /> : null

  return (
    <>
      {everUnlocked && children}
      {state !== 'unlocked' && (
        <div
          className="sh-gate-bg absolute inset-0 z-50 flex items-center justify-center p-6"
          data-testid="vault-gate"
          data-vault-state={state ?? 'loading'}
        >
          {/* Cửa sổ không có thanh tiêu đề: dải trên cùng vẫn kéo được cửa sổ khi đang khoá. */}
          <div aria-hidden className="sh-titlebar absolute inset-x-0 top-0 h-11" />
          {overlay}
        </div>
      )}
    </>
  )
}
