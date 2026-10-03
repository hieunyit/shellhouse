import { describe, expect, it } from 'vitest'
import { COMPACT_TOOLBAR, FULL_TOOLBAR, panelOverlay, toolbarFit } from '../../shared/toolbarFit'

describe('thanh công cụ bản đồ theo độ rộng', () => {
  it('chưa đo (0) coi như đủ chỗ — không nháy sang dạng gọn', () => {
    expect(toolbarFit(0)).toBe('full')
  })

  it('đủ chữ → chỉ icon → menu thả + xuống dòng khi hẹp dần', () => {
    expect(toolbarFit(1400)).toBe('full')
    expect(toolbarFit(FULL_TOOLBAR)).toBe('full')
    expect(toolbarFit(FULL_TOOLBAR - 1)).toBe('compact')
    // 1366 px, sidebar host đầy đủ + danh sách tài nguyên: ~850 px.
    expect(toolbarFit(850)).toBe('compact')
    expect(toolbarFit(COMPACT_TOOLBAR)).toBe('compact')
    expect(toolbarFit(COMPACT_TOOLBAR - 1)).toBe('narrow')
    expect(toolbarFit(390)).toBe('narrow')
  })

  it('bảng chi tiết nổi đè canvas khi 40% khung không đủ 300 px', () => {
    expect(panelOverlay(0)).toBe(false)
    expect(panelOverlay(850)).toBe(false)
    expect(panelOverlay(750)).toBe(false)
    expect(panelOverlay(749)).toBe(true)
    expect(panelOverlay(390)).toBe(true)
  })
})
