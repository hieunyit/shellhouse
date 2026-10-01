import { describe, expect, it } from 'vitest'
import {
  bucketsToCsv,
  bucketsToJson,
  csvCell,
  planSync,
  syncOverlap,
  type SyncObject
} from '../../shared/sync'

const map = (o: Record<string, [number, string | null]>): Map<string, SyncObject> =>
  new Map(Object.entries(o).map(([k, [size, etag]]) => [k, { size, etag }]))

describe('kế hoạch đồng bộ', () => {
  const src = map({ a: [1, '"aa"'], b: [2, '"bb"'], c: [3, '"cc"'], big: [9, '"x-3"'] })
  const dst = map({
    a: [1, '"aa"'],
    b: [2, '"bb2"'],
    c: [4, '"cc"'],
    big: [9, '"y-2"'],
    z: [5, null]
  })

  it('mới / cập nhật (dung lượng, ETag) / giống; ETag nhiều phần không dùng để so', () => {
    const { items, same } = planSync(src, dst, { mirror: false, compare: 'etag' })
    expect(items).toEqual([
      { rel: 'b', action: 'update', size: 2 },
      { rel: 'c', action: 'update', size: 3 }
    ])
    // a giống; big: ETag multipart ở cả hai bên → chỉ so dung lượng.
    expect(same).toBe(2)
  })
  it('chỉ so dung lượng; mirror thêm xoá', () => {
    const { items } = planSync(src, map({ ...Object.fromEntries([]), z: [1, null] }), {
      mirror: true,
      compare: 'size'
    })
    expect(items.map((i) => `${i.action}:${i.rel}`)).toEqual([
      'new:a',
      'new:b',
      'new:big',
      'new:c',
      'delete:z'
    ])
    expect(planSync(src, dst, { mirror: false, compare: 'size' }).items).toEqual([
      { rel: 'c', action: 'update', size: 3 }
    ])
  })
  it('chồng lấn: cùng tài khoản + bucket, prefix lồng nhau', () => {
    expect(syncOverlap(true, { bucket: 'b', prefix: 'a' }, { bucket: 'b', prefix: 'a/x' })).toBe(
      true
    )
    expect(syncOverlap(true, { bucket: 'b', prefix: '' }, { bucket: 'b', prefix: 'x/' })).toBe(true)
    expect(syncOverlap(true, { bucket: 'b', prefix: 'ab' }, { bucket: 'b', prefix: 'a' })).toBe(
      false
    )
    expect(syncOverlap(false, { bucket: 'b', prefix: '' }, { bucket: 'b', prefix: '' })).toBe(false)
    expect(syncOverlap(true, { bucket: 'b', prefix: '' }, { bucket: 'c', prefix: '' })).toBe(false)
  })
})

describe('export danh sách bucket', () => {
  const rows = [
    {
      bucket: { name: 'logs', createdAt: Date.UTC(2024, 0, 2), region: null },
      objects: 12,
      bytes: 3456,
      info: { region: 'eu-west-1', versioning: 'Enabled' as const, encryption: 'AES256' }
    },
    {
      bucket: { name: 'tmp', createdAt: null, region: 'us-east-1' },
      objects: null,
      bytes: null,
      info: null
    }
  ]
  it('CSV: BOM, CRLF, cột theo lựa chọn, ô trống khi chưa có số', () => {
    const csv = bucketsToCsv('Prod, EU', rows, { sizes: true, details: true })
    expect(
      csv.startsWith(
        '\uFEFFAccount,Bucket,Region,Created,Objects,Size,Size (bytes),Versioning,Encryption\r\n'
      )
    ).toBe(true)
    expect(csv).toContain(
      '"Prod, EU",logs,eu-west-1,2024-01-02T00:00:00.000Z,12,3.4 KB,3456,Enabled,AES256\r\n'
    )
    expect(csv).toContain('"Prod, EU",tmp,us-east-1,,,,,,\r\n')
    expect(bucketsToCsv('a', rows, { sizes: false, details: false }).split('\r\n')[0]).toBe(
      '\uFEFFAccount,Bucket,Region,Created'
    )
  })
  it('ô CSV chặn công thức và thoát dấu ngoặc', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(csvCell(-5)).toBe('-5')
    expect(csvCell(null)).toBe('')
  })
  it('JSON', () => {
    const json = JSON.parse(bucketsToJson('a', rows, { sizes: true, details: false })) as {
      buckets: Record<string, unknown>[]
    }
    expect(json.buckets[0]).toEqual({
      name: 'logs',
      region: 'eu-west-1',
      created: '2024-01-02T00:00:00.000Z',
      objects: 12,
      size: '3.4 KB',
      bytes: 3456
    })
  })
})
