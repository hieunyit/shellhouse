import { describe, expect, it } from 'vitest'
import { initials } from '../../src/renderer/src/shell/initials'
import {
  clearNotifications,
  markNotificationsRead,
  toast,
  useToasts
} from '../../src/renderer/src/stores/toasts'

/** Trung tâm thông báo (chuông ở status bar) và avatar của activity bar. */
describe('thông báo', () => {
  it('toast đã xong vào lịch sử (mới nhất trước), "đang chạy" thì chưa; mở chuông → đã xem', () => {
    clearNotifications()
    toast.success('Saved')
    const id = toast.loading('Uploading…')
    expect(useToasts.getState().history.map((h) => h.title)).toEqual(['Saved'])
    expect(useToasts.getState().unread).toBe(1)
    toast.update(id, 'error', 'Upload failed')
    expect(useToasts.getState().history.map((h) => h.title)).toEqual(['Upload failed', 'Saved'])
    expect(useToasts.getState().unread).toBe(2)
    markNotificationsRead()
    expect(useToasts.getState().unread).toBe(0)
    // Cập nhật lại cùng toast: thay nội dung, không đếm thêm.
    toast.update(id, 'error', 'Upload failed again')
    expect(useToasts.getState().history).toHaveLength(2)
    expect(useToasts.getState().unread).toBe(0)
    clearNotifications()
    expect(useToasts.getState().history).toEqual([])
  })
})

describe('avatar', () => {
  it('chữ viết tắt từ tên đăng nhập', () => {
    expect(initials('hieu.nguyen')).toBe('HN')
    expect(initials('hellc')).toBe('HE')
    expect(initials('Nguyễn Văn')).toBe('NV')
    expect(initials('')).toBe('')
  })
})
