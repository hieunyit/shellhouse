import { connect } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { ApiBackend } from '../../session-host/api-backend'
import type { DockerCli } from '../../session-host/backend'
import { EngineClient } from '../../session-host/engine'
import { DockerService } from '../../session-host/service'
import {
  containerApplies,
  containerBulkOp,
  pullAndWait,
  pullRefs,
  runBulk,
  splitTargets,
  type ContainerBulk
} from '../../shared/bulk'
import type { ContainerRow, DockerOp, ImageRow, NetworkRow, VolumeRow } from '../../shared/ops'
import { startEngineTestServer, type EngineTestServer } from '../engine-test-server'

/**
 * Thao tác hàng loạt (chọn nhiều dòng) qua Session Host thật tới Engine giả: chỉ gửi lệnh cho mục
 * áp dụng được, lỗi một mục (đang dùng, cần force) không dừng các mục khác, chỉ đọc chặn từng mục.
 */

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

const noCli: DockerCli = {
  exec: () => Promise.reject(new Error('no cli')),
  spawn: () => Promise.reject(new Error('no cli'))
}

async function setup(): Promise<{
  server: EngineTestServer
  run: <T>(op: DockerOp) => Promise<T>
  subscribe: (l: (event: string, data: unknown) => void) => () => void
}> {
  const server = await startEngineTestServer()
  cleanups.push(() => server.close())
  const listeners = new Set<(event: string, data: unknown) => void>()
  const s = new DockerService({
    cli: noCli,
    openPty: () => Promise.reject(new Error('no pty')),
    emit: (event, data) => {
      for (const l of listeners) l(event, data)
    },
    log: () => undefined,
    registryAuth: () => Promise.reject(new Error('no registry')),
    connect: () =>
      Promise.resolve(
        new ApiBackend(
          new EngineClient(
            () =>
              new Promise((resolve, reject) => {
                const socket = connect(server.path)
                socket.once('connect', () => {
                  resolve(socket)
                })
                socket.once('error', reject)
              })
          )
        )
      )
  })
  cleanups.push(() => {
    s.dispose()
  })
  return {
    server,
    run: <T>(op: DockerOp) => s.run(op, new AbortController().signal) as Promise<T>,
    subscribe: (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    }
  }
}

/** Như hộp thoại hàng loạt: tách mục áp dụng được rồi chạy song song. */
async function bulkContainers(
  run: <T>(op: DockerOp) => Promise<T>,
  kind: ContainerBulk,
  items: readonly ContainerRow[],
  options: { volumes?: boolean } = {}
) {
  const { targets, skipped } = splitTargets(items, (c) => containerApplies(kind, c))
  const results = await runBulk(targets, {
    key: (c) => c.name,
    run: (c) => run(containerBulkOp(kind, c, options))
  })
  return { results, skipped: skipped.map((c) => c.name) }
}

describe('thao tác hàng loạt — container', () => {
  it('stop chỉ gửi cho container đang chạy; pause / resume / kill; xoá kèm -v', async () => {
    const { server, run } = await setup()
    const list = (): Promise<ContainerRow[]> => run<ContainerRow[]>({ op: 'containers', all: true })

    const stop = await bulkContainers(run, 'stop', await list())
    expect(stop.skipped).toEqual(['old-job'])
    expect(stop.results.every((r) => r.ok)).toBe(true)
    expect(server.containers.map((c) => c.State)).toEqual(['exited', 'exited', 'exited'])
    expect(server.requests.filter((r) => r.includes('/stop'))).toHaveLength(2)

    const start = await bulkContainers(run, 'start', await list())
    expect(start.results.map((r) => r.key).sort()).toEqual(['db', 'old-job', 'web'])
    const pause = await bulkContainers(run, 'pause', await list())
    expect(pause.results).toHaveLength(3)
    expect(server.containers.every((c) => c.State === 'paused')).toBe(true)
    // Đang pause: restart không áp dụng (Engine từ chối), resume thì có.
    expect((await bulkContainers(run, 'restart', await list())).skipped).toHaveLength(3)
    await bulkContainers(run, 'unpause', await list())
    expect(server.containers.every((c) => c.State === 'running')).toBe(true)

    const [web, db] = await list()
    await bulkContainers(
      run,
      'kill',
      [web, db].filter((c): c is ContainerRow => Boolean(c))
    )
    expect(server.containers.filter((c) => c.State === 'exited').map((c) => c.Names[0])).toEqual([
      '/web',
      '/db'
    ])

    // Xoá: old-job còn chạy → force; mọi lệnh có v=true (anonymous volume).
    const remove = await bulkContainers(run, 'remove', await list(), { volumes: true })
    expect(remove.results.every((r) => r.ok)).toBe(true)
    expect(server.containers).toHaveLength(0)
    const deletes = server.requests.filter((r) => r.startsWith('DELETE /v1.45/containers/'))
    expect(deletes).toHaveLength(3)
    expect(deletes.every((r) => r.includes('v=true'))).toBe(true)
    expect(deletes.filter((r) => r.includes('force=true'))).toHaveLength(1)
  })

  it('chỉ đọc: mọi mục bị từ chối ở Session Host, Engine không nhận lệnh nào', async () => {
    const { server, run } = await setup()
    await run({ op: 'configure', readOnly: true })
    const { results } = await bulkContainers(
      run,
      'restart',
      await run<ContainerRow[]>({ op: 'containers', all: true })
    )
    expect(results).toHaveLength(3)
    expect(results.every((r) => !r.ok && /Read-only/.test(r.error ?? ''))).toBe(true)
    expect(server.requests.some((r) => r.includes('/restart'))).toBe(false)
  })
})

describe('thao tác hàng loạt — image, volume, network', () => {
  it('xoá image: đang dùng → lỗi riêng mục đó; container dừng → cần force; mục khác vẫn xoá', async () => {
    const { server, run } = await setup()
    const images = await run<ImageRow[]>({ op: 'images' })
    const remove = (force: boolean, items: readonly ImageRow[]) =>
      runBulk(items, {
        key: (i) => i.tags[0] ?? i.id,
        run: (i) => run({ op: 'image.remove', id: i.id, ...(force ? { force: true } : {}) })
      })
    const first = await remove(false, images)
    expect(first.map((r) => [r.key, r.ok])).toEqual([
      ['nginx:1.27', false],
      ['postgres:16', false],
      ['sha256:dangling1', true]
    ])
    expect(first[0]?.error).toMatch(/being used by running container/)

    // db dừng: không force vẫn lỗi (must be forced), force thì xoá được.
    const db = server.containers.find((c) => c.Names[0] === '/db')
    if (db) db.State = 'exited'
    const pg = images.filter((i) => i.tags[0] === 'postgres:16')
    expect((await remove(false, pg))[0]?.error).toMatch(/must be forced/)
    expect((await remove(true, pg))[0]?.ok).toBe(true)
    expect(server.requests).toContain('DELETE /v1.45/images/sha256%3Aimg2?force=true')
  })

  it('pull latest: mọi tag, đợi luồng xong; tag lỗi báo riêng', async () => {
    const { server, run, subscribe } = await setup()
    const refs = pullRefs([{ tags: ['redis:7', 'redis:latest'] }, { tags: [] }])
    const ok = await runBulk([...refs, 'does-not-exist'], {
      key: (r) => r,
      parallel: 2,
      run: (r) => pullAndWait(run, subscribe, r, null)
    })
    expect(ok.map((r) => [r.key, r.ok])).toEqual([
      ['redis:7', true],
      ['redis:latest', true],
      ['does-not-exist', false]
    ])
    expect(ok[2]?.error).toMatch(/pull access denied/)
    expect(server.requests).toContain('POST /v1.45/images/create?fromImage=redis&tag=latest')
  })

  it('volume: biết container nào đang gắn, dung lượng lấy riêng (không làm chậm danh sách)', async () => {
    const { run } = await setup()
    const volumes = await run<VolumeRow[]>({ op: 'volumes' })
    expect(volumes.find((v) => v.name === 'shop_data')?.usedBy).toEqual(['web'])
    expect(volumes.filter((v) => v.name !== 'shop_data').every((v) => v.usedBy.length === 0)).toBe(
      true
    )
    const sizes = await run<Record<string, number>>({ op: 'volumes.sizes' })
    expect(sizes['shop_data']).toBe(123_456)
  })

  it('xoá volume đang dùng → lỗi riêng; network built-in bị bỏ qua', async () => {
    const { server, run } = await setup()
    const volumes = await run<VolumeRow[]>({ op: 'volumes' })
    const vr = await runBulk(volumes, {
      key: (v) => v.name,
      run: (v) => run({ op: 'volume.remove', name: v.name })
    })
    expect(vr.filter((r) => !r.ok).map((r) => r.key)).toEqual(['shop_data'])
    expect(vr.find((r) => r.key === 'shop_data')?.error).toMatch(/in use/)
    expect(server.volumes.map((v) => v.Name)).toEqual(['shop_data'])

    const networks = await run<NetworkRow[]>({ op: 'networks' })
    const { targets, skipped } = splitTargets(networks, (n) => !n.builtin)
    expect(skipped.map((n) => n.name).sort()).toEqual(['bridge', 'host'])
    const nr = await runBulk(targets, {
      key: (n) => n.name,
      run: (n) => run({ op: 'network.remove', id: n.id })
    })
    expect(nr.every((r) => r.ok)).toBe(true)
    expect(server.networks.map((n) => n.Name)).toEqual(['bridge', 'host'])
  })
})
