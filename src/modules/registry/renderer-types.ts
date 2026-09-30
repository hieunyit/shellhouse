import type { ComponentType, ReactNode } from 'react'
import type { ZodType } from 'zod'
import type { ModuleManifest } from './types'

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
}
