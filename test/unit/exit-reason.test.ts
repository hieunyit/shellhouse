import { describe, expect, it } from 'vitest'
import { classifyConnectError } from '../../src/session-host/session/exit-reason'

const withCode = (code: string): Error => Object.assign(new Error(code), { code })

describe('classifyConnectError', () => {
  it.each([
    [withCode('ECONNREFUSED'), 'network'],
    [withCode('ENOTFOUND'), 'network'],
    [new Error('Timed out connecting to h:22'), 'network'],
    [new Error('Server h did not respond to the SSH handshake'), 'network'],
    [new Error('Keepalive timeout'), 'network'],
    [new Error('All configured authentication methods failed'), 'auth'],
    [new Error('Host denied (verification failed)'), 'hostkey'],
    [new Error('something odd'), 'failed'],
    ['not an error', 'failed']
  ])('%s → %s', (error, reason) => {
    expect(classifyConnectError(error)).toBe(reason)
  })
})
