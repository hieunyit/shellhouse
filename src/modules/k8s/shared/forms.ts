/**
 * Form tạo tài nguyên (kiểu Rancher / Lens): mô hình form → manifest Kubernetes, và kiểm tra hợp lệ
 * theo từng trường. Thuần — renderer vẽ form, test kiểm manifest sinh ra.
 */

export interface KV {
  key: string
  value: string
}

export type ProbeType = 'none' | 'http' | 'tcp' | 'exec'

export interface ProbeForm {
  type: ProbeType
  path: string
  port: string
  command: string
  initialDelay: string
  period: string
}

export interface EnvForm {
  name: string
  /** value: giá trị cố định; configmap / secret: lấy một key. */
  source: 'value' | 'configmap' | 'secret'
  value: string
  ref: string
  key: string
}

export interface MountForm {
  /** Tên volume (trong WorkloadForm.volumes). */
  volume: string
  path: string
  readOnly: boolean
  subPath: string
}

export interface ContainerForm {
  name: string
  image: string
  pullPolicy: '' | 'Always' | 'IfNotPresent' | 'Never'
  command: string
  args: string
  ports: { name: string; port: string; protocol: 'TCP' | 'UDP' }[]
  env: EnvForm[]
  /** Nạp mọi key của ConfigMap / Secret thành biến môi trường. */
  envFrom: { kind: 'configmap' | 'secret'; name: string }[]
  cpuRequest: string
  memoryRequest: string
  cpuLimit: string
  memoryLimit: string
  readiness: ProbeForm
  liveness: ProbeForm
  mounts: MountForm[]
}

export interface VolumeForm {
  name: string
  type: 'configmap' | 'secret' | 'pvc' | 'emptydir'
  source: string
}

export type WorkloadKind = 'Deployment' | 'StatefulSet' | 'DaemonSet' | 'Job' | 'CronJob'

export interface WorkloadForm {
  kind: WorkloadKind
  name: string
  namespace: string
  labels: KV[]
  annotations: KV[]
  replicas: string
  strategy: 'RollingUpdate' | 'Recreate'
  maxSurge: string
  maxUnavailable: string
  /** StatefulSet: service headless. */
  serviceName: string
  schedule: string
  concurrencyPolicy: 'Allow' | 'Forbid' | 'Replace'
  restartPolicy: 'OnFailure' | 'Never'
  backoffLimit: string
  completions: string
  parallelism: string
  serviceAccount: string
  nodeSelector: KV[]
  containers: ContainerForm[]
  volumes: VolumeForm[]
  /** Tạo luôn Service trỏ tới workload. */
  expose: boolean
  service: { type: ServiceType; ports: ServicePortForm[] }
}

export type ServiceType = 'ClusterIP' | 'NodePort' | 'LoadBalancer' | 'Headless'

export interface ServicePortForm {
  name: string
  port: string
  targetPort: string
  nodePort: string
  protocol: 'TCP' | 'UDP'
}

export interface ServiceForm {
  name: string
  namespace: string
  labels: KV[]
  type: ServiceType
  selector: KV[]
  ports: ServicePortForm[]
}

export interface IngressRuleForm {
  host: string
  path: string
  pathType: 'Prefix' | 'Exact' | 'ImplementationSpecific'
  service: string
  port: string
}

export interface IngressForm {
  name: string
  namespace: string
  labels: KV[]
  annotations: KV[]
  className: string
  rules: IngressRuleForm[]
  tls: { secret: string; hosts: string }[]
}

export interface ConfigMapForm {
  name: string
  namespace: string
  labels: KV[]
  data: KV[]
}

export type SecretType =
  'Opaque' | 'kubernetes.io/tls' | 'kubernetes.io/dockerconfigjson' | 'kubernetes.io/basic-auth'

export interface SecretForm {
  name: string
  namespace: string
  labels: KV[]
  type: SecretType
  data: KV[]
  tlsCert: string
  tlsKey: string
  registry: { server: string; username: string; password: string; email: string }
  basic: { username: string; password: string }
}

export interface PvcForm {
  name: string
  namespace: string
  labels: KV[]
  storageClass: string
  size: string
  accessMode: 'ReadWriteOnce' | 'ReadOnlyMany' | 'ReadWriteMany' | 'ReadWriteOncePod'
  volumeMode: 'Filesystem' | 'Block'
}

export interface HpaForm {
  name: string
  namespace: string
  targetKind: 'Deployment' | 'StatefulSet'
  target: string
  min: string
  max: string
  cpu: string
  memory: string
}

export interface NamespaceForm {
  name: string
  labels: KV[]
}

export type FormKind =
  | WorkloadKind
  | 'Service'
  | 'Ingress'
  | 'ConfigMap'
  | 'Secret'
  | 'PersistentVolumeClaim'
  | 'HorizontalPodAutoscaler'
  | 'Namespace'

/** Lỗi theo đường dẫn trường ("name", "containers.0.image"…). */
export type FieldErrors = Record<string, string>

type Obj = Record<string, unknown>

// ——— Mặc định ———

export const emptyProbe = (): ProbeForm => ({
  type: 'none',
  path: '/',
  port: '',
  command: '',
  initialDelay: '',
  period: ''
})

export const emptyContainer = (name = 'app'): ContainerForm => ({
  name,
  image: '',
  pullPolicy: '',
  command: '',
  args: '',
  ports: [],
  env: [],
  envFrom: [],
  cpuRequest: '100m',
  memoryRequest: '128Mi',
  cpuLimit: '',
  memoryLimit: '256Mi',
  readiness: emptyProbe(),
  liveness: emptyProbe(),
  mounts: []
})

export const emptyWorkload = (kind: WorkloadKind, namespace: string): WorkloadForm => ({
  kind,
  name: '',
  namespace,
  labels: [],
  annotations: [],
  replicas: '1',
  strategy: 'RollingUpdate',
  maxSurge: '25%',
  maxUnavailable: '25%',
  serviceName: '',
  schedule: '0 * * * *',
  concurrencyPolicy: 'Forbid',
  restartPolicy: 'OnFailure',
  backoffLimit: '6',
  completions: '1',
  parallelism: '1',
  serviceAccount: '',
  nodeSelector: [],
  containers: [emptyContainer()],
  volumes: [],
  expose: false,
  service: { type: 'ClusterIP', ports: [] }
})

export const emptyServicePort = (): ServicePortForm => ({
  name: '',
  port: '',
  targetPort: '',
  nodePort: '',
  protocol: 'TCP'
})

// ——— Kiểm tra ———

const DNS1123_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/
const DNS1123_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/
const QUANTITY = /^([+-]?[0-9.]+)([eE][-+]?[0-9]+|[mkMGTPE]|[KMGTPE]i)?$/
const LABEL_KEY =
  /^([a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*\/)?[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/
const LABEL_VALUE = /^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?$/
const ENV_NAME = /^[-._a-zA-Z][-._a-zA-Z0-9]*$/
const CRON = /^(@(yearly|annually|monthly|weekly|daily|midnight|hourly)|(\S+\s+){4}\S+)$/

export function checkName(v: string, what = 'Name', max = 63, subdomain = false): string | null {
  if (!v) return `${what} is required`
  if (v.length > max) return `${what} must be at most ${String(max)} characters`
  if (!(subdomain ? DNS1123_SUBDOMAIN : DNS1123_LABEL).test(v))
    return `${what} may only contain lowercase letters, digits and “-”, and must start and end with a letter or digit`
  return null
}

const isInt = (v: string, min: number, max = Number.MAX_SAFE_INTEGER): boolean =>
  /^\d+$/.test(v) && Number(v) >= min && Number(v) <= max

function checkQuantity(errors: FieldErrors, path: string, v: string): void {
  if (v && !QUANTITY.test(v.trim()))
    errors[path] = 'Use a Kubernetes quantity such as 250m, 1, 512Mi or 2Gi'
}

function checkKV(errors: FieldErrors, path: string, list: KV[], labels: boolean): void {
  const seen = new Set<string>()
  list.forEach((kv, i) => {
    if (!kv.key && !kv.value) return
    if (!kv.key) errors[`${path}.${String(i)}.key`] = 'Key is required'
    else if (labels && !LABEL_KEY.test(kv.key))
      errors[`${path}.${String(i)}.key`] = 'Not a valid key'
    else if (seen.has(kv.key)) errors[`${path}.${String(i)}.key`] = 'Duplicate key'
    if (labels && !LABEL_VALUE.test(kv.value))
      errors[`${path}.${String(i)}.value`] = 'Up to 63 letters, digits, “-”, “_” or “.”'
    seen.add(kv.key)
  })
}

function checkProbe(errors: FieldErrors, path: string, p: ProbeForm): void {
  if (p.type === 'none') return
  if ((p.type === 'http' || p.type === 'tcp') && !p.port)
    errors[`${path}.port`] = 'Port is required'
  if (p.type === 'http' && !p.path.startsWith('/'))
    errors[`${path}.path`] = 'Path must start with /'
  if (p.type === 'exec' && !p.command.trim()) errors[`${path}.command`] = 'Command is required'
}

export function validateWorkload(f: WorkloadForm): FieldErrors {
  const e: FieldErrors = {}
  const n = checkName(f.name, 'Name', f.kind === 'CronJob' ? 52 : 63)
  if (n) e['name'] = n
  if (!f.namespace) e['namespace'] = 'Pick a namespace'
  if ((f.kind === 'Deployment' || f.kind === 'StatefulSet') && !isInt(f.replicas, 0, 10_000))
    e['replicas'] = 'A whole number from 0'
  if (f.kind === 'CronJob' && !CRON.test(f.schedule.trim()))
    e['schedule'] = 'Five fields: minute hour day month weekday (e.g. 0 2 * * *)'
  if ((f.kind === 'Job' || f.kind === 'CronJob') && f.backoffLimit && !isInt(f.backoffLimit, 0))
    e['backoffLimit'] = 'A whole number'
  checkKV(e, 'labels', f.labels, true)
  checkKV(e, 'nodeSelector', f.nodeSelector, true)
  const names = new Set<string>()
  f.containers.forEach((c, i) => {
    const p = `containers.${String(i)}`
    const cn = checkName(c.name, 'Container name')
    if (cn) e[`${p}.name`] = cn
    else if (names.has(c.name)) e[`${p}.name`] = 'Container names must be unique'
    names.add(c.name)
    if (!c.image.trim()) e[`${p}.image`] = 'Image is required'
    else if (/\s/.test(c.image.trim())) e[`${p}.image`] = 'Image cannot contain spaces'
    c.ports.forEach((port, j) => {
      if (!isInt(port.port, 1, 65_535)) e[`${p}.ports.${String(j)}.port`] = '1–65535'
    })
    c.env.forEach((env, j) => {
      if (!env.name) e[`${p}.env.${String(j)}.name`] = 'Name is required'
      else if (!ENV_NAME.test(env.name))
        e[`${p}.env.${String(j)}.name`] = 'Letters, digits, “_”, “-” or “.”'
      if (env.source !== 'value' && (!env.ref || !env.key))
        e[`${p}.env.${String(j)}.ref`] = 'Pick the source and key'
    })
    checkQuantity(e, `${p}.cpuRequest`, c.cpuRequest)
    checkQuantity(e, `${p}.memoryRequest`, c.memoryRequest)
    checkQuantity(e, `${p}.cpuLimit`, c.cpuLimit)
    checkQuantity(e, `${p}.memoryLimit`, c.memoryLimit)
    checkProbe(e, `${p}.readiness`, c.readiness)
    checkProbe(e, `${p}.liveness`, c.liveness)
    c.mounts.forEach((m, j) => {
      if (!f.volumes.some((v) => v.name === m.volume))
        e[`${p}.mounts.${String(j)}.volume`] = 'Pick a volume'
      if (!m.path.startsWith('/')) e[`${p}.mounts.${String(j)}.path`] = 'Absolute path, e.g. /data'
    })
  })
  const vols = new Set<string>()
  f.volumes.forEach((v, i) => {
    const vn = checkName(v.name, 'Volume name')
    if (vn) e[`volumes.${String(i)}.name`] = vn
    else if (vols.has(v.name)) e[`volumes.${String(i)}.name`] = 'Duplicate volume name'
    vols.add(v.name)
    if (v.type !== 'emptydir' && !v.source) e[`volumes.${String(i)}.source`] = 'Pick the source'
  })
  if (f.expose) checkServicePorts(e, 'service.ports', f.service.ports, f.service.type)
  return e
}

function checkServicePorts(
  e: FieldErrors,
  path: string,
  ports: ServicePortForm[],
  type: ServiceType
): void {
  if (!ports.length && type !== 'Headless') e[path] = 'Add at least one port'
  ports.forEach((p, i) => {
    if (!isInt(p.port, 1, 65_535)) e[`${path}.${String(i)}.port`] = '1–65535'
    if (p.nodePort && !isInt(p.nodePort, 30_000, 32_767))
      e[`${path}.${String(i)}.nodePort`] = '30000–32767'
    if (ports.length > 1 && !p.name)
      e[`${path}.${String(i)}.name`] = 'Name each port when there are several'
  })
}

export function validateService(f: ServiceForm): FieldErrors {
  const e: FieldErrors = {}
  const n = checkName(f.name)
  if (n) e['name'] = n
  if (!f.namespace) e['namespace'] = 'Pick a namespace'
  checkKV(e, 'selector', f.selector, true)
  checkServicePorts(e, 'ports', f.ports, f.type)
  return e
}

export function validateIngress(f: IngressForm): FieldErrors {
  const e: FieldErrors = {}
  const n = checkName(f.name, 'Name', 253, true)
  if (n) e['name'] = n
  if (!f.namespace) e['namespace'] = 'Pick a namespace'
  if (!f.rules.length) e['rules'] = 'Add at least one rule'
  f.rules.forEach((r, i) => {
    if (
      r.host &&
      !/^(\*\.)?[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/.test(r.host)
    )
      e[`rules.${String(i)}.host`] = 'Not a valid host name'
    if (!r.path.startsWith('/')) e[`rules.${String(i)}.path`] = 'Path must start with /'
    if (!r.service) e[`rules.${String(i)}.service`] = 'Pick a service'
    if (!r.port) e[`rules.${String(i)}.port`] = 'Port is required'
  })
  return e
}

export function validateConfigMap(f: ConfigMapForm): FieldErrors {
  const e: FieldErrors = {}
  const n = checkName(f.name, 'Name', 253, true)
  if (n) e['name'] = n
  if (!f.namespace) e['namespace'] = 'Pick a namespace'
  checkKV(e, 'data', f.data, false)
  f.data.forEach((kv, i) => {
    if (kv.key && !/^[-._a-zA-Z0-9]+$/.test(kv.key))
      e[`data.${String(i)}.key`] = 'Letters, digits, “-”, “_” or “.”'
  })
  return e
}

export function validateSecret(f: SecretForm): FieldErrors {
  const e: FieldErrors = {}
  const n = checkName(f.name, 'Name', 253, true)
  if (n) e['name'] = n
  if (!f.namespace) e['namespace'] = 'Pick a namespace'
  if (f.type === 'Opaque') {
    checkKV(e, 'data', f.data, false)
    f.data.forEach((kv, i) => {
      if (kv.key && !/^[-._a-zA-Z0-9]+$/.test(kv.key))
        e[`data.${String(i)}.key`] = 'Letters, digits, “-”, “_” or “.”'
    })
  }
  if (f.type === 'kubernetes.io/tls') {
    if (!f.tlsCert.includes('BEGIN CERTIFICATE')) e['tlsCert'] = 'Paste a PEM certificate'
    if (!/BEGIN (RSA |EC )?PRIVATE KEY/.test(f.tlsKey)) e['tlsKey'] = 'Paste a PEM private key'
  }
  if (f.type === 'kubernetes.io/dockerconfigjson') {
    if (!f.registry.server) e['registry.server'] = 'Registry is required'
    if (!f.registry.username) e['registry.username'] = 'Username is required'
    if (!f.registry.password) e['registry.password'] = 'Password or token is required'
  }
  if (f.type === 'kubernetes.io/basic-auth' && !f.basic.username)
    e['basic.username'] = 'Username is required'
  return e
}

export function validatePvc(f: PvcForm): FieldErrors {
  const e: FieldErrors = {}
  const n = checkName(f.name, 'Name', 253, true)
  if (n) e['name'] = n
  if (!f.namespace) e['namespace'] = 'Pick a namespace'
  if (!f.size) e['size'] = 'Size is required'
  else checkQuantity(e, 'size', f.size)
  return e
}

export function validateHpa(f: HpaForm): FieldErrors {
  const e: FieldErrors = {}
  const n = checkName(f.name)
  if (n) e['name'] = n
  if (!f.namespace) e['namespace'] = 'Pick a namespace'
  if (!f.target) e['target'] = 'Pick the workload to scale'
  if (!isInt(f.min, 1)) e['min'] = 'At least 1'
  if (!isInt(f.max, 1)) e['max'] = 'At least 1'
  else if (isInt(f.min, 1) && Number(f.max) < Number(f.min))
    e['max'] = 'Must be at least the minimum'
  if (!f.cpu && !f.memory) e['cpu'] = 'Set a CPU or memory target'
  if (f.cpu && !isInt(f.cpu, 1, 1000)) e['cpu'] = 'Percent, 1–1000'
  if (f.memory && !isInt(f.memory, 1, 1000)) e['memory'] = 'Percent, 1–1000'
  return e
}

export function validateNamespace(f: NamespaceForm): FieldErrors {
  const e: FieldErrors = {}
  const n = checkName(f.name)
  if (n) e['name'] = n
  checkKV(e, 'labels', f.labels, true)
  return e
}

// ——— Manifest ———

const kvObject = (list: KV[]): Record<string, string> | undefined => {
  const out: Record<string, string> = {}
  for (const kv of list) if (kv.key) out[kv.key] = kv.value
  return Object.keys(out).length ? out : undefined
}

const compact = <T extends Obj>(o: T): T =>
  Object.fromEntries(
    Object.entries(o).filter(
      ([, v]) => !(v === undefined || v === '' || (Array.isArray(v) && v.length === 0))
    )
  ) as T

/** "sh -c 'echo hi'" → ["sh", "-c", "echo hi"] (tách theo khoảng trắng, giữ chuỗi trong nháy). */
export function splitArgs(s: string): string[] {
  const out: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  for (const m of s.matchAll(re)) out.push(m[1]?.replace(/\\(.)/g, '$1') ?? m[2] ?? m[3] ?? '')
  return out
}

const portValue = (v: string): number | string => (/^\d+$/.test(v) ? Number(v) : v)

function probe(p: ProbeForm): Obj | undefined {
  if (p.type === 'none') return undefined
  const timing = compact({
    initialDelaySeconds: p.initialDelay ? Number(p.initialDelay) : undefined,
    periodSeconds: p.period ? Number(p.period) : undefined
  })
  if (p.type === 'http')
    return { httpGet: { path: p.path || '/', port: portValue(p.port) }, ...timing }
  if (p.type === 'tcp') return { tcpSocket: { port: portValue(p.port) }, ...timing }
  return { exec: { command: splitArgs(p.command) }, ...timing }
}

function container(c: ContainerForm): Obj {
  const requests = compact({ cpu: c.cpuRequest || undefined, memory: c.memoryRequest || undefined })
  const limits = compact({ cpu: c.cpuLimit || undefined, memory: c.memoryLimit || undefined })
  return compact({
    name: c.name,
    image: c.image.trim(),
    imagePullPolicy: c.pullPolicy || undefined,
    command: c.command.trim() ? splitArgs(c.command) : undefined,
    args: c.args.trim() ? splitArgs(c.args) : undefined,
    ports: c.ports
      .filter((p) => p.port)
      .map((p) =>
        compact({ name: p.name || undefined, containerPort: Number(p.port), protocol: p.protocol })
      ),
    env: c.env
      .filter((e) => e.name)
      .map((e) =>
        e.source === 'value'
          ? { name: e.name, value: e.value }
          : {
              name: e.name,
              valueFrom: {
                [e.source === 'configmap' ? 'configMapKeyRef' : 'secretKeyRef']: {
                  name: e.ref,
                  key: e.key
                }
              }
            }
      ),
    envFrom: c.envFrom
      .filter((e) => e.name)
      .map((e) =>
        e.kind === 'configmap'
          ? { configMapRef: { name: e.name } }
          : { secretRef: { name: e.name } }
      ),
    resources:
      Object.keys(requests).length || Object.keys(limits).length
        ? compact({
            requests: Object.keys(requests).length ? requests : undefined,
            limits: Object.keys(limits).length ? limits : undefined
          })
        : undefined,
    readinessProbe: probe(c.readiness),
    livenessProbe: probe(c.liveness),
    volumeMounts: c.mounts
      .filter((m) => m.volume && m.path)
      .map((m) =>
        compact({
          name: m.volume,
          mountPath: m.path,
          readOnly: m.readOnly || undefined,
          subPath: m.subPath || undefined
        })
      )
  })
}

function volume(v: VolumeForm): Obj {
  switch (v.type) {
    case 'configmap':
      return { name: v.name, configMap: { name: v.source } }
    case 'secret':
      return { name: v.name, secret: { secretName: v.source } }
    case 'pvc':
      return { name: v.name, persistentVolumeClaim: { claimName: v.source } }
    default:
      return { name: v.name, emptyDir: {} }
  }
}

function meta(
  name: string,
  namespace: string | undefined,
  labels: KV[],
  annotations: KV[] = []
): Obj {
  return compact({
    name,
    namespace: namespace || undefined,
    labels: kvObject(labels),
    annotations: kvObject(annotations)
  })
}

/** Nhãn chọn pod: nhãn người dùng đặt, không có thì app=<tên>. */
export function selectorLabels(f: Pick<WorkloadForm, 'name' | 'labels'>): Record<string, string> {
  return kvObject(f.labels) ?? { app: f.name }
}

function service(
  name: string,
  namespace: string,
  labels: Record<string, string> | undefined,
  type: ServiceType,
  selector: Record<string, string> | undefined,
  ports: ServicePortForm[]
): Obj {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: compact({ name, namespace, labels }),
    spec: compact({
      type: type === 'Headless' ? undefined : type,
      clusterIP: type === 'Headless' ? 'None' : undefined,
      selector,
      ports: ports.map((p) =>
        compact({
          name: p.name || undefined,
          port: Number(p.port),
          targetPort: p.targetPort ? portValue(p.targetPort) : undefined,
          nodePort:
            p.nodePort && type !== 'ClusterIP' && type !== 'Headless'
              ? Number(p.nodePort)
              : undefined,
          protocol: p.protocol
        })
      )
    })
  }
}

export function workloadManifests(f: WorkloadForm): Obj[] {
  const sel = selectorLabels(f)
  const podSpec = compact({
    serviceAccountName: f.serviceAccount || undefined,
    nodeSelector: kvObject(f.nodeSelector),
    restartPolicy: f.kind === 'Job' || f.kind === 'CronJob' ? f.restartPolicy : undefined,
    containers: f.containers.map(container),
    volumes: f.volumes.filter((v) => v.name).map(volume)
  })
  const template = { metadata: { labels: sel }, spec: podSpec }
  const metadata = meta(
    f.name,
    f.namespace,
    f.labels.length ? f.labels : [{ key: 'app', value: f.name }],
    f.annotations
  )
  const jobSpec = compact({
    backoffLimit: f.backoffLimit ? Number(f.backoffLimit) : undefined,
    completions: f.completions && f.completions !== '1' ? Number(f.completions) : undefined,
    parallelism: f.parallelism && f.parallelism !== '1' ? Number(f.parallelism) : undefined,
    template
  })
  let main: Obj
  switch (f.kind) {
    case 'Deployment':
      main = {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata,
        spec: {
          replicas: Number(f.replicas),
          selector: { matchLabels: sel },
          strategy:
            f.strategy === 'Recreate'
              ? { type: 'Recreate' }
              : {
                  type: 'RollingUpdate',
                  rollingUpdate: {
                    maxSurge: portValue(f.maxSurge || '25%'),
                    maxUnavailable: portValue(f.maxUnavailable || '25%')
                  }
                },
          template
        }
      }
      break
    case 'StatefulSet':
      main = {
        apiVersion: 'apps/v1',
        kind: 'StatefulSet',
        metadata,
        spec: {
          replicas: Number(f.replicas),
          serviceName: f.serviceName || f.name,
          selector: { matchLabels: sel },
          template
        }
      }
      break
    case 'DaemonSet':
      main = {
        apiVersion: 'apps/v1',
        kind: 'DaemonSet',
        metadata,
        spec: { selector: { matchLabels: sel }, template }
      }
      break
    case 'Job':
      main = { apiVersion: 'batch/v1', kind: 'Job', metadata, spec: jobSpec }
      break
    case 'CronJob':
      main = {
        apiVersion: 'batch/v1',
        kind: 'CronJob',
        metadata,
        spec: {
          schedule: f.schedule.trim(),
          concurrencyPolicy: f.concurrencyPolicy,
          jobTemplate: { spec: jobSpec }
        }
      }
      break
  }
  const out = [main]
  if (f.expose && f.kind !== 'Job' && f.kind !== 'CronJob')
    out.push(
      service(
        f.kind === 'StatefulSet' && f.serviceName ? f.serviceName : f.name,
        f.namespace,
        kvObject(f.labels) ?? { app: f.name },
        f.service.type,
        sel,
        f.service.ports
      )
    )
  return out
}

export function serviceManifest(f: ServiceForm): Obj {
  return service(f.name, f.namespace, kvObject(f.labels), f.type, kvObject(f.selector), f.ports)
}

export function ingressManifest(f: IngressForm): Obj {
  const byHost = new Map<string, IngressRuleForm[]>()
  for (const r of f.rules) byHost.set(r.host, [...(byHost.get(r.host) ?? []), r])
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: meta(f.name, f.namespace, f.labels, f.annotations),
    spec: compact({
      ingressClassName: f.className || undefined,
      tls: f.tls
        .filter((t) => t.secret)
        .map((t) =>
          compact({
            secretName: t.secret,
            hosts: t.hosts
              .split(/[\s,]+/)
              .map((h) => h.trim())
              .filter(Boolean)
          })
        ),
      rules: [...byHost.entries()].map(([host, rules]) =>
        compact({
          host: host || undefined,
          http: {
            paths: rules.map((r) => ({
              path: r.path,
              pathType: r.pathType,
              backend: {
                service: {
                  name: r.service,
                  port: /^\d+$/.test(r.port) ? { number: Number(r.port) } : { name: r.port }
                }
              }
            }))
          }
        })
      )
    })
  }
}

export function configMapManifest(f: ConfigMapForm): Obj {
  return compact({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: meta(f.name, f.namespace, f.labels),
    data: kvObject(f.data)
  })
}

const b64 = (s: string): string => {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/** Secret: giá trị để ở stringData (API server tự mã hoá base64) — dễ đọc khi xem trước. */
export function secretManifest(f: SecretForm): Obj {
  const base = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: meta(f.name, f.namespace, f.labels),
    type: f.type
  }
  switch (f.type) {
    case 'kubernetes.io/tls':
      return { ...base, stringData: { 'tls.crt': f.tlsCert.trim(), 'tls.key': f.tlsKey.trim() } }
    case 'kubernetes.io/dockerconfigjson': {
      const r = f.registry
      const auth = b64(`${r.username}:${r.password}`)
      return {
        ...base,
        stringData: {
          '.dockerconfigjson': JSON.stringify({
            auths: {
              [r.server]: compact({
                username: r.username,
                password: r.password,
                email: r.email || undefined,
                auth
              })
            }
          })
        }
      }
    }
    case 'kubernetes.io/basic-auth':
      return { ...base, stringData: { username: f.basic.username, password: f.basic.password } }
    default:
      return compact({ ...base, stringData: kvObject(f.data) })
  }
}

export function pvcManifest(f: PvcForm): Obj {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: meta(f.name, f.namespace, f.labels),
    spec: compact({
      storageClassName: f.storageClass || undefined,
      accessModes: [f.accessMode],
      volumeMode: f.volumeMode === 'Filesystem' ? undefined : f.volumeMode,
      resources: { requests: { storage: f.size.trim() } }
    })
  }
}

export function hpaManifest(f: HpaForm): Obj {
  const metric = (name: 'cpu' | 'memory', v: string): Obj => ({
    type: 'Resource',
    resource: { name, target: { type: 'Utilization', averageUtilization: Number(v) } }
  })
  return {
    apiVersion: 'autoscaling/v2',
    kind: 'HorizontalPodAutoscaler',
    metadata: compact({ name: f.name, namespace: f.namespace }),
    spec: {
      scaleTargetRef: { apiVersion: 'apps/v1', kind: f.targetKind, name: f.target },
      minReplicas: Number(f.min),
      maxReplicas: Number(f.max),
      metrics: [
        ...(f.cpu ? [metric('cpu', f.cpu)] : []),
        ...(f.memory ? [metric('memory', f.memory)] : [])
      ]
    }
  }
}

export function namespaceManifest(f: NamespaceForm): Obj {
  return { apiVersion: 'v1', kind: 'Namespace', metadata: meta(f.name, undefined, f.labels) }
}

/** Id loại (để mở sau khi tạo) theo kind. */
export const KIND_ID: Record<FormKind, string> = {
  Deployment: 'deployments.apps',
  StatefulSet: 'statefulsets.apps',
  DaemonSet: 'daemonsets.apps',
  Job: 'jobs.batch',
  CronJob: 'cronjobs.batch',
  Service: 'services',
  Ingress: 'ingresses.networking.k8s.io',
  ConfigMap: 'configmaps',
  Secret: 'secrets',
  PersistentVolumeClaim: 'persistentvolumeclaims',
  HorizontalPodAutoscaler: 'horizontalpodautoscalers.autoscaling',
  Namespace: 'namespaces'
}
