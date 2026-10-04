import { useState, type SyntheticEvent } from 'react'
import { KeyRound, Upload, WandSparkles } from 'lucide-react'
import { t, tn } from '@shared/i18n'
import { AccountInput, type AccountSummary } from '@shared/hosts'
import { splitDomainUser } from '@shared/rdp'
import { useHosts } from '../../stores/hosts'
import { toast } from '../../stores/toasts'
import { PasswordInput } from '../PasswordInput'
import { Button, Checkbox, Field, Input, Modal, Notice, Select, TextArea } from '../ui'

type KeyType = 'ed25519' | 'rsa' | 'ecdsa'

/**
 * Tạo / sửa một tài khoản dùng chung: username, mật khẩu, SSH key (+ passphrase), domain (Remote
 * Desktop), ghi chú. Secret không bao giờ về renderer: ô mật khẩu / passphrase để trống khi sửa =
 * giữ giá trị đã lưu.
 */
export function AccountEditor({
  account,
  initial,
  onClose,
  onSaved
}: {
  account: AccountSummary | null
  /** Giá trị gợi ý khi tạo mới (ví dụ từ form host). */
  initial?: { name?: string; username?: string }
  onClose: () => void
  onSaved?: (id: string) => void
}): React.JSX.Element {
  const keys = useHosts((s) => s.tree.keys)
  const hosts = useHosts((s) => s.tree.hosts)
  const [name, setName] = useState(account?.name ?? initial?.name ?? '')
  const [username, setUsername] = useState(account?.username ?? initial?.username ?? '')
  const [domain, setDomain] = useState(account?.domain ?? '')
  const [password, setPassword] = useState('')
  const [forgetPassword, setForgetPassword] = useState(false)
  const [keyId, setKeyId] = useState<string | null>(account?.keyId ?? null)
  const [passphrase, setPassphrase] = useState('')
  const [forgetPassphrase, setForgetPassphrase] = useState(false)
  const [notes, setNotes] = useState(account?.notes ?? '')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [generating, setGenerating] = useState<null | {
    name: string
    type: KeyType
    passphrase: string
    busy: boolean
  }>(null)

  const key = keys.find((k) => k.id === keyId) ?? null
  const sameKey = account !== null && account.keyId === keyId
  const passphraseSaved = sameKey && account.hasPassphrase
  const users = account ? hosts.filter((h) => account.hostIds.includes(h.id)) : []

  const importKey = async (): Promise<void> => {
    const result = await window.shellhouse.importKeyFromFile()
    if (!result) return
    if (!result.ok) {
      setError(result.message)
      return
    }
    await useHosts.getState().reload()
    setKeyId(result.id)
  }

  const generate = async (): Promise<void> => {
    if (!generating) return
    setGenerating({ ...generating, busy: true })
    const result = await window.shellhouse.generateKey({
      name: generating.name.trim() || name.trim() || 'shellhouse',
      type: generating.type,
      ...(generating.type === 'rsa' ? { bits: 4096 } : {}),
      ...(generating.type === 'ecdsa' ? { bits: 256 } : {}),
      ...(generating.passphrase ? { passphrase: generating.passphrase } : {})
    })
    if (!result.ok) {
      setGenerating({ ...generating, busy: false })
      setError(result.message)
      return
    }
    await useHosts.getState().reload()
    setKeyId(result.id)
    // Lưu luôn passphrase vừa đặt vào tài khoản → kết nối không bị hỏi.
    if (generating.passphrase) setPassphrase(generating.passphrase)
    setGenerating(null)
    toast.success(t('Key created. Use “Copy public key” or “Deploy key” to add it to a server.'))
  }

  const submit = async (event?: SyntheticEvent): Promise<void> => {
    event?.preventDefault()
    setError(null)
    const split = splitDomainUser(username)
    const draft = {
      ...(account ? { id: account.id } : {}),
      name: name.trim(),
      username: split.username,
      // Trống khi sửa = giữ mật khẩu đã lưu; "Quên" = xoá.
      ...(forgetPassword ? { password: '' } : password ? { password } : {}),
      keyId,
      ...(keyId && forgetPassphrase
        ? { passphrase: '' }
        : keyId && passphrase
          ? { passphrase }
          : {}),
      // CORP\\john gõ ở ô username: tách domain ra (như form host RDP).
      domain: (split.domain ?? domain).trim(),
      notes
    }
    const parsed = AccountInput.safeParse(draft)
    if (!parsed.success) {
      setError(t(parsed.error.issues[0]?.message ?? 'Invalid input'))
      return
    }
    setSaving(true)
    try {
      const result = await window.shellhouse.saveAccount(parsed.data)
      if (!result.ok) {
        setError(result.message)
        return
      }
      toast.success(
        account
          ? t('Saved account {name}', { name: parsed.data.name })
          : t('Added account {name}', { name: parsed.data.name }),
        { group: 'account-saved' }
      )
      onSaved?.(result.id)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
      setPassword('')
      setPassphrase('')
    }
  }

  return (
    <Modal
      title={account ? t('Edit account {name}', { name: account.name }) : t('New account')}
      description={t(
        'Sign-in details you can pick for any host. Passwords and passphrases are stored encrypted in the vault.'
      )}
      onClose={onClose}
      width="max-w-lg"
      testId="account-editor"
      footer={
        <>
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button
            variant="primary"
            disabled={saving || name.trim() === ''}
            data-testid="account-save"
            onClick={() => void submit()}
          >
            {t('Save')}
          </Button>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
        {users.length > 0 && (
          <Notice testId="account-users-notice">
            {tn(
              users.length,
              'Used by {n} host — changes apply to it right away.',
              'Used by {n} hosts — changes apply to all of them right away.'
            )}
          </Notice>
        )}
        <Field label={t('Name')}>
          <Input
            autoFocus
            data-testid="account-name"
            placeholder={t('e.g. {example}', { example: t('Production deploy') })}
            value={name}
            onChange={(e) => {
              setName(e.target.value)
            }}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('Username')} hint={t('Empty = use the group’s username')}>
            <Input
              mono
              spellCheck={false}
              className="placeholder:font-sans"
              data-testid="account-username"
              placeholder={t('e.g. {example}', { example: 'deploy' })}
              value={username}
              onChange={(e) => {
                setUsername(e.target.value)
              }}
            />
          </Field>
          <Field label={t('Domain')} hint={t('Remote Desktop only — optional')}>
            <Input
              mono
              spellCheck={false}
              className="placeholder:font-sans"
              data-testid="account-domain"
              placeholder={t('e.g. {example}', { example: 'CORP' })}
              value={domain}
              onChange={(e) => {
                setDomain(e.target.value)
              }}
            />
          </Field>
        </div>

        <div className="flex flex-col gap-2 rounded-lg border border-line p-3">
          <span className="text-xs font-medium text-muted">{t('Password')}</span>
          <PasswordInput
            data-testid="account-password"
            aria-label={t('Password')}
            autoComplete="new-password"
            disabled={forgetPassword}
            placeholder={
              account?.hasPassword
                ? t('Saved — leave empty to keep it')
                : t('Optional — stored encrypted in the vault')
            }
            value={password}
            onChange={(e) => {
              setPassword(e.target.value)
            }}
          />
          {account?.hasPassword && (
            <Checkbox
              label={t('Remove the saved password')}
              data-testid="account-forget-password"
              checked={forgetPassword}
              onChange={(e) => {
                setForgetPassword(e.target.checked)
              }}
            />
          )}
        </div>

        <div className="flex flex-col gap-2 rounded-lg border border-line p-3">
          <span className="text-xs font-medium text-muted">{t('SSH key')}</span>
          <div className="flex gap-2">
            <Select
              data-testid="account-key"
              aria-label={t('SSH key')}
              value={keyId ?? ''}
              onChange={(e) => {
                setKeyId(e.target.value || null)
                setPassphrase('')
                setForgetPassphrase(false)
              }}
            >
              <option value="">{t('No SSH key')}</option>
              {keys.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name} ({k.type}
                  {k.encrypted ? `, ${t('passphrase')}` : ''})
                </option>
              ))}
            </Select>
            <Button
              icon={<Upload size={14} />}
              data-testid="account-import-key"
              onClick={() => void importKey()}
            >
              {t('Import…')}
            </Button>
            <Button
              icon={<WandSparkles size={14} />}
              data-testid="account-generate-key"
              onClick={() => {
                setGenerating(
                  generating
                    ? null
                    : { name: name.trim(), type: 'ed25519', passphrase: '', busy: false }
                )
              }}
            >
              {t('Generate…')}
            </Button>
          </div>
          {generating && (
            <div className="flex flex-col gap-2 rounded-md border border-line bg-subtle p-2.5">
              <div className="grid grid-cols-[1fr_9rem] gap-2">
                <Input
                  aria-label={t('Key name')}
                  placeholder={t('Key name')}
                  data-testid="account-keygen-name"
                  value={generating.name}
                  onChange={(e) => {
                    setGenerating({ ...generating, name: e.target.value })
                  }}
                />
                <Select
                  aria-label={t('Type')}
                  value={generating.type}
                  onChange={(e) => {
                    setGenerating({ ...generating, type: e.target.value as KeyType })
                  }}
                >
                  <option value="ed25519">Ed25519</option>
                  <option value="rsa">RSA 4096</option>
                  <option value="ecdsa">ECDSA 256</option>
                </Select>
              </div>
              <PasswordInput
                aria-label={t('Passphrase')}
                autoComplete="new-password"
                placeholder={t('Passphrase (optional)')}
                value={generating.passphrase}
                onChange={(e) => {
                  setGenerating({ ...generating, passphrase: e.target.value })
                }}
              />
              <div className="flex justify-end gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setGenerating(null)
                  }}
                >
                  {t('Cancel')}
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  icon={<KeyRound size={13} />}
                  disabled={generating.busy}
                  data-testid="account-keygen-create"
                  onClick={() => void generate()}
                >
                  {generating.busy ? t('Generating…') : t('Generate key')}
                </Button>
              </div>
            </div>
          )}
          {key?.encrypted && (
            <div className="flex flex-col gap-2">
              <PasswordInput
                data-testid="account-passphrase"
                aria-label={t('Passphrase')}
                autoComplete="new-password"
                disabled={forgetPassphrase}
                placeholder={
                  passphraseSaved
                    ? t('Saved — leave empty to keep it')
                    : t('Passphrase (leave empty to be asked when connecting)')
                }
                value={passphrase}
                onChange={(e) => {
                  setPassphrase(e.target.value)
                }}
              />
              {passphraseSaved && (
                <Checkbox
                  label={t('Remove the saved passphrase (ask when connecting)')}
                  checked={forgetPassphrase}
                  onChange={(e) => {
                    setForgetPassphrase(e.target.checked)
                  }}
                />
              )}
            </div>
          )}
          {!key && !generating && (
            <p className="text-xs text-faint">
              {t('With both a key and a password, the key is tried first.')}
            </p>
          )}
        </div>

        <Field label={t('Notes')}>
          <TextArea
            rows={2}
            className="font-sans text-[13px]"
            data-testid="account-notes"
            placeholder={t('Optional')}
            value={notes}
            onChange={(e) => {
              setNotes(e.target.value)
            }}
          />
        </Field>

        {error && (
          <Notice tone="danger" testId="account-error">
            {error}
          </Notice>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
