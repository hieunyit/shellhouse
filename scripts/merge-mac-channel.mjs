// Gộp latest-mac-<arch>.yml của các job macOS thành một latest-mac.yml (liệt kê mọi file,
// electron-updater tự chọn theo arch của máy). Chạy: node scripts/merge-mac-channel.mjs <dir>
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] ?? 'dist'
// latest-mac-macos-arm64.yml, beta-mac-macos-x64.yml… → gộp theo kênh (latest / beta).
const byChannel = new Map()
for (const f of readdirSync(dir).sort()) {
  const m = /^(.+)-mac-(.+)\.yml$/.exec(f)
  if (m) byChannel.set(m[1], [...(byChannel.get(m[1]) ?? []), f])
}
if (byChannel.size === 0) {
  console.log('no per-arch macOS channel files, nothing to merge')
  process.exit(0)
}

/** Tách file kênh electron-builder (định dạng cố định) thành các phần cần thiết. */
function parse(text) {
  const field = (key) => new RegExp(`^${key}:(.*)$`, 'm').exec(text)?.[1]?.trim()
  const filesBlock = /^files:\n((?:[ ]+.*\n)+)/m.exec(text)?.[1] ?? ''
  return {
    version: field('version'),
    path: field('path'),
    sha512: field('sha512'),
    releaseDate: field('releaseDate'),
    files: filesBlock
  }
}

for (const [channel, parts] of byChannel) {
  // Sắp theo tên: macos-arm64 trước macos-x64 → path/sha512 mặc định trỏ bản arm64.
  const parsed = parts.map((f) => parse(readFileSync(join(dir, f), 'utf8')))
  const versions = new Set(parsed.map((p) => p.version))
  if (versions.size !== 1 || !parsed[0]?.version) {
    console.error(`version mismatch between macOS builds: ${[...versions].join(', ')}`)
    process.exit(1)
  }
  const [first] = parsed
  const merged =
    `version: ${first.version}\n` +
    `files:\n${parsed.map((p) => p.files).join('')}` +
    `path: ${first.path}\n` +
    `sha512: ${first.sha512}\n` +
    `releaseDate: ${first.releaseDate}\n`
  writeFileSync(join(dir, `${channel}-mac.yml`), merged)
  for (const f of parts) rmSync(join(dir, f))
  console.log(`merged ${parts.join(', ')} → ${channel}-mac.yml`)
}
