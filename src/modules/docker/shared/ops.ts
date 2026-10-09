import { z } from 'zod'

/**
 * Giao thức của module Docker (ADR-014 mục 6.5): renderer ↔ Session Host qua tin `module`. Mọi
 * thao tác validate bằng schema ở đây trước khi chạy.
 */

/** Ký tự đầu là chữ / số: id không bao giờ bị CLI hiểu nhầm thành tuỳ chọn ("-f", "--rm"…). */
const Id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:/@-]*$/, 'Invalid id')
const Subscription = z.string().min(1).max(64)

export const ContainerAction = z.enum([
  'start',
  'stop',
  'restart',
  'pause',
  'unpause',
  'kill',
  'remove'
])
export type ContainerAction = z.infer<typeof ContainerAction>

export const PruneTarget = z.enum(['images', 'volumes', 'networks', 'containers', 'buildCache'])
export type PruneTarget = z.infer<typeof PruneTarget>

export const ComposeAction = z.enum(['start', 'stop', 'restart', 'up', 'down', 'pull'])
export type ComposeAction = z.infer<typeof ComposeAction>

/** Ảnh: "nginx:1.27", "ghcr.io/org/app:tag", "reg.local:5000/app@sha256:…". */
const ImageRef = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:/@-]*$/, 'Looks like nginx:1.27 or ghcr.io/org/app:tag')

/** Tên volume / network do người dùng đặt (như Docker cho phép). */
const ObjectName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/, 'Letters, digits, "_", "." and "-" only')

/** Khoá nhãn / tuỳ chọn driver: không rỗng, không có "=" hay khoảng trắng. */
const KeyValues = z.record(z.string().regex(/^[^=\s]{1,256}$/), z.string().max(4096))

/** Id registry đã lưu (vault) — null = không đăng nhập (ảnh công khai). */
const RegistryId = z.string().min(1).max(64).nullable()

/** Đường dẫn trong container: tuyệt đối, không có ký tự NUL / xuống dòng. */
export const ContainerPath = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^\/[^\0\n]*$/, 'Must be an absolute path in the container')

/** Đường dẫn trên máy này (thư mục lưu / file tải lên) — người dùng chọn trong hộp thoại. */
const LocalPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => !p.includes('\0'))

export const VolumeSpec = z.object({
  /** Rỗng = Docker tự đặt tên (volume ẩn danh). */
  name: ObjectName.optional(),
  driver: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][\w.:/-]*$/),
  driverOpts: KeyValues,
  labels: KeyValues
})
export type VolumeSpec = z.infer<typeof VolumeSpec>

const Cidr = z
  .string()
  .max(64)
  .regex(/^[0-9A-Fa-f:.]+\/\d{1,3}$/, 'Use CIDR notation, like 172.28.0.0/16')
const Ip = z
  .string()
  .max(64)
  .regex(/^[0-9A-Fa-f:.]+$/, 'Use an IP address, like 172.28.0.1')

export const NetworkSpec = z.object({
  name: ObjectName,
  driver: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][\w.:/-]*$/),
  subnet: Cidr.optional(),
  gateway: Ip.optional(),
  ipRange: Cidr.optional(),
  internal: z.boolean(),
  attachable: z.boolean(),
  labels: KeyValues,
  /** Tuỳ chọn driver (macvlan: parent=eth0). */
  options: KeyValues
})
export type NetworkSpec = z.infer<typeof NetworkSpec>

/** Build image bằng `docker build` (BuildKit) trên máy chạy Docker. */
export const BuildSpec = z.object({
  /** Thư mục build context trên máy chạy Docker (server với SSH, máy này với local). */
  context: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[^-\0\n][^\0\n]*$/, 'Enter the folder of the build context'),
  /** Tương đối với context hoặc tuyệt đối; rỗng = Dockerfile trong context. */
  dockerfile: z
    .string()
    .max(4096)
    .regex(/^[^-\0\n][^\0\n]*$/)
    .optional(),
  tags: z.array(ImageRef).max(16),
  buildArgs: z
    .array(
      z
        .string()
        .max(4096)
        .regex(/^[^=\s]+=/, 'Use NAME=value')
    )
    .max(100),
  target: z
    .string()
    .max(128)
    .regex(/^[A-Za-z0-9][\w.-]*$/)
    .optional(),
  noCache: z.boolean(),
  pull: z.boolean()
})
export type BuildSpec = z.infer<typeof BuildSpec>

/** Container mới (hộp thoại Run). */
const RunSpecObject = z.object({
  image: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.:/@-]*$/, 'Looks like nginx:1.27'),
  name: z
    .string()
    .regex(/^([A-Za-z0-9][A-Za-z0-9_.-]{0,127})?$/, 'Letters, digits, "_", "." and "-" only')
    .optional(),
  ports: z
    .array(
      z.object({
        host: z.number().int().min(0).max(65535),
        container: z.number().int().min(1).max(65535),
        protocol: z.enum(['tcp', 'udp'])
      })
    )
    .max(32),
  env: z
    .array(
      z
        .string()
        .max(4096)
        .regex(/^[^=\s]+=/, 'Use NAME=value')
    )
    .max(100),
  volumes: z
    .array(
      z.object({
        source: z.string().min(1).max(1024),
        target: z.string().min(1).max(1024).regex(/^\//, 'Must be an absolute path'),
        readOnly: z.boolean()
      })
    )
    .max(32),
  restart: z.enum(['no', 'always', 'unless-stopped', 'on-failure']),
  command: z.array(z.string().max(4096)).max(64).optional(),
  autoRemove: z.boolean(),
  /** Image chưa có trên máy → kéo về trước. */
  pull: z.boolean()
})
/** Docker từ chối --rm cùng chính sách restart (container tự xoá thì không khởi động lại được). */
export const RUN_RESTART_CONFLICT = 'Auto-remove (--rm) only works with the restart policy "Never"'
export const RunSpec = RunSpecObject.refine((s) => !s.autoRemove || s.restart === 'no', {
  message: RUN_RESTART_CONFLICT,
  path: ['restart']
})
export type RunSpec = z.infer<typeof RunSpec>

export const DockerOp = z.discriminatedUnion('op', [
  /**
   * Chế độ chỉ đọc cho phiên này: thao tác thay đổi bị từ chối ở Session Host. `hostId` = host SSH
   * của phiên (Session Host hỏi lại main cờ chỉ đọc đã lưu — không chỉ tin cờ renderer gửi).
   */
  z.object({
    op: z.literal('configure'),
    readOnly: z.boolean(),
    hostId: z.string().min(1).max(64).optional()
  }),
  z.object({ op: z.literal('info') }),
  z.object({ op: z.literal('containers'), all: z.boolean() }),
  z.object({
    op: z.literal('inspect'),
    kind: z.enum(['container', 'image', 'volume', 'network']),
    id: Id,
    /** true = không che biến môi trường (người dùng bấm "Show values"). */
    reveal: z.boolean().optional()
  }),
  /** Dung lượng đĩa theo loại (`docker system df`). */
  z.object({ op: z.literal('df') }),
  /** CPU / RAM của mọi container đang chạy, lặp lại → sự kiện 'statsAll'. */
  z.object({ op: z.literal('statsAll.subscribe') }),
  /** Tiến trình trong container (`docker top`). */
  z.object({ op: z.literal('top'), id: Id }),
  /** Các lớp của image (`docker history`). */
  z.object({ op: z.literal('image.history'), id: Id }),
  /** Quét lỗ hổng của image bằng Trivy (chạy trên máy chạy Docker; cần Trivy cài sẵn ở đó). */
  z.object({ op: z.literal('image.scan'), ref: ImageRef }),
  /** Tạo + chạy container (như `docker run -d`). */
  z.object({ op: z.literal('run'), spec: RunSpec }),
  /** Log nhiều container (Compose project) — mỗi dòng có tiền tố tên. */
  z.object({
    op: z.literal('logs.subscribeMany'),
    containers: z
      .array(z.object({ id: Id, name: z.string().max(200) }))
      .min(1)
      .max(50),
    tail: z.number().int().min(0).max(100_000),
    timestamps: z.boolean()
  }),
  z.object({
    op: z.literal('action'),
    id: Id,
    action: ContainerAction,
    force: z.boolean().optional(),
    /** remove: xoá cả volume ẩn danh của container (`docker rm -v`). */
    volumes: z.boolean().optional()
  }),
  z.object({
    op: z.literal('rename'),
    id: Id,
    name: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/, 'Letters, digits, "_", "." and "-" only')
  }),
  z.object({
    op: z.literal('logs.subscribe'),
    id: Id,
    tail: z.number().int().min(0).max(100_000),
    timestamps: z.boolean()
  }),
  z.object({ op: z.literal('stats.subscribe'), id: Id }),
  z.object({ op: z.literal('events.subscribe') }),
  z.object({ op: z.literal('unsubscribe'), subscription: Subscription }),
  z.object({ op: z.literal('images') }),
  z.object({ op: z.literal('image.remove'), id: Id, force: z.boolean().optional() }),
  /**
   * Kéo image. `registry` = id thông tin đăng nhập đã lưu (Session Host hỏi main lấy mật khẩu,
   * renderer không bao giờ thấy); null / thiếu = không đăng nhập.
   */
  z.object({ op: z.literal('image.pull'), ref: ImageRef, registry: RegistryId.optional() }),
  /** Đẩy image lên registry (luồng tiến độ như pull). */
  z.object({ op: z.literal('image.push'), ref: ImageRef, registry: RegistryId.optional() }),
  /** Gắn thêm tag (`docker tag <id> <repo>:<tag>`). */
  z.object({ op: z.literal('image.tag'), id: Id, target: ImageRef }),
  /** Thử đăng nhập registry đã lưu (POST /auth / `docker login`). */
  z.object({ op: z.literal('registry.check'), registry: z.string().min(1).max(64) }),
  /** Build image (CLI `docker build`, BuildKit) → luồng sự kiện 'build'. */
  z.object({ op: z.literal('build'), spec: BuildSpec }),
  z.object({ op: z.literal('volumes') }),
  /** Dung lượng từng volume (`/system/df`, có thể chậm trên máy lớn) — hỏi riêng sau khi có danh sách. */
  z.object({ op: z.literal('volumes.sizes') }),
  z.object({ op: z.literal('volume.remove'), name: Id }),
  z.object({ op: z.literal('volume.create'), spec: VolumeSpec }),
  z.object({ op: z.literal('networks') }),
  z.object({ op: z.literal('network.remove'), id: Id }),
  z.object({ op: z.literal('network.create'), spec: NetworkSpec }),
  /** Nối container vào network (alias, IPv4 cố định tuỳ chọn). */
  z.object({
    op: z.literal('network.connect'),
    network: Id,
    container: Id,
    aliases: z.array(ObjectName).max(16),
    ipv4: Ip.optional()
  }),
  z.object({
    op: z.literal('network.disconnect'),
    network: Id,
    container: Id,
    force: z.boolean()
  }),
  /** Liệt kê một thư mục trong container (exec `sh`; không có shell → đọc archive). */
  z.object({ op: z.literal('files.list'), id: Id, path: ContainerPath }),
  /** Tải file / thư mục trong container về thư mục `localDir` trên máy này. */
  z.object({
    op: z.literal('files.download'),
    id: Id,
    paths: z.array(ContainerPath).min(1).max(1000),
    localDir: LocalPath
  }),
  /** Tải file / thư mục trên máy này vào thư mục `dir` của container. */
  z.object({
    op: z.literal('files.upload'),
    id: Id,
    dir: ContainerPath,
    localPaths: z.array(LocalPath).min(1).max(1000)
  }),
  /**
   * dryRun = chỉ liệt kê những gì sẽ bị xoá. Volume: mặc định chỉ volume ẩn danh (như `docker
   * volume prune` từ Docker 23); `all` = cả volume có tên. Image: mặc định chỉ image dangling;
   * `all` = mọi image không container nào dùng (`docker image prune -a`).
   */
  z.object({
    op: z.literal('prune'),
    what: PruneTarget,
    dryRun: z.boolean(),
    all: z.boolean().optional()
  }),
  z.object({
    op: z.literal('compose'),
    project: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'Invalid project name'),
    action: ComposeAction
  })
])
export type DockerOp = z.infer<typeof DockerOp>

/** Thao tác thay đổi (bị chặn ở chế độ chỉ đọc). */
export function isMutating(op: DockerOp): boolean {
  switch (op.op) {
    case 'action':
    case 'rename':
    case 'run':
    case 'image.remove':
    case 'image.pull':
    case 'image.push':
    case 'image.tag':
    case 'build':
    case 'volume.remove':
    case 'volume.create':
    case 'network.remove':
    case 'network.create':
    case 'network.connect':
    case 'network.disconnect':
    case 'files.upload':
    case 'compose':
      return true
    case 'prune':
      return !op.dryRun
    default:
      return false
  }
}

// ——— Kết quả ———

export interface EngineInfo {
  /** "Docker Engine 27.1 · linux/amd64" */
  version: string
  apiVersion: string
  os: string
  containers: number
  running: number
  images: number
  /** 'api' = Engine API qua socket; 'cli' = `docker` CLI (dự phòng). */
  via: 'api' | 'cli'
  /** Podman / rootless… */
  flavor: string
}

export interface PortMapping {
  ip: string
  privatePort: number
  publicPort: number | null
  type: string
}

/** Trạng thái healthcheck (HEALTHCHECK của image / compose); null = không có healthcheck. */
export type Health = 'healthy' | 'unhealthy' | 'starting' | null

/** "Up 2 hours (healthy)", "Up 5 seconds (health: starting)" → trạng thái healthcheck. */
export function healthOf(status: string): Health {
  const m = /\((healthy|unhealthy|health: starting)\)/i.exec(status)
  if (!m) return null
  const v = (m[1] ?? '').toLowerCase()
  return v === 'healthy' ? 'healthy' : v === 'unhealthy' ? 'unhealthy' : 'starting'
}

export interface ContainerRow {
  id: string
  name: string
  image: string
  /** created | running | paused | restarting | exited | removing | dead */
  state: string
  status: string
  health: Health
  created: number
  ports: PortMapping[]
  /** Nhãn `com.docker.compose.project` (nếu có). */
  project: string | null
  service: string | null
  /** Thư mục + file compose (để chạy `docker compose up/down`). */
  composeDir: string | null
  composeFiles: string | null
}

export interface ImageRow {
  id: string
  tags: string[]
  size: number
  created: number
  /** Không có tag (dangling). */
  dangling: boolean
  containers: number
}

export interface VolumeRow {
  name: string
  driver: string
  mountpoint: string
  created: number | null
  project: string | null
  /** Tên container đang gắn volume này (đang chạy hay đã dừng); [] = không container nào dùng. */
  usedBy: string[]
}

export interface NetworkRow {
  id: string
  name: string
  driver: string
  scope: string
  /** bridge / host / none — không xoá được. */
  builtin: boolean
}

export interface DiskUsageEntry {
  count: number
  size: number
  /** Phần "Clean up" mặc định xoá được (khớp đúng thao tác dọn mặc định). */
  reclaimable: number
}

export interface DiskUsage {
  /**
   * reclaimable = image dangling (không tag) — thứ "Clean up" mặc định xoá. `unused` = mọi image
   * không container nào dùng (`docker image prune -a`, kể cả dangling).
   */
  images: DiskUsageEntry & { unused: { count: number; size: number } }
  containers: DiskUsageEntry
  /**
   * reclaimable = volume ẩn danh không dùng (khớp mặc định của Clean up). Volume CÓ TÊN không dùng
   * tính riêng (`namedUnused`) — thường giữ dữ liệu cần giữ. null = không biết (CLI cũ).
   */
  volumes: DiskUsageEntry & { namedUnused: { count: number; size: number } | null }
  buildCache: DiskUsageEntry
}

export interface ProcessList {
  titles: string[]
  processes: string[][]
}

export interface ImageLayer {
  id: string
  created: number
  createdBy: string
  size: number
  comment: string
}

export interface PruneResult {
  /** Tên / id những gì bị xoá (hoặc sẽ bị xoá khi dryRun). */
  items: string[]
  reclaimed: number
  /** Số mục khi không liệt kê được từng cái (build cache qua CLI). */
  count?: number
}

/** Một mục trong thư mục của container (tab Files). */
export interface ContainerFileEntry {
  name: string
  /** link = liên kết tượng trưng; `linkDir` = trỏ tới thư mục (mở được). */
  type: 'file' | 'dir' | 'link' | 'other'
  linkDir?: boolean
  size: number | null
  /** ms; null = không biết. */
  mtime: number | null
  /** "-rwxr-xr-x" (null = không biết). */
  mode: string | null
}

export interface ContainerFileList {
  path: string
  entries: ContainerFileEntry[]
  /** exec = `sh` trong container; archive = đọc tar (container không có shell / đang dừng). */
  via: 'exec' | 'archive'
  /** Thư mục quá lớn để đọc hết qua archive — danh sách thiếu. */
  truncated: boolean
}

export interface CopyResult {
  files: number
  bytes: number
  /** Liên kết / file đặc biệt bỏ qua (không tạo symlink trên máy này). */
  skipped: number
  /** Đường dẫn đã lưu trên máy này (download). */
  saved: string[]
}

/** Thông tin đăng nhập registry (chỉ Session Host thấy mật khẩu). */
export interface RegistryAuth {
  server: string
  username: string
  password: string
}

/** Sự kiện 'build': một mảnh output của `docker build`. */
export interface BuildEvent {
  subscription: string
  text: string
}

/** Mẫu CPU / RAM / mạng từ /containers/{id}/stats. */
export interface StatsSample {
  at: number
  cpuPercent: number
  memUsage: number
  memLimit: number
  netRx: number
  netTx: number
}

// ——— Sự kiện (Session Host → tab) ———

export interface LogsEvent {
  subscription: string
  stream: 'stdout' | 'stderr'
  text: string
}

export interface PullEvent {
  subscription: string
  status: string
  /** Tiến độ theo layer (0–1), null = không rõ. */
  progress: number | null
  done: boolean
  error?: string
}

/** Tham số phiên / terminal. */
export const DockerEngineParams = z.object({
  /** 'local' = máy này; có hostId = qua SSH tới host đã lưu (tab tự mở kết nối). */
  hostId: z.string().min(1).max(64).optional(),
  /** Tên hiển thị (tiêu đề tab). */
  label: z.string().max(200)
})
export type DockerEngineParams = z.infer<typeof DockerEngineParams>

export const DockerLogsParams = z.object({
  hostId: z.string().min(1).max(64).optional(),
  label: z.string().max(200),
  /** Một container… */
  container: Id.optional(),
  name: z.string().max(200),
  /** …hoặc nhiều (log cả Compose project). */
  containers: z
    .array(z.object({ id: Id, name: z.string().max(200) }))
    .max(50)
    .optional()
})
export type DockerLogsParams = z.infer<typeof DockerLogsParams>

/** Shell vào container (tab terminal của module). */
/** Tên distro WSL (Ubuntu, Ubuntu-22.04…). */
export const WSL_DISTRO = /^[\w.-]{1,64}$/

export const DockerTerminalParams = z.object({
  container: Id,
  /** Host SSH (để Session Host hỏi main cờ chỉ đọc). */
  hostId: z.string().min(1).max(64).optional(),
  /** Lệnh thay cho shell mặc định (bash nếu có, không thì sh). */
  command: z.array(z.string().max(1024)).max(32).optional(),
  user: z
    .string()
    .max(64)
    .regex(/^[A-Za-z0-9_.:-]*$/)
    .optional(),
  /** Windows: container trong Docker của distro WSL này. */
  wsl: z.string().regex(WSL_DISTRO).optional()
})
export type DockerTerminalParams = z.infer<typeof DockerTerminalParams>

/** Engine TCP + TLS: địa chỉ và chứng chỉ đã giải mã (chỉ đi main → Session Host, không tới renderer). */
export const DockerTcpConfig = z.object({
  id: z.string().min(1).max(64),
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  ca: z
    .string()
    .max(64 * 1024)
    .optional(),
  cert: z
    .string()
    .max(64 * 1024)
    .optional(),
  key: z
    .string()
    .max(64 * 1024)
    .optional()
})
export type DockerTcpConfig = z.infer<typeof DockerTcpConfig>

/**
 * Config phiên trên máy này (main phân giải): `wsl` = Docker trong distro WSL đó, `tcp` = engine ở
 * địa chỉ TCP + TLS.
 */
export const DockerSessionConfig = z.object({
  wsl: z.string().regex(WSL_DISTRO).optional(),
  tcp: DockerTcpConfig.optional()
})
export type DockerSessionConfig = z.infer<typeof DockerSessionConfig>

/** Config phiên trên máy này (main phân giải). */
export const DockerLocalConfig = z.object({
  /** Socket / named pipe của Engine; null = không có (chỉ dùng CLI). */
  socket: z.string().max(1024).nullable()
})
export type DockerLocalConfig = z.infer<typeof DockerLocalConfig>

/** Che giá trị biến môi trường có vẻ là bí mật (inspect). */
export function maskEnv(entry: string): string {
  const eq = entry.indexOf('=')
  if (eq < 0) return entry
  const name = entry.slice(0, eq)
  return /pass|secret|token|key|credential|auth|private|cert|dsn/i.test(name)
    ? `${name}=••••••`
    : entry
}
