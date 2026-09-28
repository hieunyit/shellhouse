import { useRef, useState, type ReactNode, type SyntheticEvent } from 'react'
import { KeyRound, LockKeyhole } from 'lucide-react'
import { MIN_MASTER_PASSWORD, type VaultResult } from '@shared/ipc'
import { useVault } from '../stores/vault'
import { Button, Input, Notice } from './ui'

function errorText(result: Exclude<VaultResult, { ok: true }>): string {
  switch (result.code) {
    case 'wrong-password':
      return 'Wrong master password.'
    case 'too-short':
      return `Master password must be at least ${MIN_MASTER_PASSWORD} characters.`
    case 'busy':
      return 'Still working, please wait.'
    default:
      return result.message
  }
}

function Card({
  icon,
  title,
  children
}: {
  icon: ReactNode
  title: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="shadow-elevated w-full max-w-sm rounded-2xl border border-line bg-elevated p-7">
      <div className="mb-5 flex flex-col items-center gap-3 text-center">
        <div className="flex size-11 items-center justify-center rounded-xl bg-accent-soft text-accent">
          {icon}
        </div>
        <div>
          <p className="text-xs font-medium tracking-wide text-faint uppercase">Shellhouse</p>
          <h1 className="text-lg font-semibold text-fg">{title}</h1>
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
      setError(`Master password must be at least ${MIN_MASTER_PASSWORD} characters.`)
      return
    }
    if (password !== confirm) {
      setError('The passwords do not match.')
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
    <Card icon={<KeyRound size={20} />} title="Create a master password">
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <p className="text-xs leading-relaxed text-muted">
          Your master password encrypts every password and SSH key stored in Shellhouse.{' '}
          <strong className="text-warning">It cannot be recovered if you forget it.</strong>
        </p>
        <Input
          type="password"
          autoFocus
          autoComplete="new-password"
          placeholder="Master password"
          data-testid="vault-password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value)
          }}
        />
        <Input
          type="password"
          autoComplete="new-password"
          placeholder="Confirm password"
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
          {pending ? 'Creating…' : 'Create vault'}
        </Button>
      </form>
    </Card>
  )
}

function UnlockVault(): React.JSX.Element {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
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
      inputRef.current?.focus()
    }
  }

  return (
    <Card icon={<LockKeyhole size={20} />} title="Shellhouse is locked">
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <Input
          ref={inputRef}
          type="password"
          autoFocus
          autoComplete="current-password"
          placeholder="Master password"
          data-testid="vault-password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value)
          }}
        />
        {error && (
          <Notice tone="danger" testId="vault-error">
            {error}
          </Notice>
        )}
        <Button type="submit" variant="primary" disabled={pending} data-testid="vault-submit">
          {pending ? 'Unlocking…' : 'Unlock'}
        </Button>
        <p className="text-center text-xs text-faint">Open sessions keep running while locked.</p>
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
          className="absolute inset-0 z-50 flex items-center justify-center bg-canvas p-6"
          data-testid="vault-gate"
          data-vault-state={state ?? 'loading'}
        >
          {overlay}
        </div>
      )}
    </>
  )
}
