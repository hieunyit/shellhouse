import type { ZodType } from 'zod'
import type { ModuleManifest } from './types'

/** Kiểu cho phần main của module (ADR-014 mục 3.3). */

export interface ModuleMigration {
  version: number
  name: string
  sql: string
}

export interface ModuleStatement {
  run(...params: unknown[]): { changes: number }
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

/** SQL chỉ trên bảng có tiền tố `<id>_` của module. */
export interface ModuleDb {
  prepare(sql: string): ModuleStatement
  transaction<T>(fn: () => T): T
}

/** Mã hoá / giải mã trường của CHÍNH module (bọc vault). */
export interface ModuleSecrets {
  seal(table: string, id: string, field: string, value: string): Buffer
  /** Giải mã rồi trả chuỗi; bản rõ trong bộ nhớ được xoá ngay sau khi đọc. */
  open(table: string, id: string, field: string, sealed: Buffer): string
}

export interface ModuleSettings<T> {
  get(): T
  onChange(listener: (value: T) => void): () => void
}

export interface ModuleIpc {
  /** Kênh `module:<id>:<name>`; tham số validate bằng `args` trước khi gọi handler. */
  handle<A extends unknown[]>(
    name: string,
    args: ZodType<A>,
    handler: (...args: A) => unknown
  ): void
}

export interface ModuleLog {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** File người dùng vừa chọn trong hộp thoại. */
export interface PickedFile {
  path: string
  name: string
  content: string
  /**
   * Đọc file mà file này trỏ tới (chứng chỉ trong kubeconfig…), đường dẫn tương đối tính từ thư
   * mục của file. Chỉ dùng trong lúc xử lý lần chọn này; tối đa 1 MB mỗi file.
   */
  readReferenced(path: string): Promise<string>
}

export interface MainModuleContext {
  db: ModuleDb
  /** Chỉ có khi manifest khai báo quyền `secrets`. */
  secrets: ModuleSecrets
  settings: ModuleSettings<unknown>
  ipc: ModuleIpc
  /** → renderer, tên sự kiện tự có tiền tố module. */
  events: { emit(name: string, data: unknown): void }
  /** Thư mục nhà của người dùng (`~` trong quyền read-file / write-file). */
  readonly home: string
  /** Đọc file trên máy — chỉ đường dẫn khai báo trong quyền `read-file` (kubeconfig…). */
  readFile(path: string): Promise<string>
  /**
   * Ghi đè file trên máy — chỉ đường dẫn khai báo trong quyền `write-file`. Ghi an toàn: file tạm
   * cùng thư mục rồi đổi tên (không bao giờ để lại file ghi dở); giữ quyền truy cập của file cũ.
   */
  writeFile(path: string, content: string): Promise<void>
  /** Liệt kê file (không đệ quy) trong thư mục khai báo trong quyền `read-file`. */
  readDir(path: string): Promise<{ name: string; path: string; size: number }[]>
  /** Windows: bản phân phối WSL (cần quyền chạy `wsl`); máy khác → []. */
  wslDistros(): Promise<{ name: string; running: boolean; version: number }[]>
  /**
   * Đường dẫn có phải file tạm "sửa trong editor" do main cấp (files:prepareEdit) không — để
   * Session Host chỉ ghi / theo dõi đúng file đó, không phải đường dẫn bất kỳ renderer gửi.
   */
  ownsEditFile?(path: string): boolean
  /** Hộp thoại chọn file (cần quyền `pick-file`); huỷ → []. */
  pickFiles(options: {
    title: string
    filters?: { name: string; extensions: string[] }[]
    multiple?: boolean
  }): Promise<PickedFile[]>
  log: ModuleLog
}

export interface MainModuleApi {
  /**
   * Renderer xin mở phiên `{kind:'module', module, sessionKind, params}` → main gọi hàm này để kiểm
   * tham số và giải mã secret; kết quả chỉ đi thẳng sang Session Host (không qua renderer).
   */
  resolveSession?(sessionKind: string, params: unknown): unknown
  /** Yêu cầu từ phần Session Host của chính module (`ctx.fromMain`). */
  onHostRequest?(name: string, params: unknown): unknown
  dispose?(): void
}

export interface MainModule {
  manifest: ModuleManifest
  migrations: readonly ModuleMigration[]
  /** Schema cài đặt riêng (mặc định cho mọi trường — `.catch`). */
  settings?: ZodType
  activate(ctx: MainModuleContext): MainModuleApi
}
