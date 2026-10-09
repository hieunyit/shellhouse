import { useEffect } from 'react'
import { Container } from 'lucide-react'
import { z } from 'zod'
import { Field, Input, Select } from '../../../renderer/src/components/ui'
import {
  hostEnvironmentId,
  runInModuleSession,
  sourceEnvironmentId,
  t
} from '../../registry/renderer-kit'
import { defineRunbookStep, type RunbookStepContext } from '../../registry/renderer-types'
import { CONTAINER_EXPECTS, containerCheck, type ContainerExpect } from '../shared/container-check'
import { endpointId, tcpIdOf, wslDistroOf } from '../shared/ipc'
import type { ContainerRow } from '../shared/ops'
import { sourceLabel } from './api'
import { useDocker } from './store'

/** Bước runbook: container đang chạy / healthy (đóng góp cho module Runbook). */
const Params = z.object({
  /** Nguồn Docker: '' = máy này, `wsl:<distro>`, `tcp:<id>` hoặc id host SSH. */
  source: z.string().max(200),
  container: z.string().trim().max(256),
  expect: z.enum(CONTAINER_EXPECTS)
})
type Params = z.infer<typeof Params>

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

const hostOf = (source: string): string | null => (source === '' ? null : source)

/** Cùng quy tắc chọn đích với tab Docker (`useDockerSession`). */
function targetOf(source: string): Parameters<typeof runInModuleSession>[1] {
  const wsl = wslDistroOf(source)
  const tcp = tcpIdOf(source)
  if (wsl) return { kind: 'module', sessionKind: 'engine', params: { wsl } }
  if (tcp) return { kind: 'module', sessionKind: 'engine', params: { tcp } }
  if (source) return { kind: 'ssh', hostId: source }
  return { kind: 'module', sessionKind: 'engine', params: {} }
}

async function run(p: Params, ctx: RunbookStepContext): Promise<{ ok: boolean; detail: string }> {
  if (!p.container) return { ok: false, detail: t('Enter the name of the container to check.') }
  const sshHost = p.source && !wslDistroOf(p.source) && !tcpIdOf(p.source) ? p.source : undefined
  return runInModuleSession('docker', targetOf(p.source), ctx, async (client, remaining) => {
    // Chỉ đọc: bước kiểm tra không được đổi gì trên engine.
    await client.request(
      { op: 'configure', readOnly: true, ...(sshHost ? { hostId: sshHost } : {}) },
      ctx.signal
    )
    for (;;) {
      const rows = await client.request<ContainerRow[]>({ op: 'containers', all: true }, ctx.signal)
      const check = containerCheck(rows, p.container, p.expect)
      if (check.ok) return { ok: true, detail: check.detail }
      // Vừa deploy xong thì container có thể đang được tạo lại — chờ tới hết giờ, trừ khi vô vọng.
      if (check.hopeless || remaining() < POLL_MS) return { ok: false, detail: check.detail }
      await sleep(POLL_MS, ctx.signal)
    }
  })
}

const EXPECT_LABEL: Record<ContainerExpect, () => string> = {
  running: () => t('Running'),
  healthy: () => t('Healthy (health check passes)')
}

export const containerStep = defineRunbookStep<Params>({
  label: () => t('Docker: container is healthy'),
  icon: Container,
  params: Params,
  defaults: () => ({ source: '', container: '', expect: 'running' }),
  summary: (p) =>
    `${p.container || '…'} · ${p.expect === 'healthy' ? t('healthy') : t('running')} · ${sourceLabel(hostOf(p.source))}`,
  environmentOf: (p) =>
    sourceEnvironmentId(
      'docker',
      endpointId(hostOf(p.source)),
      hostEnvironmentId(hostOf(p.source)) ?? undefined
    ),
  Editor: ({ value, onChange }) => {
    const endpoints = useDocker((s) => s.endpoints)
    const tcp = useDocker((s) => s.tcp)
    useEffect(() => {
      void useDocker.getState().reload()
    }, [])
    const set = (patch: Partial<Params>): void => {
      onChange({ ...value, ...patch })
    }
    // "Máy này" luôn có; các nguồn đã thêm (host SSH, WSL, engine TCP còn tồn tại).
    const sources = [
      '',
      ...endpoints
        .map((e) => e.hostId)
        .filter((h): h is string => h !== null)
        .filter((h) => {
          const id = tcpIdOf(h)
          return id === null || tcp.some((x) => x.id === id)
        })
    ]
    if (value.source !== '' && !sources.includes(value.source)) sources.push(value.source)
    return (
      <div className="flex flex-col gap-3" data-testid="runbook-step-docker">
        <Field label={t('Docker endpoint')}>
          <Select
            value={value.source}
            data-testid="runbook-docker-source"
            onChange={(e) => {
              set({ source: e.target.value })
            }}
          >
            {sources.map((s) => (
              <option key={s} value={s}>
                {sourceLabel(hostOf(s))}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-[1fr_14rem] gap-3">
          <Field label={t('Container name')}>
            <Input
              mono
              placeholder="web"
              data-testid="runbook-docker-container"
              value={value.container}
              onChange={(e) => {
                set({ container: e.target.value })
              }}
            />
          </Field>
          <Field label={t('Expect')}>
            <Select
              value={value.expect}
              data-testid="runbook-docker-expect"
              onChange={(e) => {
                set({ expect: e.target.value as ContainerExpect })
              }}
            >
              {CONTAINER_EXPECTS.map((x) => (
                <option key={x} value={x}>
                  {EXPECT_LABEL[x]()}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </div>
    )
  },
  run
})
