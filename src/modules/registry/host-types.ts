import type { Duplex } from 'node:stream'
import type { TransferStatus } from '@shared/sftp'
import type { Transport, TransportCallbacks } from '../../session-host/transport/types'
import type { ModuleBinary, ModuleManifest } from './types'

/** Kiểu cho phần Session Host của module (ADR-014 mục 3.4). */

export interface TerminalSize {
  cols: number
  rows: number
}

/** Kết quả chạy một chương trình tới khi xong. */
export interface ExecResult {
  code: number | null
  stdout: string
  stderr: string
}

/** Tiến trình đang chạy (log stream, `docker compose up`…). */
export interface RunningProgram {
  onStdout(listener: (chunk: Buffer) => void): void
  onStderr(listener: (chunk: Buffer) => void): void
  /** Gọi đúng một lần khi tiến trình kết thúc. */
  onExit(listener: (code: number | null) => void): void
  kill(): void
}

export interface ExecOptions {
  /** Ghi vào stdin rồi đóng. */
  input?: string | Buffer
  timeoutMs?: number
  signal?: AbortSignal
  /** Giới hạn byte stdout giữ lại (mặc định 16 MB). */
  maxOutputBytes?: number
  /** Biến môi trường thêm (chỉ chương trình trên máy; bỏ qua với SSH). */
  env?: Record<string, string>
}

/**
 * Năng lực trên một kết nối SSH đang mở — module KHÔNG nhận `ssh2.Client` thật. Lõi quote lệnh
 * (argv → chuỗi shell), kiểm quyền theo manifest và ghi log.
 */
export interface SshCapability {
  /** Chạy lệnh (argv, lõi tự quote) tới khi xong. Cần quyền `ssh-exec`. */
  exec(argv: readonly string[], options?: ExecOptions): Promise<ExecResult>
  /** Chạy lệnh dài (stream). Cần quyền `ssh-exec`. */
  spawn(argv: readonly string[], signal?: AbortSignal): Promise<RunningProgram>
  /** Lệnh trong PTY → transport cho tab terminal. Cần quyền `ssh-exec`. */
  openPty(argv: readonly string[], size: TerminalSize, cb: TransportCallbacks): Promise<Transport>
  /** Kênh tới unix socket trên server (streamlocal). Cần quyền `ssh-socket` khớp đường dẫn. */
  openUnixSocket(path: string): Promise<Duplex>
  /** Kênh TCP qua server (direct-tcpip). Cần quyền `ssh-tunnel`. */
  openTcp(host: string, port: number): Promise<Duplex>
  /** Tên hiển thị của kết nối (user@host). */
  readonly label: string
}

/** Chạy chương trình trên máy — chỉ binaries trong manifest, không qua shell, hỏi người dùng lần đầu. */
export interface LimitedSpawn {
  exec(binary: ModuleBinary, args: readonly string[], options?: ExecOptions): Promise<ExecResult>
  spawn(
    binary: ModuleBinary,
    args: readonly string[],
    signal?: AbortSignal
  ): Promise<RunningProgram>
  openPty(
    binary: ModuleBinary,
    args: readonly string[],
    size: TerminalSize,
    cb: TransportCallbacks
  ): Promise<Transport>
  /** Có tìm thấy chương trình trên máy không (không hỏi người dùng). */
  available(binary: ModuleBinary): boolean
}

export interface HostModuleContext {
  /** → `module-event` tới tab. */
  emit(event: string, data: unknown): void
  /** Danh sách truyền file → giao diện truyền file dùng chung (tin `transfers`). */
  transfers(list: TransferStatus[]): void
  spawn: LimitedSpawn
  /** Socket trên máy (Docker Desktop, Podman…). Cần quyền `local-socket` khớp đường dẫn. */
  connectLocalSocket(path: string): Promise<Duplex>
  /** Đọc file trên máy (kubeconfig). Cần quyền `read-file` khớp đường dẫn (`~` = home). */
  readFile(path: string): Promise<string>
  log(level: 'info' | 'warn' | 'error', message: string): void
  /** Hỏi phần main của chính module (`MainModuleApi.onHostRequest`). */
  fromMain(name: string, params: unknown): Promise<unknown>
  /**
   * Đường dẫn trên máy (renderer gửi: nơi lưu file tải về, file tải lên) có phải người dùng đã chọn
   * qua hộp thoại của main / kéo thả không. Không hỏi được main → false.
   */
  localPathGranted(path: string, access: 'read' | 'write'): Promise<boolean>
  /** File tạm "sửa bằng editor trên máy" do main cấp (`files:prepareEdit`). */
  ownsEditFile(path: string): Promise<boolean>
}

/** Tên yêu cầu của lõi gửi qua kênh `module:request` (không đụng tên của module). */
export const CORE_LOCAL_PATH = '$localPath'
export const CORE_EDIT_FILE = '$editFile'

export interface HostModuleSession {
  /** Một thao tác → kết quả JSON. `op` chưa validate — module parse bằng schema của mình. */
  run(op: unknown, signal: AbortSignal): Promise<unknown>
  /** Transport cho tab terminal của module (exec vào container / pod — 3.7). */
  openTerminal?(params: unknown, size: TerminalSize, cb: TransportCallbacks): Promise<Transport>
  dispose(): void
}

export interface HostModule {
  manifest: ModuleManifest
  /** Phiên riêng của module (tab S3, Docker trên máy này…). `config` do main phân giải. */
  createSession?(kind: string, config: unknown, ctx: HostModuleContext): HostModuleSession
  /** Chạy trên phiên SSH đang mở (Docker / K8s qua SSH). */
  attachToSsh?(ctx: HostModuleContext & { ssh: SshCapability }): HostModuleSession
}
