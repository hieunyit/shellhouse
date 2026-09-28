import { execFileSync } from 'node:child_process'
import { createPublicKey } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { verifyUpdateSignature, type SignedFile } from '../../src/node-shared/update-signature'
import { UPDATE_PUBLIC_KEYS } from '../../src/main/update-keys'
import { tempDir } from './helpers'

const SCRIPT = resolve('scripts/sign-update.mjs')

function keyPair(): { privateKey: string; publicKey: string } {
  const out = execFileSync(process.execPath, [SCRIPT, '--generate'], { encoding: 'utf8' })
  const [privateKey, publicKey] = out.split(/(?=-----BEGIN PUBLIC KEY-----)/)
  return { privateKey: privateKey ?? '', publicKey: publicKey ?? '' }
}

// Dạng electron-builder ghi ra (url có thể bị quote).
const YML = `version: 1.2.3
files:
  - url: Shellhouse-1.2.3.AppImage
    sha512: AAAAsha512appimage==
    size: 123
    blockMapSize: 45
  - url: 'shellhouse_1.2.3_amd64.deb'
    sha512: BBBBsha512deb==
    size: 456
path: Shellhouse-1.2.3.AppImage
sha512: AAAAsha512appimage==
releaseDate: '2026-09-28T00:00:00.000Z'
`
// Những gì electron-updater parse ra từ file trên.
const FILES: SignedFile[] = [
  { url: 'Shellhouse-1.2.3.AppImage', sha512: 'AAAAsha512appimage==' },
  { url: 'shellhouse_1.2.3_amd64.deb', sha512: 'BBBBsha512deb==' }
]

function signYml(privateKey: string, content = YML): string {
  const file = join(tempDir(), 'latest-linux.yml')
  writeFileSync(file, content)
  execFileSync(process.execPath, [SCRIPT, file], {
    env: { ...process.env, SHELLHOUSE_UPDATE_SIGNING_KEY: privateKey }
  })
  return readFileSync(file, 'utf8')
}
const signatureOf = (yml: string): string => /^shellhouseSignature: (.+)$/m.exec(yml)?.[1] ?? ''

describe('chữ ký cập nhật Linux', () => {
  const keys = keyPair()

  it('script ký → app xác minh được', () => {
    const sig = signatureOf(signYml(keys.privateKey))
    expect(verifyUpdateSignature('1.2.3', FILES, sig, [keys.publicKey])).toBe(true)
    // Thứ tự file không ảnh hưởng.
    expect(verifyUpdateSignature('1.2.3', [...FILES].reverse(), sig, [keys.publicKey])).toBe(true)
  })

  it('từ chối khi version / url / sha512 bị sửa, thiếu chữ ký, sai khoá', () => {
    const sig = signatureOf(signYml(keys.privateKey))
    const pub = [keys.publicKey]
    expect(verifyUpdateSignature('1.2.4', FILES, sig, pub)).toBe(false)
    expect(
      verifyUpdateSignature('1.2.3', [{ ...FILES[0], sha512: 'EVIL==' } as SignedFile], sig, pub)
    ).toBe(false)
    expect(verifyUpdateSignature('1.2.3', FILES.slice(0, 1), sig, pub)).toBe(false)
    expect(verifyUpdateSignature('1.2.3', FILES, undefined, pub)).toBe(false)
    expect(verifyUpdateSignature('1.2.3', FILES, 'not base64 !!', pub)).toBe(false)
    expect(verifyUpdateSignature('1.2.3', FILES, sig, [keyPair().publicKey])).toBe(false)
    expect(verifyUpdateSignature('1.2.3', FILES, sig, [])).toBe(false)
    expect(verifyUpdateSignature('1.2.3', FILES, sig, ['garbage'])).toBe(false)
  })

  it('xoay vòng khoá: chấp nhận nếu khớp một trong các key', () => {
    const sig = signatureOf(signYml(keys.privateKey))
    expect(verifyUpdateSignature('1.2.3', FILES, sig, [keyPair().publicKey, keys.publicKey])).toBe(
      true
    )
  })

  it('ký lại thay chữ ký cũ, không tạo dòng trùng', () => {
    const once = signYml(keys.privateKey)
    const other = keyPair()
    const twice = signYml(other.privateKey, once)
    expect(twice.match(/shellhouseSignature/g)).toHaveLength(1)
    expect(verifyUpdateSignature('1.2.3', FILES, signatureOf(twice), [other.publicKey])).toBe(true)
  })
})

describe('public key nhúng trong app', () => {
  it('có ít nhất một key, tất cả là public key ed25519 hợp lệ, không trùng', () => {
    expect(UPDATE_PUBLIC_KEYS.length).toBeGreaterThan(0)
    for (const pem of UPDATE_PUBLIC_KEYS) {
      const key = createPublicKey(pem)
      expect(key.type).toBe('public')
      expect(key.asymmetricKeyType).toBe('ed25519')
    }
    expect(new Set(UPDATE_PUBLIC_KEYS).size).toBe(UPDATE_PUBLIC_KEYS.length)
  })
})
