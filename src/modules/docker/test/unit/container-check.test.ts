import { describe, expect, it } from 'vitest'
import { containerCheck, findContainer } from '../../shared/container-check'
import type { ContainerRow, Health } from '../../shared/ops'

const row = (over: Partial<ContainerRow>): ContainerRow => ({
  id: 'abcdef123456',
  name: 'web',
  image: 'nginx',
  state: 'running',
  status: 'Up 2 hours',
  health: null,
  created: 0,
  ports: [],
  project: null,
  service: null,
  composeDir: null,
  composeFiles: null,
  ...over
})

describe('containerCheck — container có đạt điều kiện không', () => {
  it('running: đạt khi đang chạy; không đạt (và không chờ) khi đã thoát', () => {
    expect(containerCheck([row({})], 'web', 'running')).toEqual({
      ok: true,
      waiting: false,
      detail: 'Up 2 hours'
    })
    const exited = containerCheck([row({ state: 'exited' })], 'web', 'running')
    expect(exited).toEqual({ ok: false, waiting: false, detail: 'State: exited' })
  })

  it('đang restarting / created thì có thể chờ được', () => {
    expect(containerCheck([row({ state: 'restarting' })], 'web', 'running').waiting).toBe(true)
    expect(containerCheck([row({ state: 'created' })], 'web', 'running').waiting).toBe(true)
  })

  it('healthy: cần healthcheck báo healthy; starting / unhealthy còn chờ; không có healthcheck thì nói rõ', () => {
    const at = (health: Health, status = 'Up') =>
      containerCheck([row({ health, status })], 'web', 'healthy')
    expect(at('healthy', 'Up (healthy)')).toMatchObject({ ok: true })
    expect(at('starting')).toMatchObject({ ok: false, waiting: true })
    expect(at('unhealthy')).toMatchObject({ ok: false, waiting: true })
    const none = at(null)
    expect(none).toMatchObject({ ok: false, waiting: false })
    expect(none.detail).toMatch(/no health check/)
    // Cùng container không có healthcheck vẫn đạt với "running".
    expect(containerCheck([row({})], 'web', 'running').ok).toBe(true)
  })

  it('không thấy container → lỗi nêu tên; tên rỗng cũng vậy', () => {
    expect(containerCheck([row({})], 'api', 'running')).toEqual({
      ok: false,
      waiting: false,
      detail: 'No container named “api”'
    })
    expect(containerCheck([row({})], '  ', 'running').ok).toBe(false)
  })

  it('tìm theo tên chính xác, bỏ "/" đầu; tiền tố id chỉ từ 4 ký tự', () => {
    const rows = [row({ name: 'web', id: 'abcdef123456' }), row({ name: 'db', id: '999999aaaa' })]
    expect(findContainer(rows, '/db')?.name).toBe('db')
    expect(findContainer(rows, 'we')).toBeUndefined()
    expect(findContainer(rows, '9999')?.name).toBe('db')
    expect(findContainer(rows, '99')).toBeUndefined()
  })
})
