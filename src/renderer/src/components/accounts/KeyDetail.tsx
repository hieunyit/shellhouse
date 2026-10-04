import { useState } from 'react'
import { Copy, FileDown, KeyRound, Server, ShieldCheck, Trash2, UserRound } from 'lucide-react'
import { t, tn } from '@shared/i18n'
import type { KeySummary } from '@shared/hosts'
import { useHosts } from '../../stores/hosts'
import { toast } from '../../stores/toasts'
import { Button, IconButton } from '../ui'
import { DeployKeyToServerDialog } from './DeployKeyDialog'
import { keyTypeLabel, publicKeyBits, type KeyUsage } from './keychain-logic'
import { DetailSection, UsageChips } from './keychain-parts'

/** Chi tiết một SSH key trong Keychain: public key, fingerprint, ai đang dùng, các thao tác. */
export function KeyDetail({
  sshKey,
  usage,
  publicKey,
  onSelectAccount,
  onDelete
}: {
  sshKey: KeySummary
  usage: KeyUsage
  /** Dòng public key (undefined = đang tải, null = không đọc được). */
  publicKey: string | null | undefined
  onSelectAccount: (id: string) => void
  onDelete: () => void
}): React.JSX.Element {
  const hosts = useHosts((s) => s.tree.hosts)
  const [deploying, setDeploying] = useState(false)
  const bits = publicKey ? publicKeyBits(publicKey) : null

  const copy = (text: string, done: string): void => {
    void window.shellhouse.writeClipboard(text).then(() => {
      toast.success(done, { group: 'keychain-copy', duration: 1500 })
    })
  }

  const exportKey = (): void => {
    void window.shellhouse.exportPrivateKey(sshKey.id).then((r) => {
      if (!r) return
      if (r.ok) toast.success(t('Saved {path} (mode 600) and {path}.pub', { path: r.path }))
      else toast.error(r.message)
    })
  }

  return (
    <div className="flex flex-col gap-5" data-testid="key-detail" data-key-name={sshKey.name}>
      <header className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-subtle text-muted">
          <KeyRound size={18} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h3 className="truncate text-[15px] font-semibold text-fg" title={sshKey.name}>
            {sshKey.name}
          </h3>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <span
              className="rounded bg-subtle px-1.5 py-0.5 font-mono text-[11px]"
              data-testid="key-type"
            >
              {keyTypeLabel(sshKey.type, bits)}
            </span>
            <span className="inline-flex items-center gap-1">
              <ShieldCheck size={12} className={sshKey.encrypted ? 'text-success' : 'text-faint'} />
              {sshKey.encrypted ? t('Protected with a passphrase') : t('No passphrase')}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 gap-0.5">
          <IconButton
            size="sm"
            className="size-7"
            label={t('Export private key…')}
            data-testid="key-export"
            onClick={exportKey}
          >
            <FileDown size={14} />
          </IconButton>
          <IconButton
            size="sm"
            className="size-7 hover:bg-danger-soft hover:text-danger"
            label={t('Delete')}
            data-testid="key-delete"
            onClick={onDelete}
          >
            <Trash2 size={14} />
          </IconButton>
        </div>
      </header>

      <div className="flex flex-wrap gap-1.5">
        <Button
          size="sm"
          variant="primary"
          icon={<Copy size={13} />}
          disabled={!publicKey}
          data-testid="key-copy-public"
          onClick={() => {
            if (publicKey)
              copy(publicKey, t('Copied the public key of “{name}”.', { name: sshKey.name }))
          }}
        >
          {t('Copy public key')}
        </Button>
        <Button
          size="sm"
          icon={<Server size={13} />}
          data-testid="key-deploy"
          onClick={() => {
            setDeploying(true)
          }}
        >
          {t('Deploy to server…')}
        </Button>
      </div>

      <DetailSection title={t('Fingerprint')}>
        <div className="flex items-center gap-1">
          <code
            className="sh-selectable min-w-0 flex-1 font-mono text-xs break-all text-fg"
            data-testid="key-fingerprint"
          >
            {sshKey.fingerprint}
          </code>
          <IconButton
            size="sm"
            label={t('Copy fingerprint')}
            onClick={() => {
              copy(sshKey.fingerprint, t('Copied the fingerprint'))
            }}
          >
            <Copy size={13} />
          </IconButton>
        </div>
      </DetailSection>

      <DetailSection
        title={t('Public key')}
        hint={t('Add this line to ~/.ssh/authorized_keys on the server.')}
      >
        <textarea
          readOnly
          rows={4}
          aria-label={t('Public key')}
          data-testid="key-public"
          className="sh-selectable w-full resize-none rounded-md border border-line bg-subtle px-2.5 py-2 font-mono text-[11px] leading-relaxed break-all text-fg outline-none focus:border-accent"
          value={publicKey ?? (publicKey === null ? t('Could not read the public key') : '…')}
          onFocus={(e) => {
            e.currentTarget.select()
          }}
        />
      </DetailSection>

      <DetailSection title={t('Used by')} testId="key-usage">
        {usage.accounts.length === 0 && usage.hostIds.length === 0 && usage.groups.length === 0 ? (
          <p className="text-xs text-faint">{t('Not used by any account or host')}</p>
        ) : (
          <div className="flex flex-col gap-2.5">
            {usage.accounts.length > 0 && (
              <UsageChips
                label={tn(usage.accounts.length, '{n} account', '{n} accounts')}
                testId="key-usage-accounts"
                items={usage.accounts.map((a) => ({
                  id: a.id,
                  label: a.name,
                  icon: <UserRound size={11} />,
                  onClick: () => {
                    onSelectAccount(a.id)
                  }
                }))}
              />
            )}
            {usage.hostIds.length > 0 && (
              <UsageChips
                label={tn(usage.hostIds.length, '{n} host', '{n} hosts')}
                testId="key-usage-hosts"
                items={usage.hostIds.map((id) => {
                  const host = hosts.find((h) => h.id === id)
                  return {
                    id,
                    label: host?.label ?? '?',
                    icon: <Server size={11} />,
                    ...(host ? { title: host.hostname } : {}),
                    ...(usage.directHostIds.includes(id) ? {} : { hint: t('through an account') })
                  }
                })}
              />
            )}
            {usage.groups.length > 0 && (
              <UsageChips
                label={tn(
                  usage.groups.length,
                  'Default key of {n} group',
                  'Default key of {n} groups'
                )}
                items={usage.groups.map((g) => ({ id: g.id, label: g.name }))}
              />
            )}
          </div>
        )}
      </DetailSection>

      {deploying && (
        <DeployKeyToServerDialog
          sshKey={sshKey}
          onClose={() => {
            setDeploying(false)
          }}
        />
      )}
    </div>
  )
}
