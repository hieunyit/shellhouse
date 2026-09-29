import { useMemo } from 'react'
import { buildGroupTree, groupMoveProblem } from '@shared/group-tree'
import { useHosts } from '../stores/hosts'
import { Select } from './ui'

/**
 * Ô chọn nhóm hiển thị dạng cây (thụt lề theo cấp). Với `movingGroupId`, các vị trí không hợp lệ
 * (chính nó, nhóm con cháu, quá sâu) bị vô hiệu hoá — người dùng không chọn được thay vì bị báo lỗi
 * sau khi bấm Save.
 */
export function GroupSelect({
  value,
  onChange,
  noneLabel,
  movingGroupId,
  testId
}: {
  value: string | null
  onChange: (groupId: string | null) => void
  noneLabel: string
  /** Đang chọn nhóm cha cho nhóm này (null = nhóm mới). Bỏ trống khi chọn nhóm cho host. */
  movingGroupId?: string | null
  testId?: string
}): React.JSX.Element {
  const groups = useHosts((s) => s.tree.groups)
  const options = useMemo(() => {
    const tree = buildGroupTree(groups)
    return tree.flatten().map(({ group, depth }) => ({
      id: group.id,
      // Khoảng trắng thường bị gộp trong <option> → dùng em space để thụt lề.
      label: `${' '.repeat(depth - 1)}${depth > 1 ? '└ ' : ''}${group.name}`,
      path: tree.path(group.id).join(' / '),
      problem: movingGroupId === undefined ? null : groupMoveProblem(tree, movingGroupId, group.id)
    }))
  }, [groups, movingGroupId])

  return (
    <Select
      data-testid={testId}
      value={value ?? ''}
      onChange={(e) => {
        onChange(e.target.value || null)
      }}
    >
      <option value="">{noneLabel}</option>
      {options.map((o) => (
        <option key={o.id} value={o.id} disabled={o.problem !== null} title={o.problem ?? o.path}>
          {o.label}
        </option>
      ))}
    </Select>
  )
}
