import {
  activateTab,
  findModuleTab,
  openModuleTab,
  savedHost,
  savedHosts,
  t,
  tn,
  toast
} from '../../registry/renderer-kit'
import {
  exportRunbooks,
  remapHosts,
  stripSecretRefs,
  uniqueName,
  type Runbook,
  type RunbookStep
} from '../shared/runbook'
import { runbookApi } from './api'
import { useRunbooks } from './store'

/** Mở tab của một runbook (hoặc tab soạn runbook mới); đã mở thì chuyển tới tab đó. */
export function openRunbook(id?: string): void {
  const existing = id
    ? findModuleTab('runbook', (p) => (p as { id?: string } | null)?.id === id)
    : null
  if (existing) activateTab(existing)
  else openModuleTab('runbook', 'runbook', id ? { id } : {})
}

async function takenNames(): Promise<string[]> {
  await useRunbooks.getState().reload()
  return useRunbooks.getState().runbooks.map((r) => r.name)
}

/** Bản sao "X (copy)" (dùng chung bí mật đã lưu — đổi giá trị ở bản nào thì chỉ bản đó đổi). */
export async function duplicateRunbook(source: Pick<Runbook, 'name' | 'description' | 'steps'>) {
  const name = uniqueName(t('{name} (copy)', { name: source.name }), await takenNames())
  const r = await runbookApi.save({ name, description: source.description, steps: source.steps })
  if (!r.ok) {
    toast.error(r.message)
    return
  }
  await useRunbooks.getState().reload()
  openRunbook(r.id)
  toast.success(t('Created “{name}”', { name }))
}

/** Tên file an toàn trên mọi hệ điều hành. */
const fileName = (name: string): string =>
  `${name.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '') || 'runbooks'}.runbook.json`

/**
 * Xuất ra file JSON để chia sẻ (đồng đội nhập vào máy họ). Không có bí mật: header bí mật chỉ còn
 * tên — người nhập gõ lại giá trị. Host SSH kèm nhãn / địa chỉ để máy nhập tìm host tương ứng.
 */
export async function exportToFile(
  runbooks: readonly Pick<Runbook, 'name' | 'description' | 'steps'>[],
  name: string
): Promise<void> {
  if (runbooks.length === 0) return
  const data = exportRunbooks(runbooks, (id) => {
    const h = savedHost(id)
    return h ? { label: h.label, address: h.address } : undefined
  })
  const path = await window.shellhouse.saveTextFile(
    fileName(name),
    `${JSON.stringify(data, null, 2)}\n`
  )
  if (path) toast.success(t('Saved to {path}', { path }))
}

/** Số header bí mật (giá trị không có trong file — người nhập gõ lại). */
function secretHeaders(steps: readonly RunbookStep[]): number {
  let n = 0
  for (const step of steps) {
    const headers = (step.params as { headers?: unknown } | null)?.headers
    if (Array.isArray(headers))
      n += headers.filter((h) => (h as { secret?: unknown } | null)?.secret === true).length
  }
  return n
}

/** Nhập từ file: tên trùng thì thêm "(2)"; host ghép theo nhãn / địa chỉ; bí mật phải gõ lại. */
export async function importFromFile(): Promise<void> {
  const picked = await runbookApi.pickImport()
  if (!picked) return
  if (!picked.ok) {
    toast.error(t('Could not import'), { description: picked.message })
    return
  }
  const taken = await takenNames()
  const local = savedHosts()
  const missing = new Set<string>()
  const ids: string[] = []
  let secrets = 0
  for (const rb of picked.file.runbooks) {
    const remapped = remapHosts(
      stripSecretRefs(rb.steps) as RunbookStep[],
      picked.file.hosts,
      local
    )
    for (const m of remapped.missing) missing.add(m)
    secrets += secretHeaders(remapped.steps)
    const name = uniqueName(rb.name, taken)
    const r = await runbookApi.save({ name, description: rb.description, steps: remapped.steps })
    if (!r.ok) {
      toast.error(t('Could not import “{name}”', { name: rb.name }), { description: r.message })
      continue
    }
    taken.push(name)
    ids.push(r.id)
  }
  await useRunbooks.getState().reload()
  if (ids.length === 0) return
  if (ids.length === 1) openRunbook(ids[0])
  const notes = [
    missing.size > 0
      ? t('No matching server here for: {hosts} — choose one in those steps.', {
          hosts: [...missing].join(', ')
        })
      : '',
    secrets > 0
      ? tn(
          secrets,
          '{n} secret header value is not in the file — enter it again.',
          '{n} secret header values are not in the file — enter them again.'
        )
      : ''
  ].filter(Boolean)
  const title = tn(ids.length, 'Imported {n} runbook', 'Imported {n} runbooks')
  if (notes.length > 0) toast.warning(title, { description: notes.join(' '), duration: 0 })
  else toast.success(title)
}
