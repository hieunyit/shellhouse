import { createReadStream, createWriteStream, existsSync, type WriteStream } from 'node:fs'
import { lstat, mkdir, readdir, utimes } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { t } from '@shared/i18n'
import { hostNameOptions, numberedName, safeFileName, UniqueNames } from '@shared/file-names'
import type { ContainerFileEntry, CopyResult } from '../shared/ops'

/**
 * Tar tối giản cho copy file vào / ra container (Engine API `/containers/{id}/archive`, `docker cp`).
 * Đọc: ustar + PAX (Docker / Go archive/tar) + tên dài kiểu GNU. Ghi: ustar, tên dài / file lớn
 * dùng PAX. Không phụ thuộc thư viện ngoài.
 */

const BLOCK = 512

export interface TarEntry {
  /** Đường dẫn tương đối, phân cách "/", không có "./" đầu hay "/" cuối. */
  path: string
  type: 'file' | 'dir' | 'symlink' | 'hardlink' | 'other'
  size: number
  mode: number
  /** ms */
  mtime: number
  linkname: string
}

export interface TarHandler {
  /** Bắt đầu một mục; dữ liệu của file (nếu có) tới qua `data`, rồi `end`. */
  entry(e: TarEntry): Promise<void> | void
  data?(chunk: Buffer): Promise<void> | void
  end?(): Promise<void> | void
}

function cstring(buf: Buffer, start: number, length: number): string {
  const slice = buf.subarray(start, start + length)
  const nul = slice.indexOf(0)
  return (nul >= 0 ? slice.subarray(0, nul) : slice).toString('utf8')
}

/** Số trong header: bát phân (có thể có khoảng trắng / NUL) hoặc base-256 (bit cao của byte đầu). */
function number(buf: Buffer, start: number, length: number): number {
  const first = buf[start] ?? 0
  if (first & 0x80) {
    let n = first & 0x7f
    for (let i = 1; i < length; i++) n = n * 256 + (buf[start + i] ?? 0)
    return n
  }
  const text = cstring(buf, start, length).trim()
  return text ? parseInt(text, 8) || 0 : 0
}

/** "path=..." của PAX: "<độ dài> <khoá>=<giá trị>\n" lặp lại. */
export function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  let pos = 0
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos)
    if (space < 0) break
    const len = parseInt(data.subarray(pos, space).toString('ascii'), 10)
    if (!Number.isFinite(len) || len <= 0) break
    const record = data.subarray(space + 1, pos + len - 1).toString('utf8')
    const eq = record.indexOf('=')
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1)
    pos += len
  }
  return out
}

export function normalizeTarPath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p !== '' && p !== '.')
    .join('/')
}

const isZero = (block: Buffer): boolean => block.every((b) => b === 0)

/**
 * Đọc tar theo luồng, gọi `handler` lần lượt (đợi từng lời gọi → ghi đĩa chậm thì đọc chậm theo).
 * Trả số byte đã đọc. `stopAfter` byte → dừng sớm (trả `truncated`).
 */
export async function parseTar(
  source: AsyncIterable<Buffer>,
  handler: TarHandler,
  options: { stopAfter?: number } = {}
): Promise<{ bytes: number; truncated: boolean }> {
  let buf: Buffer = Buffer.alloc(0)
  let bytes = 0
  let state: 'header' | 'data' | 'meta' | 'pad' = 'header'
  let remaining = 0
  let pad = 0
  let metaKind = ''
  let metaChunks: Buffer[] = []
  let pax: Record<string, string> = {}
  let longName: string | null = null
  let longLink: string | null = null
  let inFile = false

  const startData = (size: number): void => {
    remaining = size
    pad = (BLOCK - (size % BLOCK)) % BLOCK
  }

  for await (const chunk of source) {
    bytes += chunk.length
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk])
    for (;;) {
      if (state === 'header') {
        if (buf.length < BLOCK) break
        const h = buf.subarray(0, BLOCK)
        buf = buf.subarray(BLOCK)
        if (isZero(h)) continue
        const flag = String.fromCharCode(h[156] ?? 0)
        const size = number(h, 124, 12)
        if (flag === 'x' || flag === 'g' || flag === 'L' || flag === 'K') {
          metaKind = flag
          metaChunks = []
          startData(size)
          state = size > 0 ? 'meta' : 'header'
          continue
        }
        const magic = h.subarray(257, 263).toString('latin1')
        const prefix = magic === 'ustar\0' ? cstring(h, 345, 155) : ''
        const rawName = cstring(h, 0, 100)
        const name = pax['path'] ?? longName ?? (prefix ? `${prefix}/${rawName}` : rawName)
        const type: TarEntry['type'] =
          flag === '0' || flag === '\0' || flag === '7'
            ? 'file'
            : flag === '5'
              ? 'dir'
              : flag === '2'
                ? 'symlink'
                : flag === '1'
                  ? 'hardlink'
                  : 'other'
        const realSize = pax['size'] !== undefined ? Number(pax['size']) || 0 : size
        const entry: TarEntry = {
          path: normalizeTarPath(name),
          type: type === 'file' && name.endsWith('/') ? 'dir' : type,
          size: realSize,
          mode: number(h, 100, 8),
          mtime:
            (pax['mtime'] !== undefined ? Number(pax['mtime']) : number(h, 136, 12)) * 1000 || 0,
          linkname: pax['linkpath'] ?? longLink ?? cstring(h, 157, 100)
        }
        pax = {}
        longName = null
        longLink = null
        await handler.entry(entry)
        // Chỉ file thường mang dữ liệu (symlink / thư mục có size 0).
        const dataSize = type === 'file' ? realSize : type === 'other' ? realSize : 0
        if (dataSize > 0) {
          startData(dataSize)
          inFile = type === 'file'
          state = 'data'
        } else if (type === 'file') await handler.end?.()
        continue
      }
      if (state === 'meta' || state === 'data') {
        if (buf.length === 0) break
        const take = Math.min(remaining, buf.length)
        const part = buf.subarray(0, take)
        buf = buf.subarray(take)
        remaining -= take
        if (state === 'meta') metaChunks.push(part)
        else if (inFile) await handler.data?.(part)
        if (remaining > 0) break
        if (state === 'meta') {
          const data = Buffer.concat(metaChunks)
          if (metaKind === 'x') pax = parsePax(data)
          else if (metaKind === 'L') longName = cstring(data, 0, data.length)
          else if (metaKind === 'K') longLink = cstring(data, 0, data.length)
        } else if (inFile) {
          inFile = false
          await handler.end?.()
        }
        state = pad > 0 ? 'pad' : 'header'
        continue
      }
      // pad
      if (buf.length === 0) break
      const skip = Math.min(pad, buf.length)
      buf = buf.subarray(skip)
      pad -= skip
      if (pad > 0) break
      state = 'header'
    }
    if (options.stopAfter !== undefined && bytes >= options.stopAfter)
      return { bytes, truncated: true }
  }
  return { bytes, truncated: false }
}

// ——— Ghi ———

function writeOctal(h: Buffer, value: number, start: number, length: number): void {
  h.write(`${value.toString(8).padStart(length - 1, '0')}\0`, start, length, 'ascii')
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`
  let len = Buffer.byteLength(body) + 1
  while (String(len).length + Buffer.byteLength(body) !== len)
    len = String(len).length + Buffer.byteLength(body)
  return `${String(len)}${body}`
}

function rawHeader(
  name: string,
  type: string,
  size: number,
  mode: number,
  mtimeSec: number
): Buffer {
  const h = Buffer.alloc(BLOCK)
  h.write(name, 0, 100, 'utf8')
  writeOctal(h, mode & 0o7777, 100, 8)
  writeOctal(h, 0, 108, 8)
  writeOctal(h, 0, 116, 8)
  writeOctal(h, Math.min(size, 0o77777777777), 124, 12)
  writeOctal(h, Math.max(0, Math.floor(mtimeSec)), 136, 12)
  h.write('        ', 148, 8, 'ascii')
  h.write(type, 156, 1, 'ascii')
  h.write('ustar\0', 257, 6, 'latin1')
  h.write('00', 263, 2, 'ascii')
  let sum = 0
  for (const b of h) sum += b
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return h
}

/** Header cho một mục; tên dài (> 100 byte) / file ≥ 8 GB → thêm header PAX trước. */
export function tarHeader(entry: {
  path: string
  type: 'file' | 'dir'
  size: number
  mode: number
  mtime: number
}): Buffer {
  const name = entry.type === 'dir' ? `${entry.path}/` : entry.path
  const mtimeSec = entry.mtime / 1000
  const size = entry.type === 'dir' ? 0 : entry.size
  const records: string[] = []
  if (Buffer.byteLength(name) > 100) records.push(paxRecord('path', name))
  if (size > 0o77777777777) records.push(paxRecord('size', String(size)))
  const main = rawHeader(
    Buffer.byteLength(name) > 100 ? name.slice(0, 90) : name,
    entry.type === 'dir' ? '5' : '0',
    size,
    entry.mode,
    mtimeSec
  )
  if (records.length === 0) return main
  const body = Buffer.from(records.join(''), 'utf8')
  const padLen = (BLOCK - (body.length % BLOCK)) % BLOCK
  return Buffer.concat([
    rawHeader('PaxHeader', 'x', body.length, 0o644, mtimeSec),
    body,
    Buffer.alloc(padLen),
    main
  ])
}

/**
 * Đóng gói file / thư mục trên máy này thành tar (luồng). Liên kết tượng trưng và file đặc biệt bị
 * bỏ qua (đếm vào `skipped`). File đổi kích thước giữa lúc đọc thông tin và lúc đọc nội dung vẫn
 * ghi đúng số byte đã khai (cắt bớt / thêm 0).
 */
export async function* packPaths(
  localPaths: readonly string[],
  stats: { files: number; bytes: number; skipped: number }
): AsyncGenerator<Buffer> {
  const windows = process.platform === 'win32'
  async function* walk(full: string, rel: string): AsyncGenerator<Buffer> {
    const st = await lstat(full)
    if (st.isDirectory()) {
      yield tarHeader({
        path: rel,
        type: 'dir',
        size: 0,
        mode: windows ? 0o755 : st.mode,
        mtime: st.mtimeMs
      })
      const names = (await readdir(full)).sort()
      for (const name of names) yield* walk(join(full, name), `${rel}/${name}`)
      return
    }
    if (!st.isFile()) {
      stats.skipped++
      return
    }
    const size = st.size
    yield tarHeader({
      path: rel,
      type: 'file',
      size,
      mode: windows ? 0o644 : st.mode,
      mtime: st.mtimeMs
    })
    let written = 0
    if (size > 0) {
      for await (const chunk of createReadStream(full, {
        end: size - 1
      }) as AsyncIterable<Buffer>) {
        const part = chunk.length > size - written ? chunk.subarray(0, size - written) : chunk
        written += part.length
        yield part
        if (written >= size) break
      }
    }
    if (written < size) yield Buffer.alloc(size - written)
    const padLen = (BLOCK - (size % BLOCK)) % BLOCK
    if (padLen) yield Buffer.alloc(padLen)
    stats.files++
    stats.bytes += size
  }
  for (const path of localPaths) yield* walk(path, basename(path))
  yield Buffer.alloc(BLOCK * 2)
}

// ——— Giải nén an toàn ———

/** `target` nằm TRONG `root` (chặn "..", đường dẫn tuyệt đối). */
export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

const NAME_OPTIONS = hostNameOptions(process.platform)

/**
 * Tên trên máy này cho mục đầu tiên của tar (file / thư mục tải về): tên an toàn, không trùng thứ
 * đã có trong `dir` ("app.log" → "app (2).log").
 */
export function freeLocalName(dir: string, raw: string): string {
  const safe = safeFileName(raw, NAME_OPTIONS)
  let name = safe
  for (let n = 2; existsSync(join(dir, name)); n++) name = numberedName(safe, n)
  return name
}

function closeStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.end((error?: Error | null) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

/**
 * Giải nén tar từ container vào `root` trên máy này. Mọi thành phần đường dẫn qua `safeFileName`
 * (không ".." / ký tự cấm / tên thiết bị Windows), đường dẫn cuối phải nằm trong `root`. Không tạo
 * liên kết (symlink / hardlink bỏ qua). Mục đầu tiên đổi tên nếu đã có thứ cùng tên.
 */
export async function extractTar(
  source: AsyncIterable<Buffer>,
  root: string,
  result: CopyResult
): Promise<void> {
  const dirs = new Map<string, UniqueNames>()
  /** Mục đầu (tên gốc → tên trên máy): tải nhiều đường dẫn = nhiều mục đầu, không ghi đè nhau. */
  const tops = new Map<string, string>()
  let file: { stream: WriteStream; path: string; mtime: number } | null = null
  const localPath = (rel: string, isFile: boolean): string => {
    const parts = rel.split('/')
    const first = parts[0] ?? ''
    let topName = tops.get(first)
    if (topName === undefined) {
      topName = freeLocalName(root, first)
      tops.set(first, topName)
    }
    const out = [topName]
    let parent = first
    parts.slice(1).forEach((part, i) => {
      let names = dirs.get(parent)
      if (!names) {
        names = new UniqueNames(NAME_OPTIONS)
        dirs.set(parent, names)
      }
      out.push(names.name(`${isFile && i === parts.length - 2 ? 'f' : 'd'}:${part}`, part))
      parent += `/${part}`
    })
    const target = join(root, ...out)
    if (!isInside(root, target))
      throw new Error(t('Unsafe file name in the archive: {name}', { name: rel }))
    return target
  }
  await parseTar(source, {
    entry: async (e) => {
      if (!e.path) return
      if (e.type === 'dir') {
        await mkdir(localPath(e.path, false), { recursive: true })
        return
      }
      if (e.type !== 'file') {
        result.skipped++
        return
      }
      const target = localPath(e.path, true)
      await mkdir(join(target, '..'), { recursive: true })
      // "wx": không bao giờ ghi đè / đi theo liên kết có sẵn.
      file = {
        stream: createWriteStream(target, { flags: 'wx', mode: 0o644 }),
        path: target,
        mtime: e.mtime
      }
      await new Promise<void>((resolve, reject) => {
        file?.stream.once('open', () => {
          resolve()
        })
        file?.stream.once('error', reject)
      })
      if (result.saved.length < 1000) result.saved.push(target)
    },
    data: async (chunk) => {
      const f = file
      if (!f) return
      result.bytes += chunk.length
      if (!f.stream.write(chunk))
        await new Promise<void>((resolve, reject) => {
          f.stream.once('drain', resolve)
          f.stream.once('error', reject)
        })
    },
    end: async () => {
      const f = file
      file = null
      if (!f) return
      await closeStream(f.stream)
      result.files++
      if (f.mtime > 0) await utimes(f.path, f.mtime / 1000, f.mtime / 1000).catch(() => undefined)
    }
  }).finally(async () => {
    const f = file as { stream: WriteStream } | null
    if (f) await closeStream(f.stream).catch(() => undefined)
  })
}

/** Mục con trực tiếp của thư mục (đọc từ tar của chính thư mục đó). */
export async function listFromTar(
  source: AsyncIterable<Buffer>,
  stopAfter: number,
  /** Tar của "/" không có mục đầu (tên thư mục) — con trực tiếp là mục một đoạn. */
  isRoot = false
): Promise<{ entries: ContainerFileEntry[]; truncated: boolean }> {
  const entries: ContainerFileEntry[] = []
  const depth = isRoot ? 1 : 2
  const { truncated } = await parseTar(
    source,
    {
      entry: (e) => {
        const parts = e.path.split('/')
        if (parts.length !== depth) return
        entries.push({
          name: parts[depth - 1] ?? '',
          type:
            e.type === 'dir'
              ? 'dir'
              : e.type === 'file' || e.type === 'hardlink'
                ? 'file'
                : e.type === 'symlink'
                  ? 'link'
                  : 'other',
          size: e.type === 'file' ? e.size : null,
          mtime: e.mtime || null,
          mode: modeText(e.mode, e.type)
        })
      }
    },
    { stopAfter }
  )
  return { entries, truncated }
}

/** 0o755 + dir → "drwxr-xr-x". */
export function modeText(mode: number, type: TarEntry['type']): string {
  const kind = type === 'dir' ? 'd' : type === 'symlink' ? 'l' : '-'
  const bits = 'rwxrwxrwx'
  let out = kind
  for (let i = 0; i < 9; i++) out += mode & (1 << (8 - i)) ? bits.charAt(i) : '-'
  return out
}
