// @vitest-environment jsdom
import './ds-dom'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { ConfirmDialog } from '../../src/renderer/src/ds/Dialog'
import {
  canConfirm,
  confirmMatches,
  requiresTyping,
  typedIsPrefix,
  type ConfirmRisk
} from '../../src/renderer/src/ds/confirm-logic'

describe('ConfirmDialog: logic gõ để xác nhận', () => {
  it('chỉ production phải gõ tên', () => {
    expect(requiresTyping('normal')).toBe(false)
    expect(requiresTyping('danger')).toBe(false)
    expect(requiresTyping('production')).toBe(true)
    expect(canConfirm('danger', '', undefined)).toBe(true)
    expect(canConfirm('production', 'web', undefined)).toBe(false)
  })

  it('khớp tuyệt đối, phân biệt hoa thường, bỏ khoảng trắng hai đầu', () => {
    expect(confirmMatches('web', 'web')).toBe(true)
    expect(confirmMatches('  web ', 'web')).toBe(true)
    expect(confirmMatches('Web', 'web')).toBe(false)
    expect(confirmMatches('we', 'web')).toBe(false)
    expect(confirmMatches('', '')).toBe(false)
    expect(confirmMatches('3 pods', '3 pods')).toBe(true)
  })

  it('đang gõ đúng hướng thì chưa báo lỗi', () => {
    expect(typedIsPrefix('we', 'web')).toBe(true)
    expect(typedIsPrefix('wx', 'web')).toBe(false)
  })
})

function Harness({
  risk,
  onConfirm
}: {
  risk: ConfirmRisk
  onConfirm: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(true)
  return (
    <>
      <span data-testid="state">{open ? 'open' : 'closed'}</span>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        risk={risk}
        title="Delete Deployment web?"
        confirmLabel="Delete"
        confirmText={risk === 'production' ? 'web' : undefined}
        onConfirm={onConfirm}
      />
    </>
  )
}

describe('ConfirmDialog: production', () => {
  it('nút Delete chỉ bật khi gõ đúng tên; chặn dán; Enter xác nhận rồi đóng', () => {
    const onConfirm = vi.fn()
    render(<Harness risk="production" onConfirm={onConfirm} />)
    const dialog = screen.getByRole('alertdialog')
    expect(dialog.getAttribute('data-risk')).toBe('production')
    const input = screen.getByTestId('confirm-type-input')
    const ok = screen.getByTestId('confirm-ok')
    // Ô gõ tên được focus sẵn (không phải nút Huỷ).
    expect(document.activeElement).toBe(input)
    expect((ok as HTMLButtonElement).disabled).toBe(true)

    // Dán bị chặn (preventDefault) và có thông báo.
    const paste = fireEvent.paste(input, { clipboardData: { getData: () => 'web' } })
    expect(paste).toBe(false)
    expect(screen.getByText('Pasting is disabled here — type the name.')).toBeTruthy()

    fireEvent.change(input, { target: { value: 'Web' } })
    expect((ok as HTMLButtonElement).disabled).toBe(true)
    expect(input.getAttribute('aria-invalid')).toBe('true')

    fireEvent.change(input, { target: { value: 'web' } })
    expect((ok as HTMLButtonElement).disabled).toBe(false)
    fireEvent.submit(input.closest('form') as HTMLFormElement)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('state').textContent).toBe('closed')
  })

  it('kéo thả chữ vào ô cũng bị chặn; Esc đóng không xác nhận', () => {
    const onConfirm = vi.fn()
    render(<Harness risk="production" onConfirm={onConfirm} />)
    const input = screen.getByTestId('confirm-type-input')
    expect(fireEvent.drop(input)).toBe(false)
    act(() => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    })
    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.getByTestId('state').textContent).toBe('closed')
  })
})

describe('ConfirmDialog: danger / normal', () => {
  it('danger: không cần gõ, nút đỏ bật sẵn, Huỷ được focus sẵn', () => {
    const onConfirm = vi.fn()
    render(<Harness risk="danger" onConfirm={onConfirm} />)
    expect(screen.queryByTestId('confirm-type-input')).toBeNull()
    const ok = screen.getByTestId<HTMLButtonElement>('confirm-ok')
    expect(ok.disabled).toBe(false)
    expect(ok.className).toContain('bg-ds-danger-solid')
    expect(document.activeElement).toBe(screen.getByTestId('confirm-cancel'))
    fireEvent.click(screen.getByTestId('confirm-cancel'))
    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.getByTestId('state').textContent).toBe('closed')
  })

  it('normal: nút primary', () => {
    render(<Harness risk="normal" onConfirm={() => undefined} />)
    expect(screen.getByTestId('confirm-ok').className).toContain('bg-ds-accent')
  })
})
