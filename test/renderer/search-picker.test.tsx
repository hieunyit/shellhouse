// @vitest-environment jsdom
import './ds-dom'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { pickResults } from '../../src/renderer/src/ds/select-logic'
import { SearchPicker } from '../../src/renderer/src/ds/Select'
import { hasTagLike, hostOptions, JUMP_TAGS } from '../../src/renderer/src/lib/host-pick'

const host = (id: string, tags: string[] = [], address = `u@${id}.corp`) => ({
  id,
  label: id,
  address,
  tags
})

/** 200 VM như danh sách thật, vài máy gắn tag jump / bastion. */
const fleet = [
  ...Array.from({ length: 200 }, (_, i) => host(`vm-${String(i).padStart(3, '0')}`)),
  host('jump-vpb-rcc', ['jump']),
  host('fci-bastion', ['Bastion']),
  host('fci-kubectl', ['k8s'])
]

describe('pickResults / hostOptions', () => {
  it('danh sách dài: chỉ hiện `limit` mục đầu, báo số còn ẩn', () => {
    const { shown, more } = pickResults(
      fleet.map((h) => ({ value: h.id, label: h.label })),
      '',
      12
    )
    expect(shown).toHaveLength(12)
    expect(more).toBe(fleet.length - 12)
  })

  it('host có tag jump / bastion lên đầu thành nhóm riêng — kể cả khi đang tìm', () => {
    const options = hostOptions(fleet, JUMP_TAGS, { preferred: 'Jump hosts', others: 'Other' })
    expect(options.slice(0, 2).map((o) => [o.label, o.group])).toEqual([
      ['jump-vpb-rcc', 'Jump hosts'],
      ['fci-bastion', 'Jump hosts']
    ])
    expect(options[2]?.group).toBe('Other')
    // "fci" khớp cả bastion (nhóm jump) và kubectl: bastion vẫn đứng trước.
    const { shown } = pickResults(options, 'fci', 12)
    expect(shown.map((o) => o.label)).toEqual(['fci-bastion', 'fci-kubectl'])
  })

  it('tìm theo tag và địa chỉ; không tìm theo id', () => {
    const options = hostOptions(
      [host('a', ['k8s'], 'root@10.2.2.30'), host('b', [], 'root@10.9.9.9')],
      JUMP_TAGS,
      { preferred: 'J', others: 'O' }
    )
    expect(options.every((o) => o.group === undefined)).toBe(true)
    expect(pickResults(options, 'k8s').shown.map((o) => o.label)).toEqual(['a'])
    expect(pickResults(options, '10.9.9').shown.map((o) => o.label)).toEqual(['b'])
    expect(pickResults([{ value: 'a3f9-uuid', label: 'web' }], 'a3f9').shown).toEqual([])
  })

  it('hasTagLike: không phân biệt hoa thường, khớp một phần ("Jump-Host")', () => {
    expect(hasTagLike({ tags: ['Jump-Host'] }, JUMP_TAGS)).toBe(true)
    expect(hasTagLike({ tags: ['prod'] }, JUMP_TAGS)).toBe(false)
  })
})

describe('SearchPicker', () => {
  function setup() {
    const onPick = vi.fn()
    const onOuterKey = vi.fn()
    render(
      <div
        onKeyDown={(e) => {
          onOuterKey(e.key)
        }}
      >
        <SearchPicker
          placeholder="Add a jump host…"
          label="Jump host"
          data-testid="jump-add"
          optionTestId="jump-option"
          options={hostOptions(fleet, JUMP_TAGS, { preferred: 'Jump hosts', others: 'Other' })}
          onPick={onPick}
        />
      </div>
    )
    return { onPick, onOuterKey }
  }

  it('mở: ô tìm có focus, chỉ 12 mục + dòng "còn N mục"; gõ để thu hẹp, Enter chọn rồi đóng', () => {
    const { onPick } = setup()
    fireEvent.click(screen.getByTestId('jump-add'))
    const search = screen.getByTestId('jump-add-search')
    expect(document.activeElement).toBe(search)
    expect(screen.getAllByTestId('jump-option')).toHaveLength(12)
    expect(screen.getByText(`${String(fleet.length - 12)} more — type to search`)).toBeTruthy()
    expect(screen.getByText('Jump hosts')).toBeTruthy()

    fireEvent.change(search, { target: { value: 'vm-150' } })
    expect(screen.getAllByTestId('jump-option').map((o) => o.dataset['name'])).toEqual(['vm-150'])
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onPick).toHaveBeenCalledWith('vm-150')
    expect(screen.queryByTestId('jump-add-search')).toBeNull()
  })

  it('Esc đóng danh sách nhưng không lan ra hộp thoại chứa nó', () => {
    const { onPick, onOuterKey } = setup()
    fireEvent.click(screen.getByTestId('jump-add'))
    fireEvent.keyDown(screen.getByTestId('jump-add-search'), { key: 'Escape' })
    expect(screen.queryByTestId('jump-add-search')).toBeNull()
    expect(onOuterKey).not.toHaveBeenCalledWith('Escape')
    expect(onPick).not.toHaveBeenCalled()
  })

  it('bấm chuột vào một mục thì chọn mục đó', () => {
    const { onPick } = setup()
    fireEvent.click(screen.getByTestId('jump-add'))
    const option = screen.getAllByTestId('jump-option')[1]
    if (!option) throw new Error('no option')
    fireEvent.click(option)
    expect(onPick).toHaveBeenCalledWith('fci-bastion')
  })
})
