import { HeadBucketCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3'
import { expect, it, vi } from 'vitest'
import { S3Service } from '../../session-host/service'

it('keeps active sync and copy jobs after more than two minutes without polling', async () => {
  const clock = vi.spyOn(Date, 'now')
  let release: (() => void) | undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const client = {
    send: async (command: unknown) => {
      if (command instanceof HeadBucketCommand) return {}
      if (command instanceof ListObjectsV2Command) {
        await held
        return { Contents: [], IsTruncated: false }
      }
      throw new Error('unexpected command')
    }
  } as unknown as S3Client
  const service = new S3Service(
    {
      endpoint: 'http://127.0.0.1:1',
      region: 'us-east-1',
      accessKeyId: 'test',
      secretAccessKey: 'test',
      forcePathStyle: true
    },
    () => undefined
  )
  vi.spyOn(service, 'clientFor').mockResolvedValue(client)
  try {
    clock.mockReturnValue(1000)
    const sync = (await service.run({
      op: 'syncStart',
      bucket: 'src',
      prefix: '',
      dest: { bucket: 'dst', prefix: '' },
      mirror: false,
      compare: 'size',
      createBucket: false,
      dryRun: true
    })) as string
    const copy = (await service.run({
      op: 'jobStart',
      job: {
        kind: 'copy',
        bucket: 'src',
        keys: ['folder/'],
        destBucket: 'dst',
        destPrefix: '',
        overwrite: true,
        move: false
      }
    })) as string
    clock.mockReturnValue(1000 + 5 * 60_000)
    expect(await service.run({ op: 'syncPoll', id: sync })).toMatchObject({ phase: 'scanning' })
    expect(await service.run({ op: 'jobPoll', id: copy })).toMatchObject({ phase: 'running' })
  } finally {
    release?.()
    service.dispose()
    clock.mockRestore()
  }
})
