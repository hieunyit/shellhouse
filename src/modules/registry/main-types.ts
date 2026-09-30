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

export interface MainModuleContext {
  db: ModuleDb
  /** Chỉ có khi manifest khai báo quyền `secrets`. */
  secrets: ModuleSecrets
  settings: ModuleSettings<unknown>
  ipc: ModuleIpc
  /** → renderer, tên sự kiện tự có tiền tố module. */
  events: { emit(name: string, data: unknown): void }
  /** Đọc file trên máy — chỉ đường dẫn khai báo trong quyền `read-file` (kubeconfig…). */
  readFile(path: string): Promise<string>
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
