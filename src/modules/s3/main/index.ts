import { language, locale, t } from '@shared/i18n'
import type { MainModule } from '../../registry/main-types'
import { s3Manifest } from '../manifest'
import { S3BrowserParams, S3Ipc, type S3SessionConfig } from '../shared/ipc'
import { S3Settings } from '../shared/settings'
import m0001 from '../migrations/0001_accounts.sql?raw'
import m0002 from '../migrations/0002_pins.sql?raw'
import m0003 from '../migrations/0003_network.sql?raw'
import { S3Accounts } from './accounts'

/**
 * Phần main của S3: tài khoản (secret trong vault), IPC `module:s3:*`, phân giải phiên — secret
 * key chỉ giải mã ở đây và đi thẳng sang Session Host.
 */
export const s3Main: MainModule = {
  manifest: s3Manifest,
  // v1 / v2 trùng migration lõi 0006 / 0007 (đã phát hành): DB cũ được ghi sẵn là đã chạy (0008);
  // chỉ chạy thật khi bật lại sau "Remove data".
  migrations: [
    { version: 1, name: 'accounts', sql: m0001 },
    { version: 2, name: 'pins', sql: m0002 },
    { version: 3, name: 'network', sql: m0003 }
  ],
  settings: S3Settings,
  activate(ctx) {
    const accounts = new S3Accounts(ctx.db, ctx.secrets)
    const changed = (): void => {
      ctx.events.emit('changed', null)
    }
    ctx.ipc.handle('accounts', S3Ipc.accounts, () => accounts.list())
    ctx.ipc.handle('save', S3Ipc.save, (input) => {
      try {
        const id = accounts.save(input)
        changed()
        return { ok: true, id }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    })
    ctx.ipc.handle('test', S3Ipc.test, async (input) => {
      try {
        const secretAccessKey =
          input.secretAccessKey ||
          (input.id ? accounts.resolve(input.id).secretAccessKey : undefined)
        if (!secretAccessKey) return { ok: false, message: t('Enter the secret access key') }
        // AWS SDK chỉ nạp khi thử kết nối (không làm chậm lúc mở app).
        const { testConnection } = await import('../session-host/client')
        return await testConnection({
          endpoint: input.endpoint,
          region: input.region,
          accessKeyId: input.accessKeyId,
          secretAccessKey,
          forcePathStyle: input.forcePathStyle,
          proxy: proxyOf(input.endpoint, input.region, input.direct),
          insecureTls: input.insecureTls
        })
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    })
    ctx.ipc.handle('delete', S3Ipc.delete, (id) => {
      accounts.delete(id)
      changed()
    })
    ctx.ipc.handle('pin', S3Ipc.pin, (id, pin, pinned) => {
      accounts.setPin(id, pin, pinned)
      changed()
    })
    /** Proxy cho endpoint của tài khoản (Settings › Network); `direct` = luôn kết nối thẳng. */
    const proxyOf = (endpoint: string, region: string, direct: boolean): string | null => {
      if (direct) return null
      const url = endpoint ? new URL(endpoint) : null
      const host = url ? url.hostname : `s3.${region || 'us-east-1'}.amazonaws.com`
      const secure = !url || url.protocol === 'https:'
      return ctx.proxyFor(host, Number(url?.port) || (secure ? 443 : 80), secure)
    }
    const connection = (accountId: string): S3SessionConfig['connection'] => {
      const account = accounts.resolve(accountId)
      return {
        endpoint: account.endpoint,
        region: account.region,
        accessKeyId: account.accessKeyId,
        secretAccessKey: account.secretAccessKey,
        forcePathStyle: account.forcePathStyle,
        proxy: proxyOf(account.endpoint, account.region, account.direct),
        insecureTls: account.insecureTls
      }
    }
    return {
      resolveSession: (_kind, raw): S3SessionConfig => {
        const params = S3BrowserParams.parse(raw)
        const settings = S3Settings.parse(ctx.settings.get())
        return {
          connection: connection(params.accountId),
          limits: { requests: settings.requests, transfers: settings.transfers },
          language: language(),
          locale: locale()
        }
      },
      // Session Host xin kết nối của tài khoản khác (đích đồng bộ) — secret đi thẳng sang đó.
      onHostRequest: (name, params) => {
        if (name !== 'account') throw new Error(`Unknown request ${name}`)
        return connection(S3BrowserParams.shape.accountId.parse(params))
      }
    }
  }
}
