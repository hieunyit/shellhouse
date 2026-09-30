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

export interface S3TestServer {
  endpoint: string
  accessKeyId: string
  secretAccessKey: string
  close(): Promise<void>
}

/** Server tương thích S3 chạy trong tiến trình (s3rver, lưu vào thư mục tạm), có sẵn bucket. */
export async function startS3TestServer(buckets: string[] = ['demo']): Promise<S3TestServer> {
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
