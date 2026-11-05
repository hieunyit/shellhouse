import { readFileSync } from 'node:fs'
import { X509Certificate } from 'node:crypto'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { certExpiry } from '../../session-host/certs'
import { certificates } from '../../session-host/operations'
import type { KubeClient } from '../../session-host/client'
import type { CertificateInfo } from '../../shared/ops'
import { certificateNotes, certificateState, CERT_WARN_DAYS } from '../../shared/certificates'
import { credentialProvider } from '../../session-host/auth'
import type { LimitedSpawn } from '../../../registry/host-types'

const crt = readFileSync(join(import.meta.dirname, '../fixtures/server.crt'), 'utf8')
const expiry = new Date(new X509Certificate(crt).validTo).toISOString()
const now = Date.parse('2026-11-05T00:00:00Z')
const info = (offset: number): CertificateInfo => ({
  id: 'client',
  name: 'client',
  source: 'client',
  expiresAt: new Date(now + offset).toISOString()
})

describe('Kubernetes certificate checks', () => {
  it('refreshes exec credentials before the client certificate expires even when the plugin advertises a later timestamp', async () => {
    let clock = Date.parse(expiry) - 120_000
    let calls = 0
    const spawn = {
      exec: async () => {
        await Promise.resolve()
        calls++
        return {
          code: 0,
          stderr: '',
          stdout: JSON.stringify({
            status: {
              clientCertificateData: crt,
              clientKeyData: 'key',
              expirationTimestamp: new Date(clock + 86_400_000).toISOString()
            }
          })
        }
      }
    } as unknown as LimitedSpawn
    const provider = credentialProvider(
      {
        exec: {
          command: 'kubelogin',
          args: ['get-token'],
          env: {},
          apiVersion: 'client.authentication.k8s.io/v1'
        }
      },
      spawn,
      'https://cluster',
      () => clock
    )
    expect((await provider(false)).cert).toBe(crt)
    await provider(false)
    expect(calls).toBe(1)
    clock += 70_000
    await provider(false)
    expect(calls).toBe(2)
  })
  it('parses a PEM leaf and reports invalid certificates as unknown', () => {
    expect(certExpiry(crt)).toBe(expiry)
    expect(certExpiry('invalid')).toBeNull()
    expect(certExpiry('-----BEGIN CERTIFICATE-----\nbroken\n-----END CERTIFICATE-----')).toBeNull()
  })
  it('treats notAfter as expired, warns at 30 days, rounds remaining days up and handles malformed dates', () => {
    expect(certificateState(info(0), now)).toBe('danger')
    expect(certificateState(info(-1), now)).toBe('danger')
    expect(certificateState(info(CERT_WARN_DAYS * 86_400_000), now)).toBe('warning')
    expect(certificateState(info(CERT_WARN_DAYS * 86_400_000 + 1), now)).toBe('ok')
    expect(certificateState({ ...info(1), expiresAt: 'bad' }, now)).toBe('unknown')
    expect(certificateNotes({ items: [info(1.5 * 86_400_000)] }, now)[0]?.text).toContain('2 days')
  })
  it('paginates TLS Secrets and returns only metadata; malformed TLS data remains visible', async () => {
    const calls: unknown[] = []
    const client = {
      serverCertExpiry: expiry,
      clientCertExpiry: expiry,
      caCertExpiry: expiry,
      json: async (_method: string, path: string, opts: { query: Record<string, unknown> }) => {
        await Promise.resolve()
        calls.push({ path, query: opts.query })
        return opts.query['continue']
          ? {
              items: [
                {
                  type: 'kubernetes.io/tls',
                  metadata: { name: 'broken', namespace: 'app' },
                  data: { 'tls.crt': 'bad', 'tls.key': 'NEVER-RETURN-THIS' }
                }
              ]
            }
          : {
              metadata: { continue: 'next' },
              items: [
                {
                  type: 'kubernetes.io/tls',
                  metadata: { name: 'web', namespace: 'app' },
                  data: {
                    'tls.crt': Buffer.from(crt).toString('base64'),
                    'tls.key': 'NEVER-RETURN-THIS'
                  }
                }
              ]
            }
      }
    } as unknown as KubeClient
    const result = await certificates(client)
    expect(result.items).toHaveLength(5)
    expect(result.items.at(-2)).toMatchObject({
      source: 'secret',
      name: 'web',
      namespace: 'app',
      expiresAt: expiry
    })
    expect(result.items.at(-1)?.expiresAt).toBeNull()
    expect(JSON.stringify(result)).not.toContain('NEVER-RETURN-THIS')
    expect(JSON.stringify(result)).not.toContain('BEGIN CERTIFICATE')
    expect(calls).toEqual([
      {
        path: '/api/v1/secrets',
        query: { fieldSelector: 'type=kubernetes.io/tls', limit: 500, continue: undefined }
      },
      {
        path: '/api/v1/secrets',
        query: { fieldSelector: 'type=kubernetes.io/tls', limit: 500, continue: 'next' }
      }
    ])
  })
  it('preserves connection certificate checks when RBAC denies Secret listing and propagates cancellation', async () => {
    const client = {
      serverCertExpiry: expiry,
      json: async () => {
        await Promise.resolve()
        throw new Error('Forbidden')
      }
    } as unknown as KubeClient
    expect(await certificates(client)).toMatchObject({
      items: [{ source: 'server', expiresAt: expiry }],
      secretsError: 'Forbidden'
    })
    await expect(certificates(client, AbortSignal.abort())).rejects.toThrow()
  })
})
