import { createHash } from 'node:crypto'

/**
 * Tiện ích cho SSH public key dạng blob (định dạng wire của SSH):
 * string keyType, rồi các trường phụ thuộc loại key.
 */

function readString(blob: Buffer, offset: number): { value: Buffer; next: number } {
  if (offset + 4 > blob.length) throw new Error('Truncated key blob')
  const len = blob.readUInt32BE(offset)
  const start = offset + 4
  if (start + len > blob.length) throw new Error('Truncated key blob')
  return { value: blob.subarray(start, start + len), next: start + len }
}

export function keyTypeOf(blob: Buffer): string {
  return readString(blob, 0).value.toString('ascii')
}

/** "SHA256:<base64 không padding>" như `ssh-keygen -l`. */
export function fingerprintSha256(blob: Buffer): string {
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`
}

function mpintBits(value: Buffer): number {
  let i = 0
  while (i < value.length && value[i] === 0) i++
  if (i === value.length) return 0
  const first = value[i] ?? 0
  return (value.length - i - 1) * 8 + (32 - Math.clz32(first))
}

/** Tên và độ dài key như OpenSSH hiển thị trong randomart: [ED25519 256], [RSA 3072]... */
export function keyLabel(blob: Buffer): { name: string; bits: number } {
  const type = keyTypeOf(blob)
  if (type === 'ssh-ed25519') return { name: 'ED25519', bits: 256 }
  if (type.startsWith('ecdsa-sha2-nistp')) {
    return { name: 'ECDSA', bits: Number(type.slice('ecdsa-sha2-nistp'.length)) }
  }
  if (type === 'ssh-rsa') {
    const e = readString(blob, readString(blob, 0).next)
    const n = readString(blob, e.next)
    return { name: 'RSA', bits: mpintBits(n.value) }
  }
  if (type === 'ssh-dss') return { name: 'DSA', bits: 1024 }
  return { name: type.toUpperCase(), bits: 0 }
}

const FLD_X = 17
const FLD_Y = 9
const AUGMENT = ' .o+=*BOX@%&#/^SE'

/** "Drunken bishop" — cùng thuật toán `fingerprint_randomart` của OpenSSH (sshkey.c). */
export function randomart(blob: Buffer): string {
  const digest = createHash('sha256').update(blob).digest()
  const len = AUGMENT.length - 1
  const field = Array.from({ length: FLD_X }, () => new Array<number>(FLD_Y).fill(0))
  let x = Math.floor(FLD_X / 2)
  let y = Math.floor(FLD_Y / 2)

  for (const byte of digest) {
    let input = byte
    for (let b = 0; b < 4; b++) {
      x += input & 1 ? 1 : -1
      y += input & 2 ? 1 : -1
      x = Math.min(Math.max(x, 0), FLD_X - 1)
      y = Math.min(Math.max(y, 0), FLD_Y - 1)
      const col = field[x] as number[]
      if ((col[y] ?? 0) < len - 2) col[y] = (col[y] ?? 0) + 1
      input >>= 2
    }
  }
  ;(field[Math.floor(FLD_X / 2)] as number[])[Math.floor(FLD_Y / 2)] = len - 1
  ;(field[x] as number[])[y] = len

  const { name, bits } = keyLabel(blob)
  let title = `[${name} ${bits}]`
  if (title.length > FLD_X + 1) title = `[${name}]`
  const hash = '[SHA256]'

  const border = (label: string): string => {
    const left = Math.floor((FLD_X - label.length) / 2)
    return `+${'-'.repeat(left)}${label}${'-'.repeat(FLD_X - left - label.length)}+`
  }

  const lines = [border(title)]
  for (let row = 0; row < FLD_Y; row++) {
    let line = '|'
    for (let col = 0; col < FLD_X; col++) {
      line += AUGMENT[Math.min((field[col] as number[])[row] ?? 0, len)] ?? ' '
    }
    lines.push(`${line}|`)
  }
  lines.push(border(hash))
  return lines.join('\n')
}
