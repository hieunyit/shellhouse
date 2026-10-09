import { t } from '@shared/i18n'
import type { MainModule } from '../../registry/main-types'
import { runbookManifest } from '../manifest'
import {
  RunbookFile,
  RunbookIpc,
  RunbookLocalParams,
  type RunbookSessionConfig
} from '../shared/runbook'
import m0001 from '../migrations/0001_runbooks.sql?raw'
import m0002 from '../migrations/0002_secrets.sql?raw'
import { RunbookSecrets } from './secrets'
import { RunbookStore } from './store'

/** File runbook lớn hơn chừng này chắc không phải file runbook (500 runbook × 50 bước vẫn nhỏ hơn). */
const IMPORT_MAX_BYTES = 8 * 1024 * 1024

/**
 * Phần main của Runbook: lưu danh sách runbook, giá trị bí mật của header HTTP (mã hoá trong vault),
 * phân giải proxy / bí mật cho phiên gọi HTTP, đọc file nhập.
 */
export const runbookMain: MainModule = {
  manifest: runbookManifest,
  migrations: [
    { version: 1, name: 'runbooks', sql: m0001 },
    { version: 2, name: 'secrets', sql: m0002 }
  ],
  activate(ctx) {
    const store = new RunbookStore(ctx.db)
    const secrets = new RunbookSecrets(ctx.db, ctx.secrets)
    // Dọn bí mật không runbook nào dùng nữa (header đã đổi / runbook đã xoá).
    const pruned = secrets.prune(store.list())
    if (pruned > 0) ctx.log.info(`removed ${String(pruned)} unused secret value(s)`)
    const changed = (): void => {
      ctx.events.emit('changed', null)
    }
    ctx.ipc.handle('list', RunbookIpc.list, () => store.list())
    ctx.ipc.handle('save', RunbookIpc.save, (input) => {
      try {
        const id = store.save(input)
        changed()
        return { ok: true, id }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    })
    ctx.ipc.handle('remove', RunbookIpc.remove, (id) => {
      store.remove(id)
      changed()
    })
    ctx.ipc.handle('putSecret', RunbookIpc.putSecret, (value) => secrets.put(value))
    ctx.ipc.handle('pickImport', RunbookIpc.pickImport, async () => {
      const files = await ctx.pickFiles({
        title: t('Import runbooks'),
        filters: [
          { name: t('Runbooks'), extensions: ['json'] },
          { name: t('All files'), extensions: ['*'] }
        ]
      })
      const file = files[0]
      if (!file) return null
      if (file.content.length > IMPORT_MAX_BYTES)
        return { ok: false, message: t('This file is too large to be a runbook file.') }
      let json: unknown
      try {
        json = JSON.parse(file.content)
      } catch {
        return { ok: false, message: t('This file is not valid JSON.') }
      }
      const parsed = RunbookFile.safeParse(json)
      if (!parsed.success)
        return {
          ok: false,
          message: t('This is not a Shellhouse runbook file ({issue}).', {
            issue: parsed.error.issues[0]?.message ?? '—'
          })
        }
      return { ok: true, name: file.name, file: parsed.data }
    })
    return {
      // Phiên `local` (bước HTTP): proxy theo Settings › Network cho địa chỉ, và giá trị bí mật của
      // header — đi thẳng sang Session Host, không qua renderer.
      resolveSession: (_kind, raw): RunbookSessionConfig => {
        const params = RunbookLocalParams.parse(raw ?? {})
        let proxy: string | null = null
        if (params.url && URL.canParse(params.url)) {
          const url = new URL(params.url)
          const secure = url.protocol === 'https:'
          proxy = ctx.proxyFor(url.hostname, Number(url.port) || (secure ? 443 : 80), secure)
        }
        return { proxy, secrets: secrets.resolve(params.secretIds) }
      }
    }
  }
}
