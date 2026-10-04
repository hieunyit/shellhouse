// @vitest-environment jsdom
import './ds-dom'
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { Menu, type MenuEntry } from '../../src/renderer/src/ds/Menu'

function entries(run: (id: string) => void, toggle = vi.fn()): MenuEntry[] {
  return [
    { kind: 'label', id: 'l', label: 'Pod' },
    {
      id: 'logs',
      label: 'Logs',
      shortcut: 'L',
      onSelect: () => {
        run('logs')
      }
    },
    {
      id: 'shell',
      label: 'Open shell',
      onSelect: () => {
        run('shell')
      }
    },
    {
      id: 'scale',
      label: 'Scale…',
      disabled: true,
      onSelect: () => {
        run('scale')
      }
    },
    {
      id: 'restart',
      label: 'Restart',
      onSelect: () => {
        run('restart')
      }
    },
    { kind: 'checkbox', id: 'node', label: 'Show node', checked: false, onCheckedChange: toggle },
    { kind: 'separator', id: 's' },
    {
      id: 'delete',
      label: 'Delete Pod…',
      danger: true,
      onSelect: () => {
        run('delete')
      }
    }
  ]
}

function setup(
  run = vi.fn(),
  toggle = vi.fn()
): { trigger: HTMLElement; run: typeof run; toggle: typeof toggle } {
  render(
    <Menu
      label="Pod actions"
      entries={entries(run, toggle)}
      trigger={<button type="button">Actions</button>}
    />
  )
  const trigger = screen.getByRole('button', { name: 'Actions' })
  return { trigger, run, toggle }
}

/** Nhãn của mục đang được focus trong menu (Radix: roving focus thật trên phần tử). */
function focused(): string {
  const el = document.activeElement
  return (el?.querySelector('.truncate')?.textContent ?? el?.textContent ?? '').trim()
}

/** Radix chuyển focus / typeahead trong setTimeout → chờ một nhịp. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

async function key(k: string): Promise<void> {
  act(() => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: k })
  })
  await flush()
}

async function open(
  trigger: HTMLElement,
  how: 'Enter' | 'ArrowDown' | ' ' = 'Enter'
): Promise<void> {
  trigger.focus()
  act(() => {
    fireEvent.keyDown(trigger, { key: how })
  })
  await flush()
}

describe('Menu: bàn phím', () => {
  it('Enter / ↓ mở menu, focus mục đầu; aria-expanded trên nút mở', async () => {
    const { trigger } = setup()
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    await open(trigger, 'ArrowDown')
    expect(screen.getByRole('menu', { name: 'Pod actions' })).toBeTruthy()
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(focused()).toContain('Logs')
  })

  it('↑↓ di chuyển, bỏ qua mục disabled và nhãn; End / Home; không vòng quanh', async () => {
    const { trigger } = setup()
    await open(trigger)
    await key('ArrowDown')
    expect(focused()).toBe('Open shell')
    await key('ArrowDown')
    expect(focused()).toBe('Restart')
    await key('End')
    expect(focused()).toBe('Delete Pod…')
    await key('ArrowDown')
    expect(focused()).toBe('Delete Pod…')
    await key('Home')
    expect(focused()).toContain('Logs')
  })

  it('gõ chữ để nhảy tới mục (typeahead)', async () => {
    const { trigger } = setup()
    await open(trigger)
    await key('r')
    expect(focused()).toBe('Restart')
    await key('Escape')
    await open(trigger)
    // Gõ liền nhiều chữ = tìm theo cả cụm.
    await key('d')
    await key('e')
    expect(focused()).toBe('Delete Pod…')
  })

  it('Enter chạy mục đang focus rồi đóng menu, focus về nút mở', async () => {
    const { trigger, run } = setup()
    await open(trigger)
    await key('ArrowDown')
    await key('Enter')
    expect(run).toHaveBeenCalledWith('shell')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('Esc đóng không chạy gì, focus về nút mở', async () => {
    const { trigger, run } = setup()
    await open(trigger)
    await key('Escape')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(run).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(trigger)
  })

  it('mục checkbox: Space bật / tắt, menu vẫn mở; mục disabled có aria-disabled', async () => {
    const { trigger, toggle } = setup()
    await open(trigger)
    const disabled = screen.getByRole('menuitem', { name: 'Scale…' })
    expect(disabled.getAttribute('aria-disabled')).toBe('true')
    const box = screen.getByRole('menuitemcheckbox', { name: 'Show node' })
    expect(box.getAttribute('aria-checked')).toBe('false')
    act(() => {
      box.focus()
    })
    await key(' ')
    expect(toggle).toHaveBeenCalledWith(true)
    expect(screen.getByRole('menu')).toBeTruthy()
  })
})
