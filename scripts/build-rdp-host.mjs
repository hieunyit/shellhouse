// Build tiến trình phụ Remote Desktop cho Windows (native/rdp-host-win → bin/shellhouse-rdp-host.exe).
//
// Dùng csc.exe của .NET Framework 4.x — có sẵn trên mọi Windows 10 / 11 và runner windows-latest: không
// cần Visual Studio, Windows SDK, NuGet hay runtime đi kèm. Mã viết theo C# 5 (giới hạn của csc này).
// Nền tảng khác: bỏ qua (không lỗi) — macOS / Linux dùng IronRDP.
//
//   node scripts/build-rdp-host.mjs            build (Windows), bỏ qua nơi khác
//   node scripts/build-rdp-host.mjs --require  lỗi nếu không build được (CI Windows)
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const project = join(root, 'native', 'rdp-host-win')
const out = join(project, 'bin', 'shellhouse-rdp-host.exe')
const required = process.argv.includes('--require')

function done(message, code = 0) {
  process.stdout.write(`${message}\n`)
  process.exit(code)
}

if (process.platform !== 'win32') done('rdp-host: skipped (Windows only)')

const windir = process.env['WINDIR'] ?? process.env['SystemRoot'] ?? 'C:\\Windows'
const csc = [
  join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
].find((p) => existsSync(p))
if (!csc) done('rdp-host: csc.exe of .NET Framework 4.x not found', required ? 1 : 0)

const sources = readdirSync(join(project, 'src'))
  .filter((f) => f.endsWith('.cs'))
  .sort()
  .map((f) => join(project, 'src', f))

mkdirSync(dirname(out), { recursive: true })
const args = [
  '/nologo',
  '/target:winexe',
  // Chỉ phát hành Windows x64; mstscax.dll trong System32 là bản 64-bit.
  '/platform:x64',
  '/optimize+',
  '/warn:4',
  '/codepage:65001',
  '/utf8output',
  `/win32manifest:${join(project, 'app.manifest')}`,
  `/out:${out}`,
  '/r:System.dll',
  '/r:System.Drawing.dll',
  '/r:System.Windows.Forms.dll',
  '/r:System.Web.Extensions.dll',
  ...sources
]
try {
  execFileSync(csc, args, { stdio: 'inherit' })
} catch {
  done('rdp-host: build failed', 1)
}
done(`rdp-host: built ${out}`)
