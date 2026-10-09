import { invokeModule, onModuleEvent } from '../../registry/renderer-kit'
import type { Runbook, RunbookFile, RunbookInput } from '../shared/runbook'

/** IPC `module:runbook:*`. */
export const runbookApi = {
  list: () => invokeModule<Runbook[]>('runbook', 'list'),
  save: (input: RunbookInput) =>
    invokeModule<{ ok: true; id: string } | { ok: false; message: string }>(
      'runbook',
      'save',
      input
    ),
  remove: (id: string) => invokeModule<undefined>('runbook', 'remove', id),
  /** Giá trị bí mật → id (giá trị ở lại main, mã hoá). */
  putSecret: (value: string) => invokeModule<string>('runbook', 'putSecret', value),
  /** null = huỷ chọn file. */
  pickImport: () =>
    invokeModule<
      { ok: true; name: string; file: RunbookFile } | { ok: false; message: string } | null
    >('runbook', 'pickImport'),
  onChanged: (listener: () => void) =>
    onModuleEvent('runbook', 'changed', () => {
      listener()
    })
}
