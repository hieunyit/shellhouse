import type { ZodType } from 'zod'
import { t } from '@shared/i18n'
import type { SessionPool } from '../../registry/renderer-session'
import { maskSecrets, renderParams, tailOutput, type RunbookStep, type StepResult } from './runbook'

/**
 * Chạy một runbook (ADR-016): tuần tự, dừng ở bước lỗi đầu tiên (trừ `continueOnFail`), áp chính
 * sách an toàn theo MÔI TRƯỜNG của các đích. Thuần — loại bước, môi trường và giờ đều đưa vào, nên
 * test không cần Session Host hay giao diện.
 */

export interface StepOutcome {
  ok: boolean
  detail: string
  output?: string
}

export type PromptFn = (
  prompt: { id: number; request: unknown } | null,
  answer: (ok: boolean, answers: string[]) => void
) => void

export interface StepKind {
  label(): string
  params: ZodType
  /** Nạp dữ liệu cần cho `environmentOf` / `run` (xem `RunbookStepKind.prepare`). */
  prepare?: () => Promise<void>
  /** Id môi trường của đích; null = không có. */
  environmentOf(params: never): string | null
  /** Có thể thay đổi thứ gì đó (chỉ bước lệnh) — bị chặn ở môi trường chỉ đọc. */
  mutates: boolean
  run(
    params: never,
    ctx: { signal: AbortSignal; timeoutMs: number; onPrompt: PromptFn; pool?: SessionPool }
  ): Promise<StepOutcome>
}

/** `undefined` = không có loại này; 'disabled' = module đóng góp loại này đang tắt. */
export type KindResolver = (type: string) => StepKind | 'disabled' | undefined

export interface EnvInfo {
  id: string
  name: string
  /** `type` = phải gõ lại tên trước khi làm việc nguy hiểm (Production). */
  confirm: 'type' | 'confirm' | 'undo'
  readOnly: boolean
}

export interface RunPlan {
  /** Tên các môi trường buộc phải gõ lại tên runbook (rỗng = không cần). */
  typed: string[]
  /** Bước `command` nhắm vào môi trường chỉ đọc: id bước → tên môi trường. */
  blocked: Map<string, string>
}

/**
 * Chính sách chạy: môi trường của đích mỗi bước (qua loại bước) quyết định. Đích thuộc môi trường
 * `type` → gõ lại tên runbook; bước `command` ở môi trường chỉ đọc → chặn (không biết lệnh có ghi
 * không). Bước kiểm tra chỉ đọc (http, k8s, docker) vẫn chạy ở môi trường chỉ đọc.
 */
export function planRun(
  steps: readonly RunbookStep[],
  kindOf: KindResolver,
  envOf: (id: string) => EnvInfo | undefined,
  values: Readonly<Record<string, string>> = {}
): RunPlan {
  const typed = new Set<string>()
  const blocked = new Map<string, string>()
  for (const step of steps) {
    const kind = kindOf(step.type)
    if (!kind || kind === 'disabled') continue
    let params: unknown
    try {
      params = kind.params.safeParse(renderParams(step.params, values))
    } catch {
      continue
    }
    const parsed = params as { success: boolean; data?: unknown }
    if (!parsed.success) continue
    const envId = kind.environmentOf(parsed.data as never)
    const env = envId ? envOf(envId) : undefined
    if (!env) continue
    if (env.confirm === 'type') typed.add(env.name)
    if (kind.mutates && env.readOnly) blocked.set(step.id, env.name)
  }
  return { typed: [...typed], blocked }
}

/** Gọi `prepare` của mọi loại bước runbook dùng (mỗi loại một lần) — trước `planRun`. */
export async function prepareKinds(
  steps: readonly RunbookStep[],
  kindOf: KindResolver
): Promise<void> {
  // Theo hàm (resolver có thể trả bản sao của cùng một loại).
  const prepares = new Set<() => Promise<void>>()
  for (const step of steps) {
    const kind = kindOf(step.type)
    if (kind && kind !== 'disabled' && kind.prepare) prepares.add(kind.prepare)
  }
  // Nạp hỏng thì `environmentOf` / `run` tự báo — không chặn cả runbook ở đây.
  await Promise.all([...prepares].map((prepare) => prepare().catch(() => undefined)))
}

export interface ExecuteDeps {
  steps: readonly RunbookStep[]
  values: Readonly<Record<string, string>>
  kindOf: KindResolver
  plan: RunPlan
  signal: AbortSignal
  onPrompt: PromptFn
  /** Phiên dùng chung theo đích trong lần chạy này (người gọi đóng khi xong). */
  pool?: SessionPool
  onUpdate(results: StepResult[]): void
  now?: () => number
}

export function summarize(results: readonly StepResult[]): {
  passed: number
  failed: number
  skipped: number
  ok: boolean
} {
  const count = (s: StepResult['status'][]): number =>
    results.filter((r) => s.includes(r.status)).length
  const failed = count(['fail', 'blocked'])
  return {
    passed: count(['pass']),
    failed,
    skipped: count(['skipped']),
    ok: failed === 0 && results.every((r) => r.status === 'pass')
  }
}

function errorText(e: unknown): string {
  return maskSecrets(e instanceof Error ? e.message : String(e))
}

export async function executeRunbook(deps: ExecuteDeps): Promise<StepResult[]> {
  const now = deps.now ?? Date.now
  const results: StepResult[] = deps.steps.map((s) => ({
    stepId: s.id,
    status: 'pending',
    detail: ''
  }))
  const publish = (): void => {
    deps.onUpdate(results.map((r) => ({ ...r })))
  }
  const set = (i: number, patch: Partial<StepResult>): void => {
    results[i] = { ...(results[i] as StepResult), ...patch }
    publish()
  }
  publish()
  // Trong một đối tượng: `fail` (hàm lồng) sửa nó, TS không theo dõi được qua closure.
  const flow: { stopped: 'failed' | 'cancelled' | null } = { stopped: null }
  for (const [i, step] of deps.steps.entries()) {
    if (flow.stopped === null && deps.signal.aborted) flow.stopped = 'cancelled'
    if (flow.stopped) {
      set(i, {
        status: 'skipped',
        detail: flow.stopped === 'cancelled' ? t('Stopped') : t('Skipped — an earlier step failed')
      })
      continue
    }
    const fail = (
      detail: string,
      status: StepResult['status'] = 'fail',
      extra: Partial<StepResult> = {}
    ): void => {
      set(i, { status, detail, ...extra })
      if (!step.continueOnFail) flow.stopped = 'failed'
    }
    const blockedBy = deps.plan.blocked.get(step.id)
    if (blockedBy !== undefined) {
      fail(
        t('Blocked: commands do not run on the read-only environment {env}', { env: blockedBy }),
        'blocked'
      )
      continue
    }
    const kind = deps.kindOf(step.type)
    if (kind === undefined) {
      fail(t('Unknown step type “{type}”', { type: step.type }))
      continue
    }
    if (kind === 'disabled') {
      fail(t('The module for this step is turned off — turn it on in Settings › Modules'))
      continue
    }
    let params: unknown
    try {
      const parsed = kind.params.safeParse(renderParams(step.params, deps.values))
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        fail(
          t('This step is incomplete: {what}', {
            what: issue ? `${issue.path.join('.') || '—'} — ${issue.message}` : '—'
          })
        )
        continue
      }
      params = parsed.data
    } catch (e) {
      fail(errorText(e))
      continue
    }
    const started = now()
    set(i, { status: 'running', detail: '' })
    try {
      const outcome = await kind.run(params as never, {
        signal: deps.signal,
        timeoutMs: step.timeoutSec * 1000,
        onPrompt: deps.onPrompt,
        ...(deps.pool ? { pool: deps.pool } : {})
      })
      const output = outcome.output ? tailOutput(outcome.output) : undefined
      const base = {
        detail: maskSecrets(outcome.detail),
        durationMs: now() - started,
        ...(output ? { output } : {})
      }
      if (outcome.ok) set(i, { status: 'pass', ...base })
      else fail(base.detail, 'fail', { durationMs: base.durationMs, ...(output ? { output } : {}) })
    } catch (e) {
      if (deps.signal.aborted) {
        set(i, { status: 'skipped', detail: t('Stopped'), durationMs: now() - started })
        flow.stopped = 'cancelled'
      } else fail(errorText(e), 'fail', { durationMs: now() - started })
    }
  }
  return results
}
