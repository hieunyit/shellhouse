import { useEffect, useState } from 'react'
import { Bug, Check, Copy, ExternalLink, RefreshCw } from 'lucide-react'
import type { AppInfo } from '@shared/ipc'
import { t } from '@shared/i18n'
import { Logo } from '../Logo'
import { Button } from '../ui'

const REPO = 'https://github.com/hieunyit/shellhouse'

/** Giới thiệu app: logo, phiên bản, thành phần, link phát hành / báo lỗi. */
export function AboutSection({
  onCheckUpdates
}: {
  onCheckUpdates: () => void
}): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    void window.shellhouse.getInfo().then(setInfo)
  }, [])

  // [nhãn hiển thị, nhãn tiếng Anh khi sao chép (dán vào báo lỗi), giá trị]
  const rows: [string, string, string][] = info
    ? [
        [t('Version'), 'Version', info.version],
        ['Electron', 'Electron', info.electron],
        ['Chromium', 'Chromium', info.chrome],
        ['Node.js', 'Node.js', info.node],
        [t('Platform'), 'Platform', `${info.platform} ${info.arch}`]
      ]
    : []
  const beta = info?.version.includes('-') ?? false

  return (
    <div className="flex flex-col gap-6" data-testid="settings-about">
      <div className="flex items-center gap-4">
        <Logo size={64} className="shrink-0 drop-shadow-md" />
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight text-fg">
            Shellhouse
            {beta && (
              <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">
                Beta
              </span>
            )}
          </h2>
          <p className="mt-0.5 text-[13px] text-muted">
            {t('SSH, SFTP, Telnet, serial and S3 — one secure workspace for your servers.')}
          </p>
          <p className="mt-1 font-mono text-xs text-faint" data-testid="about-version">
            {info ? t('Version {version}', { version: info.version }) : ' '}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button icon={<RefreshCw size={13} />} onClick={onCheckUpdates}>
          {t('Check for updates')}
        </Button>
        <a
          href={`${REPO}/releases`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium text-muted hover:bg-hover hover:text-fg"
        >
          <ExternalLink size={13} /> {t('Release notes')}
        </a>
        <a
          href={`${REPO}/issues/new`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium text-muted hover:bg-hover hover:text-fg"
        >
          <Bug size={13} /> {t('Report a problem')}
        </a>
      </div>

      <div className="rounded-lg border border-line">
        <dl className="divide-y divide-line text-[13px]">
          {rows.map(([k, , v]) => (
            <div key={k} className="flex items-center justify-between gap-4 px-3.5 py-2">
              <dt className="text-muted">{k}</dt>
              <dd className="font-mono text-xs text-fg">{v}</dd>
            </div>
          ))}
        </dl>
        <div className="flex justify-end border-t border-line px-2 py-1.5">
          <Button
            size="sm"
            variant="ghost"
            icon={copied ? <Check size={13} /> : <Copy size={13} />}
            disabled={!info}
            onClick={() => {
              void window.shellhouse
                .writeClipboard(rows.map(([, k, v]) => `${k}: ${v}`).join('\n'))
                .then(() => {
                  setCopied(true)
                })
            }}
          >
            {copied ? t('Copied') : t('Copy details')}
          </Button>
        </div>
      </div>

      <p className="text-xs text-faint">
        {t('Passwords and keys stay encrypted on this computer. Shellhouse sends no telemetry.')}
      </p>
    </div>
  )
}
