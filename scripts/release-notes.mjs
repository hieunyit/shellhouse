// In phần CHANGELOG.md của một phiên bản (dùng làm nội dung GitHub Release).
// Chạy: node scripts/release-notes.mjs 0.2.0
import { readFileSync } from 'node:fs'

const version = process.argv[2]
const changelog = readFileSync('CHANGELOG.md', 'utf8')
const escaped = (version ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const section = new RegExp(
  `^## \\[?${escaped}\\]?.*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`,
  'm'
).exec(changelog)
if (!version || !section?.[1]?.trim()) {
  console.error(`CHANGELOG.md has no section for ${version}`)
  process.exit(1)
}
process.stdout.write(`${section[1].trim()}\n`)
