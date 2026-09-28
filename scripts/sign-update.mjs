// Ký file kênh cập nhật Linux bằng ed25519 (ADR-0008).
//
//   node scripts/sign-update.mjs --generate            # in cặp khoá mới (PEM)
//   SHELLHOUSE_UPDATE_SIGNING_KEY="$(cat key.pem)" node scripts/sign-update.mjs dist/latest-linux.yml
//
// Nội dung được ký phải khớp từng byte với updatePayload() trong src/node-shared/update-signature.ts.
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

if (process.argv[2] === '--generate') {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  process.stdout.write(privateKey.export({ type: 'pkcs8', format: 'pem' }))
  process.stdout.write(publicKey.export({ type: 'spki', format: 'pem' }))
  process.exit(0)
}

const file = process.argv[2]
const pem = process.env.SHELLHOUSE_UPDATE_SIGNING_KEY
if (!file || !pem) {
  console.error(
    'usage: SHELLHOUSE_UPDATE_SIGNING_KEY=<pem> node scripts/sign-update.mjs <channel.yml>'
  )
  process.exit(2)
}

const unquote = (s) => s.trim().replace(/^(['"])(.*)\1$/, '$2')
const original = readFileSync(file, 'utf8').replace(/^shellhouseSignature:.*\n?/m, '')
const version = unquote(/^version:(.*)$/m.exec(original)?.[1] ?? '')
const files = [...original.matchAll(/^\s*- url:(.*)\n\s+sha512:(.*)$/gm)].map((m) => ({
  url: unquote(m[1]),
  sha512: unquote(m[2])
}))
if (!version || files.length === 0) {
  console.error(`${file}: no version or files found`)
  process.exit(1)
}
const lines = files
  .sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0))
  .map((f) => `${f.url} ${f.sha512}\n`)
const payload = Buffer.from(`shellhouse-update-v1\n${version}\n${lines.join('')}`, 'utf8')
const signature = sign(null, payload, createPrivateKey(pem)).toString('base64')
const body = original.endsWith('\n') ? original : `${original}\n`
writeFileSync(file, `${body}shellhouseSignature: ${signature}\n`)
console.log(`signed ${file} (version ${version}, ${files.length} file(s))`)
