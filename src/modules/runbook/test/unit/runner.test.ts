import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  executeRunbook,
  planRun,
  prepareKinds,
  summarize,
  type EnvInfo,
  type KindResolver,
  type StepKind,
  type StepOutcome
} from '../../shared/runner'
import type { RunbookStep, StepResult } from '../../shared/runbook'

const PROD: EnvInfo = { id: 'prod', name: 'Production', confirm: 'type', readOnly: false }
const FROZEN: EnvInfo = { id: 'frozen', name: 'Frozen', confirm: 'confirm', readOnly: true }
const envs: Record<string, EnvInfo> = { prod: PROD, frozen: FROZEN }
const envOf = (id: string): EnvInfo | undefined => envs[id]

const step = (
  id: string,
  type: string,
  params: unknown = {},
  over: Partial<RunbookStep> = {}
): RunbookStep => ({
  id,
  name: '',
  type,
  params,
  timeoutSec: 5,
  continueOnFail: false,
  ...over
})

interface Kind extends StepKind {
  calls: unknown[]
}
function kind(
  run: (params: Record<string, unknown>) => Promise<StepOutcome> | StepOutcome,
  opts: { mutates?: boolean; env?: (p: Record<string, unknown>) => string | null } = {}
): Kind {
  const calls: unknown[] = []
  return {
    calls,
    label: () => 'test',
    params: z.looseObject({ target: z.string().optional(), n: z.number().optional() }),
    mutates: opts.mutates ?? false,
    environmentOf: (p: Record<string, unknown>) => opts.env?.(p) ?? null,
    run: (p: Record<string, unknown>) => {
      calls.push(p)
      return Promise.resolve(run(p))
    }
  }
}

const resolver =
  (kinds: Record<string, StepKind | 'disabled'>): KindResolver =>
  (type) =>
    kinds[type]

const NO_PLAN = { typed: [], blocked: new Map<string, string>() }

async function run(
  steps: RunbookStep[],
  kinds: Record<string, StepKind | 'disabled'>,
  extra: {
    values?: Record<string, string>
    signal?: AbortSignal
    plan?: ReturnType<typeof planRun>
  } = {}
): Promise<{ results: StepResult[]; updates: StepResult[][] }> {
  const updates: StepResult[][] = []
  const results = await executeRunbook({
    steps,
    values: extra.values ?? {},
    kindOf: resolver(kinds),
    plan: extra.plan ?? NO_PLAN,
    signal: extra.signal ?? new AbortController().signal,
    onPrompt: () => undefined,
    onUpdate: (r) => updates.push(r),
    now: () => 1000
  })
  return { results, updates }
}

describe('executeRunbook', () => {
  it('chạy tuần tự, mọi bước đạt → tất cả pass; báo cập nhật từng bước (pending → running → pass)', async () => {
    const order: string[] = []
    const ok = kind((p) => {
      order.push(String(p['target']))
      return { ok: true, detail: 'fine' }
    })
    const { results, updates } = await run(
      [step('a', 'ok', { target: 'one' }), step('b', 'ok', { target: 'two' })],
      { ok }
    )
    expect(order).toEqual(['one', 'two'])
    expect(results.map((r) => [r.stepId, r.status, r.detail])).toEqual([
      ['a', 'pass', 'fine'],
      ['b', 'pass', 'fine']
    ])
    expect(updates[0]?.map((r) => r.status)).toEqual(['pending', 'pending'])
    expect(updates.some((u) => u[0]?.status === 'running')).toBe(true)
    expect(summarize(results)).toEqual({ passed: 2, failed: 0, skipped: 0, ok: true })
  })

  it('bước lỗi dừng runbook: các bước sau là "skipped", không chạy', async () => {
    const bad = kind(() => ({ ok: false, detail: 'HTTP 503' }))
    const never = kind(() => ({ ok: true, detail: '' }))
    const { results } = await run([step('a', 'bad'), step('b', 'never')], { bad, never })
    expect(results.map((r) => r.status)).toEqual(['fail', 'skipped'])
    expect(results[1]?.detail).toMatch(/earlier step failed/)
    expect(never.calls).toHaveLength(0)
    expect(summarize(results)).toMatchObject({ failed: 1, skipped: 1, ok: false })
  })

  it('continueOnFail: bước lỗi không dừng; kết quả chung vẫn là không đạt', async () => {
    const bad = kind(() => ({ ok: false, detail: 'down' }))
    const good = kind(() => ({ ok: true, detail: 'up' }))
    const { results } = await run(
      [step('a', 'bad', {}, { continueOnFail: true }), step('b', 'good')],
      { bad, good }
    )
    expect(results.map((r) => r.status)).toEqual(['fail', 'pass'])
    expect(summarize(results).ok).toBe(false)
  })

  it('biến {{x}} được thay vào tham số trước khi chạy; thiếu biến → bước lỗi, không chạy', async () => {
    const k = kind(() => ({ ok: true, detail: '' }))
    await run(
      [step('a', 'k', { target: 'https://{{host}}/h' })],
      { k },
      { values: { host: 'x.io' } }
    )
    expect(k.calls[0]).toMatchObject({ target: 'https://x.io/h' })
    const missing = kind(() => ({ ok: true, detail: '' }))
    const { results } = await run([step('a', 'missing', { target: '{{host}}' })], { missing })
    expect(results[0]).toMatchObject({ status: 'fail' })
    expect(results[0]?.detail).toMatch(/Missing value for: host/)
    expect(missing.calls).toHaveLength(0)
  })

  it('tham số sai theo schema của loại → "incomplete", nêu trường; loại lạ / module tắt → lỗi riêng', async () => {
    const k = kind(() => ({ ok: true, detail: '' }))
    const { results } = await run(
      [
        step('a', 'k', { n: 'not a number' }),
        step('b', 'ghost', {}, { continueOnFail: true }),
        step('c', 'off', {}, { continueOnFail: true })
      ],
      { k, off: 'disabled' }
    )
    // Bước a lỗi và dừng → b, c bỏ qua; chạy lại với continueOnFail để xem từng loại lỗi.
    expect(results[0]?.detail).toMatch(/This step is incomplete: n/)
    const second = await run([step('b', 'ghost', {}, { continueOnFail: true }), step('c', 'off')], {
      off: 'disabled'
    })
    expect(second.results[0]?.detail).toBe('Unknown step type “ghost”')
    expect(second.results[1]?.detail).toMatch(/module for this step is turned off/)
  })

  it('bước ném lỗi → fail với nguyên văn lỗi, đã che bí mật; đầu ra cũng được che và cắt', async () => {
    const boom = kind(() => {
      throw new Error('login failed password=hunter2')
    })
    const noisy = kind(() => ({
      ok: false,
      detail: 'exit 1',
      output: `${'x\n'.repeat(40)}API_KEY=abc`
    }))
    const r1 = await run([step('a', 'boom')], { boom })
    expect(r1.results[0]).toMatchObject({ status: 'fail', detail: 'login failed password=••••' })
    const r2 = await run([step('a', 'noisy')], { noisy })
    expect(r2.results[0]?.output?.split('\n')).toHaveLength(20)
    expect(r2.results[0]?.output).toContain('API_KEY=••••')
  })

  it('chặn theo kế hoạch: bước nằm trong plan.blocked không chạy, là "blocked", tính là lỗi', async () => {
    const cmd = kind(() => ({ ok: true, detail: '' }), { mutates: true })
    const { results } = await run(
      [step('a', 'cmd')],
      { cmd },
      {
        plan: { typed: [], blocked: new Map([['a', 'Frozen']]) }
      }
    )
    expect(results[0]?.status).toBe('blocked')
    expect(results[0]?.detail).toMatch(/read-only environment Frozen/)
    expect(cmd.calls).toHaveLength(0)
    expect(summarize(results).ok).toBe(false)
  })

  it('huỷ giữa chừng: bước đang chạy và các bước sau là "skipped"; không chạy tiếp', async () => {
    const controller = new AbortController()
    const slow = kind(
      () =>
        new Promise<StepOutcome>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => {
            reject(new Error('Cancelled'))
          })
          setTimeout(() => {
            controller.abort()
          }, 5)
        })
    )
    const after = kind(() => ({ ok: true, detail: '' }))
    const { results } = await run(
      [step('a', 'slow'), step('b', 'after')],
      { slow, after },
      {
        signal: controller.signal
      }
    )
    expect(results.map((r) => r.status)).toEqual(['skipped', 'skipped'])
    expect(after.calls).toHaveLength(0)
    // Huỷ trước khi bắt đầu: không bước nào chạy.
    const early = new AbortController()
    early.abort()
    const none = await run([step('a', 'after')], { after }, { signal: early.signal })
    expect(none.results[0]?.status).toBe('skipped')
  })

  it('đo thời gian từng bước', async () => {
    let t = 1000
    const k = kind(() => {
      t += 250
      return { ok: true, detail: '' }
    })
    const results = await executeRunbook({
      steps: [step('a', 'k')],
      values: {},
      kindOf: resolver({ k }),
      plan: NO_PLAN,
      signal: new AbortController().signal,
      onPrompt: () => undefined,
      onUpdate: () => undefined,
      now: () => t
    })
    expect(results[0]?.durationMs).toBe(250)
  })
})

describe('planRun — chính sách theo môi trường của đích', () => {
  const env = (p: Record<string, unknown>): string | null =>
    typeof p['target'] === 'string' ? p['target'] : null
  const check = kind(() => ({ ok: true, detail: '' }), { env })
  const cmd = kind(() => ({ ok: true, detail: '' }), { mutates: true, env })

  it('đích ở Production → phải gõ lại tên; đích ở môi trường thường → không', () => {
    const plan = planRun([step('a', 'check', { target: 'prod' })], resolver({ check }), envOf)
    expect(plan.typed).toEqual(['Production'])
    expect(
      planRun([step('a', 'check', { target: 'nowhere' })], resolver({ check }), envOf).typed
    ).toEqual([])
    expect(planRun([step('a', 'check', {})], resolver({ check }), envOf).typed).toEqual([])
  })

  it('môi trường chỉ đọc chặn bước lệnh nhưng KHÔNG chặn bước kiểm tra chỉ đọc', () => {
    const plan = planRun(
      [step('a', 'check', { target: 'frozen' }), step('b', 'cmd', { target: 'frozen' })],
      resolver({ check, cmd }),
      envOf
    )
    expect([...plan.blocked]).toEqual([['b', 'Frozen']])
  })

  it('môi trường quyết định theo đích của TỪNG bước; gom tên không trùng', () => {
    const plan = planRun(
      [
        step('a', 'check', { target: 'prod' }),
        step('b', 'cmd', { target: 'prod' }),
        step('c', 'cmd', { target: 'frozen' })
      ],
      resolver({ check, cmd }),
      envOf
    )
    expect(plan.typed).toEqual(['Production'])
    expect([...plan.blocked.keys()]).toEqual(['c'])
  })

  it('đích đặt bằng biến {{x}} được thay trước khi xét; tham số sai / loại tắt không làm hỏng kế hoạch', () => {
    const plan = planRun(
      [
        step('a', 'check', { target: '{{where}}' }),
        step('b', 'check', { n: 'bad' }),
        step('c', 'off'),
        step('d', 'ghost')
      ],
      resolver({ check, off: 'disabled' }),
      envOf,
      { where: 'prod' }
    )
    expect(plan.typed).toEqual(['Production'])
    // Thiếu biến: bỏ qua bước đó (lúc chạy sẽ báo lỗi biến), không ném.
    expect(() =>
      planRun([step('a', 'check', { target: '{{where}}' })], resolver({ check }), envOf)
    ).not.toThrow()
  })
})

describe('prepareKinds', () => {
  it('nạp dữ liệu của mỗi loại bước một lần trước khi tính kế hoạch (môi trường suy được)', async () => {
    // Loại bước chỉ biết môi trường của đích sau khi nạp (như danh sách context K8s).
    const loaded = { value: false }
    let calls = 0
    const prepare = (): Promise<void> => {
      calls++
      loaded.value = true
      return Promise.resolve()
    }
    const k8s: StepKind = {
      ...kind(() => ({ ok: true, detail: '' }), { env: () => (loaded.value ? 'prod' : null) }),
      prepare
    }
    // Resolver trả bản sao mỗi lần (như renderer) — vẫn chỉ nạp một lần.
    const kindOf: KindResolver = (type) => (type === 'k8s.rollout' ? { ...k8s } : undefined)
    const steps = [step('a', 'k8s.rollout'), step('b', 'k8s.rollout'), step('c', 'nope')]
    expect(planRun(steps, kindOf, envOf).typed).toEqual([])
    await prepareKinds(steps, kindOf)
    expect(calls).toBe(1)
    expect(planRun(steps, kindOf, envOf).typed).toEqual(['Production'])
  })

  it('nạp lỗi không chặn runbook', async () => {
    const failing: StepKind = {
      ...kind(() => ({ ok: true, detail: '' })),
      prepare: () => Promise.reject(new Error('offline'))
    }
    await expect(prepareKinds([step('a', 'x')], resolver({ x: failing }))).resolves.toBeUndefined()
  })
})
