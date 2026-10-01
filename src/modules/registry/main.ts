import type { ZodType } from 'zod'
import type { AppSettings, ModuleEntry, SettingsPatch } from '@shared/settings'
import type { Db } from '../../main/store/db'
import type { Vault } from '../../main/vault/vault'
import { readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { createModuleDb, migrateModule, removeModuleData } from './main-db'
import { expandHome, localPathAllowed } from './local-paths'
import type { MainModule, MainModuleApi, MainModuleContext, ModuleLog } from './main-types'
import { tablePrefix, type ModuleManifest, type ModuleState } from './types'

/**
 * Registry của main (ADR-014 mục 3.3, 3.9): bật / tắt module lúc chạy, cấp `ctx` hẹp cho từng
 * module, định tuyến IPC `module:<id>:<name>`, phân giải phiên module.
 */

export interface MainRegistryDeps {
  db: Db
  vault: Pick<Vault, 'encryptString' | 'decrypt'>
  settings: {
    get(): AppSettings
    update(patch: SettingsPatch): AppSettings
    onChange(listener: (s: AppSettings) => void): () => void
  }
  /** Sự kiện module → renderer. */
  emit(module: string, name: string, data: unknown): void
  /** Danh sách / trạng thái module đổi → renderer, Session Host. */
  onStatesChanged(states: ModuleState[]): void
  log: (level: 'info' | 'warn' | 'error', message: string) => void
  now?: () => number
  /** Hộp thoại chọn file của hệ điều hành (main của app); huỷ → []. */
  showOpenDialog?(options: {
    title: string
    filters?: { name: string; extensions: string[] }[]
    multiple?: boolean
  }): Promise<string[]>
  /** Windows: bản phân phối WSL (không khởi động distro nào). */
  listWslDistros?(): Promise<{ name: string; running: boolean; version: number }[]>
  /** Cho test: home / biến môi trường khi kiểm quyền đọc file. */
  home?: string
  env?: NodeJS.ProcessEnv
}

interface Active {
  module: MainModule
  api: MainModuleApi
  handlers: Map<string, { args: ZodType; handler: (...args: unknown[]) => unknown }>
  settingsListeners: Set<(value: unknown) => void>
}

export class ModuleNotEnabledError extends Error {
  constructor(id: string) {
    super(`The ${id} module is turned off — enable it in Settings → Modules`)
    this.name = 'ModuleNotEnabledError'
  }
}

export function isModuleEnabled(manifest: ModuleManifest, entry: ModuleEntry | undefined): boolean {
  return entry?.enabled ?? manifest.enabledByDefault
}

export class MainModuleRegistry {
  private readonly modules = new Map<string, MainModule>()
  private readonly active = new Map<string, Active>()
  /** Lỗi bật module gần nhất (hiện cho người dùng). */
  private readonly failures = new Map<string, string>()
  private unsubscribe: (() => void) | null = null
  private lastStates = ''

  constructor(
    modules: readonly MainModule[],
    private readonly deps: MainRegistryDeps
  ) {
    for (const m of modules) {
      if (!/^[a-z0-9-]{1,40}$/.test(m.manifest.id))
        throw new Error(`Invalid module id: ${m.manifest.id}`)
      if (this.modules.has(m.manifest.id)) throw new Error(`Duplicate module: ${m.manifest.id}`)
      this.modules.set(m.manifest.id, m)
    }
  }

  /** Bật các module đang bật trong cài đặt; theo dõi cài đặt để bật / tắt lúc chạy. */
  start(): void {
    this.sync(this.deps.settings.get())
    this.unsubscribe = this.deps.settings.onChange((s) => {
      this.sync(s)
    })
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    for (const id of [...this.active.keys()]) this.deactivate(id)
  }

  manifests(): ModuleManifest[] {
    return [...this.modules.values()].map((m) => m.manifest)
  }

  states(): ModuleState[] {
    const entries = this.deps.settings.get().modules
    return [...this.modules.values()].map((m) => ({
      id: m.manifest.id,
      enabled: this.active.has(m.manifest.id),
      seen: entries[m.manifest.id]?.seen === true
    }))
  }

  isEnabled(id: string): boolean {
    return this.active.has(id)
  }

  setEnabled(id: string, enabled: boolean): ModuleState[] {
    if (!this.modules.has(id)) throw new Error(`Unknown module: ${id}`)
    // Cài đặt đổi → sync() bật / tắt thật.
    this.deps.settings.update({ modules: { [id]: { enabled } } })
    const active = this.isEnabled(id)
    if (active !== enabled) {
      const error = this.failures.get(id)
      throw new Error(error ?? `Could not ${enabled ? 'enable' : 'disable'} the module`)
    }
    return this.states()
  }

  /** Xoá toàn bộ dữ liệu của module (phải tắt trước). */
  removeData(id: string): void {
    if (!this.modules.has(id)) throw new Error(`Unknown module: ${id}`)
    if (this.active.has(id)) throw new Error('Turn the module off before removing its data')
    const tables = removeModuleData(this.deps.db, id)
    this.deps.log('info', `Module ${id}: removed data (${tables.join(', ') || 'no tables'})`)
  }

  invoke(id: string, name: string, args: readonly unknown[]): unknown {
    const active = this.active.get(id)
    if (!active) throw new ModuleNotEnabledError(id)
    const entry = active.handlers.get(name)
    if (!entry) throw new Error(`Module ${id} has no handler "${name}"`)
    const parsed = entry.args.safeParse(args)
    if (!parsed.success) {
      this.deps.log('warn', `IPC module:${id}:${name}: invalid arguments`)
      throw new Error('Invalid arguments')
    }
    return entry.handler(...(parsed.data as unknown[]))
  }

  /** `ctx.fromMain` của phần Session Host → handler của phần main cùng module. */
  async hostRequest(id: string, name: string, params: unknown): Promise<unknown> {
    const active = this.active.get(id)
    if (!active) throw new ModuleNotEnabledError(id)
    if (!active.api.onHostRequest) throw new Error(`Module ${id} does not answer host requests`)
    return await active.api.onHostRequest(name, params)
  }

  /**
   * Module đang TẮT có dấu hiệu trên máy này (kubeconfig, socket Docker, Docker trong WSL…) — để
   * gợi ý bật (3.12.4). Chỉ kiểm file có tồn tại, không đọc nội dung; WSL chỉ hỏi distro đang chạy
   * (không khởi động distro nào).
   */
  async detectLocal(
    exists: (path: string) => boolean,
    home: string,
    wsl: { running: () => Promise<string[]>; exists: (distro: string, path: string) => boolean } = {
      running: () => Promise.resolve([]),
      exists: () => false
    }
  ): Promise<string[]> {
    const expand = (p: string): string => (p.startsWith('~/') ? `${home}${p.slice(1)}` : p)
    let distros: Promise<string[]> | null = null
    const out: string[] = []
    for (const m of this.modules.values()) {
      if (this.active.has(m.manifest.id)) continue
      for (const d of m.manifest.detect ?? []) {
        if (d.on !== 'startup') continue
        if (d.probe === 'wsl-file') distros ??= wsl.running().catch(() => [])
        const hit =
          d.probe === 'wsl-file'
            ? (await (distros ?? Promise.resolve([]))).some((name) => wsl.exists(name, d.path))
            : exists(expand(d.path))
        if (hit) {
          out.push(m.manifest.id)
          break
        }
      }
    }
    return out
  }

  resolveSession(id: string, sessionKind: string, params: unknown): unknown {
    const active = this.active.get(id)
    if (!active) throw new ModuleNotEnabledError(id)
    if (!active.module.manifest.contributes.sessionKinds?.includes(sessionKind))
      throw new Error(`Module ${id} has no session kind "${sessionKind}"`)
    if (!active.api.resolveSession) throw new Error(`Module ${id} does not open sessions`)
    return active.api.resolveSession(sessionKind, params)
  }

  private sync(settings: AppSettings): void {
    for (const [id, module] of this.modules) {
      const want = isModuleEnabled(module.manifest, settings.modules[id])
      if (want && !this.active.has(id)) this.activate(module)
      else if (!want && this.active.has(id)) this.deactivate(id)
      else if (want) this.notifySettings(id, settings)
    }
    const states = this.states()
    const key = JSON.stringify(states)
    if (key !== this.lastStates) {
      this.lastStates = key
      this.deps.onStatesChanged(states)
    }
  }

  private activate(module: MainModule): void {
    const id = module.manifest.id
    try {
      migrateModule(this.deps.db, id, module.migrations, this.deps.now)
      const handlers: Active['handlers'] = new Map()
      const settingsListeners: Active['settingsListeners'] = new Set()
      const api = module.activate(this.context(module, handlers, settingsListeners))
      this.active.set(id, { module, api, handlers, settingsListeners })
      this.failures.delete(id)
      this.deps.log('info', `Module ${id}: enabled`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.failures.set(id, message)
      this.deps.log('error', `Module ${id}: could not enable — ${message}`)
    }
  }

  private deactivate(id: string): void {
    const active = this.active.get(id)
    if (!active) return
    this.active.delete(id)
    try {
      active.api.dispose?.()
    } catch (error) {
      this.deps.log('warn', `Module ${id}: dispose failed — ${String(error)}`)
    }
    this.deps.log('info', `Module ${id}: disabled`)
  }

  private moduleSettings(module: MainModule, settings: AppSettings): unknown {
    const entry = settings.modules[module.manifest.id] ?? {}
    return module.settings ? module.settings.parse(entry) : entry
  }

  private notifySettings(id: string, settings: AppSettings): void {
    const active = this.active.get(id)
    if (!active || active.settingsListeners.size === 0) return
    const value = this.moduleSettings(active.module, settings)
    for (const l of active.settingsListeners) l(value)
  }

  private context(
    module: MainModule,
    handlers: Active['handlers'],
    settingsListeners: Active['settingsListeners']
  ): MainModuleContext {
    const id = module.manifest.id
    const prefix = tablePrefix(id)
    const hasSecrets = module.manifest.permissions.some((p) => p.kind === 'secrets')
    const checkTable = (table: string): void => {
      if (!hasSecrets) throw new Error(`Module ${id} did not declare the "secrets" permission`)
      if (!table.startsWith(prefix))
        throw new Error(`Module ${id} can only encrypt fields of its own tables (${prefix}*)`)
    }
    const log: ModuleLog = {
      info: (m) => {
        this.deps.log('info', `[${id}] ${m}`)
      },
      warn: (m) => {
        this.deps.log('warn', `[${id}] ${m}`)
      },
      error: (m) => {
        this.deps.log('error', `[${id}] ${m}`)
      }
    }
    return {
      db: createModuleDb(id, this.deps.db),
      secrets: {
        seal: (table, rowId, field, value) => {
          checkTable(table)
          return this.deps.vault.encryptString({ table, id: rowId, field }, value)
        },
        open: (table, rowId, field, sealed) => {
          checkTable(table)
          const secret = this.deps.vault.decrypt({ table, id: rowId, field }, sealed)
          try {
            return secret.revealString()
          } finally {
            secret.dispose()
          }
        }
      },
      settings: {
        get: () => this.moduleSettings(module, this.deps.settings.get()),
        onChange: (listener) => {
          settingsListeners.add(listener)
          return () => settingsListeners.delete(listener)
        }
      },
      ipc: {
        handle: (name, args, handler) => {
          if (!/^[a-zA-Z][\w-]{0,40}$/.test(name)) throw new Error(`Invalid IPC name: ${name}`)
          if (handlers.has(name)) throw new Error(`Duplicate IPC handler module:${id}:${name}`)
          handlers.set(name, {
            args,
            handler: handler as (...a: unknown[]) => unknown
          })
        }
      },
      events: {
        emit: (name, data) => {
          if (this.active.has(id)) this.deps.emit(id, name, data)
        }
      },
      home: this.deps.home ?? homedir(),
      readFile: async (path) => {
        const ctx = {
          home: this.deps.home ?? homedir(),
          env: this.deps.env ?? process.env,
          platform: process.platform
        }
        if (!localPathAllowed(module.manifest, 'read-file', path, ctx))
          throw new Error(
            `Module ${id} is not allowed to read ${path} (not declared in its manifest)`
          )
        return readFile(expandHome(path, ctx.home), 'utf8')
      },
      writeFile: async (path, content) => {
        const ctx = {
          home: this.deps.home ?? homedir(),
          env: this.deps.env ?? process.env,
          platform: process.platform
        }
        if (!localPathAllowed(module.manifest, 'write-file', path, ctx))
          throw new Error(
            `Module ${id} is not allowed to change ${path} (not declared in its manifest)`
          )
        const target = expandHome(path, ctx.home)
        const mode = await stat(target).then(
          (s) => s.mode & 0o777,
          () => 0o600
        )
        const temp = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`)
        await writeFile(temp, content, { mode })
        try {
          await rename(temp, target)
        } catch (error) {
          await rm(temp, { force: true })
          throw error
        }
      },
      readDir: async (path) => {
        const ctx = {
          home: this.deps.home ?? homedir(),
          env: this.deps.env ?? process.env,
          platform: process.platform
        }
        const dir = expandHome(path, ctx.home)
        const entries = await readdir(dir, { withFileTypes: true })
        const out: { name: string; path: string; size: number }[] = []
        for (const e of entries) {
          if (!e.isFile()) continue
          const full = join(dir, e.name)
          if (!localPathAllowed(module.manifest, 'read-file', full, ctx)) continue
          const info = await stat(full).catch(() => null)
          if (info) out.push({ name: e.name, path: full, size: info.size })
        }
        return out
      },
      wslDistros: async () => {
        if (
          !module.manifest.permissions.some((p) => p.kind === 'run-program' && p.binary === 'wsl')
        )
          throw new Error(`Module ${id} did not declare running "wsl"`)
        return this.deps.listWslDistros ? this.deps.listWslDistros() : []
      },
      pickFiles: async (options) => {
        if (!module.manifest.permissions.some((p) => p.kind === 'pick-file'))
          throw new Error(`Module ${id} did not declare the "pick-file" permission`)
        if (!this.deps.showOpenDialog) return []
        const paths = await this.deps.showOpenDialog(options)
        const MAX = 4 * 1024 * 1024
        return Promise.all(
          paths.map(async (path) => {
            const info = await stat(path)
            if (info.size > MAX) throw new Error(`${basename(path)} is too large`)
            return {
              path,
              name: basename(path),
              content: await readFile(path, 'utf8'),
              readReferenced: async (ref: string) => {
                const target = isAbsolute(ref) ? ref : join(dirname(path), ref)
                const s = await stat(target)
                if (!s.isFile() || s.size > 1024 * 1024)
                  throw new Error(`${ref} is not a small file`)
                return readFile(target, 'utf8')
              }
            }
          })
        )
      },
      log
    }
  }
}
