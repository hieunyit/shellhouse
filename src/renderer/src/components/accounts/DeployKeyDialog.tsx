import { useMemo, useState } from 'react'
import { Server } from 'lucide-react'
import { t } from '@shared/i18n'
import type { KeySummary } from '@shared/hosts'
import { useHosts } from '../../stores/hosts'
import { useTabs } from '../../stores/tabs'
import { controllers } from '../../terminal/registry'
import { cleanError } from '../../lib/format'
import { Button, Modal, Notice, cx } from '../ui'

interface Session {
  tabId: string
  title: string
  address: string
}

/**
 * Keychain → Deploy to server: thêm public key vào ~/.ssh/authorized_keys qua một phiên SSH đang
 * kết nối (giống nút "Deploy key" trên thanh công cụ terminal, nhưng chọn phiên thay vì chọn key).
 */
export function DeployKeyToServerDialog({
  sshKey,
  onClose
}: {
  sshKey: KeySummary
  onClose: () => void
}): React.JSX.Element {
  const tabs = useTabs((s) => s.tabs)
  const hosts = useHosts((s) => s.tree.hosts)
  // Ảnh chụp lúc mở: trạng thái kết nối nằm trong controller (không phải store).
  const sessions = useMemo<Session[]>(
    () =>
      tabs.flatMap((tab): Session[] => {
        if (controllers.get(tab.id)?.connectionState !== 'connected') return []
        if (tab.target.kind === 'ssh') {
          const { username, host, port } = tab.target
          return [
            {
              tabId: tab.id,
              title: tab.title,
              address: `${username}@${host}${port === 22 ? '' : `:${String(port)}`}`
            }
          ]
        }
        if (tab.target.kind === 'host') {
          const hostId = tab.target.hostId
          const host = hosts.find((h) => h.id === hostId)
          if (!host || host.protocol !== 'ssh') return []
          return [{ tabId: tab.id, title: tab.title, address: host.hostname }]
        }
        return []
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chỉ tính một lần khi mở
    []
  )
  const [tabId, setTabId] = useState(sessions[0]?.tabId ?? '')
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async (): Promise<void> => {
    const controller = controllers.get(tabId)
    if (!controller) {
      setResult({ ok: false, text: t('The tab was closed') })
      return
    }
    setBusy(true)
    try {
      const line = await window.shellhouse.publicKey(sshKey.id)
      const r = await controller.deployKey(line)
      if (r.status === 'added')
        setResult({ ok: true, text: t('Key added to ~/.ssh/authorized_keys.') })
      else if (r.status === 'exists')
        setResult({ ok: true, text: t('The key is already on the server.') })
      else setResult({ ok: false, text: r.message ?? t('Could not add the key.') })
    } catch (error) {
      setResult({ ok: false, text: cleanError(error) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={t('Deploy “{name}” to a server', { name: sshKey.name })}
      description={t(
        'Like ssh-copy-id: no duplicates, ~/.ssh is 700 and authorized_keys is 600. Requires a POSIX shell on the server.'
      )}
      onClose={onClose}
      width="max-w-md"
      testId="keychain-deploy-dialog"
      footer={
        <>
          <Button onClick={onClose}>{t('Close')}</Button>
          <Button
            variant="primary"
            disabled={!tabId || busy}
            data-testid="keychain-deploy-run"
            onClick={() => void run()}
          >
            {busy ? t('Adding…') : t('Add key')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {sessions.length === 0 ? (
          <Notice testId="keychain-deploy-empty">
            {t(
              'No SSH session is connected. Connect to the server (password sign-in is fine), then deploy the key from here or from the terminal toolbar.'
            )}
          </Notice>
        ) : (
          <div role="radiogroup" aria-label={t('Session')} className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted">
              {t('Add the key through this session')}
            </span>
            {sessions.map((s) => (
              <label
                key={s.tabId}
                data-testid="keychain-deploy-session"
                className={cx(
                  'flex cursor-pointer items-center gap-2.5 rounded-md border px-2.5 py-2 text-[13px]',
                  tabId === s.tabId ? 'border-accent bg-subtle' : 'border-line hover:bg-hover'
                )}
              >
                <input
                  type="radio"
                  name="keychain-deploy-session"
                  className="accent-[var(--sh-accent)]"
                  checked={tabId === s.tabId}
                  onChange={() => {
                    setTabId(s.tabId)
                    setResult(null)
                  }}
                />
                <Server size={14} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate text-fg">{s.title}</span>
                <span className="truncate font-mono text-xs text-faint">{s.address}</span>
              </label>
            ))}
          </div>
        )}
        {result && (
          <Notice tone={result.ok ? 'success' : 'danger'} testId="keychain-deploy-result">
            {result.text}
          </Notice>
        )}
      </div>
    </Modal>
  )
}
