import type { SelectOption } from '../ds'

export interface PickableHost {
  id: string
  label: string
  /** Chữ phụ bên phải: "user@hostname" / "hostname". */
  address: string
  tags: readonly string[]
}

/** Host có tag chứa một trong các từ (không phân biệt hoa thường): "jump", "Jump-host", "bastion"… */
export function hasTagLike(host: Pick<PickableHost, 'tags'>, words: readonly string[]): boolean {
  return host.tags.some((tag) => {
    const lower = tag.toLowerCase()
    return words.some((w) => lower.includes(w))
  })
}

/**
 * Lựa chọn host cho Combobox / SearchList: host có tag ưu tiên (`prefer`) lên đầu thành nhóm riêng
 * (vẫn đứng đầu khi tìm), còn lại giữ thứ tự của người gọi. Tìm theo nhãn, địa chỉ và tag. Không host
 * nào có tag ưu tiên → không chia nhóm.
 */
export function hostOptions(
  hosts: readonly PickableHost[],
  prefer: readonly string[],
  groups: { preferred: string; others: string }
): SelectOption<string>[] {
  const flagged = hosts.map((h) => ({ h, preferred: hasTagLike(h, prefer) }))
  const anyPreferred = flagged.some((x) => x.preferred)
  return [...flagged.filter((x) => x.preferred), ...flagged.filter((x) => !x.preferred)].map(
    ({ h, preferred }) => ({
      value: h.id,
      label: h.label,
      hint: h.address,
      keywords: [h.address, ...h.tags],
      ...(anyPreferred ? { group: preferred ? groups.preferred : groups.others } : {})
    })
  )
}

/** Từ khoá tag của jump host / bastion (ưu tiên trong ô "Add a jump host…"). */
export const JUMP_TAGS = ['jump', 'bastion'] as const
