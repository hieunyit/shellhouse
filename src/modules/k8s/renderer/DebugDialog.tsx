import { useState } from 'react'
import { Bug } from 'lucide-react'
import { Button, Field, Input, Modal, Notice, Select } from '../../../renderer/src/components/ui'
import { cleanError } from '../../../renderer/src/lib/format'
import { confirmAction, onTabClosed, t, toast } from '../../registry/renderer-kit'
import type { ContextRef, K8sOp } from '../shared/ops'
import type { K8sObject } from '../shared/resources'
import { containersOf } from './actions'
import { openPodShell } from './api'
import { useClusterGuard } from './confirm'

type Request = <T>(op: K8sOp) => Promise<T>

/** Image debug hay dùng (như gợi ý của kubectl / k9s). */
const IMAGES = [
  { value: 'busybox:1.36', hint: 'sh, ps, top, wget, nslookup' },
  { value: 'nicolaka/netshoot', hint: 'tcpdump, dig, curl, iperf, ss, nmap' },
  { value: 'alpine:3.20', hint: 'sh, apk add …' },
  { value: 'ubuntu:24.04', hint: 'bash, apt-get …' }
]
const CUSTOM = '__custom'

/**
 * `kubectl debug` trong app: container debug tạm thời trong pod (chia sẻ namespace tiến trình với
 * container đích) hoặc pod debug đặc quyền trên node (/ của node ở /host). Mở terminal gắn vào nó.
 * Pod debug node: đóng tab terminal → hỏi xoá pod.
 */
export function DebugDialog({
  target,
  obj,
  request,
  contextRef,
  bastionHostId,
  namespaces,
  defaultNamespace,
  onClose
}: {
  target: 'pod' | 'node'
  obj: K8sObject
  request: Request
  contextRef: ContextRef
  bastionHostId: string | undefined
  /** Namespace chọn được cho pod debug node. */
  namespaces: readonly string[]
  defaultNamespace: string
  onClose: () => void
}): React.JSX.Element {
  const { guard } = useClusterGuard()
  const [preset, setPreset] = useState(IMAGES[0]?.value ?? 'busybox')
  const [custom, setCustom] = useState('')
  const containers = containersOf(obj)
  const [container, setContainer] = useState(containers[0] ?? '')
  const [namespace, setNamespace] = useState(defaultNamespace)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const image = preset === CUSTOM ? custom.trim() : preset
  const validImage = /^[a-z0-9][\w./:@-]*$/i.test(image)
  const name = obj.metadata.name

  const start = (): void => {
    if (busy || !validImage) return
    void (async () => {
      const ok = await guard({
        title:
          target === 'pod'
            ? t('Debug {name}?', { name })
            : t('Start a privileged debug pod on {name}?', { name }),
        message:
          target === 'pod'
            ? t(
                'Adds an ephemeral container to the pod. It stays in the pod spec until the pod is replaced.'
              )
            : t('The pod can see every process and file on the node.'),
        confirmLabel: t('Start debugging'),
        name,
        onlyProduction: true
      })
      if (!ok) return
      setBusy(true)
      setError(null)
      try {
        if (target === 'pod') {
          const r = await request<{ container: string }>({
            op: 'debug.ephemeral',
            namespace: obj.metadata.namespace ?? '',
            pod: name,
            image,
            ...(container ? { target: container } : {})
          })
          openPodShell(
            {
              ref: contextRef,
              namespace: obj.metadata.namespace ?? '',
              pod: name,
              container: r.container,
              attach: true,
              banner: t('Debug container {container} ({image}) in pod {pod}. Type exit to leave.', {
                container: r.container,
                image,
                pod: name
              })
            },
            bastionHostId
          )
          toast.success(t('Debug container {container} started', { container: r.container }))
        } else {
          const r = await request<{ namespace: string; pod: string; container: string }>({
            op: 'debug.node',
            node: name,
            image,
            namespace
          })
          const tabId = openPodShell(
            {
              ref: contextRef,
              namespace: r.namespace,
              pod: r.pod,
              container: r.container,
              attach: true,
              banner: t(
                'Debug pod {pod} on node {node}. The node’s file system is at /host — run “chroot /host” for a shell on the node.',
                { pod: r.pod, node: name }
              )
            },
            bastionHostId
          )
          const remove = (): void => {
            void toast
              .promise(
                request({
                  op: 'delete',
                  kind: 'pods',
                  namespace: r.namespace,
                  name: r.pod,
                  force: true
                }),
                {
                  loading: t('Deleting debug pod {pod}…', { pod: r.pod }),
                  success: t('Deleted debug pod {pod}', { pod: r.pod }),
                  error: t('Could not delete debug pod {pod}', { pod: r.pod })
                }
              )
              .catch(() => undefined)
          }
          // Đóng terminal → hỏi dọn pod (pod đặc quyền không nên để lại trên node).
          onTabClosed(tabId, () => {
            void confirmAction({
              title: t('Delete debug pod {pod}?', { pod: r.pod }),
              message: t('The privileged pod is still running on {node}.', { node: name }),
              confirmLabel: t('Delete pod'),
              danger: true
            }).then((yes) => {
              if (yes) remove()
            })
          })
          toast.success(t('Debug pod {pod} is running', { pod: r.pod }), {
            action: { label: t('Delete pod'), run: remove }
          })
        }
        onClose()
      } catch (e) {
        setError(cleanError(e))
        setBusy(false)
      }
    })()
  }

  return (
    <Modal
      title={target === 'pod' ? t('Debug pod {name}', { name }) : t('Debug node {name}', { name })}
      description={
        target === 'pod'
          ? t(
              'Starts a debug container inside the running pod and opens a shell in it (kubectl debug).'
            )
          : t(
              'Starts a privileged pod on the node (host PID and network, node files at /host) and opens a shell in it.'
            )
      }
      onClose={onClose}
      testId="k8s-debug-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            variant="primary"
            icon={<Bug size={13} />}
            disabled={busy || !validImage}
            data-testid="k8s-debug-start"
            onClick={start}
          >
            {busy ? t('Starting…') : t('Start debugging')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field
          label={t('Image')}
          hint={IMAGES.find((i) => i.value === preset)?.hint ?? t('Any image with a shell')}
        >
          <Select
            value={preset}
            data-testid="k8s-debug-image"
            onChange={(e) => {
              setPreset(e.target.value)
            }}
          >
            {IMAGES.map((i) => (
              <option key={i.value} value={i.value}>
                {i.value}
              </option>
            ))}
            <option value={CUSTOM}>{t('Other image…')}</option>
          </Select>
        </Field>
        {preset === CUSTOM && (
          <Input
            mono
            autoFocus
            placeholder="registry/image:tag"
            aria-label={t('Image')}
            data-testid="k8s-debug-custom-image"
            value={custom}
            onChange={(e) => {
              setCustom(e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') start()
            }}
          />
        )}
        {target === 'pod' && containers.length > 0 && (
          <Field
            label={t('Target container')}
            hint={t('Shares its process namespace — ps shows the app’s processes.')}
          >
            <Select
              value={container}
              data-testid="k8s-debug-target"
              onChange={(e) => {
                setContainer(e.target.value)
              }}
            >
              {containers.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
              <option value="">{t('None (separate processes)')}</option>
            </Select>
          </Field>
        )}
        {target === 'node' && (
          <Field label={t('Namespace for the debug pod')}>
            <Select
              value={namespace}
              onChange={(e) => {
                setNamespace(e.target.value)
              }}
            >
              {[...new Set([defaultNamespace, ...namespaces])].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {target === 'node' && (
          <Notice tone="warning">
            {t(
              'Privileged access to the node. You will be asked to delete the pod when you close the terminal.'
            )}
          </Notice>
        )}
        {busy && (
          <p className="text-xs text-faint">
            {t('Waiting for the container to start — pulling the image can take a while…')}
          </p>
        )}
        {error && (
          <Notice tone="danger" testId="k8s-debug-error">
            {error}
          </Notice>
        )}
      </div>
    </Modal>
  )
}
