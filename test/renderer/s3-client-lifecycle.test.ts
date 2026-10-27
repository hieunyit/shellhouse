import { expect, it, vi } from 'vitest'
import type { ModuleSessionEvents } from '../../src/modules/registry/renderer-kit'
import type { TransferStatus } from '../../src/shared/sftp'
const h = vi.hoisted(() => ({ events: null as ModuleSessionEvents | null }))
vi.mock('../../src/modules/registry/renderer-kit', () => ({
  ModuleSessionClient: {
    open: (_module: string, _target: unknown, events: ModuleSessionEvents) => {
      h.events = events
      return Promise.resolve({ close: () => undefined, request: () => Promise.resolve(null) })
    }
  }
}))
import { S3SessionClient } from '../../src/modules/s3/renderer/s3-client'
it('kết thúc transfers đang chạy/chờ khi mất phiên và chỉ báo ngắt một lần', async () => {
  const updates: TransferStatus[][] = []
  const disconnected = vi.fn()
  const client = await S3SessionClient.open('account', (list) => updates.push(list), disconnected)
  const transfer = (id: string, state: TransferStatus['state']): TransferStatus => ({
    id,
    state,
    direction: 'download',
    localPath: '/file',
    remotePath: 's3://demo/file',
    size: 10,
    transferred: 3,
    resumedFrom: 0,
    bytesPerSecond: 5,
    error: null
  })
  h.events?.onEvent?.('transfers', {
    remove: [],
    upsert: [transfer('running', 'running'), transfer('queued', 'queued'), transfer('done', 'done')]
  })
  h.events?.onHostRestart?.()
  h.events?.onExit?.('network')
  expect(disconnected).toHaveBeenCalledTimes(1)
  expect(updates.at(-1)?.map((item) => [item.id, item.state, item.bytesPerSecond])).toEqual([
    ['running', 'error', 0],
    ['queued', 'error', 0],
    ['done', 'done', 5]
  ])
  expect(updates.at(-1)?.[0]?.error).toBe('The connection changed')
  h.events?.onEvent?.('transfers', { remove: [], upsert: [transfer('running', 'done')] })
  expect(updates).toHaveLength(2)
  client.close()
})
