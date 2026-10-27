import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { updatePayload } from '../../src/node-shared/update-signature'
import { tempDir } from './helpers'

const VERSION = '1.2.0-beta.35'
const SCRIPT = pathToFileURL(resolve('scripts/verify-release-artifacts.mjs')).href
const RUN = `import { verifyReleaseArtifacts } from ${JSON.stringify(SCRIPT)}; await verifyReleaseArtifacts(process.argv[1], process.argv[2], [process.argv[3]])`

function fixture() {
  const dir = tempDir()
  const keys = generateKeyPairSync('ed25519')
  const installers = [
    `Shellhouse-${VERSION}.AppImage`,
    `shellhouse_${VERSION}_amd64.deb`,
    `shellhouse-${VERSION}.x86_64.rpm`,
    `Shellhouse-Setup-${VERSION}.exe`,
    `Shellhouse-${VERSION}-win.zip`,
    `Shellhouse-${VERSION}-arm64.dmg`,
    `Shellhouse-${VERSION}-arm64-mac.zip`,
    `Shellhouse-${VERSION}.dmg`,
    `Shellhouse-${VERSION}-mac.zip`
  ]
  const data = new Map(installers.map((name) => [name, Buffer.from(`test installer: ${name}`)]))
  const bytesOf = (name: string): Buffer => {
    const bytes = data.get(name)
    if (!bytes) throw new Error(name)
    return bytes
  }
  const digest = (name: string): string =>
    createHash('sha512').update(bytesOf(name)).digest('base64')
  for (const [name, bytes] of data) {
    writeFileSync(join(dir, name), bytes)
    if (/\.(dmg|exe)$|-mac\.zip$/.test(name))
      writeFileSync(join(dir, `${name}.blockmap`), 'blockmap')
  }
  writeFileSync(
    join(dir, 'SHA256SUMS.txt'),
    installers
      .map((name) => {
        const hash = createHash('sha256').update(bytesOf(name)).digest('hex')
        return name.endsWith('.exe') || name.endsWith('-win.zip')
          ? `${hash} *./${name}\n`
          : `${hash}  ${name}\n`
      })
      .join('')
  )
  const channels: Record<string, string[]> = {
    'latest-linux.yml': installers.slice(0, 3),
    'latest.yml': installers.slice(3, 4),
    'latest-mac.yml': installers.slice(5)
  }
  for (const [channel, names] of Object.entries(channels)) {
    const first = names[0]
    if (!first) throw new Error(channel)
    const files = names.map((name) => ({ url: name, sha512: digest(name) }))
    let text =
      `version: ${VERSION}\nfiles:\n` +
      names
        .map(
          (name) =>
            `  - url: '${name}'\n    sha512: ${digest(name)}\n    size: ${bytesOf(name).length}\n`
        )
        .join('') +
      `path: ${first}\nsha512: ${digest(first)}\n`
    if (channel === 'latest-linux.yml')
      text += `shellhouseSignature: ${sign(null, updatePayload(VERSION, files), keys.privateKey).toString('base64')}\n`
    writeFileSync(join(dir, channel), text)
  }
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const verify = (): void => {
    execFileSync(process.execPath, ['--input-type=module', '-e', RUN, dir, VERSION, publicKey], {
      stdio: 'pipe'
    })
  }
  return { dir, verify }
}

describe('release artifacts gate', () => {
  it('accepts all 18 files with valid mixed Windows/POSIX checksums and signed metadata', () => {
    expect(fixture().verify).not.toThrow()
  })
  it('rejects a release missing the Apple Silicon installer', () => {
    const { dir, verify } = fixture()
    unlinkSync(join(dir, `Shellhouse-${VERSION}-arm64.dmg`))
    expect(verify).toThrow(/ENOENT.*arm64\.dmg/)
  })
  it('rejects a changed Windows archive', () => {
    const { dir, verify } = fixture()
    writeFileSync(join(dir, `Shellhouse-${VERSION}-win.zip`), 'corrupted')
    expect(verify).toThrow(/SHA256 mismatch/)
  })
  it('rejects metadata copied from another version', () => {
    const { dir, verify } = fixture()
    const path = join(dir, 'latest-mac.yml')
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace(`version: ${VERSION}`, 'version: 1.2.0-beta.33')
    )
    expect(verify).toThrow(/Wrong version/)
  })
  it('rejects an invalid Linux update signature', () => {
    const { dir, verify } = fixture()
    const path = join(dir, 'latest-linux.yml')
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace(
        /^shellhouseSignature:.*$/m,
        `shellhouseSignature: ${Buffer.alloc(64).toString('base64')}`
      )
    )
    expect(verify).toThrow(/Invalid Linux update signature/)
  })
  it('rejects a wrong update hash even when installer checksums match', () => {
    const { dir, verify } = fixture()
    const path = join(dir, 'latest.yml')
    writeFileSync(path, readFileSync(path, 'utf8').replace(/sha512: .+/, 'sha512: wrong'))
    expect(verify).toThrow(/SHA512 mismatch/)
  })
})
