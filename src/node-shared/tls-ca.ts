import { X509Certificate } from 'node:crypto'
import { getCACertificates } from 'node:tls'
import { t } from '@shared/i18n'

/** Parse public certificates only; never persist a pasted private key as CA material. */
export function parseCaCertificates(pem: string): string[] {
  if (!pem.trim()) return []
  const pattern = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g
  const certs = pem.match(pattern) ?? []
  if (!certs.length || pem.replace(pattern, '').trim())
    throw new Error(t('Enter PEM certificates only, without private keys'))
  try {
    for (const cert of certs) new X509Certificate(cert)
  } catch {
    throw new Error(t('The CA certificate is not a valid X.509 certificate'))
  }
  return certs
}

/** Preserve bundled/extra roots and add OS trust, without changing process-wide TLS defaults. */
export function trustedCaCertificates(customPem = ''): string[] {
  return [
    ...new Set(
      [
        ...getCACertificates('default'),
        ...getCACertificates('system'),
        ...parseCaCertificates(customPem)
      ].map((cert) => cert.trim())
    )
  ]
}
