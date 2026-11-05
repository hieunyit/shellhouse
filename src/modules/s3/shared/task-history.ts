import { z } from 'zod'

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const S3TaskRecord = z.object({
  id: z.string().min(1).max(128),
  accountId: z.string().min(1).max(64),
  accountName: z.string().max(500),
  kind: z.enum(['copy', 'move', 'sync', 'delete', 'rename']),
  label: z.string().max(4096),
  source: z.string().max(4096),
  destination: z.string().max(4096),
  state: z.enum(['running', 'done', 'error', 'cancelled']),
  completed: count,
  total: count.nullable(),
  failed: count,
  checking: z.object({ done: count, total: count }).optional(),
  error: z
    .string()
    .max(16 * 1024)
    .nullable(),
  startedAt: count,
  finishedAt: count.nullable()
})
export type S3TaskRecord = z.infer<typeof S3TaskRecord>
export const MAX_S3_TASK_HISTORY = 1000

/** Persist terminal records; live progress belongs to the running session. */
export const S3FinishedTask = S3TaskRecord.extend({
  state: z.enum(['done', 'error', 'cancelled']),
  finishedAt: count
})
