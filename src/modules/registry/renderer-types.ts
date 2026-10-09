import type { ComponentType, ReactNode } from 'react'
import type { ZodType } from 'zod'
import type { ModuleManifest } from './types'
import type { OneShotContext, SessionPrompt } from './renderer-session'

/** Kiểu cho phần renderer của module (ADR-014 mục 3.8). */

export interface ModuleTabProps<P = unknown> {
  tabId: string
  params: P
  /** Tab đang được chọn trong nhóm của nó. */
  active: boolean
  /** Panel đang hiện (không bị tab khác cùng nhóm che). */
  visible: boolean
}

export interface ModuleTabDef<P = unknown> {
  /** Nên là component lazy (`lazyModuleComponent`) để module tắt không tốn gì. */
  component: ComponentType<ModuleTabProps<P>>
  title(params: P): string
  icon: ComponentType<{ size?: number; className?: string }>
  params: ZodType<P>
  /** Tab có ô gõ lệnh → tham gia MultiExec. */
  multiExec?: boolean
}

/**
 * Khai báo loại tab với kiểu tham số riêng. Registry luôn parse `params` bằng `def.params` trước khi
 * đưa cho component / title, nên ép kiểu về `ModuleTabDef` (unknown) là an toàn.
 */
export function defineTab<P>(def: ModuleTabDef<P>): ModuleTabDef {
  return def as unknown as ModuleTabDef
}

/** Host SSH (đã lưu) mà menu chuột phải đang mở cho. */
export interface HostContext {
  hostId: string
  label: string
  /** 'ssh' | 'telnet' | 'serial' — module chạy trên SSH chỉ gắn vào host SSH. */
  protocol: string
}

export interface ModuleMenuEntry {
  id: string
  label: string
  icon?: ReactNode
  onSelect(): void
}

export interface ModuleCommand {
  id: string
  title: string
  run(): void
}

/** Hộp hỏi mật khẩu / host key mà một phiên đang chờ (null = không còn gì chờ). */
export type RunbookPrompt = SessionPrompt

/** Bối cảnh khi chạy một bước của runbook (huỷ, hết giờ, hỏi mật khẩu — xem `OneShotContext`). */
export type RunbookStepContext = OneShotContext

export interface RunbookStepOutcome {
  ok: boolean
  /** Một dòng: vì sao đạt / lỗi ("3/3 bản sẵn sàng", "container chưa healthy"…). */
  detail: string
  /** Đầu ra thêm (nếu có) — runbook che giá trị giống bí mật trước khi hiện / lưu. */
  output?: string
}

/**
 * Loại bước module đóng góp cho Runbook (ADR-016 mục 8). Là bước KIỂM TRA chỉ đọc (chờ Deployment
 * sẵn sàng, container healthy…) — việc thay đổi nằm ngoài khuôn này nên môi trường chỉ đọc không
 * chặn chúng. Tên đầy đủ của loại bước là `<id module>.<khoá>`.
 */
export interface RunbookStepKind<P = unknown> {
  label(): string
  icon: ComponentType<{ size?: number; className?: string }>
  params: ZodType<P>
  /** Tham số của bước mới. */
  defaults(): P
  /** Một dòng mô tả bước trong danh sách. */
  summary(params: P): string
  /** Form sửa tham số. */
  Editor: ComponentType<{ value: P; onChange: (next: P) => void }>
  /**
   * Nạp dữ liệu mà `environmentOf` / `run` cần (danh sách context…) — runbook gọi trước khi tính
   * chính sách chạy, để không bỏ sót môi trường Production chỉ vì store chưa nạp.
   */
  prepare?: () => Promise<void>
  /** Id môi trường của đích (để suy mức xác nhận); null = không có. */
  environmentOf(params: P): string | null
  run(params: P, ctx: RunbookStepContext): Promise<RunbookStepOutcome>
}

/** Khai báo loại bước với kiểu tham số riêng (registry luôn parse `params` trước khi dùng). */
export function defineRunbookStep<P>(def: RunbookStepKind<P>): RunbookStepKind {
  return def as unknown as RunbookStepKind
}

export interface RendererModule {
  manifest: ModuleManifest
  /** Mục ở thanh bên. */
  SidebarSection?: ComponentType
  /** Loại tab → định nghĩa. */
  tabs?: Record<string, ModuleTabDef>
  /** Mục trong menu chuột phải của host SSH đã lưu. */
  hostActions?: (host: HostContext) => ModuleMenuEntry[]
  /** Lệnh trong bảng lệnh (tiêu đề tự thêm tiền tố tên module). */
  commands?: () => ModuleCommand[]
  /** Trang riêng trong Settings → Modules. */
  SettingsPage?: ComponentType
  /**
   * Việc nền khi module bật và vault đã mở (theo dõi cluster / Docker cho Home): chạy một lần, trả
   * về hàm dừng (module bị tắt / đóng cửa sổ).
   */
  background?: () => () => void
  /** Loại bước đóng góp cho module Runbook, theo khoá (tên đầy đủ: `<id module>.<khoá>`). */
  runbookSteps?: Record<string, RunbookStepKind>
}
