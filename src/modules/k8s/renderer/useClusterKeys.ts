import { useEffect, useRef } from 'react'
import { actionsFor, eventKey, type ActionHandlers } from './actions'
import type { Row } from '../shared/rows'

const isTyping = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement &&
  (t.tagName === 'INPUT' ||
    t.tagName === 'TEXTAREA' ||
    t.tagName === 'SELECT' ||
    t.isContentEditable)

export const focusGrid = (root: HTMLElement | null): void => {
  root?.querySelector<HTMLElement>('[role="grid"]')?.focus()
}

export interface ClusterKeys {
  active: boolean
  ready: boolean
  /** Bảng đã có dữ liệu (đưa focus vào bảng khi tab hiện). */
  loaded: boolean
  kindId: string
  readOnly: boolean
  /** Đang mở hộp thoại của tab — phím tắt tạm nghỉ. */
  dialogOpen: boolean
  helpOpen: boolean
  setHelpOpen: (fn: (open: boolean) => boolean) => void
  single: Row | undefined
  handlers: ActionHandlers
  /** ':' → mở thanh lệnh, '/' → ô lọc. */
  focusFilter: (command: boolean) => void
  allNamespaces: () => void
  openDetail: (key: string) => void
  /** Esc: đóng chi tiết / ra khỏi breadcrumb / xoá lọc; false = không có gì để quay lại. */
  back: () => boolean
  /** Số dòng đang chọn (> 1 → phím chạy thao tác hàng loạt). */
  multiCount?: number
  /** Phím của thao tác hàng loạt; true = đã xử lý. */
  bulk?: (key: string) => boolean
  /** Ctrl+A khi focus chưa ở trong bảng. */
  selectAll?: () => void
}

/**
 * Phím tắt kiểu k9s, nghe ở window: bảng vừa tải lại (focus rơi về <body>) vẫn nhận phím. Chỉ khi
 * tab đang hiện và focus ở trong tab hoặc chưa ở đâu; bỏ qua khi đang gõ hay focus trong hộp thoại.
 */
export function useClusterKeys(
  rootRef: React.RefObject<HTMLElement | null>,
  keys: ClusterKeys
): void {
  const latest = useRef(keys)
  useEffect(() => {
    latest.current = keys
  })
  const { active, ready, loaded, kindId } = keys

  useEffect(() => {
    if (!active) return
    const onKeyDown = (e: KeyboardEvent): void => {
      const k0 = latest.current
      if (e.defaultPrevented || isTyping(e.target) || k0.dialogOpen) return
      // Hộp xác nhận (Modal) nằm trong tab: phím không chạy thao tác trên bảng phía sau.
      if (e.target instanceof Element && e.target.closest('[role="dialog"]')) return
      const k = eventKey(e)
      if (k === ':' || k === '/') {
        e.preventDefault()
        k0.focusFilter(k === ':')
        return
      }
      if (k === '?') {
        k0.setHelpOpen((o) => !o)
        return
      }
      if (k === 'Escape') {
        if (k0.helpOpen) k0.setHelpOpen(() => false)
        else if (k0.back()) e.preventDefault()
        return
      }
      if (k === '0') {
        k0.allNamespaces()
        return
      }
      if (k === 'ctrl+a' && k0.selectAll) {
        e.preventDefault()
        k0.selectAll()
        return
      }
      if ((k0.multiCount ?? 0) > 1 && k0.bulk?.(k)) {
        e.preventDefault()
        return
      }
      const single = k0.single
      if (k === 'd' && single) {
        k0.openDetail(single.row.key)
        return
      }
      if (single) {
        const action = actionsFor(k0.kindId, single.obj, k0.readOnly, k0.handlers).find(
          (x) => x.key === k
        )
        if (action) {
          e.preventDefault()
          action.run()
        }
      }
    }
    const listener = (e: KeyboardEvent): void => {
      const focused = document.activeElement
      if (focused && focused !== document.body && !rootRef.current?.contains(focused)) return
      onKeyDown(e)
    }
    window.addEventListener('keydown', listener)
    return () => {
      window.removeEventListener('keydown', listener)
    }
  }, [active, rootRef])

  // Tab được chọn → đưa focus vào bảng để dùng phím ngay.
  useEffect(() => {
    if (!active || !ready || !loaded) return
    const t = setTimeout(() => {
      if (!rootRef.current?.contains(document.activeElement)) focusGrid(rootRef.current)
    }, 50)
    return () => {
      clearTimeout(t)
    }
  }, [active, ready, kindId, loaded, rootRef])
}
