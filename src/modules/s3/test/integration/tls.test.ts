import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer as createHttpsServer } from 'node:https'
import { createServer as createHttpServer } from 'node:http'
import { connect, type AddressInfo, type Socket } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ListBucketsCommand, type S3Client } from '@aws-sdk/client-s3'

const system = vi.hoisted(() => ({ certs: [] as string[] }))
vi.mock('node:tls', async (original) => {
  const tls = await original<typeof import('node:tls')>()
  return {
    ...tls,
    getCACertificates: (type?: 'default' | 'system' | 'bundled' | 'extra') =>
      type === 'system' ? system.certs : tls.getCACertificates(type)
  }
})
import { createS3Client, errorText } from '../../session-host/client'
import { parseCaCertificates, trustedCaCertificates } from '../../../../node-shared/tls-ca'

const fixtures = join(import.meta.dirname, '../../../docker/test/fixtures')
const ca = readFileSync(join(fixtures, 'ca.pem'), 'utf8')
const key = readFileSync(join(fixtures, 'server-key.pem'), 'utf8')
const cert = readFileSync(join(fixtures, 'server.pem'), 'utf8')
const otherCa = readFileSync(join(fixtures, 'other-ca.pem'), 'utf8')
const cleanups: (() => Promise<void> | void)[] = []
beforeEach(() => {
  system.certs = []
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function endpoint(): Promise<number> {
  const server = createHttpsServer({ key, cert }, (_request, response) => {
    response.setHeader('content-type', 'application/xml')
    response.end(
      '<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Buckets><Bucket><Name>private-minio</Name></Bucket></Buckets></ListAllMyBucketsResult>'
    )
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => {
          resolve()
        })
      })
  )
  return (server.address() as AddressInfo).port
}

async function proxy(port: number): Promise<string> {
  const sockets = new Set<Socket>()
  const server = createHttpServer()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => {
      sockets.delete(socket)
    })
  })
  server.on('connect', (_request, client, head) => {
    const upstream = connect(port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      client.pipe(upstream).pipe(client)
    })
    sockets.add(upstream)
    upstream.once('close', () => {
      sockets.delete(upstream)
    })
    upstream.on('error', () => {
      client.destroy()
    })
    client.once('close', () => {
      upstream.destroy()
    })
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => {
          resolve()
        })
      })
  )
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function client(
  url: string,
  options: { caPem?: string; proxy?: string; insecureTls?: boolean } = {}
): S3Client {
  const client = createS3Client(
    {
      endpoint: url,
      region: 'us-east-1',
      accessKeyId: 'test',
      secretAccessKey: 'test',
      forcePathStyle: true,
      ...options
    },
    2
  )
  cleanups.push(() => {
    client.destroy()
  })
  return client
}

describe('S3 internal TLS trust', () => {
  it('uses an OS trusted CA without requiring Node startup flags', async () => {
    const port = await endpoint()
    system.certs = [ca]
    const result = await client(`https://127.0.0.1:${port}`).send(new ListBucketsCommand({}))
    expect(result.Buckets?.[0]?.Name).toBe('private-minio')
  })

  it('connects using an account CA while other accounts still reject the untrusted chain', async () => {
    const port = await endpoint()
    const url = `https://127.0.0.1:${port}`
    expect(
      (await client(url, { caPem: ca }).send(new ListBucketsCommand({}))).Buckets?.[0]?.Name
    ).toBe('private-minio')
    await expect(client(url).send(new ListBucketsCommand({}))).rejects.toThrow(/certificate/i)
    await expect(client(url, { caPem: otherCa }).send(new ListBucketsCommand({}))).rejects.toThrow(
      /certificate/i
    )
  })

  it('keeps CA and hostname verification through HTTP CONNECT', async () => {
    const port = await endpoint()
    const via = await proxy(port)
    expect(
      (
        await client(`https://localhost:${port}`, { proxy: via, caPem: ca }).send(
          new ListBucketsCommand({})
        )
      ).Buckets?.[0]?.Name
    ).toBe('private-minio')
    await expect(
      client(`https://wrong-host.internal:${port}`, { proxy: via, caPem: ca }).send(
        new ListBucketsCommand({})
      )
    ).rejects.toThrow(/Hostname\/IP|altname|certificate/i)
    await expect(
      client(`https://127.0.0.2:${port}`, { proxy: via, caPem: ca }).send(
        new ListBucketsCommand({})
      )
    ).rejects.toThrow(/Hostname\/IP|altname|certificate/i)
  })

  it('adds custom roots without dropping default trust or accepting private keys', () => {
    system.certs = [ca]
    const parsed = parseCaCertificates(ca)
    const trusted = trustedCaCertificates(ca)
    expect(trusted.filter((pem) => pem.trim() === parsed[0])).toHaveLength(1)
    expect(trusted.length).toBeGreaterThan(1)
    expect(() => parseCaCertificates(key)).toThrow(/without private keys/)
    expect(() => parseCaCertificates(`${ca}\n${key}`)).toThrow(/without private keys/)
    expect(() =>
      parseCaCertificates('-----BEGIN CERTIFICATE-----\nbad\n-----END CERTIFICATE-----')
    ).toThrow(/X.509/)
  })

  it('shows an account CA remedy and avoids repeated hints or Node CLI instructions', () => {
    const error = new Error(
      'unable to verify the first certificate; if the root CA is installed locally, try running Node.js with --use-system-ca'
    )
    const text = errorText(error)
    expect(text).toContain('CA certificate (PEM)')
    expect(text).not.toContain('--use-system-ca')
    expect(text).not.toContain('Skip certificate verification')
    expect(errorText(new Error(text))).toBe(text)
  })
})
