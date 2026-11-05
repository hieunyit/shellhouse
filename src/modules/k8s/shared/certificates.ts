import { t, tn } from '@shared/i18n'
import { formatDateTime } from '@shared/i18n/format'
import type { CertificateInfo, CertificatesResult } from './ops'

export const CERT_WARN_DAYS = 30
const DAY = 86_400_000

export function certificateName(cert: CertificateInfo): string {
  switch (cert.source) {
    case 'server':
      return t('API server certificate')
    case 'client':
      return t('Client certificate')
    case 'ca':
      return t('Cluster CA certificate')
    case 'secret':
      return `${cert.namespace ?? ''}/${cert.name}`
  }
}

export function certificateState(
  cert: CertificateInfo,
  now = Date.now()
): 'ok' | 'warning' | 'danger' | 'unknown' {
  const expiry = cert.expiresAt ? Date.parse(cert.expiresAt) : NaN
  if (!Number.isFinite(expiry)) return 'unknown'
  if (expiry <= now) return 'danger'
  return expiry - now <= CERT_WARN_DAYS * DAY ? 'warning' : 'ok'
}

export function certificateNotes(
  result: CertificatesResult,
  now = Date.now()
): {
  id: string
  severity: 'warning' | 'danger'
  text: string
}[] {
  return result.items.flatMap((cert) => {
    const state = certificateState(cert, now)
    if (state === 'ok') return []
    const name = certificateName(cert)
    const date = cert.expiresAt ? formatDateTime(cert.expiresAt) : ''
    return [
      {
        id: cert.id,
        severity: state === 'danger' ? ('danger' as const) : ('warning' as const),
        text:
          state === 'unknown'
            ? t('Could not read the expiry of {name}', { name })
            : state === 'danger'
              ? t('{name} expired on {date}', { name, date })
              : tn(
                  Math.max(1, Math.ceil((Date.parse(cert.expiresAt ?? '') - now) / DAY)),
                  '{name} expires in {n} day ({date})',
                  '{name} expires in {n} days ({date})',
                  { name, date }
                )
      }
    ]
  })
}
