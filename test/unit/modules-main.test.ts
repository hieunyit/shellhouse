import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Secret } from '../../src/node-shared/secret'
import { openDatabase } from '../../src/main/store/db'
import { migrate } from '../../src/main/store/migrate'
import { MIGRATIONS } from '../../src/main/store/migrations'
import { SettingsService } from '../../src/main/settings'
import { TEST_KDF } from '../../src/main/vault/crypto'
import { Vault } from '../../src/main/vault/vault'
import {
  checkModuleSql,
  moduleSchemaVersion,
  referencedTables
} from '../../src/modules/registry/main-db'
import { MainModuleRegistry, ModuleNotEnabledError } from '../../src/modules/registry/main'
import type { MainModule, MainModuleContext } from '../../src/modules/registry/main-types'
import type { ModuleManifest, ModuleState } from '../../src/modules/registry/types'
import { s3Main } from '../../src/modules/s3/main'

function manifest(id: string, extra: Partial<ModuleManifest> = {}): ModuleManifest {
  return {
    id,
    name: `Fake ${id}`,
    summary: 'A fake module',
    description: 'For tests',
    category: 'other',
    keywords: [],
    source: 'builtin',
    since: '1.3.0',
    permissions: [],
    version: 1,
    icon: 'puzzle',
    enabledByDefault: false,
    contributes: { sessionKinds: ['main'] },
    ...extra
  }
}

/** Module giả dùng đủ mọi điểm gắn của main. */
function fakeModule(
  id = 'fake',
  options: { sql?: string; permissions?: ModuleManifest['permissions'] } = {}
): MainModule & { ctx: MainModuleContext | null; disposed: number } {
  const module: MainModule & { ctx: MainModuleContext | null; disposed: number } = {
    manifest: manifest(id, { permissions: options.permissions ?? [] }),
    migrations: [
      {
        version: 1,
        name: 'items',
        sql:
          options.sql ??
          `CREATE TABLE ${id}_items (id TEXT PRIMARY KEY, name TEXT NOT NULL, secret BLOB)`
      }
    ],
    settings: z.object({ level: z.number().int().catch(3) }),
    ctx: null,
    disposed: 0,
    activate(ctx) {
      module.ctx = ctx
      ctx.ipc.handle('add', z.tuple([z.string().min(1)]), (name) => {
        ctx.db.prepare(`INSERT INTO ${id}_items (id, name) VALUES (?, ?)`).run(name, name)
        ctx.events.emit('changed', name)
        return { ok: true }
      })
      ctx.ipc.handle('list', z.tuple([]), () =>
        ctx.db.prepare(`SELECT name FROM ${id}_items ORDER BY name`).all()
      )
      return {
        resolveSession: (kind, params) => ({ kind, params, level: ctx.settings.get() }),
        dispose: () => {
          module.disposed++
        }
      }
    }
  }
  return module
}

async function setup(modules: MainModule[]) {
  const db = openDatabase(':memory:')
  await migrate(db, MIGRATIONS)
  const vault = new Vault(db, TEST_KDF)
  await vault.create(Secret.fromString('master-password'))
  const settings = new SettingsService(db)
  const events: { module: string; name: string; data: unknown }[] = []
  const states: ModuleState[][] = []
  const logs: string[] = []
  const registry = new MainModuleRegistry(modules, {
    db,
    vault,
    settings,
    emit: (module, name, data) => events.push({ module, name, data }),
    onStatesChanged: (s) => states.push(s),
    log: (_level, message) => logs.push(message)
  })
  registry.start()
  return { db, vault, settings, registry, events, states, logs }
}

describe('MainModuleRegistry', () => {
  it('bật: chạy migration, đăng ký IPC (validate tham số), sự kiện; tắt: gỡ hết; bật lại: giữ dữ liệu', async () => {
    const fake = fakeModule()
    const { db, registry, events, states } = await setup([fake])
    expect(registry.states()).toEqual([{ id: 'fake', enabled: false, seen: false }])
    expect(() => registry.invoke('fake', 'list', [])).toThrow(ModuleNotEnabledError)

    registry.setEnabled('fake', true)
    expect(states.at(-1)).toEqual([{ id: 'fake', enabled: true, seen: false }])
    expect(moduleSchemaVersion(db, 'fake')).toBe(1)
    expect(registry.invoke('fake', 'add', ['alpha'])).toEqual({ ok: true })
    expect(events).toEqual([{ module: 'fake', name: 'changed', data: 'alpha' }])
    expect(registry.invoke('fake', 'list', [])).toEqual([{ name: 'alpha' }])
    // Tham số sai schema / handler không khai báo → lỗi, không gọi handler.
    expect(() => registry.invoke('fake', 'add', [''])).toThrow('Invalid arguments')
    expect(() => registry.invoke('fake', 'nope', [])).toThrow(/no handler "nope"/)

    registry.setEnabled('fake', false)
    expect(fake.disposed).toBe(1)
    expect(() => registry.invoke('fake', 'list', [])).toThrow(ModuleNotEnabledError)
    // Sự kiện của module đã tắt không tới renderer.
    fake.ctx?.events.emit('late', null)
    expect(events).toHaveLength(1)

    registry.setEnabled('fake', true)
    expect(registry.invoke('fake', 'list', [])).toEqual([{ name: 'alpha' }])
    expect(moduleSchemaVersion(db, 'fake')).toBe(1)
  })

  it('chặn: migration tạo bảng không có tiền tố → không bật được, báo lỗi rõ', async () => {
    const bad = fakeModule('bad', { sql: 'CREATE TABLE items (id TEXT)' })
    const { db, registry } = await setup([bad])
    expect(() => registry.setEnabled('bad', true)).toThrow(/must start with "bad_"/)
    expect(registry.isEnabled('bad')).toBe(false)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'items'").get()).toBeUndefined()
  })

  it('chặn: SQL trên bảng của lõi / module khác, PRAGMA, ATTACH', async () => {
    const fake = fakeModule()
    const { registry } = await setup([fake])
    registry.setEnabled('fake', true)
    const db = fake.ctx?.db
    expect(() => db?.prepare('SELECT * FROM hosts')).toThrow(/must start with "fake_"/)
    expect(() => db?.prepare('SELECT * FROM fake_items JOIN s3_accounts')).toThrow(/s3_accounts/)
    expect(() => db?.prepare('UPDATE settings SET value = 1')).toThrow(/settings/)
    expect(() => db?.prepare('PRAGMA user_version = 99')).toThrow(/not allowed/)
    expect(() => db?.prepare("ATTACH DATABASE 'x' AS y")).toThrow(/not allowed/)
    // Chuỗi trong câu lệnh không bị đọc nhầm thành tên bảng.
    expect(() => db?.prepare("SELECT name FROM fake_items WHERE name = 'from hosts'")).not.toThrow()
  })

  it('secret: chỉ khi khai báo quyền, chỉ bảng của chính module; mã hoá / giải mã qua vault', async () => {
    const withSecrets = fakeModule('keep', {
      permissions: [{ kind: 'secrets', detail: 'Stores keys' }]
    })
    const without = fakeModule('plain')
    const { registry } = await setup([withSecrets, without])
    registry.setEnabled('keep', true)
    registry.setEnabled('plain', true)
    const sealed = withSecrets.ctx?.secrets.seal('keep_items', 'a', 'secret', 'bi-mat')
    expect(sealed).toBeInstanceOf(Buffer)
    expect(withSecrets.ctx?.secrets.open('keep_items', 'a', 'secret', sealed as Buffer)).toBe(
      'bi-mat'
    )
    // Không mở được bằng tham chiếu khác (AD gắn với bảng / id / trường).
    expect(() =>
      withSecrets.ctx?.secrets.open('keep_items', 'b', 'secret', sealed as Buffer)
    ).toThrow()
    expect(() => withSecrets.ctx?.secrets.seal('hosts', 'a', 'password', 'x')).toThrow(/own tables/)
    expect(() => without.ctx?.secrets.seal('plain_items', 'a', 'secret', 'x')).toThrow(
      /"secrets" permission/
    )
  })

  it('Remove data: phải tắt trước; xoá bảng và lịch sử migration; bật lại tạo lại từ đầu', async () => {
    const fake = fakeModule()
    const { db, registry } = await setup([fake])
    registry.setEnabled('fake', true)
    registry.invoke('fake', 'add', ['alpha'])
    expect(() => {
      registry.removeData('fake')
    }).toThrow(/Turn the module off/)
    registry.setEnabled('fake', false)
    registry.removeData('fake')
    expect(moduleSchemaVersion(db, 'fake')).toBe(0)
    registry.setEnabled('fake', true)
    expect(registry.invoke('fake', 'list', [])).toEqual([])
  })

  it('cài đặt riêng: parse bằng schema của module; phiên module nhận cài đặt hiện tại', async () => {
    const fake = fakeModule()
    const { registry, settings } = await setup([fake])
    registry.setEnabled('fake', true)
    const seen: unknown[] = []
    fake.ctx?.settings.onChange((v) => seen.push(v))
    expect(registry.resolveSession('fake', 'main', { x: 1 })).toEqual({
      kind: 'main',
      params: { x: 1 },
      level: { level: 3 }
    })
    settings.update({ modules: { fake: { level: 7 } } })
    expect(seen).toEqual([{ level: 7 }])
    expect(() => registry.resolveSession('fake', 'other', {})).toThrow(/no session kind/)
  })

  it('S3: DB cũ (bảng từ migration 0006/0007) được ghi sẵn là đã chạy; Remove data rồi bật lại tạo lại bảng', async () => {
    const { db, registry } = await setup([s3Main])
    expect(moduleSchemaVersion(db, 's3')).toBe(2)
    // S3 bật mặc định.
    expect(registry.isEnabled('s3')).toBe(true)
    expect(registry.invoke('s3', 'accounts', [])).toEqual([])
    registry.setEnabled('s3', false)
    registry.removeData('s3')
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 's3_accounts'").get()
    ).toBeUndefined()
    registry.setEnabled('s3', true)
    expect(moduleSchemaVersion(db, 's3')).toBe(2)
    expect(registry.invoke('s3', 'accounts', [])).toEqual([])
  })

  it('dò dấu hiệu trên máy chỉ cho module đang tắt', async () => {
    const detecting: MainModule = {
      ...fakeModule('kube'),
      manifest: manifest('kube', {
        detect: [{ on: 'startup', probe: 'local-file', path: '~/.kube/config' }]
      })
    }
    const { registry } = await setup([detecting])
    const exists = (p: string): boolean => p === '/home/u/.kube/config'
    expect(registry.detectLocal(exists, '/home/u')).toEqual(['kube'])
    registry.setEnabled('kube', true)
    expect(registry.detectLocal(exists, '/home/u')).toEqual([])
  })
})

describe('checkModuleSql', () => {
  it('đọc tên bảng sau các từ khoá; bỏ qua từ khoá SQL', () => {
    expect(
      referencedTables(
        'INSERT INTO a_x (id) VALUES (1) ON CONFLICT(id) DO UPDATE SET id = excluded.id'
      )
    ).toEqual(expect.arrayContaining(['a_x']))
    expect(() => {
      checkModuleSql(
        'a',
        'INSERT INTO a_x (id) VALUES (1) ON CONFLICT(id) DO UPDATE SET id = excluded.id'
      )
    }).not.toThrow()
    expect(() => {
      checkModuleSql('a', 'CREATE INDEX a_x_name ON a_x (name)')
    }).not.toThrow()
    expect(() => {
      checkModuleSql('a', 'CREATE INDEX idx ON a_x (name)')
    }).toThrow(/idx/)
    expect(() => {
      checkModuleSql('a', 'SELECT * FROM (SELECT * FROM a_x)')
    }).not.toThrow()
    expect(() => {
      checkModuleSql('a', 'DROP TABLE IF EXISTS "hosts"')
    }).toThrow(/hosts/)
    expect(() => {
      checkModuleSql('my-mod', 'CREATE TABLE my_mod_items (id TEXT)')
    }).not.toThrow()
  })
})

describe('ctx.pickFiles / readDir', () => {
  it('chỉ khi khai báo quyền pick-file; đọc file được chọn và file nó trỏ tới; readDir theo quyền read-file', async () => {
    const { tempDir } = await import('./helpers')
    const { writeFileSync, mkdirSync } = await import('node:fs')
    const { join } = await import('node:path')
    const home = tempDir()
    mkdirSync(join(home, '.kube', 'sub'), { recursive: true })
    writeFileSync(join(home, '.kube', 'config'), 'a')
    writeFileSync(join(home, '.kube', 'dev.yaml'), 'b')
    const elsewhere = tempDir()
    writeFileSync(join(elsewhere, 'picked.yaml'), 'picked')
    writeFileSync(join(elsewhere, 'ca.crt'), 'ca')
    const picking: MainModule = {
      ...fakeModule('pick'),
      manifest: manifest('pick', {
        permissions: [
          { kind: 'pick-file', detail: 'x' },
          { kind: 'read-file', path: '~/.kube/**' }
        ]
      })
    }
    const plain = fakeModule('plain')
    const db = openDatabase(':memory:')
    await migrate(db, MIGRATIONS)
    const vault = new Vault(db, TEST_KDF)
    await vault.create(Secret.fromString('master-password'))
    const settings = new SettingsService(db)
    let captured: MainModuleContext | null = null
    const registry = new MainModuleRegistry(
      [{ ...picking, activate: (ctx) => ((captured = ctx), {}) }, plain],
      {
        db,
        vault,
        settings,
        emit: () => undefined,
        onStatesChanged: () => undefined,
        log: () => undefined,
        home,
        showOpenDialog: () => Promise.resolve([join(elsewhere, 'picked.yaml')])
      }
    )
    registry.start()
    registry.setEnabled('pick', true)
    registry.setEnabled('plain', true)
    const ctx = captured as MainModuleContext | null
    const files = await ctx?.pickFiles({ title: 't' })
    expect(files?.map((f) => [f.name, f.content])).toEqual([['picked.yaml', 'picked']])
    await expect(files?.[0]?.readReferenced('ca.crt')).resolves.toBe('ca')
    await expect(plain.ctx?.pickFiles({ title: 't' })).rejects.toThrow(/pick-file/)
    expect((await ctx?.readDir('~/.kube'))?.map((f) => f.name).sort()).toEqual([
      'config',
      'dev.yaml'
    ])
    await expect(ctx?.readFile(join(elsewhere, 'picked.yaml'))).rejects.toThrow(/not allowed/)
  })
})
