import { useEffect, useState } from 'react'
import { CheckCircle2, XCircle } from 'lucide-react'
import type { AppInfo, NativeModuleStatus, SessionHostStatus } from '@shared/ipc'
import { t } from '@shared/i18n'
import { useHostStatus } from '../stores/host-status'
import { Button, cx, SectionTitle } from './ui'

function stateLabel(state: SessionHostStatus['state']): string {
  switch (state) {
    case 'starting':
      return t('Starting')
    case 'running':
      return t('Running')
    case 'restarting':
      return t('Restarting')
    case 'stopped':
      return t('Stopped')
  }
}

const stateColor: Record<SessionHostStatus['state'], string> = {
  starting: 'bg-warning',
  running: 'bg-success',
  restarting: 'bg-warning',
  stopped: 'bg-danger'
}

export function Diagnostics(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const status = useHostStatus((s) => s.status)
  const [modules, setModules] = useState<NativeModuleStatus[] | null>(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    void window.shellhouse.getInfo().then(setInfo)
  }, [])

  const runCheck = async (): Promise<void> => {
    setChecking(true)
    try {
      setModules(await window.shellhouse.checkNativeModules())
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="flex flex-col gap-6 text-[13px]">
      <section>
        <SectionTitle>{t('Application')}</SectionTitle>
        {info && (
          <p className="font-mono text-xs text-muted" data-testid="app-info">
            v{info.version} · Electron {info.electron} · Node {info.node} · {info.platform}/
            {info.arch}
          </p>
        )}
      </section>

      <section>
        <SectionTitle
          description={t(
            'Runs every SSH connection and terminal in a separate process, restarted automatically if it crashes.'
          )}
        >
          {t('Session host')}
        </SectionTitle>
        {status && (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <span className="flex items-center gap-2">
              <span className={cx('size-2 rounded-full', stateColor[status.state])} />
              <span data-testid="host-state" data-state={status.state}>
                {stateLabel(status.state)}
              </span>
            </span>
            <span className="text-muted">PID {status.pid ?? '—'}</span>
            <span className="text-muted" data-testid="host-restarts">
              {t('Restarts: {n}', { n: status.restarts })}
            </span>
            {status.lastExit && (
              <span className="text-faint">
                {t('Last exit: {reason} (code {code})', {
                  reason: status.lastExit.reason,
                  code: status.lastExit.code ?? '—'
                })}
              </span>
            )}
          </div>
        )}
        {info?.testHooks && (
          <Button
            variant="danger"
            size="sm"
            className="mt-3"
            data-testid="crash-host"
            onClick={() => void window.shellhouse.crashSessionHostForTest()}
          >
            {t('Kill session host (test)')}
          </Button>
        )}
      </section>

      <section>
        <div className="flex items-start">
          <div className="flex-1">
            <SectionTitle>{t('Native modules')}</SectionTitle>
          </div>
          <Button
            size="sm"
            disabled={checking}
            data-testid="run-selfcheck"
            onClick={() => void runCheck()}
          >
            {checking ? t('Checking…') : t('Run check')}
          </Button>
        </div>
        {modules && (
          <div className="overflow-hidden rounded-lg border border-line">
            <table className="w-full text-left" data-testid="module-table">
              <thead className="bg-subtle text-xs text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">{t('Module')}</th>
                  <th className="px-3 py-2 font-medium">{t('Process')}</th>
                  <th className="px-3 py-2 font-medium">{t('Result')}</th>
                </tr>
              </thead>
              <tbody>
                {modules.map((m) => (
                  <tr
                    key={`${m.process}:${m.name}`}
                    className="border-t border-line"
                    data-testid={`module-${m.name}`}
                    data-ok={m.ok}
                  >
                    <td className="px-3 py-2 font-mono text-xs">{m.name}</td>
                    <td className="px-3 py-2 text-muted">{m.process}</td>
                    <td className={cx('px-3 py-2', m.ok ? 'text-success' : 'text-danger')}>
                      <span className="inline-flex items-center gap-1.5">
                        {m.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />} {m.detail}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
