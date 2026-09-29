import { describe, expect, it } from 'vitest'
import { algorithmsFor } from '../../src/session-host/ssh/connect'

type Algos = {
  serverHostKey: string[]
  kex?: { append: string[] }
  cipher?: { append: string[] }
}

describe('thuật toán legacy theo host', () => {
  it('mặc định: không có ssh-rsa (SHA-1), không đụng kex / cipher mặc định của ssh2', () => {
    const a = algorithmsFor({ knownKeyTypes: [] }) as Algos
    expect(a.serverHostKey).not.toContain('ssh-rsa')
    expect(a.serverHostKey[0]).toBe('ssh-ed25519')
    expect(a.kex).toBeUndefined()
    expect(a.cipher).toBeUndefined()
  })

  it('bật legacy: chỉ NỐI THÊM thuật toán cũ sau thuật toán hiện đại', () => {
    const a = algorithmsFor({ knownKeyTypes: [], legacyAlgorithms: true }) as Algos
    expect(a.serverHostKey.slice(-2)).toEqual(['ssh-rsa', 'ssh-dss'])
    expect(a.serverHostKey[0]).toBe('ssh-ed25519')
    expect(a.kex?.append).toEqual([
      'diffie-hellman-group14-sha1',
      'diffie-hellman-group-exchange-sha1',
      'diffie-hellman-group1-sha1'
    ])
    expect(a.cipher?.append).toContain('aes128-cbc')
  })
})
