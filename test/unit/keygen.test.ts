import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generateVerifiedKey, isValidPublicKeyLine } from '../../src/main/hosts/keygen'
import { tempDir } from './helpers'

function hasSshKeygen(): boolean {
  try {
    execFileSync('ssh-keygen', ['-?'], { stdio: 'ignore' })
    return true
  } catch (error) {
    return (error as { status?: number }).status === 1
  }
}

describe('generateVerifiedKey', () => {
  it.each([
    ['ed25519', undefined],
    ['rsa', 3072],
    ['ecdsa', 384]
  ] as const)('%s: public key một dòng, có comment', (type, bits) => {
    const key = generateVerifiedKey({ type, ...(bits ? { bits } : {}), comment: 'hieu@laptop' })
    expect(key.publicKey).toMatch(/ hieu@laptop$/)
    expect(isValidPublicKeyLine(key.publicKey)).toBe(true)
    expect(key.privateKey).toContain('BEGIN OPENSSH PRIVATE KEY')
  })

  it('từ chối độ dài không hợp lệ', () => {
    expect(() => generateVerifiedKey({ type: 'rsa', bits: 1024, comment: '' })).toThrow(
      /Invalid key size/
    )
  })

  it.skipIf(!hasSshKeygen())(
    '300 key ed25519 (một nửa có passphrase): ssh-keygen đọc được TẤT CẢ và ra đúng public key',
    () => {
      const dir = tempDir()
      let retried = 0
      for (let i = 0; i < 300; i++) {
        const passphrase = i % 2 === 0 ? `pp-${i}` : undefined
        const key = generateVerifiedKey({
          type: 'ed25519',
          comment: `k${i}`,
          ...(passphrase ? { passphrase } : {})
        })
        if (key.attempts > 1) retried++
        const file = join(dir, `k${i}`)
        writeFileSync(file, key.privateKey, { mode: 0o600 })
        const derived = execFileSync('ssh-keygen', ['-y', '-P', passphrase ?? '', '-f', file], {
          encoding: 'utf8'
        }).trim()
        expect(derived.split(' ').slice(0, 2)).toEqual(key.publicKey.split(' ').slice(0, 2))
      }
      // Ghi nhận: bộ tạo của ssh2 có hỏng thật, và bộ kiểm chứng đã bắt được.
      process.stdout.write(`  (${retried}/300 key phải tạo lại do ssh2 sinh key hỏng)\n`)
    },
    120_000
  )
})

describe('isValidPublicKeyLine', () => {
  it('từ chối nhiều dòng, private key, rác, ký tự chèn lệnh', () => {
    const { publicKey, privateKey } = generateVerifiedKey({ type: 'ed25519', comment: 'x' })
    expect(isValidPublicKeyLine(`${publicKey}\nssh-ed25519 AAAA evil`)).toBe(false)
    expect(isValidPublicKeyLine(privateKey)).toBe(false)
    expect(isValidPublicKeyLine('ssh-ed25519 không-phải-base64')).toBe(false)
    // Comment bình thường (có khoảng trắng) hợp lệ; ký tự kiểu chèn lệnh bị từ chối
    // (dù sao key cũng được gửi qua stdin, không nằm trong câu lệnh).
    const bare = publicKey.split(' ').slice(0, 2).join(' ')
    expect(isValidPublicKeyLine(`${bare} Hieu laptop 2026`)).toBe(true)
    expect(isValidPublicKeyLine(`${bare}'; rm -rf ~ #`)).toBe(false)
  })
})
