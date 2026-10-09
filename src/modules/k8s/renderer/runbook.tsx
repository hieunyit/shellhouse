import { useEffect } from 'react'
import { Rocket } from 'lucide-react'
import { z } from 'zod'
import { Field, Input, Select } from '../../../renderer/src/components/ui'
import {
  environmentFromColor,
  runInModuleSession,
  sourceEnvironmentId,
  t
} from '../../registry/renderer-kit'
import { defineRunbookStep, type RunbookStepContext } from '../../registry/renderer-types'
import { ROLLOUT_KINDS, rolloutState, type RolloutKind } from '../shared/rollout'
import { useK8s } from './store'

/** Bước runbook: chờ một Deployment / StatefulSet / DaemonSet sẵn sàng (đóng góp cho module Runbook). */
const Params = z.object({
  /** `ContextEntry.key` của context. */
  context: z.string().max(400),
  kind: z.enum(ROLLOUT_KINDS),
  namespace: z.string().trim().max(253),
  name: z.string().trim().max(253)
})
type Params = z.infer<typeof Params>

const KIND_LABEL: Record<RolloutKind, () => string> = {
  'deployments.apps': () => 'Deployment',
  'statefulsets.apps': () => 'StatefulSet',
  'daemonsets.apps': () => 'DaemonSet'
}

/** Hỏi lại trạng thái mỗi chừng này — đủ thưa để không dồn API, đủ nhanh để thấy khi vừa xong. */
const POLL_MS = 2000

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done)
  })

async function run(p: Params, ctx: RunbookStepContext): Promise<{ ok: boolean; detail: string }> {
  if (!useK8s.getState().loaded) await useK8s.getState().reload()
  const entry = useK8s.getState().contexts.find((c) => c.key === p.context)
  if (!entry)
    return { ok: false, detail: t('This cluster context is no longer in your kubeconfig.') }
  if (!p.name) return { ok: false, detail: t('Enter the name of the workload to check.') }
  const bastion = entry.settings.bastionHostId
  return runInModuleSession(
    'k8s',
    bastion
      ? { kind: 'ssh', hostId: bastion }
      : { kind: 'module', sessionKind: 'cluster', params: {} },
    ctx,
    async (client, remaining) => {
      // Chỉ đọc: bước kiểm tra không được đổi gì trên cluster.
      await client.request({ op: 'connect', ref: entry.ref, readOnly: true }, ctx.signal)
      for (;;) {
        const obj = await client.request(
          {
            op: 'get',
            kind: p.kind,
            ...(p.namespace ? { namespace: p.namespace } : {}),
            name: p.name,
            format: 'json'
          },
          ctx.signal
        )
        const state = rolloutState(p.kind, obj)
        if (state.ready) return { ok: true, detail: state.detail }
        if (remaining() < POLL_MS) return { ok: false, detail: state.detail }
        await sleep(POLL_MS, ctx.signal)
      }
    }
  )
}

export const rolloutStep = defineRunbookStep<Params>({
  label: () => t('Kubernetes: rollout is ready'),
  icon: Rocket,
  params: Params,
  defaults: () => ({ context: '', kind: 'deployments.apps', namespace: '', name: '' }),
  summary: (p) => {
    const entry = useK8s.getState().contexts.find((c) => c.key === p.context)
    return `${KIND_LABEL[p.kind]()} ${p.namespace ? `${p.namespace}/` : ''}${p.name || '…'}${entry ? ` · ${entry.name}` : ''}`
  },
  prepare: async () => {
    if (!useK8s.getState().loaded) await useK8s.getState().reload()
  },
  environmentOf: (p) => {
    if (!p.context) return null
    // Môi trường người dùng chọn cho context không cần danh sách context; chỉ màu cũ mới cần.
    const entry = useK8s.getState().contexts.find((c) => c.key === p.context)
    return sourceEnvironmentId(
      'k8s',
      p.context,
      entry ? environmentFromColor(entry.settings.color ?? null) : undefined
    )
  },
  Editor: ({ value, onChange }) => {
    const contexts = useK8s((s) => s.contexts)
    useEffect(() => {
      void useK8s.getState().reload()
    }, [])
    const set = (patch: Partial<Params>): void => {
      onChange({ ...value, ...patch })
    }
    return (
      <div className="flex flex-col gap-3" data-testid="runbook-step-k8s">
        <Field label={t('Cluster context')}>
          <Select
            value={value.context}
            data-testid="runbook-k8s-context"
            onChange={(e) => {
              set({ context: e.target.value })
            }}
          >
            <option value="">{t('Choose a context…')}</option>
            {contexts.map((c) => (
              <option key={c.key} value={c.key}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-[10rem_1fr_1fr] gap-3">
          <Field label={t('Kind')}>
            <Select
              value={value.kind}
              data-testid="runbook-k8s-kind"
              onChange={(e) => {
                set({ kind: e.target.value as RolloutKind })
              }}
            >
              {ROLLOUT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]()}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('Namespace')}>
            <Input
              mono
              placeholder="shop"
              data-testid="runbook-k8s-namespace"
              value={value.namespace}
              onChange={(e) => {
                set({ namespace: e.target.value })
              }}
            />
          </Field>
          <Field label={t('Name')}>
            <Input
              mono
              placeholder="web"
              data-testid="runbook-k8s-name"
              value={value.name}
              onChange={(e) => {
                set({ name: e.target.value })
              }}
            />
          </Field>
        </div>
      </div>
    )
  },
  run
})
