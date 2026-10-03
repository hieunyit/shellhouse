import { randomBytes } from 'node:crypto'
import { t } from '@shared/i18n'
import type { K8sObject } from '../shared/resources'
import type { KubeClient } from './client'

/**
 * `kubectl debug` (ADR-014 mục 7.4): container debug tạm thời trong pod đang chạy, hoặc pod debug
 * đặc quyền trên một node. Cả hai bật stdin + TTY → terminal gắn (attach) vào tiến trình chính.
 */

const ns = (n: string): string => `/namespaces/${encodeURIComponent(n)}`
const sig = (signal?: AbortSignal): { signal?: AbortSignal } => (signal ? { signal } : {})

/** Chờ container chạy tối đa chừng này (kéo image lần đầu có thể lâu) — test chỉnh được. */
export const debugWait = { timeoutMs: 120_000, pollMs: 1000 }

/** Lý do chờ không bao giờ tự hết → báo ngay, không đợi tới hết giờ. */
const FATAL_WAITING = new Set([
  'ErrImagePull',
  'ImagePullBackOff',
  'InvalidImageName',
  'CreateContainerConfigError',
  'CreateContainerError',
  'RunContainerError'
])

/** Nhãn đánh dấu pod debug do Shellhouse tạo (dễ tìm / dọn). */
export const DEBUG_LABEL = 'shellhouse.dev/debug'

interface ContainerStatus {
  name: string
  state?: {
    running?: unknown
    waiting?: { reason?: string; message?: string }
    terminated?: { reason?: string; exitCode?: number; message?: string }
  }
}

const suffix = (): string => randomBytes(3).toString('hex').slice(0, 5)

/** Chờ container `name` của pod chạy (trong `field` của status: containerStatuses / ephemeral…). */
async function waitRunning(
  client: KubeClient,
  path: string,
  field: 'containerStatuses' | 'ephemeralContainerStatuses',
  name: string,
  signal?: AbortSignal
): Promise<void> {
  const deadline = Date.now() + debugWait.timeoutMs
  for (;;) {
    const pod = await client.json<K8sObject>('GET', path, sig(signal))
    const statuses = (pod.status?.[field] as ContainerStatus[] | undefined) ?? []
    const st = statuses.find((s) => s.name === name)?.state
    if (st?.running) return
    if (st?.terminated)
      throw new Error(
        t('The debug container exited ({reason})', {
          reason: st.terminated.reason ?? `exit ${String(st.terminated.exitCode ?? '?')}`
        })
      )
    if (st?.waiting?.reason && FATAL_WAITING.has(st.waiting.reason))
      throw new Error(`${st.waiting.reason}${st.waiting.message ? `: ${st.waiting.message}` : ''}`)
    if (pod.status?.['phase'] === 'Failed' || pod.status?.['phase'] === 'Succeeded')
      throw new Error(t('The debug pod stopped ({phase})', { phase: pod.status['phase'] }))
    if (signal?.aborted) throw new Error('Cancelled')
    if (Date.now() > deadline)
      throw new Error(
        t('The debug container did not start in time{reason}', {
          reason: st?.waiting?.reason ? ` (${st.waiting.reason})` : ''
        })
      )
    await new Promise((r) => setTimeout(r, debugWait.pollMs))
  }
}

/**
 * Thêm container debug tạm thời (ephemeral) vào pod: PATCH subresource ephemeralcontainers (strategic
 * merge — giữ container debug cũ), `target` = container chia sẻ namespace tiến trình (thấy tiến trình
 * của app). Trả tên container khi nó đã chạy.
 */
export async function debugEphemeral(
  client: KubeClient,
  namespace: string,
  pod: string,
  image: string,
  target: string | undefined,
  signal?: AbortSignal
): Promise<{ container: string }> {
  const path = `/api/v1${ns(namespace)}/pods/${encodeURIComponent(pod)}`
  const current = await client.json<K8sObject>('GET', path, sig(signal))
  const taken = new Set(
    ['containers', 'initContainers', 'ephemeralContainers'].flatMap((k) =>
      ((current.spec?.[k] as { name: string }[] | undefined) ?? []).map((c) => c.name)
    )
  )
  let name = `debugger-${suffix()}`
  while (taken.has(name)) name = `debugger-${suffix()}`
  await client.json('PATCH', `${path}/ephemeralcontainers`, {
    body: {
      spec: {
        ephemeralContainers: [
          {
            name,
            image,
            imagePullPolicy: 'IfNotPresent',
            stdin: true,
            tty: true,
            terminationMessagePolicy: 'File',
            ...(target ? { targetContainerName: target } : {})
          }
        ]
      }
    },
    contentType: 'application/strategic-merge-patch+json',
    ...sig(signal)
  })
  await waitRunning(client, path, 'ephemeralContainerStatuses', name, signal)
  return { container: name }
}

/** Đặc tả pod debug node (như `kubectl debug node/<n> --profile=sysadmin`). */
export function nodeDebugPod(node: string, image: string, name: string): K8sObject {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      labels: { 'app.kubernetes.io/managed-by': 'shellhouse', [DEBUG_LABEL]: 'node' }
    },
    spec: {
      nodeName: node,
      hostPID: true,
      hostNetwork: true,
      hostIPC: true,
      restartPolicy: 'Never',
      terminationGracePeriodSeconds: 0,
      // Chạy được trên node có taint (control plane, NoSchedule…).
      tolerations: [{ operator: 'Exists' }],
      containers: [
        {
          name: 'debugger',
          image,
          imagePullPolicy: 'IfNotPresent',
          stdin: true,
          tty: true,
          securityContext: { privileged: true },
          volumeMounts: [{ name: 'host-root', mountPath: '/host' }]
        }
      ],
      volumes: [{ name: 'host-root', hostPath: { path: '/' } }]
    }
  }
}

/** Tạo pod debug trên node, chờ chạy. Pod không tự xoá — người dùng dọn khi đóng terminal. */
export async function debugNode(
  client: KubeClient,
  node: string,
  image: string,
  namespace: string,
  signal?: AbortSignal
): Promise<{ namespace: string; pod: string; container: string }> {
  // Tên pod ≤ 63 ký tự (DNS label) — tên node dài thì cắt.
  const base = `node-debugger-${node}`.slice(0, 56).replace(/[.-]+$/, '')
  const name = `${base}-${suffix()}`
  await client.json('POST', `/api/v1${ns(namespace)}/pods`, {
    body: nodeDebugPod(node, image, name),
    ...sig(signal)
  })
  const path = `/api/v1${ns(namespace)}/pods/${encodeURIComponent(name)}`
  try {
    await waitRunning(client, path, 'containerStatuses', 'debugger', signal)
  } catch (error) {
    // Không chạy được → dọn luôn (không để pod đặc quyền treo trên node).
    await client.json('DELETE', path, { query: { gracePeriodSeconds: 0 } }).catch(() => undefined)
    throw error
  }
  return { namespace, pod: name, container: 'debugger' }
}
