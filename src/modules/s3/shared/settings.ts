import { z } from 'zod'

/** Cài đặt riêng của S3 (`settings.modules.s3`). */
export const S3Settings = z.object({
  /** Số request cùng lúc khi quét / thống kê / copy / xoá (dịch vụ nhỏ dễ báo SlowDown nếu quá cao). */
  requests: z.number().int().min(4).max(64).catch(16),
  /** Số file truyền cùng lúc. */
  transfers: z.number().int().min(1).max(16).catch(6)
})
export type S3Settings = z.infer<typeof S3Settings>
