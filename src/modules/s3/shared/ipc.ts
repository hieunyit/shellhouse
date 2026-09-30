import { z } from 'zod'
import { S3AccountInput, S3Pin } from './ops'

/** Tham số IPC `module:s3:*` (main validate trước khi gọi handler). */
export const S3Ipc = {
  accounts: z.tuple([]),
  save: z.tuple([S3AccountInput]),
  delete: z.tuple([z.string().max(64)]),
  pin: z.tuple([z.string().max(64), S3Pin, z.boolean()])
} as const

/** Tham số mở tab / phiên S3. */
export const S3BrowserParams = z.object({
  accountId: z.string().min(1).max(64),
  bucket: z.string().min(1).max(255).optional(),
  prefix: z.string().max(1024).optional()
})
export type S3BrowserParams = z.infer<typeof S3BrowserParams>

/** Phiên S3 đã phân giải (main → Session Host, có secret). */
export const S3SessionConfig = z.object({
  connection: z.object({
    endpoint: z.string().max(500),
    region: z.string().max(64),
    accessKeyId: z.string().max(256),
    secretAccessKey: z.string().max(1024),
    forcePathStyle: z.boolean()
  }),
  limits: z.object({
    requests: z.number().int().min(1).max(64),
    transfers: z.number().int().min(1).max(16)
  })
})
export type S3SessionConfig = z.infer<typeof S3SessionConfig>
