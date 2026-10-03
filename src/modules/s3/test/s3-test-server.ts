import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** s3rver không có kiểu TypeScript — chỉ khai báo phần dùng tới. */
interface S3rverInstance {
  run(): Promise<{ port: number }>
  close(): Promise<void>
}
type S3rverCtor = new (options: Record<string, unknown>) => S3rverInstance

interface ListOptions {
  delimiter?: string
  startAfter?: string
  prefix?: string
  maxKeys?: number
}
interface ListResult {
  objects: { key: string }[]
  commonPrefixes: string[]
  isTruncated: boolean
}
interface FilesystemStoreProto {
  listObjects: (this: unknown, bucket: string, options: ListOptions) => Promise<ListResult>
  __shellhouseFixed?: boolean
}

/**
 * s3rver 3.7.1 lỗi khi liệt kê có Delimiter: bỏ qua các thư mục sâu hơn một cấp dưới prefix, nên
 * bucket chỉ có `a/b/c/report.txt` trả về gốc rỗng (S3 thật trả CommonPrefixes `a/`). Sửa bằng cách
 * liệt kê phẳng rồi tự gom CommonPrefixes — cùng ngữ nghĩa cắt trang (chỉ đếm key) như bản gốc.
 */
function fixDelimiterListing(): void {
  const proto = (
    createRequire(__filename)('s3rver/lib/stores/filesystem') as {
      prototype: FilesystemStoreProto
    }
  ).prototype
  if (proto.__shellhouseFixed) return
  proto.__shellhouseFixed = true
  const original = proto.listObjects
  proto.listObjects = async function (bucket, options) {
    const { delimiter = '', prefix = '', maxKeys = Infinity } = options
    if (!delimiter) return original.call(this, bucket, options)
    const flat = await original.call(this, bucket, {
      ...options,
      delimiter: '',
      maxKeys: Infinity
    })
    const commonPrefixes = new Set<string>()
    const objects: ListResult['objects'] = []
    let isTruncated = false
    for (const o of flat.objects) {
      const idx = o.key.slice(prefix.length).indexOf(delimiter)
      if (idx !== -1) commonPrefixes.add(o.key.slice(0, prefix.length + idx + delimiter.length))
      else if (objects.length < maxKeys) objects.push(o)
      else {
        isTruncated = true
        break
      }
    }
    // Trang bị cắt: trang sau bắt đầu sau key cuối — prefix nằm sau nó để trang sau trả, tránh lặp.
    const last = objects.at(-1)?.key
    const prefixes = [...commonPrefixes].filter(
      (p) => !isTruncated || last === undefined || p < last
    )
    return { objects, commonPrefixes: prefixes.sort(), isTruncated }
  }
}

export interface S3TestServer {
  endpoint: string
  accessKeyId: string
  secretAccessKey: string
  close(): Promise<void>
}

/** Server tương thích S3 chạy trong tiến trình (s3rver, lưu vào thư mục tạm), có sẵn bucket. */
export async function startS3TestServer(buckets: string[] = ['demo']): Promise<S3TestServer> {
  fixDelimiterListing()
  const S3rver = createRequire(__filename)('s3rver') as S3rverCtor
  const directory = mkdtempSync(join(tmpdir(), 'sh-s3-'))
  const server = new S3rver({
    address: '127.0.0.1',
    port: 0,
    silent: true,
    directory,
    configureBuckets: buckets.map((name) => ({ name, configs: [] }))
  })
  const { port } = await server.run()
  return {
    endpoint: `http://127.0.0.1:${port}`,
    accessKeyId: 'S3RVER',
    secretAccessKey: 'S3RVER',
    close: async () => {
      await server.close()
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }
}
