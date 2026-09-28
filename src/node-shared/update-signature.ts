import { createPublicKey, verify } from 'node:crypto'

/**
 * Chữ ký ed25519 cho file kênh cập nhật Linux (latest-linux.yml) — ADR-0008.
 *
 * electron-updater chỉ kiểm tra sha512 của file tải về so với file kênh; file kênh lại chỉ được bảo
 * vệ bằng HTTPS. CI ký (version + url + sha512 của từng file) bằng khoá riêng, ghi chữ ký vào trường
 * `shellhouseSignature` của file kênh; app xác minh bằng public key nhúng sẵn trước khi tải.
 * Nội dung được ký phải khớp từng byte với scripts/sign-update.mjs.
 */

export interface SignedFile {
  url: string
  sha512: string
}

export function updatePayload(version: string, files: readonly SignedFile[]): Buffer {
  const lines = [...files]
    .sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0))
    .map((f) => `${f.url} ${f.sha512}\n`)
  return Buffer.from(`shellhouse-update-v1\n${version}\n${lines.join('')}`, 'utf8')
}

/** true nếu chữ ký hợp lệ với ít nhất một public key (cho phép xoay vòng khoá). */
export function verifyUpdateSignature(
  version: string,
  files: readonly SignedFile[],
  signatureBase64: unknown,
  publicKeysPem: readonly string[]
): boolean {
  if (typeof signatureBase64 !== 'string' || files.length === 0) return false
  const signature = Buffer.from(signatureBase64, 'base64')
  if (signature.length !== 64) return false
  const payload = updatePayload(version, files)
  return publicKeysPem.some((pem) => {
    try {
      const key = createPublicKey(pem)
      if (key.asymmetricKeyType !== 'ed25519') return false
      return verify(null, payload, key, signature)
    } catch {
      return false
    }
  })
}
