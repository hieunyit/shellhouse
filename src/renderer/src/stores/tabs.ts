import { create } from 'zustand'
import type { WorkspaceItem } from '@shared/workspaces'
import { shellName } from './shells'

/** Tab có terminal (local / SSH / host đã lưu). */
export type TerminalTarget =
  | { kind: 'local'; shellId?: string }
  | { kind: 'ssh'; host: string; port: number; username: string }
  | { kind: 'host'; hostId: string }

/** Tab trình quản lý S3 (không có terminal). */
export interface S3Target {
  kind: 's3'
  accountId: string
  /** Vị trí đang xem (không có = bảng bucket). Nhân bản tab / workspace mở lại đúng chỗ này. */
  bucket?: string
  prefix?: string
}

export type TabTarget = TerminalTarget | S3Target

export interface Tab {
  id: string
  title: string
  target: TabTarget
  /** Tab sinh ra từ lệnh chia màn hình: đặt cạnh tab nguồn theo hướng này ('within' = cùng nhóm). */
  splitFrom?: { tabId: string; direction: 'right' | 'below' | 'within' }
  /** Panel mở sẵn khi tab vừa tạo. */
  initialPanel?: 'sftp'
  /** 'files' = trình quản lý file hai cột (Local | Remote) thay cho terminal ("Open SFTP"). */
  view?: 'files'
}

export interface OpenHostOptions {
  /** Mở cạnh tab đang active thay vì thành tab mới. */
  split?: 'right' | 'below'
  panel?: 'sftp'
  /** Mở thành trình quản lý file hai cột. */
  view?: 'files'
}

interface TabsState {
  tabs: Tab[]
  activeId: string | null
  /** Tab terminal local; `shellId` = shell cụ thể (không có = shell mặc định). */
  addLocal: (shellId?: string) => string
  addSsh: (target: { host: string; port: number; username: string }) => string
  addHost: (host: { id: string; label: string }, options?: OpenHostOptions) => string
  /** Mở trình quản lý S3 của một tài khoản. */
  addS3: (
    account: { id: string; name: string },
    location?: { bucket: string; prefix: string }
  ) => string
  /** Tab S3 đổi vị trí đang xem: cập nhật đích (để nhân bản / lưu workspace) và tiêu đề. */
  setS3Location: (
    id: string,
    location: { bucket: string; prefix: string } | null,
    title: string
  ) => void
  /** Mở nhiều host: thành các tab, hoặc xếp lưới (chia màn hình) trong một khung. */
  openHosts: (hosts: readonly { id: string; label: string }[], layout: 'tabs' | 'grid') => string[]
  /** Mở lại một workspace đã lưu (thêm vào các tab đang mở). */
  openWorkspace: (items: readonly WorkspaceItem[]) => string[]
  /** Mở một phiên mới cùng đích với tab hiện tại, đặt cạnh nó. */
  split: (direction: 'right' | 'below') => string | null
  /** Mở thêm một phiên cùng đích, thành tab cạnh tab này. */
  duplicate: (id: string) => string | null
  /** Đóng mọi tab trừ tab này. */
  closeOthers: (id: string) => void
  close: (id: string) => void
  activate: (id: string) => void
  cycle: (delta: 1 | -1) => void
  setTitle: (id: string, title: string) => void
  /** Tab chuyển giữa terminal và trình quản lý file hai cột. */
  setView: (id: string, view: 'files' | undefined) => void
}

let localCounter = 0

/** Tiêu đề tab S3 theo vị trí: "bucket" hoặc "bucket/…/thư-mục-cuối". */
export function s3LocationTitle(bucket: string, prefix: string): string {
  const parts = prefix.split('/').filter(Boolean)
  if (parts.length === 0) return bucket
  if (parts.length === 1) return `${bucket}/${parts[0] ?? ''}`
  return `${bucket}/…/${parts.at(-1) ?? ''}`
}

export const useTabs = create<TabsState>((set, get) => {
  const add = (
    title: string,
    target: TabTarget,
    splitFrom?: Tab['splitFrom'],
    initialPanel?: Tab['initialPanel'],
    view?: Tab['view']
  ): string => {
    const id = crypto.randomUUID()
    set((s) => ({
      tabs: [
        ...s.tabs,
        {
          id,
          title,
          target,
          ...(splitFrom ? { splitFrom } : {}),
          ...(initialPanel ? { initialPanel } : {}),
          ...(view ? { view } : {})
        }
      ],
      activeId: id
    }))
    return id
  }
  return {
    tabs: [],
    activeId: null,
    addLocal: (shellId) => {
      const title = shellName(shellId) ?? `Local ${++localCounter}`
      return add(title, shellId ? { kind: 'local', shellId } : { kind: 'local' })
    },
    addSsh: (t) =>
      add(`${t.username}@${t.host}${t.port === 22 ? '' : `:${t.port}`}`, { kind: 'ssh', ...t }),
    addHost: (host, options) => {
      const active = get().activeId
      const splitFrom =
        options?.split && active ? { tabId: active, direction: options.split } : undefined
      return add(
        options?.view === 'files' ? `${host.label} (SFTP)` : host.label,
        { kind: 'host', hostId: host.id },
        splitFrom,
        options?.panel,
        options?.view
      )
    },
    addS3: (account, location) =>
      add(
        location ? s3LocationTitle(location.bucket, location.prefix) : account.name,
        location
          ? { kind: 's3', accountId: account.id, bucket: location.bucket, prefix: location.prefix }
          : { kind: 's3', accountId: account.id }
      ),
    openHosts: (hosts, layout) => {
      const ids: string[] = []
      // Lưới gần vuông: 4 host → 2×2, 6 → 3×2. Hàng đầu chia phải, các hàng sau chia xuống từ ô phía trên.
      const cols = Math.ceil(Math.sqrt(hosts.length))
      const active = get().activeId
      hosts.forEach((host, i) => {
        let splitFrom: Tab['splitFrom']
        // Ô đầu tiên của lưới mở trong khung mới bên phải (không lẫn vào các tab đang mở).
        if (layout === 'grid' && i === 0 && active)
          splitFrom = { tabId: active, direction: 'right' }
        if (layout === 'grid' && i > 0) {
          splitFrom =
            i < cols
              ? { tabId: ids[i - 1] ?? '', direction: 'right' }
              : { tabId: ids[i - cols] ?? '', direction: 'below' }
        }
        ids.push(add(host.label, { kind: 'host', hostId: host.id }, splitFrom))
      })
      return ids
    },
    openWorkspace: (items) => {
      const ids: string[] = []
      for (const item of items) {
        const anchor = item.after === null ? undefined : ids[item.after]
        const splitFrom = anchor ? { tabId: anchor, direction: item.direction } : undefined
        const title =
          item.target.kind === 'local'
            ? (shellName(item.target.shellId) ?? `Local ${++localCounter}`)
            : item.title
        ids.push(add(title, item.target, splitFrom, undefined, item.view))
      }
      return ids
    },
    split: (direction) => {
      const { tabs, activeId } = get()
      const source = tabs.find((t) => t.id === activeId)
      if (!source) return null
      const title =
        source.target.kind === 'local'
          ? (shellName(source.target.shellId) ?? `Local ${++localCounter}`)
          : source.title
      return add(title, source.target, { tabId: source.id, direction })
    },
    duplicate: (id) => {
      const source = get().tabs.find((t) => t.id === id)
      if (!source) return null
      const title =
        source.target.kind === 'local'
          ? (shellName(source.target.shellId) ?? `Local ${++localCounter}`)
          : source.title
      return add(
        title,
        source.target,
        { tabId: source.id, direction: 'within' },
        undefined,
        source.view
      )
    },
    closeOthers: (id) => {
      set((s) => ({ tabs: s.tabs.filter((t) => t.id === id), activeId: id }))
    },
    close: (id) => {
      set((s) => {
        const index = s.tabs.findIndex((t) => t.id === id)
        if (index === -1) return s
        const tabs = s.tabs.filter((t) => t.id !== id)
        let activeId = s.activeId
        if (activeId === id) activeId = (tabs[index] ?? tabs[index - 1] ?? null)?.id ?? null
        return { tabs, activeId }
      })
    },
    activate: (id) => {
      set({ activeId: id })
    },
    cycle: (delta) => {
      const { tabs, activeId } = get()
      if (tabs.length === 0) return
      const index = tabs.findIndex((t) => t.id === activeId)
      const next = tabs[(index + delta + tabs.length) % tabs.length]
      if (next) set({ activeId: next.id })
    },
    setView: (id, view) => {
      set((s) => ({
        tabs: s.tabs.map((t) => {
          if (t.id !== id) return t
          const next = { ...t }
          if (view) next.view = view
          else delete next.view
          return next
        })
      }))
    },
    setTitle: (id, title) => {
      set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, title } : t)) }))
    },
    setS3Location: (id, location, title) => {
      set((s) => ({
        tabs: s.tabs.map((t) => {
          if (t.id !== id || t.target.kind !== 's3') return t
          const target: S3Target = location
            ? { ...t.target, bucket: location.bucket, prefix: location.prefix }
            : { kind: 's3', accountId: t.target.accountId }
          return { ...t, target, title }
        })
      }))
    }
  }
})
