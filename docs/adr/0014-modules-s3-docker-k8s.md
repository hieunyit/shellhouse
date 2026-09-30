# ADR-014: Khuôn module — chuyển S3 sang module, module Docker và Kubernetes

- Trạng thái: Đề xuất (chưa làm)
- Ngày: 2026-09-30
- Liên quan: ADR-002 (mô hình tiến trình), ADR-003 (giao thức stream), ADR-004 (secret),
  ADR-013 (đồng bộ)

## 1. Bối cảnh

S3 được thêm vào bằng cách "khâu" trực tiếp vào lõi app: loại phiên `'s3'` trong `stream-protocol`,
nhánh `if (spec.kind === 's3')` ở main và Session Host, tin nhắn `s3` / `s3-result` riêng, loại tab
`S3Target`, nhánh riêng trong `Workspace`, `MultiExec`, `broadcast`, `workspaces`, IPC `s3:*`,
migration trong danh sách chung… (mục 5.1 liệt kê đủ 20+ chỗ).

Mỗi tính năng tương tự (Docker, Kubernetes, systemd, database tunnel…) làm theo cách đó sẽ nhân số
nhánh `if` lên, lõi app phình ra và khó test. Cần một **khuôn module**: tính năng lớn nằm gọn trong một
thư mục, gắn vào app qua các **điểm gắn** (contribution points) có định nghĩa rõ.

### Không làm (trong ADR này)

- **Plugin của bên thứ ba** (cài từ kho, code lạ). Module ở đây là code **chính thức** của Shellhouse:
  được review, test, phát hành cùng app. Khuôn được thiết kế để sau này có thể mở cho bên thứ ba (mục
  3.10), nhưng việc đó cần sandbox riêng và một ADR khác.

## 2. Quyết định (tóm tắt)

1. Mỗi module là một thư mục `src/modules/<id>/`, chia theo tiến trình: `shared/`, `main/`,
   `session-host/`, `renderer/`. Lõi app **không import** code bên trong module, chỉ gọi qua registry.
2. Mỗi module khai báo một **manifest** (id, tên, phiên bản, điểm gắn) và một **entry** cho từng tiến trình.
3. Giao thức Session Host dùng **tin nhắn chung** `module` / `module-result` / `module-event`, loại phiên
   chung `{ kind: 'module', module, params }` — không thêm loại tin riêng cho từng tính năng.
4. Module nhận **năng lực** (capability) qua một `ctx` hẹp — không tự đọc vault, không tự mở IPC, không
   spawn chương trình tuỳ ý.
5. S3 là module đầu tiên (chuyển từ code hiện có), sau đó **Docker**, rồi **Kubernetes**.

---

## 3. Khuôn module

### 3.1. Cấu trúc thư mục

```
src/modules/
  registry/                       ← phần lõi, KHÔNG thuộc module nào
    types.ts                      ← kiểu manifest, ctx, điểm gắn (dùng chung)
    main.ts                       ← registry của main
    session-host.ts               ← registry của Session Host
    renderer.ts                   ← registry của renderer
    all.ts                        ← danh sách module chính thức (import tĩnh, xem 3.9)
  s3/
    manifest.ts                   ← khai báo (dùng ở mọi tiến trình, không có code nặng)
    shared/                       ← zod schema: ops, events, tham số tab, bản ghi đồng bộ
    main/index.ts                 ← IPC, DB, giải mã secret, migration
    session-host/index.ts         ← service chạy thao tác (AWS SDK…)
    renderer/index.ts             ← mục thanh bên, loại tab, lệnh, cài đặt
    migrations/0001_accounts.sql
    test/…
  docker/ …
  k8s/ …
```

Quy tắc import (kiểm bằng ESLint `no-restricted-imports`):

- Lõi app → chỉ `src/modules/registry/*`.
- Module → lõi: chỉ `@shared/*`, `src/modules/registry/types`, và các thành phần UI dùng chung
  (`components/ui`, `components/files/*`, `SortMenu`…). **Không** import `src/main/vault`, `src/main/store`
  trực tiếp.
- Module → module khác: không (nếu cần, đi qua điểm gắn / lệnh).

### 3.2. Manifest

```ts
// src/modules/registry/types.ts
export interface ModuleManifest {
  id: string // 's3' | 'docker' | 'k8s' — chữ thường, [a-z0-9-]
  name: string // 'S3 storage'
  description: string
  version: number // tăng khi đổi định dạng dữ liệu / giao thức của module
  icon: string // tên icon lucide
  /** Bật mặc định khi cài mới. */
  enabledByDefault: boolean
  /** Chương trình bên ngoài module được phép gọi (3.6). */
  binaries?: readonly ('docker' | 'kubectl' | 'aws' | 'gcloud' | 'kubelogin')[]
  contributes: {
    sidebarSection?: boolean
    tabKinds?: readonly string[] // 'browser' | 'logs' | 'terminal'…
    hostActions?: readonly string[] // mục trong menu chuột phải của host SSH
    commands?: readonly { id: string; title: string }[]
    settings?: boolean // có trang trong Settings → Modules
    sessionKinds?: readonly string[] // loại phiên chạy trong Session Host
    attachToSsh?: boolean // chạy được trên kết nối SSH đang mở (3.5)
    syncRecordTypes?: readonly string[] // loại bản ghi đồng bộ (ADR-013)
  }
}
```

Manifest chỉ là dữ liệu tĩnh → đọc được mà không tải code module (hiện trong Settings, bảng lệnh).

### 3.3. Main process

```ts
export interface MainModule {
  manifest: ModuleManifest
  migrations: readonly { version: number; name: string; sql: string }[]
  activate(ctx: MainModuleContext): MainModuleApi | Promise<MainModuleApi>
}

export interface MainModuleContext {
  db: ModuleDb // chỉ chạy SQL trên bảng tiền tố `<id>_` (kiểm khi migrate)
  secrets: ModuleSecrets // mã hoá / giải mã trường của CHÍNH module (bọc vault.encryptString)
  settings: ModuleSettings<unknown> // phần cài đặt riêng của module (zod schema của module)
  ipc: ModuleIpc // đăng ký handler `module:<id>:<name>` (validate zod bắt buộc)
  events: { emit(name: string, data: unknown): void } // → renderer (`module:<id>:changed`…)
  sync?: ModuleSync // (ADR-013) đăng ký bản ghi đồng bộ, gọi touch()
  log: ModuleLog
}

export interface MainModuleApi {
  /**
   * Renderer xin mở phiên `{kind:'module', module:id, sessionKind, params}` → main gọi hàm này để
   * kiểm tham số và giải mã secret; kết quả chỉ đi thẳng sang Session Host (không qua renderer).
   */
  resolveSession?(sessionKind: string, params: unknown): Promise<unknown>
  dispose?(): void
}
```

- **Migration theo module**: bảng `module_migrations(module_id, version, name, applied_at)`. Mọi bảng
  của module có tiền tố `<id>_` (kiểm tự động khi chạy migration: câu lệnh tạo bảng khác tiền tố → lỗi).
  Tắt module **không xoá** dữ liệu; có nút "Remove data" riêng.
- **Secret**: `ctx.secrets.seal(table, id, field, value)` / `open(…)` — chỉ nhận `table` có tiền tố của
  module. Module không có đường nào lấy DEK hay đọc bảng của lõi / module khác.

### 3.4. Session Host

```ts
export interface HostModule {
  manifest: ModuleManifest
  /** Phiên riêng của module (tab S3, tab Docker local…). */
  createSession?(kind: string, config: unknown, ctx: HostModuleContext): HostModuleSession
  /** Chạy trên phiên SSH đang mở (Docker / K8s qua SSH). */
  attachToSsh?(ctx: HostModuleContext & { ssh: SshCapability }): HostModuleSession
}

export interface HostModuleSession {
  /** Một thao tác (đã validate bằng zod của module) → kết quả JSON. */
  run(op: unknown, signal: AbortSignal): Promise<unknown>
  /** Tạo transport terminal cho tab "exec vào container / pod" (3.7). */
  openTerminal?(
    params: unknown,
    size: { cols: number; rows: number },
    cb: TransportCallbacks
  ): Transport
  dispose(): void
}

export interface HostModuleContext {
  emit(event: string, data: unknown): void // → `module-event` tới tab
  transfers: TransferQueueLike // hàng đợi truyền file dùng chung (S3)
  pool: typeof import('../../node-shared/pool') // createLimiter / mapLimit / runQueue
  spawn?: LimitedSpawn // chỉ binaries trong manifest (3.6)
  fetch: ModuleFetch // HTTP có proxy, timeout, không theo redirect lạ
  log(level: 'info' | 'warn' | 'error', message: string): void
}

export interface SshCapability {
  exec(command: string, opts?: { pty?: boolean }): Promise<ExecChannel>
  /** Kênh tới unix socket trên server (streamlocal) — Docker socket. */
  openUnixSocket(path: string): Promise<Duplex>
  /** Kênh TCP qua server (direct-tcpip) — API server K8s sau bastion. */
  openTcp(host: string, port: number): Promise<Duplex>
}
```

Module không nhận `ssh2.Client` thật — chỉ `SshCapability` (lõi kiểm tham số, ghi log).

### 3.5. Giao thức (thay cho tin `s3` / `s3-result`)

Thêm vào `stream-protocol.ts` (một lần, cho mọi module):

```ts
// Renderer → Session Host
{ t: 'module', id: number, module: string, op: unknown }        // op validate bằng schema của module
{ t: 'module-cancel', id: number }                              // huỷ thao tác dài (AbortSignal)
{ t: 'module-attach', module: string }                          // gắn module vào phiên SSH của tab
// Session Host → Renderer
{ t: 'module-result', id: number, ok: boolean, result?: unknown, error?: string }
{ t: 'module-event', module: string, event: string, data: unknown }   // log stream, watch K8s…
```

Loại phiên:

```ts
// Renderer → main: mở tab module
{ kind: 'module', module: 's3', sessionKind: 'browser', cols, rows, params: { accountId } }
// Main → Session Host (đã phân giải, có secret)
{ kind: 'module', module: 's3', sessionKind: 'browser', cols, rows, config: { endpoint, …, secretAccessKey } }
```

- Session Host tra `module` trong registry → `createSession(sessionKind, config)`.
- Thao tác trên phiên SSH có sẵn: tab terminal gửi `module-attach` → Session Host gọi `attachToSsh`
  với `SshCapability` của kết nối đó (giống SFTP hiện nay chạy trên kết nối của tab).
- Mọi `op` và `event` có **zod schema trong `shared/` của module**; registry validate trước khi chuyển.
- Thao tác dài (quét, log) nhận `AbortSignal`; đóng tab → huỷ hết.

### 3.6. Chạy chương trình bên ngoài (docker, kubectl, trình cấp token)

- `ctx.spawn(binary, args)` chỉ chạy chương trình có trong `manifest.binaries`, tìm bằng
  `find-on-path` (đã có), **không qua shell**, args là mảng (không ghép chuỗi).
- Lần đầu module cần chạy một chương trình → app hỏi người dùng ("Allow the Kubernetes module to run
  `aws` to get cluster tokens?"), nhớ lựa chọn theo (module, đường dẫn chương trình, hash file).
- Qua SSH: `ssh.exec` nhận **một lệnh đã được quote bởi lõi** (`shellQuote(argv)`), không nhận chuỗi tự do.

### 3.7. Tab terminal của module (exec vào container / pod)

Loại tab mới `{ kind: 'module-terminal', module, params }`. Session Host gọi
`session.openTerminal(params)` → trả về một `Transport` (cùng interface với LocalPty / SSH shell) →
dùng lại toàn bộ đường terminal hiện có: OutputPump, flow control, log phiên, gợi ý lệnh, tìm kiếm,
MultiExec (tab module-terminal tham gia MultiExec được).

### 3.8. Renderer

```ts
export interface RendererModule {
  manifest: ModuleManifest
  /** Mục ở thanh bên (lazy). */
  SidebarSection?: LazyComponent<{}>
  /** Loại tab → component (lazy). */
  tabs?: Record<
    string,
    {
      component: LazyComponent<ModuleTabProps>
      title(params: unknown): string
      icon: string
      params: ZodType
      multiExec?: boolean
    }
  >
  /** Mục trong menu chuột phải của host SSH đang mở / đã lưu. */
  hostActions?: (host: HostContext) => MenuEntry[]
  commands?: Record<string, (ctx: CommandContext) => void>
  SettingsPage?: LazyComponent<{}>
}
```

Lõi app thay mọi nhánh `if (kind === 's3')` bằng tra registry:

| Chỗ trong lõi                | Trước                                 | Sau                                                        |
| ---------------------------- | ------------------------------------- | ---------------------------------------------------------- |
| `stores/tabs.ts`             | `S3Target` riêng                      | `{ kind: 'module', module, tab, params }`                  |
| `Workspace.tsx`              | `if (target.kind === 's3') <S3View/>` | `registry.tab(module, tab).component`                      |
| Icon / tiêu đề tab           | nhánh riêng                           | `registry.tab(…).icon / title(params)`                     |
| `MultiExecView`, `broadcast` | loại trừ `'s3'`                       | chỉ tab có `multiExec: true`                               |
| `workspaces.ts` (lưu bố cục) | schema `'s3'`                         | `{kind:'module', module, tab, params}` + params của module |
| Thanh bên                    | `<S3Section/>` cứng                   | lặp qua module có `SidebarSection`, theo thứ tự cài đặt    |
| Bảng lệnh                    | —                                     | lệnh của module (có tiền tố tên module)                    |
| Settings                     | S3 rải trong Files                    | Settings → **Modules** (bật/tắt, trang riêng mỗi module)   |

### 3.9. Nạp module

- Danh sách module chính thức là **import tĩnh** trong `registry/all.ts` (Vite tách chunk; renderer dùng
  `import()` động cho component nặng) → không nạp code từ đĩa lúc chạy, không có đường cho code lạ.
- Module tắt: không đăng ký IPC, không hiện UI, Session Host không tạo service. Code vẫn nằm trong gói
  cài đặt (nhẹ, chỉ vài trăm KB mỗi module).
- Cài đặt: `settings.modules = { s3: { enabled: true }, docker: { enabled: true, … } }`.

### 3.10. Hướng tới plugin bên thứ ba (không làm bây giờ)

Khuôn trên cố tình để module chỉ giao tiếp qua `ctx` và schema → sau này có thể chạy module lạ trong
tiến trình / iframe sandbox riêng, `ctx` thành API qua message, quyền khai báo trong manifest (người
dùng duyệt), kho plugin có ký số. Cần ADR riêng; **không** cho code lạ chạy trong main hay Session Host
như Tabby.

### 3.11. Kiểm thử khuôn

- Test hợp đồng cho registry: module giả đăng ký đủ mọi điểm gắn → xuất hiện đúng chỗ, tắt thì biến mất.
- Test chặn: module cố tạo bảng không có tiền tố, gọi IPC không khai báo, spawn chương trình không khai
  báo → lỗi.
- ESLint chặn import sai (3.1).

---

## 4. (dành chỗ) Đồng bộ

Module khai báo `syncRecordTypes` và dùng `ctx.sync.touch()` (ADR-013 mục 6.2). S3: `s3_account`.
Docker: `docker_endpoint`. K8s: `k8s_context` (chỉ metadata + tham chiếu, xem 7.3).

---

## 5. Chuyển S3 sang module

### 5.1. Bản đồ di chuyển

| Hiện tại                                                   | Sau                                                                                                                        |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/s3.ts`                                         | `src/modules/s3/shared/ops.ts`, `types.ts`                                                                                 |
| `src/main/s3-accounts.ts`                                  | `src/modules/s3/main/accounts.ts` (dùng `ctx.db`, `ctx.secrets`)                                                           |
| `migrations/0006_s3_accounts.sql`, `0007_s3_pins.sql`      | giữ nguyên trong lõi (đã phát hành — không sửa); đánh dấu bảng thuộc module `s3` (xem 5.3)                                 |
| `src/main/index.ts` nhánh `spec.kind === 's3'`, IPC `s3:*` | `modules/s3/main/index.ts`: `resolveSession`, IPC `module:s3:accounts                                                      | save | delete | pin` |
| `src/shared/ipc.ts`, preload `s3Accounts`…                 | API chung `window.shellhouse.module(id, name, …args)` + kiểu sinh từ schema module                                         |
| `src/shared/stream-protocol.ts` `S3SessionSpec`, tin `s3`  | bỏ; dùng `module` / `module-result` / `module-event`                                                                       |
| `src/session-host/s3/service.ts`, `edit.ts`                | `src/modules/s3/session-host/`                                                                                             |
| `src/session-host/session/session.ts` nhánh `'s3'`         | bỏ; Session gọi registry                                                                                                   |
| `src/renderer/src/s3/*`, `stores/s3.ts`                    | `src/modules/s3/renderer/`                                                                                                 |
| `stores/tabs.ts` `S3Target`, `addS3`, `setS3Location`      | `{kind:'module', module:'s3', tab:'browser', params:{accountId, bucket?, prefix?}}`; `addModuleTab()`, `setModuleParams()` |
| `Workspace.tsx`, `MultiExecView`, `broadcast.ts`           | tra registry (3.8)                                                                                                         |
| `shared/workspaces.ts` target `'s3'`                       | target `module` + **đọc được bản cũ** `'s3'` (chuyển tự động)                                                              |
| `settings.files.s3Requests/s3Transfers`                    | `settings.modules.s3.requests/transfers` (migration cài đặt)                                                               |
| `test/integration/s3*.ts`, `test/e2e/s3.spec.ts`           | `src/modules/s3/test/` (vitest / playwright vẫn tìm thấy)                                                                  |

### 5.2. Các bước (mỗi bước giữ mọi test xanh)

1. Thêm `modules/registry/*` + tin nhắn / loại phiên chung **song song** với đường cũ.
2. Chuyển code S3 sang `src/modules/s3/` (chỉ đổi đường dẫn import), chạy qua registry.
3. Chuyển renderer sang tab `module`; `workspaces` đọc được cả target cũ `'s3'`.
4. Xoá đường cũ (`'s3'` trong protocol, IPC `s3:*`, nhánh trong session / main / Workspace…).
5. Chuyển cài đặt `files.s3*` → `modules.s3.*` (migration cài đặt, giữ giá trị người dùng).
6. Kiểm: toàn bộ E2E S3 hiện có chạy nguyên (chỉ đổi selector nếu cần), thêm test "tắt module S3 →
   mục S3 biến mất, bật lại → dữ liệu còn nguyên".

Ước lượng: **1,5–2 tuần** (gồm khuôn module).

### 5.3. Migration đã phát hành

Không sửa migration 0006 / 0007 (đã có trên máy người dùng). Thêm `module_migrations` và ghi sẵn
`('s3', 1, 'accounts')`, `('s3', 2, 'pins')` cho các DB đã có hai bảng đó; module S3 mới bắt đầu từ
version 3. Bảng giữ tên `s3_accounts` (đã đúng tiền tố).

---

## 6. Module Docker

### 6.1. Mục tiêu

Quản lý Docker trên **máy này** và **trên server qua SSH** (không cần mở cổng Docker ra mạng, không cần
cài gì thêm trên server): container, image, volume, network, compose project, log, thống kê,
**exec vào container thành tab terminal**.

### 6.2. Kết nối

| Nguồn                     | Cách nói chuyện với Docker Engine API (HTTP)                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Máy này (Linux/macOS)     | Unix socket `/var/run/docker.sock` (hoặc `DOCKER_HOST`, context Docker Desktop / Colima / OrbStack / Podman)                 |
| Máy này (Windows)         | Named pipe `//./pipe/docker_engine`                                                                                          |
| Server qua SSH (chính)    | **streamlocal** qua kết nối SSH: `openssh_forwardOutStreamLocal('/var/run/docker.sock')` → HTTP trên kênh đó                 |
| Server qua SSH (dự phòng) | `docker` CLI qua `ssh.exec` với `--format '{{json .}}'` (khi server tắt `AllowStreamLocalForwarding` hoặc socket ở chỗ khác) |
| Rootless / Podman         | Socket `$XDG_RUNTIME_DIR/docker.sock` / `podman.sock` (Podman có API tương thích)                                            |

- Không dùng thư viện lớn (dockerode kéo nhiều phụ thuộc): client HTTP tối giản (~300 dòng) trên
  `http.request({ createConnection })` — chạy được cho cả socket local lẫn kênh SSH. Hỗ trợ
  phiên bản API tối thiểu 1.41 (Docker 20.10).
- Quyền: socket Docker ≈ quyền root trên server. Người dùng SSH không thuộc nhóm `docker` → báo rõ
  ("Your user can't access the Docker socket on this server. Add it to the `docker` group or use
  `sudo`…"); **không** tự dùng sudo.

### 6.3. Tính năng

| Nhóm             | Chi tiết                                                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Container        | Danh sách (trạng thái, image, cổng, uptime, CPU/RAM sống), lọc, sắp xếp; start / stop / restart / pause / kill / remove (xác nhận); inspect (JSON, env đã che giá trị có vẻ bí mật); đổi tên |
| Log              | Tab log riêng: follow, `tail N`, timestamps, tìm kiếm, tạm dừng cuộn, tải về file; stdout/stderr tô màu                                                                                      |
| Exec             | "Open shell" → **tab terminal** (3.7): qua SSH chạy `docker exec -it <id> sh -c 'command -v bash >/dev/null && exec bash                                                                     |     | exec sh'`trong PTY; local chạy qua`docker` CLI trong PTY (giai đoạn sau: Engine API exec + hijack, không cần CLI) |
| Thống kê         | Stream `/containers/{id}/stats` → biểu đồ nhỏ CPU / RAM / mạng trong trang chi tiết                                                                                                          |
| Image            | Danh sách, dung lượng, xoá, pull (tiến độ theo layer), prune ảnh treo                                                                                                                        |
| Volume / Network | Danh sách, xoá, prune (xác nhận, liệt kê trước những gì sẽ xoá)                                                                                                                              |
| Compose          | Nhóm container theo nhãn `com.docker.compose.project`; restart / stop / start cả project; up/down/pull dùng `docker compose` CLI (qua SSH hoặc local)                                        |
| Sự kiện          | Stream `/events` để danh sách tự cập nhật (không cần poll)                                                                                                                                   |
| File             | "Copy file from / to container" qua API archive (tar) — giai đoạn 2                                                                                                                          |

### 6.4. Giao diện

- **Thanh bên → Docker**: "This computer" (nếu có engine) + các host SSH đã bật Docker (tự phát hiện lần
  đầu kết nối: có `/var/run/docker.sock` → hiện gợi ý).
- **Menu chuột phải của host / tab SSH**: "Docker…" → mở tab Docker trên kết nối đó.
- **Tab Docker**: thanh trái (Containers / Images / Volumes / Networks / Compose), bảng giữa (dùng
  `FileTable`-style dùng chung), bảng chi tiết bên phải; nút nhanh trên từng dòng (Logs, Shell,
  Restart). Cùng hệ thống giao diện với S3 / SFTP.
- **Chế độ chỉ đọc** theo từng nguồn (ẩn mọi thao tác thay đổi) — nên bật cho production.

### 6.5. Giao thức (schema trong `modules/docker/shared`)

```ts
type DockerOp =
  | { op: 'info' }
  | { op: 'containers'; all: boolean }
  | { op: 'inspect'; kind: 'container' | 'image' | 'volume' | 'network'; id: string }
  | {
      op: 'action'
      id: string
      action: 'start' | 'stop' | 'restart' | 'pause' | 'unpause' | 'kill' | 'remove'
      force?: boolean
    }
  | { op: 'logs.subscribe'; id: string; tail: number; timestamps: boolean } // → event 'logs'
  | { op: 'stats.subscribe'; id: string } // → event 'stats'
  | { op: 'events.subscribe' } // → event 'engine'
  | { op: 'unsubscribe'; subscription: string }
  | { op: 'images' }
  | { op: 'image.remove'; id: string; force?: boolean }
  | { op: 'image.pull'; ref: string }
  | { op: 'volumes' }
  | { op: 'volume.remove'; name: string }
  | { op: 'networks' }
  | { op: 'network.remove'; id: string }
  | { op: 'prune'; what: 'images' | 'volumes' | 'networks' | 'containers'; dryRun: boolean }
  | {
      op: 'compose'
      project: string
      action: 'start' | 'stop' | 'restart' | 'up' | 'down' | 'pull'
    }
```

Event: `logs` (chunk + stream), `stats` (mẫu CPU/RAM), `engine` (container thay đổi), `pull` (tiến độ).

### 6.6. Kiểm thử

- Integration: **Engine API giả** (server HTTP trên unix socket tạm, trả dữ liệu ghi sẵn) → test client
  HTTP, danh sách, action, log stream (định dạng multiplex 8 byte header), stats, events.
- Integration trên Linux CI: Docker thật (runner Ubuntu có sẵn Docker) — chạy container `alpine`, exec,
  log, xoá.
- Qua SSH: server SSH test hiện có + hỗ trợ streamlocal chuyển tới socket Engine giả.
- E2E: mở tab Docker (Engine giả), restart container, mở log, mở shell (tab terminal).

Ước lượng: **3 tuần** (client + SSH streamlocal + UI + log/stats + exec + test).

---

## 7. Module Kubernetes

### 7.1. Mục tiêu

Làm việc với cluster như Lens / k9s nhưng nằm cạnh terminal và SSH: đổi context / namespace, xem tài
nguyên sống (watch), log, **exec vào pod thành tab terminal**, port-forward, scale, rollout restart,
sửa YAML bằng editor trên máy — và **đi qua bastion SSH** khi API server không mở ra ngoài.

### 7.2. Kết nối

- **kubeconfig**: `~/.kube/config`, biến `KUBECONFIG`, và file người dùng thêm. App **đọc tại chỗ** (không
  copy vào DB mặc định) và hiện danh sách context. Tuỳ chọn "Import into vault" cho kubeconfig chứa
  token/cert tĩnh → secret được mã hoá, đồng bộ được (ADR-013).
- **Xác thực**: token, client cert, OIDC (refresh token), và **exec plugin** (`aws eks get-token`,
  `gke-gcloud-auth-plugin`, `kubelogin`) — chạy qua `ctx.spawn` với danh sách cho phép + hỏi người dùng
  lần đầu (3.6).
- **Qua SSH bastion**: context gắn với một host SSH đã lưu → Session Host mở kênh `direct-tcpip` tới API
  server qua bastion (`SshCapability.openTcp`), TLS vẫn kiểm chứng chỉ theo `server` / `tls-server-name`
  trong kubeconfig (không tắt kiểm tra).
- Thư viện: `@kubernetes/client-node` trong Session Host (có watch, exec qua WebSocket, port-forward,
  auth plugin). Đặt sau `import()` động để app không nặng khi module tắt.

### 7.3. Dữ liệu lưu

Bảng `k8s_contexts`: tham chiếu (file kubeconfig + tên context) **hoặc** kubeconfig đã import (mã hoá),
host SSH bastion (nếu có), namespace mặc định, chế độ chỉ đọc, màu (dùng lại màu môi trường của host:
đỏ cho production). Không lưu tài nguyên cluster.

### 7.4. Tính năng

| Nhóm         | Chi tiết                                                                                                                                                                                                                   |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Điều hướng   | Chọn context (tô màu production), namespace (tất cả / chọn nhiều), tìm nhanh tài nguyên (Ctrl+K)                                                                                                                           |
| Tài nguyên   | Pods, Deployments, StatefulSets, DaemonSets, ReplicaSets, Jobs, CronJobs, Services, Ingresses, ConfigMaps, **Secrets (giá trị ẩn, bấm mới hiện, không lưu đĩa)**, PVC, Nodes, Events, Namespaces; CRD hiện dạng bảng chung |
| Trực tiếp    | **Watch** theo loại + namespace (resourceVersion, tự nối lại, `410 Gone` → list lại); phân trang `limit/continue`                                                                                                          |
| Pod          | Trạng thái, restart, container; log (chọn container, follow, previous, timestamps, tìm, tải về); **Shell** → tab terminal qua exec WebSocket (resize TTY); xoá pod                                                         |
| Workload     | Scale (+/−), rollout restart, lịch sử rollout, pause/resume, xem ReplicaSet                                                                                                                                                |
| Port-forward | Chọn pod / service + cổng → port-forward, hiện trong Forwards panel dùng chung, copy `localhost:port`                                                                                                                      |
| YAML         | Xem YAML; **sửa bằng editor trên máy** (như sửa file từ xa): lưu → `server-side apply` / `replace` với `resourceVersion` (xung đột → báo, không ghi đè)                                                                    |
| Mô tả        | Trang chi tiết kiểu `kubectl describe`: điều kiện, sự kiện liên quan, container, volume                                                                                                                                    |
| An toàn      | Chế độ **chỉ đọc** theo context; context production: thao tác phá huỷ phải gõ tên tài nguyên để xác nhận                                                                                                                   |
| Lỗi RBAC     | Hiện rõ ("You can't list secrets in namespace X") thay vì lỗi 403 thô; ẩn loại tài nguyên không có quyền (`SelfSubjectAccessReview`)                                                                                       |

### 7.5. Giao thức (rút gọn)

```ts
type K8sOp =
  | { op: 'contexts' }
  | { op: 'namespaces' }
  | {
      op: 'list'
      kind: string
      namespace?: string
      labelSelector?: string
      limit: number
      continue?: string
    }
  | { op: 'watch'; kind: string; namespace?: string; resourceVersion: string } // → event 'watch'
  | { op: 'get'; kind: string; namespace?: string; name: string; format: 'json' | 'yaml' }
  | { op: 'apply'; yaml: string; resourceVersion?: string }
  | { op: 'delete'; kind: string; namespace?: string; name: string }
  | {
      op: 'scale'
      kind: 'deployment' | 'statefulset'
      namespace: string
      name: string
      replicas: number
    }
  | { op: 'rolloutRestart'; kind: string; namespace: string; name: string }
  | {
      op: 'logs.subscribe'
      namespace: string
      pod: string
      container?: string
      previous: boolean
      tail: number
    }
  | { op: 'portForward'; namespace: string; target: string; ports: [number, number][] }
  | { op: 'secret.reveal'; namespace: string; name: string; key: string }
  | { op: 'unsubscribe'; subscription: string }
```

### 7.6. Hiệu năng

- Mỗi (context, loại, namespace) một **watch** chia sẻ giữa các bảng đang mở; bỏ watch khi không còn ai xem.
- Cluster lớn (hàng chục nghìn pod): phân trang, chỉ giữ cột cần hiện, cập nhật UI theo lô (≤ 10 lần/giây).
- Log: giới hạn bộ đệm (ví dụ 50.000 dòng / tab), cuộn ảo.

### 7.7. Kiểm thử

- Unit: bảng tài nguyên (chuyển đối tượng → dòng), xử lý watch (`ADDED/MODIFIED/DELETED/BOOKMARK`, 410).
- Integration trên Linux CI: **kind** (Kubernetes in Docker) — tạo namespace, deployment, exec, log,
  port-forward, scale, apply có xung đột.
- API server giả cho macOS / Windows CI (không có Docker).
- E2E: chọn context, xem pod, mở log, mở shell, chế độ chỉ đọc chặn xoá.

Ước lượng: **4–5 tuần**.

---

## 8. Kế hoạch tổng

| Bước | Nội dung                                                                                                 | Ước lượng           |
| ---- | -------------------------------------------------------------------------------------------------------- | ------------------- |
| 1    | Khuôn module (registry 3 tiến trình, giao thức chung, migration theo module, Settings → Modules, ESLint) | 1 tuần              |
| 2    | Chuyển S3 sang module (5.2), xoá đường cũ                                                                | 1 tuần              |
| 3    | `SshCapability` (exec đã quote, streamlocal, direct-tcpip) + tab `module-terminal`                       | 0,5 tuần            |
| 4    | Module Docker (6)                                                                                        | 3 tuần              |
| 5    | Module Kubernetes (7)                                                                                    | 4–5 tuần            |
| 6    | (Tuỳ chọn) systemd / database tunnel trên cùng khuôn                                                     | 1–2 tuần mỗi module |

**Tổng**: khoảng **10–11 tuần** cho khuôn + S3 + Docker + Kubernetes (một người, đã gồm test).

Thứ tự này cho giá trị sớm: sau bước 2 không có tính năng mới nhưng lõi gọn hơn; sau bước 4 người dùng
đã có Docker qua SSH — tính năng mà Termius / MobaXterm không có.

## 9. Hệ quả

- (+) Lõi app không còn nhánh riêng cho từng tính năng; thêm module không sửa lõi.
- (+) Module có ranh giới rõ → test riêng, bật/tắt được, chuẩn bị cho plugin bên thứ ba sau này.
- (+) Docker / K8s dùng lại mọi thứ đã có: terminal, SSH, forwarding, sửa file từ xa, hàng đợi, giao diện.
- (−) Thêm một lớp trừu tượng (registry, ctx) — phải giữ nó mỏng, tránh "framework trong framework".
- (−) Chuyển S3 đụng nhiều file; làm từng bước, song song đường cũ, để luôn xanh.
- (−) Docker socket / kubeconfig là quyền rất cao → chế độ chỉ đọc, xác nhận thao tác phá huỷ, hỏi trước
  khi chạy chương trình bên ngoài.

## 10. Câu hỏi còn mở

1. Docker Desktop / Colima / OrbStack / Podman: tự dò hết hay để người dùng chọn socket?
2. K8s: có cần hỗ trợ Helm (danh sách release, rollback) ngay trong bản đầu không?
3. Thứ tự các module sau K8s: systemd, database tunnel, hay trình quản lý file dạng S3 cho
   Azure Blob / Google Cloud Storage?
