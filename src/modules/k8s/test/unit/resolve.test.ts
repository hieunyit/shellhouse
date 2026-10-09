import { describe, expect, it } from 'vitest'
import { HostResolver } from '../../session-host/resolve'

describe('HostResolver — phân giải DNS cho Connections', () => {
  it('chỉ phân giải tên công khai; tên nội bộ không bao giờ tới DNS', async () => {
    const asked: string[] = []
    const r = new HostResolver((h) => {
      asked.push(h)
      return Promise.resolve(['1.2.3.4'])
    })
    const out = await r.resolve([
      'api.stripe.com',
      'db.prod.corp',
      'redis.default.svc.cluster.local',
      '10.0.0.5',
      'redis',
      'API.Stripe.com.'
    ])
    expect(asked).toEqual(['api.stripe.com'])
    expect(out.results).toEqual({ 'api.stripe.com': ['1.2.3.4'] })
    expect(out.skipped.sort()).toEqual([
      '10.0.0.5',
      'db.prod.corp',
      'redis',
      'redis.default.svc.cluster.local'
    ])
  })

  it('nhớ kết quả (không hỏi lại) và nhớ cả thất bại; thất bại không làm hỏng lượt', async () => {
    let calls = 0
    const r = new HostResolver((h) => {
      calls++
      return h === 'bad.example.com'
        ? Promise.reject(new Error('NXDOMAIN'))
        : Promise.resolve(['9.9.9.9'])
    })
    const a = await r.resolve(['ok.example.com', 'bad.example.com'])
    expect(a.results).toEqual({ 'ok.example.com': ['9.9.9.9'] })
    await r.resolve(['ok.example.com', 'bad.example.com'])
    expect(calls).toBe(2)
  })

  it('tên chậm quá thời gian chờ → bỏ qua, các tên khác vẫn có', async () => {
    const r = new HostResolver((h) =>
      h === 'slow.example.com'
        ? new Promise<string[]>(() => undefined)
        : Promise.resolve(['5.5.5.5'])
    )
    const out = await r.resolve(['slow.example.com', 'fast.example.com'])
    expect(out.results).toEqual({ 'fast.example.com': ['5.5.5.5'] })
  }, 10_000)

  it('giới hạn số tên mỗi lượt', async () => {
    let calls = 0
    const r = new HostResolver(() => {
      calls++
      return Promise.resolve(['1.1.1.1'])
    })
    await r.resolve(Array.from({ length: 200 }, (_, i) => `h${String(i)}.example.com`))
    expect(calls).toBe(64)
  })

  it('internal=true: tên nội bộ cũng được phân giải (người dùng chấp nhận); IP và một nhãn vẫn không', async () => {
    const asked: string[] = []
    const r = new HostResolver((h) => {
      asked.push(h)
      return Promise.resolve(['10.9.9.9'])
    })
    const out = await r.resolve(['db.prod.corp', 'redis', '10.0.0.1'], undefined, true)
    expect(asked).toEqual(['db.prod.corp'])
    expect(out.results).toEqual({ 'db.prod.corp': ['10.9.9.9'] })
  })
})
