import type { S3Bucket, S3BucketInfo, SyncAction } from './ops'

/** Một object khi so sánh hai bên (key tính từ prefix gốc). */
export interface SyncObject {
  size: number
  etag: string | null
}

export interface SyncItem {
  /** Key tương đối (sau prefix). */
  rel: string
  action: SyncAction
  size: number
}

/** "a/b" → "a/b/"; "" giữ nguyên. */
export function normalizePrefix(prefix: string): string {
  return prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix
}

/** ETag của upload nhiều phần ("…-12") không phải MD5 nội dung — không dùng để so. */
function comparableEtag(etag: string | null): string | null {
  if (!etag || etag.includes('-')) return null
  return etag.replace(/"/g, '').toLowerCase()
}

/**
 * Kế hoạch đồng bộ: object chỉ có ở nguồn → new; khác dung lượng (hoặc khác ETag khi so được) →
 * update; `mirror` thì object chỉ có ở đích → delete. Sắp theo key để xem trước dễ đọc.
 */
export function planSync(
  source: ReadonlyMap<string, SyncObject>,
  dest: ReadonlyMap<string, SyncObject>,
  options: { mirror: boolean; compare: 'size' | 'etag' }
): { items: SyncItem[]; same: number } {
  const items: SyncItem[] = []
  let same = 0
  for (const [rel, src] of source) {
    const dst = dest.get(rel)
    if (!dst) {
      items.push({ rel, action: 'new', size: src.size })
      continue
    }
    let changed = src.size !== dst.size
    if (!changed && options.compare === 'etag') {
      const a = comparableEtag(src.etag)
      const b = comparableEtag(dst.etag)
      changed = a !== null && b !== null && a !== b
    }
    if (changed) items.push({ rel, action: 'update', size: src.size })
    else same++
  }
  if (options.mirror)
    for (const [rel, dst] of dest)
      if (!source.has(rel)) items.push({ rel, action: 'delete', size: dst.size })
  items.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return { items, same }
}

/**
 * Nguồn và đích chồng lên nhau (cùng tài khoản + bucket, prefix này nằm trong prefix kia) — đồng bộ
 * sẽ tự chép vào chính nó.
 */
export function syncOverlap(
  sameAccount: boolean,
  source: { bucket: string; prefix: string },
  dest: { bucket: string; prefix: string }
): boolean {
  if (!sameAccount || source.bucket !== dest.bucket) return false
  const a = normalizePrefix(source.prefix)
  const b = normalizePrefix(dest.prefix)
  return a.startsWith(b) || b.startsWith(a)
}

// ---------- Export danh sách bucket ----------

export interface BucketExportRow {
  bucket: S3Bucket
  objects: number | null
  bytes: number | null
  info: S3BucketInfo | null
}

/** BOM để Excel nhận đúng UTF-8 (dấu tiếng Việt…). */
const BOM = '\uFEFF'

const iso = (ms: number | null): string => (ms === null ? '' : new Date(ms).toISOString())

/** "1.23 TB", "512.0 MB"… (đơn vị 1024, như trong app). */
export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  if (n < 1000 * 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`
  return `${(n / 1024 ** 4).toFixed(2)} TB`
}

/** Ô CSV: bọc ngoặc khi cần; chặn công thức Excel (=, +, -, @ ở đầu). */
export function csvCell(value: string | number | null): string {
  if (value === null) return ''
  let text = String(value)
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** CSV (UTF-8, có BOM để Excel đọc đúng dấu, xuống dòng CRLF). */
export function bucketsToCsv(
  account: string,
  rows: readonly BucketExportRow[],
  options: { sizes: boolean; details: boolean }
): string {
  const header = [
    'Account',
    'Bucket',
    'Region',
    'Created',
    ...(options.sizes ? ['Objects', 'Size', 'Size (bytes)'] : []),
    ...(options.details ? ['Versioning', 'Encryption'] : [])
  ]
  const lines = rows.map((r) =>
    [
      account,
      r.bucket.name,
      r.info?.region ?? r.bucket.region,
      iso(r.bucket.createdAt),
      ...(options.sizes ? [r.objects, r.bytes === null ? null : humanSize(r.bytes), r.bytes] : []),
      ...(options.details ? [r.info?.versioning ?? null, r.info?.encryption ?? null] : [])
    ]
      .map(csvCell)
      .join(',')
  )
  return `${BOM}${[header.map(csvCell).join(','), ...lines].join('\r\n')}\r\n`
}

export function bucketsToJson(
  account: string,
  rows: readonly BucketExportRow[],
  options: { sizes: boolean; details: boolean }
): string {
  return `${JSON.stringify(
    {
      account,
      exportedAt: new Date().toISOString(),
      buckets: rows.map((r) => ({
        name: r.bucket.name,
        region: r.info?.region ?? r.bucket.region,
        created: r.bucket.createdAt === null ? null : iso(r.bucket.createdAt),
        ...(options.sizes
          ? {
              objects: r.objects,
              size: r.bytes === null ? null : humanSize(r.bytes),
              bytes: r.bytes
            }
          : {}),
        ...(options.details
          ? { versioning: r.info?.versioning ?? null, encryption: r.info?.encryption ?? null }
          : {})
      }))
    },
    null,
    2
  )}\n`
}
