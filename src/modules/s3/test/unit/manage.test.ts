import {
  CopyObjectCommand,
  DeleteBucketLifecycleCommand,
  DeleteObjectsCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutBucketLifecycleConfigurationCommand,
  type S3Client
} from '@aws-sdk/client-s3'
import { afterEach, describe, expect, it } from 'vitest'
import { setLanguage } from '@shared/i18n'
import { S3_OBJECT_CHANGED } from '../../shared/ops'
import {
  lifecycleRuleProblem,
  newLifecycleRule,
  objectEditProblem,
  objectHttpUrl,
  parseCorsJson,
  shareLinkSeconds,
  suggestRuleId,
  tagsProblem
} from '../../shared/manage'
import {
  deleteVersions,
  fromSdkRule,
  listVersions,
  objectVersions,
  readLifecycle,
  readVersioning,
  restoreVersion,
  toSdkRule,
  updateObject,
  writeLifecycle
} from '../../session-host/manage'
import { errorText } from '../../session-host/client'

afterEach(() => {
  setLanguage('en')
})

const s3Error = (name: string, status: number): Error =>
  Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } })

/** Client giả: mỗi lệnh gọi `handle`, ghi lại input để kiểm tra. */
function fakeClient(handle: (command: unknown) => unknown) {
  const sent: unknown[] = []
  const client = {
    send: (command: unknown) => {
      sent.push(command)
      try {
        return Promise.resolve(handle(command))
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
  } as unknown as S3Client
  return { client, sent }
}

describe('S3 quản lý: dịch vụ không hỗ trợ / chưa cấu hình', () => {
  it('lifecycle: chưa có cấu hình → [], NotImplemented → unsupported, AccessDenied → denied', async () => {
    const none = fakeClient(() => {
      throw s3Error('NoSuchLifecycleConfiguration', 404)
    })
    expect(await readLifecycle(none.client, 'b')).toEqual({ state: 'ok', value: [] })
    const r2 = fakeClient(() => {
      throw s3Error('NotImplemented', 501)
    })
    expect(await readLifecycle(r2.client, 'b')).toEqual({ state: 'unsupported' })
    const denied = fakeClient(() => {
      throw s3Error('AccessDenied', 403)
    })
    expect(await readLifecycle(denied.client, 'b')).toEqual({ state: 'denied' })
    const other = fakeClient(() => {
      throw s3Error('NoSuchBucket', 404)
    })
    expect(await readLifecycle(other.client, 'b')).toEqual({
      state: 'error',
      message: 'The bucket does not exist'
    })
  })

  it('versioning: Status trống = Off; 405 MethodNotAllowed = không hỗ trợ', async () => {
    const off = fakeClient((c) => {
      expect(c).toBeInstanceOf(GetBucketVersioningCommand)
      return {}
    })
    expect(await readVersioning(off.client, 'b')).toEqual({ state: 'ok', value: 'Off' })
    const no = fakeClient(() => {
      throw s3Error('MethodNotAllowed', 405)
    })
    expect(await readVersioning(no.client, 'b')).toEqual({ state: 'unsupported' })
  })

  it('lỗi theo ngôn ngữ giao diện', () => {
    setLanguage('vi')
    expect(errorText(s3Error('NotImplemented', 501))).toBe('Nhà cung cấp này không hỗ trợ')
    expect(errorText(s3Error('NoSuchKey', 404))).toBe('Object không tồn tại')
  })
})

describe('S3 quản lý: lifecycle', () => {
  it('rule đơn giản: đọc → sửa được, ghi lại đúng dạng SDK', () => {
    const rule = fromSdkRule(
      {
        ID: 'logs',
        Status: 'Enabled',
        Filter: { Prefix: 'logs/' },
        Expiration: { Days: 30 },
        NoncurrentVersionExpiration: { NoncurrentDays: 7 },
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: 3 }
      },
      0
    )
    expect(rule).toEqual({
      id: 'logs',
      enabled: true,
      prefix: 'logs/',
      expireDays: 30,
      noncurrentDays: 7,
      abortMultipartDays: 3,
      extra: [],
      raw: null
    })
    expect(toSdkRule({ ...rule, enabled: false })).toEqual({
      ID: 'logs',
      Status: 'Disabled',
      Filter: { Prefix: 'logs/' },
      Expiration: { Days: 30 },
      NoncurrentVersionExpiration: { NoncurrentDays: 7 },
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: 3 }
    })
  })

  it('rule có phần không sửa được (chuyển lớp, lọc tag, ngày cố định): giữ nguyên khi lưu', () => {
    const date = new Date('2030-01-01T00:00:00.000Z')
    const rule = fromSdkRule(
      {
        ID: 'archive',
        Status: 'Enabled',
        Filter: { Tag: { Key: 'tier', Value: 'cold' } },
        Expiration: { Date: date },
        Transitions: [{ Days: 30, StorageClass: 'GLACIER' }]
      },
      0
    )
    expect(rule.extra).toEqual(['Tag filter', 'Expiration date', 'Storage class transitions'])
    expect(rule.raw).not.toBeNull()
    const back = toSdkRule({ ...rule, enabled: false })
    expect(back.Status).toBe('Disabled')
    expect(back.Transitions).toEqual([{ Days: 30, StorageClass: 'GLACIER' }])
    expect(back.Filter).toEqual({ Tag: { Key: 'tier', Value: 'cold' } })
    // Date phải là Date (SDK ghi định dạng ngày), không phải chuỗi JSON.
    expect(back.Expiration?.Date).toBeInstanceOf(Date)
    expect(back.Expiration?.Date?.toISOString()).toBe(date.toISOString())
  })

  it('rule kiểu cũ (Prefix ngay trong rule) và rule không có ID', () => {
    const legacy = fromSdkRule({ Prefix: 'tmp/', Status: 'Enabled', Expiration: { Days: 1 } }, 2)
    expect(legacy).toMatchObject({ id: 'rule-3', prefix: 'tmp/', expireDays: 1, raw: null })
  })

  it('ghi: danh sách rỗng = xoá cấu hình; có rule = Put cả cấu hình', async () => {
    const s3 = fakeClient(() => ({}))
    await writeLifecycle(s3.client, 'b', [])
    expect(s3.sent[0]).toBeInstanceOf(DeleteBucketLifecycleCommand)
    const rule = newLifecycleRule({
      id: 'x',
      prefix: '',
      expireDays: null,
      noncurrentDays: null,
      abortMultipartDays: 7
    })
    await writeLifecycle(s3.client, 'b', [rule])
    const put = s3.sent[1] as PutBucketLifecycleConfigurationCommand
    expect(put).toBeInstanceOf(PutBucketLifecycleConfigurationCommand)
    expect(put.input.LifecycleConfiguration?.Rules).toEqual([
      {
        ID: 'x',
        Status: 'Enabled',
        Filter: { Prefix: '' },
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 }
      }
    ])
  })

  it('đọc qua GetBucketLifecycleConfiguration', async () => {
    const s3 = fakeClient((c) => {
      expect(c).toBeInstanceOf(GetBucketLifecycleConfigurationCommand)
      return { Rules: [{ ID: 'a', Status: 'Disabled', Filter: { Prefix: '' } }] }
    })
    const got = await readLifecycle(s3.client, 'b')
    expect(got).toMatchObject({ state: 'ok', value: [{ id: 'a', enabled: false }] })
  })

  it('kiểm tra rule mới', () => {
    const base = {
      id: '',
      prefix: 'logs/',
      expireDays: 30,
      noncurrentDays: null,
      abortMultipartDays: null
    }
    expect(lifecycleRuleProblem(base, [])).toBeNull()
    expect(lifecycleRuleProblem({ ...base, expireDays: null }, [])).toMatch(/at least one action/)
    expect(lifecycleRuleProblem({ ...base, expireDays: 0 }, [])).toMatch(/whole number/)
    expect(lifecycleRuleProblem({ ...base, prefix: '/x' }, [])).toMatch(/cannot start/)
    const existing = [newLifecycleRule({ ...base, id: 'dup' })]
    expect(lifecycleRuleProblem({ ...base, id: 'dup' }, existing)).toMatch(/already exists/)
    expect(suggestRuleId('logs/app/', [])).toBe('shellhouse-logs-app')
    expect(suggestRuleId('', [newLifecycleRule({ ...base, id: 'shellhouse-all-objects' })])).toBe(
      'shellhouse-all-objects-2'
    )
  })
})

describe('S3 quản lý: phiên bản object', () => {
  const at = (s: string): Date => new Date(`2026-01-0${s}T00:00:00Z`)

  it('xem phiên bản một thư mục: gộp phiên bản + delete marker, mới nhất trước, có thư mục con', async () => {
    const s3 = fakeClient((c) => {
      expect(c).toBeInstanceOf(ListObjectVersionsCommand)
      return {
        CommonPrefixes: [{ Prefix: 'docs/sub/' }],
        Versions: [
          { Key: 'docs/', VersionId: 'dir', IsLatest: true, Size: 0 },
          { Key: 'docs/a.txt', VersionId: 'a1', IsLatest: false, LastModified: at('1'), Size: 1 },
          { Key: 'docs/a.txt', VersionId: 'a2', IsLatest: false, LastModified: at('2'), Size: 2 },
          { Key: 'docs/b.txt', VersionId: 'b1', IsLatest: true, LastModified: at('1'), Size: 5 }
        ],
        DeleteMarkers: [
          { Key: 'docs/a.txt', VersionId: 'a3', IsLatest: true, LastModified: at('3') }
        ]
      }
    })
    const out = await listVersions(s3.client, { op: 'listVersions', bucket: 'b', prefix: 'docs/' })
    expect(out.folders).toEqual([{ name: 'sub', key: 'docs/sub/' }])
    expect(out.versions.map((v) => [v.name, v.versionId, v.isLatest, v.deleteMarker])).toEqual([
      ['a.txt', 'a3', true, true],
      ['a.txt', 'a2', false, false],
      ['a.txt', 'a1', false, false],
      ['b.txt', 'b1', true, false]
    ])
    expect(out.truncated).toBe(false)
  })

  it('thư mục rất nhiều phiên bản: dừng ở một trang lớn, trả marker để tải tiếp', async () => {
    let page = 0
    const s3 = fakeClient((c) => {
      const input = (c as ListObjectVersionsCommand).input
      page++
      const start = page === 1 ? 0 : Number(input.KeyMarker?.slice(1))
      const Versions = Array.from({ length: 1000 }, (_, i) => ({
        Key: `k${String(start + i).padStart(6, '0')}`,
        VersionId: 'v',
        IsLatest: true,
        Size: 1
      }))
      const last = Versions.at(-1)?.Key ?? ''
      return {
        Versions,
        IsTruncated: true,
        NextKeyMarker: `k${String(Number(last.slice(1)) + 1)}`,
        NextVersionIdMarker: 'v'
      }
    })
    const out = await listVersions(s3.client, { op: 'listVersions', bucket: 'b', prefix: '' })
    expect(out.versions).toHaveLength(5000)
    expect(out.truncated).toBe(true)
    expect(out.next?.keyMarker).toBeTruthy()
  })

  it('phiên bản của đúng một key (bỏ key dài hơn cùng đầu)', async () => {
    const s3 = fakeClient(() => ({
      Versions: [
        { Key: 'a.txt', VersionId: '1', IsLatest: true, LastModified: at('2'), Size: 3 },
        { Key: 'a.txt.bak', VersionId: '9', IsLatest: true, LastModified: at('1'), Size: 3 }
      ],
      IsTruncated: true,
      NextKeyMarker: 'a.txt.bak'
    }))
    const out = await objectVersions(s3.client, 'b', 'a.txt')
    expect(out).toMatchObject({ state: 'ok', value: [{ key: 'a.txt', versionId: '1' }] })
    // Đã sang key khác → không hỏi trang sau.
    expect(s3.sent).toHaveLength(1)
  })

  it('khôi phục: copy từ versionId lên chính key, giữ lớp lưu trữ', async () => {
    const s3 = fakeClient((c) => {
      if (c instanceof HeadObjectCommand)
        return { ContentLength: 10, StorageClass: 'STANDARD_IA', ServerSideEncryption: 'AES256' }
      return {}
    })
    await restoreVersion(s3.client, 'b', 'dir/a b.txt', 'v1')
    expect((s3.sent[0] as HeadObjectCommand).input.VersionId).toBe('v1')
    const copy = s3.sent[1] as CopyObjectCommand
    expect(copy).toBeInstanceOf(CopyObjectCommand)
    expect(copy.input).toMatchObject({
      Bucket: 'b',
      Key: 'dir/a b.txt',
      CopySource: 'b/dir/a%20b.txt?versionId=v1',
      StorageClass: 'STANDARD_IA',
      ServerSideEncryption: 'AES256'
    })
    expect(copy.input.MetadataDirective).toBeUndefined()
  })

  it('xoá vĩnh viễn: một lô DeleteObjects kèm VersionId; lỗi từng mục → một câu', async () => {
    const ok = fakeClient(() => ({ Errors: [] }))
    expect(await deleteVersions(ok.client, 'b', [{ key: 'a', versionId: '1' }])).toBe(1)
    expect((ok.sent[0] as DeleteObjectsCommand).input.Delete?.Objects).toEqual([
      { Key: 'a', VersionId: '1' }
    ])
    const bad = fakeClient(() => ({
      Errors: [{ Key: 'a', Code: 'AccessDenied', Message: 'Denied' }]
    }))
    await expect(deleteVersions(bad.client, 'b', [{ key: 'a', versionId: '1' }])).rejects.toThrow(
      'Could not delete 1 version: a (Denied)'
    )
  })
})

describe('S3 quản lý: metadata', () => {
  const head = {
    ETag: '"e1"',
    ContentLength: 4,
    ContentType: 'text/plain',
    ContentEncoding: 'gzip',
    StorageClass: 'GLACIER_IR',
    ServerSideEncryption: 'aws:kms',
    SSEKMSKeyId: 'key-1',
    Metadata: { old: '1' }
  }

  it('sửa metadata: copy REPLACE lên chính nó, giữ lớp lưu trữ / KMS / Content-Encoding, kiểm tra ETag', async () => {
    const s3 = fakeClient((c) => {
      if (c instanceof HeadObjectCommand) return head
      if (c instanceof GetObjectTaggingCommand) return { TagSet: [] }
      return {}
    })
    await updateObject(
      s3.client,
      'b',
      'k',
      {
        contentType: 'application/json',
        cacheControl: 'max-age=60',
        contentDisposition: '',
        metadata: [{ key: 'Author', value: 'An' }]
      },
      '"e1"'
    )
    const copy = s3.sent.find((c) => c instanceof CopyObjectCommand) as CopyObjectCommand
    expect(copy.input).toMatchObject({
      Bucket: 'b',
      Key: 'k',
      CopySource: 'b/k',
      CopySourceIfMatch: '"e1"',
      MetadataDirective: 'REPLACE',
      ContentType: 'application/json',
      CacheControl: 'max-age=60',
      ContentEncoding: 'gzip',
      Metadata: { author: 'An' },
      StorageClass: 'GLACIER_IR',
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: 'key-1'
    })
    expect(copy.input.ContentDisposition).toBeUndefined()
  })

  it('object đã đổi kể từ lúc mở → không ghi', async () => {
    const s3 = fakeClient(() => head)
    await expect(
      updateObject(
        s3.client,
        'b',
        'k',
        { contentType: '', cacheControl: '', contentDisposition: '', metadata: [] },
        '"other"'
      )
    ).rejects.toThrow(S3_OBJECT_CHANGED)
    expect(s3.sent.some((c) => c instanceof CopyObjectCommand)).toBe(false)
    // Người khác ghi giữa HEAD và copy: 412 → cùng câu báo.
    const raced = fakeClient((c) => {
      if (c instanceof CopyObjectCommand) throw s3Error('PreconditionFailed', 412)
      if (c instanceof GetObjectTaggingCommand) return { TagSet: [] }
      return head
    })
    await expect(
      updateObject(raced.client, 'b', 'k', {
        contentType: 'a/b',
        cacheControl: '',
        contentDisposition: '',
        metadata: []
      })
    ).rejects.toThrow(S3_OBJECT_CHANGED)
  })

  it('kiểm tra metadata / tag người dùng nhập', () => {
    const edit = {
      contentType: 'text/plain',
      cacheControl: '',
      contentDisposition: '',
      metadata: []
    }
    expect(objectEditProblem(edit)).toBeNull()
    expect(objectEditProblem({ ...edit, metadata: [{ key: 'a b', value: '1' }] })).toMatch(
      /letters, numbers/
    )
    expect(objectEditProblem({ ...edit, metadata: [{ key: 'tác-giả', value: '1' }] })).toMatch(
      /letters, numbers/
    )
    expect(objectEditProblem({ ...edit, metadata: [{ key: 'a', value: 'Việt' }] })).toMatch(/ASCII/)
    expect(
      objectEditProblem({
        ...edit,
        metadata: [
          { key: 'A', value: '1' },
          { key: 'a', value: '2' }
        ]
      })
    ).toMatch(/used twice/)
    expect(
      objectEditProblem({ ...edit, metadata: [{ key: 'big', value: 'x'.repeat(2100) }] })
    ).toMatch(/2 KB/)
    expect(tagsProblem([{ key: 'env', value: 'prod' }])).toBeNull()
    expect(tagsProblem([{ key: '', value: 'x' }])).toMatch(/needs a key/)
    expect(
      tagsProblem(Array.from({ length: 11 }, (_, i) => ({ key: `k${String(i)}`, value: '' })))
    ).toMatch(/at most 10/)
  })
})

describe('S3 quản lý: CORS, địa chỉ object, link chia sẻ', () => {
  it('CORS JSON: danh sách rule, cấu hình kiểu AWS CLI, ô trống, lỗi có chỗ sai', () => {
    expect(parseCorsJson('')).toEqual({ ok: true, rules: [] })
    expect(
      parseCorsJson('[{"AllowedMethods":["GET"],"AllowedOrigins":["*"],"MaxAgeSeconds":60}]')
    ).toEqual({
      ok: true,
      rules: [{ AllowedMethods: ['GET'], AllowedOrigins: ['*'], MaxAgeSeconds: 60 }]
    })
    expect(
      parseCorsJson('{"CORSRules":[{"AllowedMethods":["PUT"],"AllowedOrigins":["https://a"]}]}')
    ).toMatchObject({ ok: true, rules: [{ AllowedMethods: ['PUT'] }] })
    expect(parseCorsJson('[{')).toMatchObject({ ok: false, error: /Not valid JSON/ })
    const bad = parseCorsJson('[{"AllowedMethods":["PATCH"],"AllowedOrigins":["*"]}]')
    expect(bad).toMatchObject({ ok: false, error: /^0\.AllowedMethods\.0: / })
    expect(parseCorsJson('[{"AllowedMethods":["GET"],"AllowedOrigins":["*"],"Typo":1}]').ok).toBe(
      false
    )
  })

  it('URL HTTPS: AWS virtual-hosted theo region của bucket, endpoint tự đặt path-style', () => {
    const aws = { endpoint: '', region: 'us-east-1', forcePathStyle: false }
    expect(objectHttpUrl(aws, 'photos', 'a b/ảnh #1.jpg', 'eu-west-1')).toBe(
      'https://photos.s3.eu-west-1.amazonaws.com/a%20b/%E1%BA%A3nh%20%231.jpg'
    )
    expect(objectHttpUrl(aws, 'my.site', 'x', null)).toBe(
      'https://s3.us-east-1.amazonaws.com/my.site/x'
    )
    expect(
      objectHttpUrl(
        { endpoint: 'http://127.0.0.1:9000/', region: '', forcePathStyle: true },
        'demo',
        'a/b.txt'
      )
    ).toBe('http://127.0.0.1:9000/demo/a/b.txt')
    expect(
      objectHttpUrl(
        { endpoint: 'https://s3.wasabisys.com', region: '', forcePathStyle: false },
        'demo',
        'b.txt'
      )
    ).toBe('https://demo.s3.wasabisys.com/b.txt')
  })

  it('thời hạn link tự nhập: 1 phút – 7 ngày', () => {
    expect(shareLinkSeconds('90', 'minutes')).toBe(5400)
    expect(shareLinkSeconds('7', 'days')).toBe(604_800)
    expect(shareLinkSeconds('8', 'days')).toBeNull()
    expect(shareLinkSeconds('0.5', 'minutes')).toBeNull()
    expect(shareLinkSeconds('', 'hours')).toBeNull()
  })
})
