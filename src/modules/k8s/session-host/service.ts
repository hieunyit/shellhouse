import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { parse as parseYaml, stringify as toYaml } from 'yaml'
import type WebSocket from 'ws'
import type { HostModuleSession, TerminalSize } from '../../registry/host-types'
import type { Transport, TransportCallbacks } from '../../../session-host/transport/types'
import {
  K8sOp,
  K8sTerminalParams,
  isMutating,
  type ContextRef,
  type DiscoveredKind,
  type PortForwardInfo
} from '../shared/ops'
import {
  BUILTIN_KINDS,
  hideSecretValues,
  resourcePath,
  slim,
  type K8sObject,
  type ResourceKind
} from '../shared/resources'
import { KubeClient, KubeError, type RawConnect } from './client'
import { credentialProvider, type AuthConfig } from './auth'

/** Kết quả `fromMain('resolve')` (xem main/kubeconfig.ts). */
export interface ResolvedClusterConfig {
  name: string
  server: string
  ca?: string
  insecure: boolean
  tlsServerName?: string
  namespace: string
  auth: AuthConfig
}

export interface K8sServiceDeps {
  resolve(ref: ContextRef): Promise<ResolvedClusterConfig>
  rawConnect: RawConnect
  spawn: import('../../registry/host-types').LimitedSpawn
  emit(event: string, data: unknown): void
  log(level: 'info' | 'warn' | 'error', message: string): void
}

/** Nhóm API có sẵn của Kubernetes — tài nguyên nhóm khác là CRD ("Custom resources"). */
function isBuiltinGroup(group: string): boolean {
  return (
    group === '' ||
    group.endsWith('.k8s.io') ||
    ['apps', 'batch', 'autoscaling', 'policy', 'extensions', 'events'].includes(group)
  )
}

const WATCH_FLUSH_MS = 100

export const DEFAULT_POD_SHELL = [
  'sh',
  '-c',
  'command -v bash >/dev/null 2>&1 && exec bash || exec sh'
]

interface SharedWatch {
  subscribers: Set<string>
  controller: AbortController
  pending: { type: 'ADDED' | 'MODIFIED' | 'DELETED'; object: unknown }[]
  timer: NodeJS.Timeout | null
}

interface Forward {
  info: PortForwardInfo
  server: Server
  sockets: Set<Socket>
}

export class K8sService implements HostModuleSession {
  private client: KubeClient | null = null
  private cluster: ResolvedClusterConfig | null = null
  private readOnly = false
  private kinds = new Map<string, ResourceKind>(BUILTIN_KINDS.map((k) => [k.id, k]))
  private readonly subscriptions = new Map<string, () => void>()
  private readonly watches = new Map<string, SharedWatch>()
  private readonly forwards = new Map<string, Forward>()
  private readonly edits = new Map<string, () => void>()
  private disposed = false

  constructor(private readonly deps: K8sServiceDeps) {}

  private async connect(ref: ContextRef): Promise<KubeClient> {
    const cluster = await this.deps.resolve(ref)
    this.cluster = cluster
    this.client = new KubeClient(
      cluster,
      this.deps.rawConnect,
      credentialProvider(cluster.auth, this.deps.spawn, cluster.server)
    )
    this.deps.log('info', `context ${cluster.name} → ${cluster.server}`)
    return this.client
  }

  private require(): KubeClient {
    if (!this.client) throw new Error('Not connected to a cluster')
    return this.client
  }

  private kind(id: string): ResourceKind {
    const k = this.kinds.get(id)
    if (!k) throw new Error(`Unknown resource type ${id}`)
    return k
  }

  async run(raw: unknown, signal: AbortSignal): Promise<unknown> {
    const op = K8sOp.parse(raw)
    if (op.op === 'unsubscribe') {
      this.subscriptions.get(op.subscription)?.()
      this.subscriptions.delete(op.subscription)
      return null
    }
    if (op.op === 'connect') {
      this.readOnly = op.readOnly
      const client = await this.connect(op.ref)
      const version = await client.json<{ gitVersion?: string }>('GET', '/version', { signal })
      return { version: version.gitVersion ?? '', namespace: this.cluster?.namespace ?? 'default' }
    }
    if (this.readOnly && isMutating(op))
      throw new Error('Read-only mode is on for this context — turn it off to make changes')
    const client = this.require()
    switch (op.op) {
      case 'namespaces': {
        try {
          const list = await client.json<{ items: K8sObject[] }>('GET', '/api/v1/namespaces', {
            signal
          })
          return { names: list.items.map((n) => n.metadata.name).sort(), canList: true }
        } catch (error) {
          if (error instanceof KubeError && error.status === 403)
            return { names: [this.cluster?.namespace ?? 'default'], canList: false }
          throw error
        }
      }
      case 'discover':
        return this.discover(client, op.namespace, signal)
      case 'list': {
        const kind = this.kind(op.kind)
        const res = await client.json<{
          items: K8sObject[]
          metadata: { resourceVersion?: string; continue?: string }
        }>('GET', resourcePath(kind, op.namespace), {
          query: {
            limit: op.limit,
            continue: op.continue,
            labelSelector: op.labelSelector || undefined,
            fieldSelector: op.fieldSelector || undefined
          },
          signal
        })
        const clean = (o: K8sObject): K8sObject =>
          kind.id === 'secrets' ? hideSecretValues(slim(o)) : slim(o)
        return {
          items: res.items.map(clean),
          resourceVersion: res.metadata.resourceVersion ?? '',
          continue: res.metadata.continue ?? null
        }
      }
      case 'watch':
        return this.watch(op.kind, op.namespace, op.labelSelector, op.resourceVersion)
      case 'get': {
        const kind = this.kind(op.kind)
        let o = slim(
          await client.json<K8sObject>('GET', resourcePath(kind, op.namespace, op.name), { signal })
        )
        if (kind.id === 'secrets') o = hideSecretValues(o)
        return op.format === 'yaml' ? toYaml(o) : o
      }
      case 'apply':
        return this.apply(client, op.yaml)
      case 'delete':
        await client.json('DELETE', resourcePath(this.kind(op.kind), op.namespace, op.name))
        return null
      case 'scale':
        await client.json(
          'PATCH',
          resourcePath(this.kind(op.kind), op.namespace, op.name, 'scale'),
          {
            body: { spec: { replicas: op.replicas } },
            contentType: 'application/merge-patch+json'
          }
        )
        return null
      case 'rolloutRestart':
        await client.json('PATCH', resourcePath(this.kind(op.kind), op.namespace, op.name), {
          body: {
            spec: {
              template: {
                metadata: {
                  annotations: { 'kubectl.kubernetes.io/restartedAt': new Date().toISOString() }
                }
              }
            }
          },
          contentType: 'application/strategic-merge-patch+json'
        })
        return null
      case 'rolloutPause':
        await client.json(
          'PATCH',
          resourcePath(this.kind('deployments.apps'), op.namespace, op.name),
          {
            body: { spec: { paused: op.paused } },
            contentType: 'application/merge-patch+json'
          }
        )
        return null
      case 'logs.subscribe':
        return this.subscribe('logs', async (id, s) => {
          const decoder = new TextDecoder()
          let buffer = ''
          let timer: NodeJS.Timeout | null = null
          const flush = (): void => {
            if (timer) clearTimeout(timer)
            timer = null
            if (buffer) this.deps.emit('logs', { subscription: id, stream: 'stdout', text: buffer })
            buffer = ''
          }
          try {
            await client.stream(
              'GET',
              `/api/v1/namespaces/${encodeURIComponent(op.namespace)}/pods/${encodeURIComponent(op.pod)}/log`,
              {
                query: {
                  follow: !op.previous,
                  previous: op.previous || undefined,
                  container: op.container,
                  tailLines: op.tail,
                  timestamps: op.timestamps || undefined
                },
                signal: s
              },
              (chunk) => {
                buffer += decoder.decode(chunk, { stream: true })
                if (buffer.length > 64 * 1024) flush()
                else timer ??= setTimeout(flush, 50)
              }
            )
          } finally {
            flush()
          }
        })
      case 'portForward':
        return this.portForward(client, op.namespace, op.target, op.ports)
      case 'portForward.stop': {
        const f = this.forwards.get(op.id)
        if (f) this.stopForward(f)
        return null
      }
      case 'portForwards':
        return [...this.forwards.values()].map((f) => f.info)
      case 'secret.reveal': {
        const secret = await client.json<K8sObject>(
          'GET',
          resourcePath(this.kind('secrets'), op.namespace, op.name),
          { signal }
        )
        const value = secret.data?.[op.key]
        if (value === undefined) throw new Error(`The secret has no key ${op.key}`)
        return Buffer.from(value, 'base64').toString('utf8')
      }
      case 'edit':
        return this.edit(client, this.kind(op.kind), op.namespace, op.name, op.localPath)
    }
  }

  /**
   * Loại tài nguyên cluster có (gồm CRD), đánh dấu loại không list được trong namespace đang xem
   * (SelfSubjectAccessReview) để ẩn khỏi điều hướng.
   */
  private async discover(
    client: KubeClient,
    namespace: string | undefined,
    signal: AbortSignal
  ): Promise<DiscoveredKind[]> {
    const custom: ResourceKind[] = []
    try {
      const groups = await client.json<{
        groups: { name: string; preferredVersion: { groupVersion: string; version: string } }[]
      }>('GET', '/apis', { signal })
      const others = groups.groups.filter((g) => !isBuiltinGroup(g.name))
      await Promise.all(
        others.slice(0, 64).map(async (g) => {
          const list = await client
            .json<{
              resources: { name: string; kind: string; namespaced: boolean; verbs: string[] }[]
            }>('GET', `/apis/${g.preferredVersion.groupVersion}`, { signal })
            .catch(() => null)
          for (const r of list?.resources ?? []) {
            if (r.name.includes('/') || !r.verbs.includes('list')) continue
            custom.push({
              id: `${r.name}.${g.name}`,
              group: g.name,
              version: g.preferredVersion.version,
              plural: r.name,
              kind: r.kind,
              namespaced: r.namespaced,
              title: r.kind,
              section: 'Custom resources'
            })
          }
        })
      )
    } catch (error) {
      this.deps.log(
        'warn',
        `discovery failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    for (const k of custom) this.kinds.set(k.id, k)
    const all = [...BUILTIN_KINDS, ...custom.sort((a, b) => a.id.localeCompare(b.id))]
    const allowed = await Promise.all(
      all.map((k) =>
        client
          .json<{ status?: { allowed?: boolean } }>(
            'POST',
            '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews',
            {
              body: {
                apiVersion: 'authorization.k8s.io/v1',
                kind: 'SelfSubjectAccessReview',
                spec: {
                  resourceAttributes: {
                    verb: 'list',
                    group: k.group,
                    resource: k.plural,
                    ...(k.namespaced && namespace ? { namespace } : {})
                  }
                }
              },
              signal
            }
          )
          .then(
            (r) => r.status?.allowed !== false,
            // Không hỏi được quyền → cứ hiện (lỗi thật sẽ báo khi list).
            () => true
          )
      )
    )
    return all.map((k, i) => ({
      id: k.id,
      group: k.group,
      version: k.version,
      plural: k.plural,
      kind: k.kind,
      namespaced: k.namespaced,
      forbidden: allowed[i] === false
    }))
  }

  /** Luồng dài chạy nền; trả id đăng ký ngay; kết thúc / lỗi → sự kiện `<kind>-end`. */
  private subscribe(
    kind: string,
    start: (id: string, signal: AbortSignal) => Promise<void>
  ): { subscription: string } {
    const id = randomUUID()
    const controller = new AbortController()
    this.subscriptions.set(id, () => {
      controller.abort()
    })
    void start(id, controller.signal)
      .then(
        () => {
          if (!controller.signal.aborted) this.deps.emit(`${kind}-end`, { subscription: id })
        },
        (error: unknown) => {
          if (controller.signal.aborted || this.disposed) return
          this.deps.emit(`${kind}-end`, {
            subscription: id,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      )
      .finally(() => {
        this.subscriptions.delete(id)
      })
    return { subscription: id }
  }

  /**
   * Watch dùng chung theo (loại, namespace, selector) trong phiên (ADR-014 mục 7.6): tự nối lại khi
   * server đóng luồng; 410 Gone → báo renderer list lại. Sự kiện gửi theo lô ≤ 10 lần / giây.
   */
  private watch(
    kindId: string,
    namespace: string | undefined,
    selector: string | undefined,
    resourceVersion: string
  ): { subscription: string } {
    const kind = this.kind(kindId)
    const key = `${kindId}|${namespace ?? ''}|${selector ?? ''}`
    const id = randomUUID()
    let shared = this.watches.get(key)
    if (!shared) {
      const created: SharedWatch = {
        subscribers: new Set(),
        controller: new AbortController(),
        pending: [],
        timer: null
      }
      shared = created
      this.watches.set(key, created)
      void this.runWatch(created, kind, namespace, selector, resourceVersion)
    }
    const w = shared
    w.subscribers.add(id)
    this.subscriptions.set(id, () => {
      w.subscribers.delete(id)
      if (w.subscribers.size === 0) {
        w.controller.abort()
        if (w.timer) clearTimeout(w.timer)
        this.watches.delete(key)
      }
    })
    return { subscription: id }
  }

  private flushWatch(w: SharedWatch, extra?: { relist?: boolean; error?: string }): void {
    if (w.timer) clearTimeout(w.timer)
    w.timer = null
    const events = w.pending
    w.pending = []
    if (events.length === 0 && !extra) return
    for (const subscription of w.subscribers)
      this.deps.emit('watch', { subscription, events, ...extra })
  }

  private async runWatch(
    w: SharedWatch,
    kind: ResourceKind,
    namespace: string | undefined,
    selector: string | undefined,
    startVersion: string
  ): Promise<void> {
    let rv = startVersion
    let failures = 0
    const client = this.require()
    const signal = w.controller.signal
    // Đọc qua hàm để TS không thu hẹp kiểu qua `await`.
    const aborted = (): boolean => signal.aborted
    while (!aborted() && !this.disposed) {
      let pending = ''
      let gone = false
      try {
        await client.stream(
          'GET',
          resourcePath(kind, namespace),
          {
            query: {
              watch: true,
              resourceVersion: rv,
              allowWatchBookmarks: true,
              labelSelector: selector || undefined,
              timeoutSeconds: 300
            },
            signal
          },
          (chunk) => {
            pending += chunk.toString('utf8')
            let nl = pending.indexOf('\n')
            while (nl >= 0) {
              const line = pending.slice(0, nl).trim()
              pending = pending.slice(nl + 1)
              nl = pending.indexOf('\n')
              if (!line) continue
              let e: { type: string; object: K8sObject & { code?: number } }
              try {
                e = JSON.parse(line) as typeof e
              } catch {
                continue
              }
              if (e.type === 'ERROR') {
                if (e.object.code === 410) gone = true
                continue
              }
              if (e.object.metadata.resourceVersion) rv = e.object.metadata.resourceVersion
              if (e.type === 'BOOKMARK') continue
              if (e.type !== 'ADDED' && e.type !== 'MODIFIED' && e.type !== 'DELETED') continue
              const obj = kind.id === 'secrets' ? hideSecretValues(slim(e.object)) : slim(e.object)
              w.pending.push({ type: e.type, object: obj })
              w.timer ??= setTimeout(() => {
                this.flushWatch(w)
              }, WATCH_FLUSH_MS)
            }
          }
        )
        failures = 0
      } catch (error) {
        if (aborted()) return
        if (error instanceof KubeError && error.status === 410) gone = true
        else {
          failures++
          this.deps.log(
            'warn',
            `watch ${kind.id}: ${error instanceof Error ? error.message : String(error)}`
          )
          if (failures >= 5) {
            this.flushWatch(w, { error: error instanceof Error ? error.message : String(error) })
            return
          }
        }
      }
      if (gone) {
        // Phiên bản quá cũ — renderer list lại rồi đăng ký watch mới.
        this.flushWatch(w, { relist: true })
        return
      }
      this.flushWatch(w)
      // Server đóng luồng (timeoutSeconds) → nối lại ngay; lỗi mạng → chờ tăng dần.
      if (failures > 0)
        await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** failures)))
    }
  }

  /** Replace (PUT) có kiểm resourceVersion — ai đó đã sửa trước → báo, không ghi đè. */
  private async apply(client: KubeClient, text: string): Promise<K8sObject> {
    const o = parseYaml(text) as K8sObject | null
    const meta = (o as { metadata?: K8sObject['metadata'] } | null)?.metadata
    if (!o || typeof o !== 'object' || !meta?.name || !o.kind || !o.apiVersion)
      throw new Error('The YAML needs apiVersion, kind and metadata.name')
    const kind = [...this.kinds.values()].find(
      (k) => k.kind === o.kind && (k.group ? `${k.group}/${k.version}` : k.version) === o.apiVersion
    )
    if (!kind) throw new Error(`Unknown kind ${o.kind} (${o.apiVersion})`)
    if (!o.metadata.resourceVersion)
      throw new Error('metadata.resourceVersion is missing — reload the object before saving')
    try {
      return await client.json<K8sObject>(
        'PUT',
        resourcePath(kind, o.metadata.namespace, o.metadata.name),
        {
          body: o
        }
      )
    } catch (error) {
      if (error instanceof KubeError && error.status === 409)
        throw new Error(
          'Someone changed this object since you opened it. Reload it and apply your change again.',
          { cause: error }
        )
      throw error
    }
  }

  /**
   * Sửa YAML bằng editor trên máy: ghi ra file tạm (main cấp đường dẫn), theo dõi; mỗi lần lưu →
   * replace. Lưu nối tiếp dùng resourceVersion mới nhất của chính mình; người khác sửa → 409 → báo.
   */
  private async edit(
    client: KubeClient,
    kind: ResourceKind,
    namespace: string | undefined,
    name: string,
    localPath: string
  ): Promise<null> {
    if (kind.id === 'secrets')
      throw new Error('Secrets cannot be edited in an editor (values would be written to disk)')
    const o = slim(await client.json<K8sObject>('GET', resourcePath(kind, namespace, name)))
    const writtenRv = o.metadata.resourceVersion ?? ''
    let currentRv = writtenRv
    let last = toYaml(o)
    await writeFile(localPath, last, 'utf8')
    this.edits.get(localPath)?.()
    let busy = false
    // Hỏi nội dung file mỗi 500 ms (YAML nhỏ): không phụ thuộc mtime / sự kiện theo dõi file của
    // từng hệ điều hành (lưu hai lần trong cùng một giây, editor ghi file tạm rồi đổi tên…).
    const check = (): void => {
      if (busy) return
      busy = true
      void (async () => {
        try {
          const text = await readFile(localPath, 'utf8').catch(() => last)
          if (text === last) return
          last = text
          const edited = parseYaml(text) as K8sObject
          // Người dùng không tự sửa resourceVersion → dùng bản mới nhất mình vừa ghi.
          if (edited.metadata.resourceVersion === writtenRv)
            edited.metadata.resourceVersion = currentRv
          const saved = await this.apply(client, toYaml(edited))
          currentRv = saved.metadata.resourceVersion ?? currentRv
          this.deps.emit('edit', { path: localPath, name, ok: true })
        } catch (error) {
          this.deps.emit('edit', {
            path: localPath,
            name,
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          })
        } finally {
          busy = false
        }
      })()
    }
    const timer = setInterval(check, 500)
    this.edits.set(localPath, () => {
      clearInterval(timer)
    })
    return null
  }

  private async resolveTarget(
    client: KubeClient,
    namespace: string,
    target: string,
    port: number
  ): Promise<{ pod: string; port: number }> {
    const [type, name] = target.split('/') as [string, string]
    if (type === 'pod') return { pod: name, port }
    const svc = await client.json<{
      spec: {
        selector?: Record<string, string>
        ports?: { port: number; targetPort?: number | string }[]
      }
    }>(
      'GET',
      `/api/v1/namespaces/${encodeURIComponent(namespace)}/services/${encodeURIComponent(name)}`
    )
    const selector = Object.entries(svc.spec.selector ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join(',')
    if (!selector) throw new Error(`The service ${name} has no pod selector`)
    const pods = await client.json<{
      items: (K8sObject & {
        spec: { containers?: { ports?: { name?: string; containerPort: number }[] }[] }
      })[]
    }>('GET', `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods`, {
      query: { labelSelector: selector, fieldSelector: 'status.phase=Running' }
    })
    const pod = pods.items[0]
    if (!pod) throw new Error(`No running pod behind the service ${name}`)
    const svcPort = svc.spec.ports?.find((p) => p.port === port)
    let targetPort: number = port
    if (typeof svcPort?.targetPort === 'number') targetPort = svcPort.targetPort
    else if (typeof svcPort?.targetPort === 'string') {
      const named = svcPort.targetPort
      const found = pod.spec.containers?.flatMap((c) => c.ports ?? []).find((p) => p.name === named)
      if (!found) throw new Error(`The pod has no port named ${named}`)
      targetPort = found.containerPort
    }
    return { pod: pod.metadata.name, port: targetPort }
  }

  /** Port-forward: cổng trên máy (127.0.0.1) → WebSocket portforward tới pod (mỗi kết nối một WS). */
  private async portForward(
    client: KubeClient,
    namespace: string,
    target: string,
    ports: [number, number][]
  ): Promise<PortForwardInfo[]> {
    const out: PortForwardInfo[] = []
    for (const [local, remote] of ports) {
      const resolved = await this.resolveTarget(client, namespace, target, remote)
      const id = randomUUID()
      const sockets = new Set<Socket>()
      const info: PortForwardInfo = {
        id,
        namespace,
        target,
        localPort: local,
        remotePort: remote,
        connections: 0,
        error: null
      }
      const server = createServer((socket) => {
        sockets.add(socket)
        info.connections++
        this.emitForwards()
        socket.on('close', () => {
          sockets.delete(socket)
          info.connections--
          this.emitForwards()
        })
        void this.pipeForward(client, namespace, resolved.pod, resolved.port, socket).catch(
          (error: unknown) => {
            info.error = error instanceof Error ? error.message : String(error)
            this.emitForwards()
            socket.destroy()
          }
        )
      })
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(local, '127.0.0.1', () => {
          server.removeListener('error', reject)
          resolve()
        })
      })
      const address = server.address()
      if (address && typeof address === 'object') info.localPort = address.port
      this.forwards.set(id, { info, server, sockets })
      out.push(info)
    }
    this.emitForwards()
    return out
  }

  private async pipeForward(
    client: KubeClient,
    namespace: string,
    pod: string,
    port: number,
    socket: Socket
  ): Promise<void> {
    socket.pause()
    const ws: WebSocket = await client.websocket(
      `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}/portforward`,
      { ports: String(port) },
      ['v4.channel.k8s.io']
    )
    const seen = new Set<number>()
    ws.on('message', (data: Buffer) => {
      if (data.length === 0) return
      const channel = data[0] ?? 0
      let payload = data.subarray(1)
      // Khung đầu tiên của mỗi kênh mang số cổng (2 byte) — bỏ qua.
      if (!seen.has(channel)) {
        seen.add(channel)
        payload = payload.subarray(2)
      }
      if (payload.length === 0) return
      if (channel === 0) socket.write(payload)
      else if (channel === 1) {
        this.deps.log('warn', `port-forward: ${payload.toString('utf8')}`)
        socket.destroy()
      }
    })
    ws.on('close', () => socket.destroy())
    ws.on('error', () => socket.destroy())
    socket.on('data', (chunk: Buffer) => {
      ws.send(Buffer.concat([Buffer.from([0]), chunk]))
    })
    socket.on('close', () => {
      ws.close()
    })
    socket.resume()
  }

  private emitForwards(): void {
    this.deps.emit(
      'forwards',
      [...this.forwards.values()].map((f) => f.info)
    )
  }

  private stopForward(f: Forward): void {
    f.server.close()
    for (const s of f.sockets) s.destroy()
    this.forwards.delete(f.info.id)
    this.emitForwards()
  }

  /** Shell vào pod: exec qua WebSocket (kênh v4), TTY đổi kích thước theo terminal. */
  async openTerminal(raw: unknown, size: TerminalSize, cb: TransportCallbacks): Promise<Transport> {
    const params = K8sTerminalParams.parse(raw)
    const client = this.client ?? (await this.connect(params.ref))
    const command = params.command?.length ? params.command : DEFAULT_POD_SHELL
    const ws = await client.websocket(
      `/api/v1/namespaces/${encodeURIComponent(params.namespace)}/pods/${encodeURIComponent(params.pod)}/exec`,
      {
        command,
        container: params.container,
        stdin: true,
        stdout: true,
        stderr: true,
        tty: true
      },
      ['v4.channel.k8s.io']
    )
    return new PodExecTransport(ws, size, cb)
  }

  dispose(): void {
    this.disposed = true
    for (const stop of this.subscriptions.values()) stop()
    this.subscriptions.clear()
    for (const w of this.watches.values()) w.controller.abort()
    this.watches.clear()
    for (const f of [...this.forwards.values()]) this.stopForward(f)
    for (const stop of this.edits.values()) stop()
    this.edits.clear()
  }
}

/** Transport terminal trên kênh exec của Kubernetes (0 stdin, 1 stdout, 2 stderr, 3 lỗi, 4 resize). */
export class PodExecTransport implements Transport {
  private exited = false
  private code: number | null = null

  constructor(
    private readonly ws: WebSocket,
    size: TerminalSize,
    cb: TransportCallbacks
  ) {
    ws.on('message', (data: Buffer) => {
      const channel = data[0]
      const payload = data.subarray(1)
      if (channel === 1 || channel === 2) cb.onData(payload)
      else if (channel === 3) {
        try {
          const status = JSON.parse(payload.toString('utf8')) as {
            status?: string
            details?: { causes?: { reason?: string; message?: string }[] }
          }
          if (status.status === 'Success') this.code = 0
          else {
            const exit = status.details?.causes?.find((c) => c.reason === 'ExitCode')?.message
            this.code = exit ? Number(exit) : 1
          }
        } catch {
          this.code = 1
        }
      }
    })
    ws.on('close', () => {
      if (this.exited) return
      this.exited = true
      cb.onExit({ code: this.code, signal: null })
    })
    ws.on('error', (error) => {
      if (this.exited) return
      this.exited = true
      cb.onExit({ code: null, signal: null, error: error.message })
    })
    this.resize(size.cols, size.rows)
  }

  write(data: string): void {
    if (!this.exited) this.ws.send(Buffer.concat([Buffer.from([0]), Buffer.from(data, 'utf8')]))
  }

  resize(cols: number, rows: number): void {
    if (!this.exited)
      this.ws.send(
        Buffer.concat([
          Buffer.from([4]),
          Buffer.from(JSON.stringify({ Width: cols, Height: rows }))
        ])
      )
  }

  pause(): void {
    this.ws.pause()
  }

  resume(): void {
    this.ws.resume()
  }

  close(): void {
    if (!this.exited) this.ws.close()
  }
}
