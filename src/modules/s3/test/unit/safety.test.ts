import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { endpointWarning } from '../../shared/ops'
import {
  createBucketInput,
  isConditionalWriteUnsupported,
  isPreconditionFailed,
  preservedAttributes
} from '../../session-host/client'
import { deleteErrorSummary, lastName } from '../../session-host/bulk'
import { isInside, planLocalTargets, safeLocalTarget } from '../../session-host/service'

describe('S3: ghi ra máy an toàn', () => {
  const root = resolve('/tmp/dl/site')

  it('key có "..", đường dẫn tuyệt đối, "\\" không ghi ra ngoài thư mục đích', () => {
    expect(safeLocalTarget(root, 'css/a.css')).toBe(join(root, 'css', 'a.css'))
    for (const rel of [
      '../../.bashrc',
      'data/../../.bashrc',
      '..',
      '/etc/passwd',
      '..\\..\\evil.exe',
      'a/./b',
      ''
    ]) {
      const target = safeLocalTarget(root, rel)
      expect(isInside(root, target), rel).toBe(true)
    }
    expect(safeLocalTarget(root, 'data/../../.bashrc')).toBe(
      join(root, 'data', '_', '_', '.bashrc')
    )
  })

  it('tải thư mục: hai key ra cùng tên an toàn không ghi chung một file', () => {
    const win = { windows: true, foldCase: true }
    expect(
      planLocalTargets(root, ['a./x', 'a/x', 'a//b', 'a/_/b', 'r:1.txt', 'r_1.txt', 'A/x'], win)
    ).toEqual([
      // "A/x" không phải đổi gì → được xếp trước "a./x".
      join(root, 'a (3)', 'x'),
      join(root, 'a', 'x'),
      join(root, 'a', '_ (2)', 'b'),
      join(root, 'a', '_', 'b'),
      join(root, 'r_1 (2).txt'),
      join(root, 'r_1.txt'),
      join(root, 'A (2)', 'x')
    ])
    // File và thư mục cùng tên gốc ("k" và "k/v") là hai mục khác nhau.
    const linux = { windows: false, foldCase: false }
    expect(planLocalTargets(root, ['k', 'k/v', 'A/x', 'a/x'], linux)).toEqual([
      join(root, 'k'),
      join(root, 'k (2)', 'v'),
      join(root, 'A', 'x'),
      join(root, 'a', 'x')
    ])
    for (const t of planLocalTargets(root, ['../../.bashrc', '..', '/etc/passwd'], win))
      expect(isInside(root, t)).toBe(true)
  })

  it('isInside: chính thư mục gốc, thư mục cha, anh em cùng tiền tố đều không tính', () => {
    expect(isInside(root, root)).toBe(false)
    expect(isInside(root, resolve(root, '..'))).toBe(false)
    expect(isInside(root, `${root}-evil/x`)).toBe(false)
    expect(isInside(root, join(root, 'x'))).toBe(true)
    // Tên bắt đầu bằng ".." vẫn là tên bên trong.
    expect(isInside(root, join(root, '..x'))).toBe(true)
  })

  it('tên cuối của key', () => {
    expect(lastName('a/b/c.txt')).toBe('c.txt')
    expect(lastName('a/b/')).toBe('b')
    expect(lastName('x/..\\..\\evil.exe')).toBe('..\\..\\evil.exe')
  })
})

describe('S3: tham số request', () => {
  it('CreateBucket: ngoài us-east-1 có LocationConstraint; "auto" (R2) / trống thì không', () => {
    expect(createBucketInput('b', 'eu-west-1')).toEqual({
      Bucket: 'b',
      CreateBucketConfiguration: { LocationConstraint: 'eu-west-1' }
    })
    for (const region of ['', 'us-east-1', 'auto'])
      expect(createBucketInput('b', region)).toEqual({ Bucket: 'b' })
  })

  it('giữ thuộc tính object khi ghi đè, kể cả storage class (trừ STANDARD)', () => {
    expect(
      preservedAttributes({
        ContentType: 'application/yaml',
        CacheControl: 'no-cache',
        ContentEncoding: 'gzip',
        Metadata: { owner: 'ops' },
        StorageClass: 'STANDARD_IA',
        ETag: '"x"'
      })
    ).toEqual({
      ContentType: 'application/yaml',
      CacheControl: 'no-cache',
      ContentEncoding: 'gzip',
      Metadata: { owner: 'ops' },
      StorageClass: 'STANDARD_IA'
    })
    expect(preservedAttributes({ StorageClass: 'STANDARD', Metadata: {} })).toEqual({})
    expect(preservedAttributes(null)).toEqual({})
  })

  it('phân loại lỗi ghi có điều kiện', () => {
    expect(isPreconditionFailed({ name: 'PreconditionFailed' })).toBe(true)
    expect(isPreconditionFailed({ $metadata: { httpStatusCode: 412 } })).toBe(true)
    expect(isPreconditionFailed({ name: 'AccessDenied' })).toBe(false)
    expect(isConditionalWriteUnsupported({ name: 'NotImplemented' })).toBe(true)
    expect(isConditionalWriteUnsupported({ $metadata: { httpStatusCode: 501 } })).toBe(true)
    expect(isConditionalWriteUnsupported({ name: 'AccessDenied' })).toBe(false)
  })

  it('lỗi DeleteObjects: tổng số + vài key đầu', () => {
    const errors = [
      { key: 'a', message: 'Access denied' },
      { key: 'b', message: 'Access denied' },
      { key: 'c', message: 'Locked' },
      { key: 'd', message: 'Locked' }
    ]
    expect(deleteErrorSummary(errors, 1200)).toBe(
      'Could not delete 1,200 objects: a (Access denied), b (Access denied), c (Locked), and 1,197 more'
    )
    expect(deleteErrorSummary(errors.slice(0, 1), 1)).toBe(
      'Could not delete 1 object: a (Access denied)'
    )
  })

  it('cảnh báo endpoint http:// (trừ máy này / mạng nội bộ)', () => {
    expect(endpointWarning('http://s3.example.com')).toMatch(/unencrypted/)
    expect(endpointWarning('https://s3.example.com')).toBeNull()
    expect(endpointWarning('')).toBeNull()
    for (const local of [
      'http://localhost:9000',
      'http://127.0.0.1:9000',
      'http://192.168.1.10:9000',
      'http://10.0.0.5',
      'http://172.20.0.2:9000',
      'http://[::1]:9000'
    ])
      expect(endpointWarning(local), local).toBeNull()
    expect(endpointWarning('http://172.32.0.1')).toMatch(/unencrypted/)
  })
})
