import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fingerprintSha256, keyLabel, keyTypeOf, randomart } from '../../src/node-shared/hostkey'
import { tempDir } from './helpers'

function hasSshKeygen(): boolean {
  try {
    execFileSync('ssh-keygen', ['-?'], { stdio: 'ignore' })
    return true
  } catch (error) {
    // ssh-keygen -? thoát mã 1 nhưng vẫn là có cài.
    return (error as { status?: number }).status === 1
  }
}

const cases: [string, string[]][] = [
  ['ed25519', ['-t', 'ed25519']],
  ['rsa', ['-t', 'rsa', '-b', '3072']],
  ['ecdsa', ['-t', 'ecdsa', '-b', '384']]
]

describe.skipIf(!hasSshKeygen())('hostkey so với ssh-keygen', () => {
  it.each(cases)('%s: fingerprint + randomart trùng khớp từng ký tự', (_name, args) => {
    const dir = tempDir()
    const keyPath = join(dir, 'k')
    execFileSync('ssh-keygen', [...args, '-N', '', '-q', '-f', keyPath])
    const pub = readFileSync(`${keyPath}.pub`, 'utf8').trim().split(/\s+/)
    const blob = Buffer.from(pub[1] ?? '', 'base64')

    expect(keyTypeOf(blob)).toBe(pub[0])
    const out = execFileSync('ssh-keygen', ['-lv', '-E', 'sha256', '-f', `${keyPath}.pub`], {
      encoding: 'utf8'
    })
      .replace(/\r\n/g, '\n') // ssh-keygen trên Windows in CRLF
      .trimEnd()
    const [summary, ...art] = out.split('\n')
    expect(summary).toContain(fingerprintSha256(blob))
    expect(summary).toContain(String(keyLabel(blob).bits))
    expect(randomart(blob)).toBe(art.join('\n'))
  })
})

describe('hostkey', () => {
  it('từ chối blob bị cắt cụt', () => {
    expect(() => keyTypeOf(Buffer.from([0, 0, 0, 20, 1, 2]))).toThrow(/Truncated/)
  })
})
