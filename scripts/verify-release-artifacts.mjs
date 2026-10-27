// Refuse an incomplete release: Windows x64, Linux x64 and both macOS architectures.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream, lstatSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { UPDATE_PUBLIC_KEYS } from '../src/main/update-keys.ts'
import { verifyUpdateSignature } from '../src/node-shared/update-signature.ts'

export function releaseInstallers(version) {
  assert(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version), 'Invalid release version')
  return [
    `Shellhouse-${version}.AppImage`,
    `shellhouse_${version}_amd64.deb`,
    `shellhouse-${version}.x86_64.rpm`,
    `Shellhouse-Setup-${version}.exe`,
    `Shellhouse-${version}-win.zip`,
    `Shellhouse-${version}-arm64.dmg`,
    `Shellhouse-${version}-arm64-mac.zip`,
    `Shellhouse-${version}.dmg`,
    `Shellhouse-${version}-mac.zip`
  ]
}

export function releaseAssets(version) {
  const installers = releaseInstallers(version)
  const blocks = installers.filter((name) => /\.(dmg|exe)$|-mac\.zip$/.test(name))
  return [
    ...installers,
    ...blocks.map((name) => `${name}.blockmap`),
    'latest-linux.yml',
    'latest-mac.yml',
    'latest.yml',
    'SHA256SUMS.txt'
  ]
}

const unquote = (value) => value.trim().replace(/^(['"])(.*)\1$/, '$2')

export async function verifyReleaseArtifacts(dir, version, publicKeys = UPDATE_PUBLIC_KEYS) {
  const expected = releaseAssets(version)
  for (const name of expected) {
    const info = lstatSync(join(dir, name))
    assert(info.isFile() && info.size > 0, `Missing or empty release file: ${name}`)
  }
  const hashes = new Map()
  for (const name of releaseInstallers(version)) {
    const sha256 = createHash('sha256'),
      sha512 = createHash('sha512')
    for await (const chunk of createReadStream(join(dir, name))) {
      sha256.update(chunk)
      sha512.update(chunk)
    }
    hashes.set(name, { sha256: sha256.digest('hex'), sha512: sha512.digest('base64') })
  }
  const checksums = new Map()
  for (const line of readFileSync(join(dir, 'SHA256SUMS.txt'), 'utf8').trim().split(/\r?\n/)) {
    const match = /^([\da-f]{64}) [ *](.+)$/i.exec(line)
    assert(match, `Invalid checksum line: ${line}`)
    const name = match[2].replace(/^\.\//, '')
    assert(!checksums.has(name), `Duplicate checksum: ${name}`)
    checksums.set(name, match[1].toLowerCase())
  }
  assert.equal(checksums.size, hashes.size, 'Expected checksums for all nine installers')
  for (const [name, hash] of hashes)
    assert.equal(checksums.get(name), hash.sha256, `SHA256 mismatch: ${name}`)

  const channels = {
    'latest-linux.yml': [...hashes.keys()].filter((name) => /\.(AppImage|deb|rpm)$/.test(name)),
    'latest-mac.yml': [...hashes.keys()].filter((name) => /\.dmg$|-mac\.zip$/.test(name)),
    'latest.yml': [...hashes.keys()].filter((name) => name.endsWith('.exe'))
  }
  for (const [channel, required] of Object.entries(channels)) {
    const text = readFileSync(join(dir, channel), 'utf8')
    assert.equal(
      unquote(/^version:(.*)$/m.exec(text)?.[1] ?? ''),
      version,
      `Wrong version: ${channel}`
    )
    const files = [
      ...text.matchAll(/^\s*- url:(.*)\r?\n\s+sha512:(.*)\r?\n\s+size:\s*(\d+)/gm)
    ].map((m) => ({ url: unquote(m[1]), sha512: unquote(m[2]), size: Number(m[3]) }))
    assert.equal(new Set(files.map((f) => f.url)).size, files.length, `Duplicate files: ${channel}`)
    for (const name of required)
      assert(
        files.some((f) => f.url === name),
        `Missing from ${channel}: ${name}`
      )
    for (const file of files) {
      assert(hashes.has(file.url), `Unknown release file: ${file.url}`)
      assert.equal(file.sha512, hashes.get(file.url).sha512, `SHA512 mismatch: ${file.url}`)
      assert.equal(file.size, lstatSync(join(dir, file.url)).size, `Wrong size: ${file.url}`)
    }
    const defaultPath = unquote(/^path:(.*)$/m.exec(text)?.[1] ?? '')
    assert(
      files.some((file) => file.url === defaultPath),
      `Invalid default path: ${channel}`
    )
    assert.equal(
      unquote(/^sha512:(.*)$/m.exec(text)?.[1] ?? ''),
      hashes.get(defaultPath).sha512,
      `Wrong default hash: ${channel}`
    )
    if (channel === 'latest-linux.yml') {
      const signature = unquote(/^shellhouseSignature:(.*)$/m.exec(text)?.[1] ?? '')
      assert(
        verifyUpdateSignature(version, files, signature, publicKeys),
        'Invalid Linux update signature'
      )
    }
  }
  return expected
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  verifyReleaseArtifacts(process.argv[2] ?? 'dist', process.argv[3] ?? '').then(
    (files) =>
      console.log(
        `Verified ${files.length} release files: nine installers, blockmaps, checksums and signed update metadata.`
      ),
    (error) => {
      console.error(error.message)
      process.exitCode = 1
    }
  )
}
