import { utils, type ParsedKey } from 'ssh2'
import { t } from '@shared/i18n'

export type KeyType = 'ed25519' | 'rsa' | 'ecdsa'

export interface GenerateOptions {
  type: KeyType
  /** rsa: 3072/4096; ecdsa: 256/384/521; ed25519: bỏ qua. */
  bits?: number
  comment: string
  passphrase?: string
}

export const KEY_BITS: Record<KeyType, readonly number[]> = {
  ed25519: [256],
  rsa: [3072, 4096],
  ecdsa: [256, 384, 521]
}

const MAX_ATTEMPTS = 10

/**
 * Tạo cặp key định dạng OpenSSH và KIỂM CHỨNG trước khi trả về: đọc lại private key (kèm
 * passphrase), đọc public key, ký thử và xác minh. `ssh2.utils.generateKeyPairSync` sinh ~0,4%
 * file hỏng mà cả ssh2 lẫn ssh-keygen đều không đọc được (ADR-004) — không bao giờ trả key chưa kiểm.
 */
export function generateVerifiedKey(options: GenerateOptions): {
  privateKey: string
  publicKey: string
  attempts: number
} {
  const bits = options.bits ?? KEY_BITS[options.type][0]
  if (bits === undefined || !KEY_BITS[options.type].includes(bits)) {
    throw new Error(`Invalid key size for ${options.type}: ${String(bits)}`)
  }
  const base = { comment: options.comment }
  const encryption = options.passphrase
    ? { passphrase: options.passphrase, cipher: 'aes256-ctr', rounds: 16 }
    : {}

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const pair =
      options.type === 'ed25519'
        ? utils.generateKeyPairSync('ed25519', { ...base, ...encryption } as never)
        : utils.generateKeyPairSync(options.type, { bits, ...base, ...encryption } as never)
    const priv: ParsedKey | Error = utils.parseKey(pair.private, options.passphrase)
    const pub: ParsedKey | Error = utils.parseKey(pair.public)
    if (priv instanceof Error || pub instanceof Error) continue
    if (!priv.getPublicSSH().equals(pub.getPublicSSH())) continue
    const probe = Buffer.from(`shellhouse-probe-${attempt}`)
    if (!pub.verify(probe, priv.sign(probe))) continue
    return { privateKey: pair.private, publicKey: pair.public.trim(), attempts: attempt }
  }
  throw new Error(t('Could not generate a valid key after several attempts'))
}

/** Public key một dòng hợp lệ (dùng trước khi triển khai lên server). */
export function isValidPublicKeyLine(line: string): boolean {
  if (
    !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/]+={0,3}( [^\r\n]{0,200})?$/.test(
      line
    )
  ) {
    return false
  }
  const parsed: ParsedKey | Error = utils.parseKey(line)
  return !(parsed instanceof Error) && !parsed.isPrivateKey()
}
