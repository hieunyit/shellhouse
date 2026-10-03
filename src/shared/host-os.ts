import { z } from 'zod'

/**
 * Nhận diện hệ điều hành của server SSH (hiện icon distro trên host): đọc /etc/os-release qua một
 * kênh exec riêng ngay sau khi kết nối; không có thì `uname` (macOS, BSD); Windows OpenSSH nhận
 * theo chuỗi phiên bản của server + `ver`. Chỉ import zod — dùng chung cho main, Session Host,
 * renderer và test.
 */

export const OS_IDS = [
  'ubuntu',
  'debian',
  'rhel',
  'centos',
  'rocky',
  'almalinux',
  'fedora',
  'amazon',
  'suse',
  'opensuse',
  'arch',
  'alpine',
  'oracle',
  'kali',
  'raspbian',
  'freebsd',
  'macos',
  'windows',
  'linux',
  'unix'
] as const
export const OsId = z.enum(OS_IDS)
export type OsId = z.infer<typeof OsId>

export const HostOs = z.object({
  id: OsId,
  /** Tên hiển thị (NAME của os-release: "Ubuntu", "Debian GNU/Linux"…). */
  name: z.string().min(1).max(100),
  /** VERSION (hoặc VERSION_ID) — null với distro rolling (Arch…). */
  version: z.string().max(100).nullable()
})
export type HostOs = z.infer<typeof HostOs>

/** Dấu phân cách giữa os-release và phần `uname` trong output lệnh dò. */
export const OS_UNAME_MARKER = '--SHELLHOUSE-UNAME--'
const RPI_MARKER = '--SHELLHOUSE-RPI--'

/**
 * Lệnh dò (chạy bằng `sh -c '…'`, không có dấu nháy đơn): không cần quyền, không hỏi gì, xong ngay.
 * /etc/rpi-issue: Raspberry Pi OS 64-bit báo ID=debian trong os-release.
 */
export const OS_DETECT_SCRIPT = [
  'cat /etc/os-release 2>/dev/null || cat /usr/lib/os-release 2>/dev/null',
  `test -f /etc/rpi-issue && echo ${RPI_MARKER}`,
  `echo ${OS_UNAME_MARKER}`,
  'uname -sr 2>/dev/null',
  'sw_vers -productVersion 2>/dev/null',
  'true'
].join('; ')

/** Bóc giá trị os-release: "…" / '…' (có \" \\ \$ \`), hoặc không nháy. */
function unquote(raw: string): string {
  const v = raw.trim()
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"'))
    return v.slice(1, -1).replace(/\\([\\"$`])/g, '$1')
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1)
  return v
}

/** /etc/os-release → bảng KEY → value (bỏ dòng chú thích / sai cú pháp). */
export function parseOsRelease(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line)
    if (!m?.[1] || m[2] === undefined) continue
    out[m[1]] = unquote(m[2])
  }
  return out
}

/** Một ID (của ID hoặc ID_LIKE) → icon. */
function idToOs(id: string): OsId | null {
  const v = id.toLowerCase()
  if (v === 'ubuntu') return 'ubuntu'
  if (v === 'debian') return 'debian'
  if (v === 'raspbian') return 'raspbian'
  if (v === 'rhel' || v === 'redhat') return 'rhel'
  if (v === 'centos') return 'centos'
  if (v === 'rocky') return 'rocky'
  if (v === 'almalinux') return 'almalinux'
  if (v === 'fedora') return 'fedora'
  if (v === 'amzn') return 'amazon'
  if (v === 'sles' || v === 'sled' || v === 'sles_sap' || v === 'suse') return 'suse'
  if (v === 'opensuse' || v.startsWith('opensuse-')) return 'opensuse'
  if (v === 'arch' || v === 'archarm') return 'arch'
  if (v === 'alpine') return 'alpine'
  if (v === 'ol') return 'oracle'
  if (v === 'kali') return 'kali'
  if (v === 'freebsd') return 'freebsd'
  return null
}

/**
 * Bảng os-release → icon: ID trước, rồi tới ID_LIKE theo thứ tự (Linux Mint → ubuntu, Manjaro →
 * arch…), cuối cùng là Linux chung.
 */
export function osIdFromRelease(release: Record<string, string>): OsId {
  const direct = idToOs(release['ID'] ?? '')
  if (direct) return direct
  for (const like of (release['ID_LIKE'] ?? '').split(/\s+/)) {
    const found = like ? idToOs(like) : null
    // ID_LIKE="rhel centos fedora" (Rocky cũ / clone): họ RHEL.
    if (found) return found
  }
  const name = (release['NAME'] ?? '').toLowerCase()
  if (name.includes('red hat')) return 'rhel'
  if (name.includes('freebsd')) return 'freebsd'
  return 'linux'
}

/** Bảng os-release → HostOs (null = không có gì dùng được). */
export function osFromRelease(release: Record<string, string>): HostOs | null {
  if (!release['ID'] && !release['NAME']) return null
  const id = osIdFromRelease(release)
  const name = (release['NAME'] || release['PRETTY_NAME'] || release['ID'] || 'Linux').slice(0, 100)
  const version = (release['VERSION'] || release['VERSION_ID'] || '').slice(0, 100) || null
  return { id, name, version }
}

/** `uname -sr` (+ `sw_vers -productVersion` trên macOS) → HostOs. */
export function osFromUname(uname: string, productVersion?: string): HostOs | null {
  const m = /^(\S+)(?:\s+(\S+))?/.exec(uname.trim())
  if (!m?.[1]) return null
  const [, system, release] = m
  const sys = system.toLowerCase()
  if (sys === 'darwin')
    return { id: 'macos', name: 'macOS', version: productVersion?.trim() || null }
  if (sys === 'freebsd') return { id: 'freebsd', name: 'FreeBSD', version: release ?? null }
  if (sys === 'linux') return { id: 'linux', name: 'Linux', version: release ?? null }
  if (/^(cygwin|mingw|msys)/.test(sys)) return { id: 'windows', name: 'Windows', version: null }
  if (/^(openbsd|netbsd|dragonfly|sunos|aix|hp-ux)$/.test(sys))
    return { id: 'unix', name: system, version: release ?? null }
  return null
}

/** Output của OS_DETECT_SCRIPT → HostOs (null = không nhận ra — giữ thông tin cũ). */
export function osFromDetectOutput(output: string): HostOs | null {
  const at = output.indexOf(OS_UNAME_MARKER)
  const releasePart = at >= 0 ? output.slice(0, at) : output
  const unamePart = at >= 0 ? output.slice(at + OS_UNAME_MARKER.length) : ''
  const rpi = releasePart.includes(RPI_MARKER)
  const fromRelease = osFromRelease(parseOsRelease(releasePart))
  if (fromRelease) {
    // Raspberry Pi OS 64-bit: os-release y như Debian.
    if (rpi && fromRelease.id === 'debian')
      return { ...fromRelease, id: 'raspbian', name: 'Raspberry Pi OS' }
    return fromRelease
  }
  const [uname = '', product] = unamePart
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  return osFromUname(uname, product)
}

/** Chuỗi phiên bản phần mềm của server SSH ("OpenSSH_for_Windows_8.1") có phải Windows không. */
export function isWindowsSshServer(software: string | undefined): boolean {
  return !!software && /windows/i.test(software)
}

/** Output `cmd /c ver` ("Microsoft Windows [Version 10.0.20348.2340]") → HostOs. */
export function osFromWindowsVer(output: string): HostOs {
  // Bản Windows tiếng khác: "[Versión 10.0…]", "[版本 10.0…]" → lấy dãy số trong ngoặc vuông.
  const m = /\[[^\]\d]*([\d.]+)\]/.exec(output) ?? /(\d+\.\d+\.\d+)/.exec(output)
  return { id: 'windows', name: 'Windows', version: m?.[1] ?? null }
}

/** Hai kết quả có khác nhau không (chỉ ghi DB / báo renderer khi đổi). */
export function sameOs(a: HostOs | null | undefined, b: HostOs | null | undefined): boolean {
  if (!a || !b) return !a && !b
  return a.id === b.id && a.name === b.name && a.version === b.version
}

/** "Ubuntu 22.04.4 LTS (Jammy Jellyfish)" — chú thích của icon. */
export function osTitle(os: HostOs): string {
  return os.version ? `${os.name} ${os.version}` : os.name
}
