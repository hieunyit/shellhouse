import { useEffect, useMemo, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { Button, Modal, Notice } from '../../../renderer/src/components/ui'
import {
  activateTab,
  t,
  useFleetMonitored,
  useHomeAttentionEnabled,
  usePublishAttention
} from '../../registry/renderer-kit'
import { formatDateTime } from '@shared/i18n/format'
import type { CertificatesResult, K8sOp } from '../shared/ops'
import { certificateName, certificateNotes, certificateState } from '../shared/certificates'

type Request = <T>(op: K8sOp, signal?: AbortSignal) => Promise<T>

/** Checks continue while another tab is active. Only expiry metadata is retained. */
export function Certificates({
  ready,
  request,
  tabId,
  contextKey,
  cluster
}: {
  ready: boolean
  request: Request
  tabId: string
  contextKey: string
  cluster: string
}): React.JSX.Element | null {
  const [state, setState] = useState<{ request: Request; result: CertificatesResult } | null>(null)
  const [error, setError] = useState<{ request: Request; message: string } | null>(null)
  const [expanded, setExpanded] = useState(false)
  const monitored = useFleetMonitored(`k8s:${contextKey}`)
  const attention = useHomeAttentionEnabled()
  useEffect(() => {
    if (!ready) return
    const abort = new AbortController()
    let busy = false
    const poll = async (): Promise<void> => {
      if (busy) return
      busy = true
      try {
        const result = await request<CertificatesResult>({ op: 'certificates' }, abort.signal)
        if (!abort.signal.aborted) {
          setState({ request, result })
          setError(null)
        }
      } catch (e) {
        if (!abort.signal.aborted)
          setError({ request, message: e instanceof Error ? e.message : String(e) })
      } finally {
        busy = false
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), 60_000)
    return () => {
      abort.abort()
      clearInterval(timer)
    }
  }, [ready, request])
  const result = ready && state?.request === request ? state.result : null
  const failure = ready && error?.request === request ? error.message : null
  const notes = useMemo(() => (result ? certificateNotes(result) : []), [result])
  const items = useMemo(
    () =>
      attention && !monitored
        ? notes.map((note) => ({
            id: note.id,
            title: t('Certificate expiry'),
            description: note.text,
            severity: note.severity,
            source: cluster,
            open: () => {
              activateTab(tabId)
              setExpanded(true)
            }
          }))
        : [],
    [notes, cluster, tabId, attention, monitored]
  )
  usePublishAttention(`k8s-certificates:${tabId}`, items)
  if (!ready) return null
  return (
    <div className="shrink-0 border-b border-line px-2 py-1" data-testid="k8s-certificates">
      <div className="flex items-center gap-2">
        <Button
          icon={<ShieldCheck size={12} />}
          onClick={() => {
            setExpanded(true)
          }}
          data-testid="k8s-certificates-open"
        >
          {t('Certificates')}
          {notes.length ? ` (${notes.length})` : ''}
        </Button>
        {notes.length > 0 && (
          <span
            className={
              notes.some((note) => note.severity === 'danger')
                ? 'truncate text-xs text-danger'
                : 'truncate text-xs text-warning'
            }
          >
            {notes[0]?.text}
          </span>
        )}
        {(failure || result?.secretsError || result?.truncated) && (
          <span className="text-xs text-warning">
            {t('Some certificates could not be checked')}
          </span>
        )}
      </div>
      {expanded && (
        <Modal
          title={t('Certificates')}
          onClose={() => {
            setExpanded(false)
          }}
          width="max-w-2xl"
          testId="k8s-certificates-dialog"
          footer={
            <Button
              onClick={() => {
                setExpanded(false)
              }}
            >
              {t('Close')}
            </Button>
          }
        >
          <div className="flex max-h-96 flex-col gap-2 overflow-auto">
            <p className="text-xs text-muted">
              {t(
                'Warnings appear when a certificate expires within 30 days. Checks run every minute while this cluster tab is open.'
              )}
            </p>
            {!result && !failure && (
              <p className="text-xs text-muted">{t('Checking certificates…')}</p>
            )}
            {failure && <Notice tone="danger">{failure}</Notice>}
            {result?.secretsError && (
              <Notice tone="warning">
                {t('Could not check TLS Secrets across the cluster')}: {result.secretsError}
              </Notice>
            )}
            {result?.truncated && (
              <Notice tone="warning">{t('Only the first 10,000 TLS Secrets were checked')}</Notice>
            )}
            {result?.items.map((cert) => {
              const status = certificateState(cert)
              return (
                <div
                  key={cert.id}
                  className="flex items-center justify-between gap-3 rounded border border-line p-2 text-xs"
                  data-testid="k8s-certificate"
                  data-state={status}
                >
                  <span className="min-w-0 truncate font-mono">{certificateName(cert)}</span>
                  <span
                    className={
                      status === 'danger'
                        ? 'text-danger'
                        : status === 'warning' || status === 'unknown'
                          ? 'text-warning'
                          : 'text-muted'
                    }
                  >
                    {cert.expiresAt
                      ? formatDateTime(cert.expiresAt)
                      : t('Certificate expiry is unknown')}
                  </span>
                </div>
              )
            })}
            {notes.map((note) => (
              <Notice key={note.id} tone={note.severity}>
                {note.text}
              </Notice>
            ))}
          </div>
        </Modal>
      )}
    </div>
  )
}
