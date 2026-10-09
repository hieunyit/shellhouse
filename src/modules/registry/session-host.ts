import { readFile } from 'node:fs/promises'
import { connect as netConnect } from 'node:net'
import { homedir } from 'node:os'
import type { Duplex } from 'node:stream'
import type { TransferStatus } from '@shared/sftp'
import {
  findProgram,
  openProgramPty,
  sha256File,
  spawnProgram
} from '../../session-host/modules/local-programs'
import { collect } from '../../session-host/modules/ssh-capability'
import { expandHome, localPathAllowed } from './local-paths'
import { CORE_EDIT_FILE, CORE_LOCAL_PATH } from './host-types'
import type {
  HostModule,
  HostModuleContext,
  HostModuleSession,
  LimitedSpawn,
  SshCapability
} from './host-types'
import {
  matchPathPattern,
  type ModuleBinary,
  type ModuleDetector,
  type ModuleManifest
} from './types'

/**
 * Registry của Session Host (ADR-014 mục 3.4, 3.6): tạo phiên module, gắn module vào kết nối SSH,
 * cấp `ctx` đã kiểm quyền theo manifest (dùng năng lực không khai báo → lỗi).
 */

export class ModulePermissionError extends Error {
  constructor(moduleId: string, what: string) {
    super(`Module ${moduleId} is not allowed to ${what} (not declared in its manifest)`)
    this.name = 'ModulePermissionError'
  }
}

export interface HostRegistryDeps {
  log(level: 'info' | 'warn' | 'error', message: string): void
  /** Hỏi main (người dùng) cho phép module chạy chương trình này; main nhớ lựa chọn. */
  requestProgramGrant(
    module: string,
    binary: string,
    path: string,
    sha256: string
  ): Promise<boolean>
  /** Chuyển yêu cầu `ctx.fromMain` tới main. */
  requestMain?(module: string, name: string, params: unknown): Promise<unknown>
  /** Cho test. */
  findProgram?(name: string): string | null
  home?: string
  env?: NodeJS.ProcessEnv
  /** userData của app — không module nào đọc được qua symlink trỏ vào đó. */
  appData?: string
}

/** Nơi phiên module gửi sự kiện / danh sách truyền file (port của tab). */
export interface ModuleSink {
  emit(event: string, data: unknown): void
  transfers(list: TransferStatus[]): void
}

export class HostModuleRegistry {
  private readonly modules = new Map<string, HostModule>()
  private enabled = new Set<string>()
  /** module|path|sha → đã được cho phép (trong đời tiến trình này). */
  private readonly grants = new Map<string, Promise<boolean>>()

  constructor(
    modules: readonly HostModule[],
    private readonly deps: HostRegistryDeps
  ) {
    for (const m of modules) this.modules.set(m.manifest.id, m)
  }

  setEnabled(ids: readonly string[]): void {
    this.enabled = new Set(ids.filter((id) => this.modules.has(id)))
  }

  isEnabled(id: string): boolean {
    return this.enabled.has(id)
  }

  /** Module đang TẮT có cách dò trên kết nối SSH (để gợi ý bật). */
  probeTargets(): { id: string; detect: readonly ModuleDetector[] }[] {
    return [...this.modules.values()]
      .filter((m) => !this.enabled.has(m.manifest.id))
      .map((m) => ({
        id: m.manifest.id,
        detect: (m.manifest.detect ?? []).filter((d) => d.on === 'ssh-connected')
      }))
      .filter((t) => t.detect.length > 0)
  }

  manifest(id: string): ModuleManifest | null {
    return this.modules.get(id)?.manifest ?? null
  }

  private require(id: string): HostModule {
    const module = this.modules.get(id)
    if (!module) throw new Error(`Unknown module: ${id}`)
    if (!this.enabled.has(id)) throw new Error(`The ${module.manifest.name} module is turned off`)
    return module
  }

  createSession(id: string, kind: string, config: unknown, sink: ModuleSink): HostModuleSession {
    const module = this.require(id)
    if (!module.createSession || !module.manifest.contributes.sessionKinds?.includes(kind))
      throw new Error(`Module ${id} has no session kind "${kind}"`)
    return module.createSession(kind, config, this.context(module.manifest, sink))
  }

  attach(id: string, ssh: SshCapability, sink: ModuleSink): HostModuleSession {
    const module = this.require(id)
    if (!module.attachToSsh || !module.manifest.contributes.attachToSsh)
      throw new Error(`Module ${id} cannot run on SSH connections`)
    return module.attachToSsh({
      ...this.context(module.manifest, sink),
      ssh: this.guardSsh(module.manifest, ssh)
    })
  }

  /** Bọc năng lực SSH: chỉ cho những gì manifest khai báo; ghi log. */
  guardSsh(manifest: ModuleManifest, ssh: SshCapability): SshCapability {
    const id = manifest.id
    const has = (kind: string): boolean => manifest.permissions.some((p) => p.kind === kind)
    // Luôn trả Promise (kể cả khi bị chặn) — module chỉ cần bắt lỗi theo một kiểu.
    const withExec = <T>(
      what: string,
      argv: readonly string[],
      run: () => Promise<T>
    ): Promise<T> => {
      if (!has('ssh-exec'))
        return Promise.reject(new ModulePermissionError(id, 'run commands over SSH'))
      this.deps.log('info', `[${id}] ssh ${what} on ${ssh.label}: ${argv[0] ?? ''}`)
      return run()
    }
    return {
      label: ssh.label,
      exec: (argv, options) => withExec('exec', argv, () => ssh.exec(argv, options)),
      spawn: (argv, signal) => withExec('exec', argv, () => ssh.spawn(argv, signal)),
      openPty: (argv, size, cb) => withExec('pty', argv, () => ssh.openPty(argv, size, cb)),
      openUnixSocket: (path) => {
        const allowed = manifest.permissions.some(
          (p) => p.kind === 'ssh-socket' && matchPathPattern(p.path, path)
        )
        if (!allowed) return Promise.reject(new ModulePermissionError(id, `open ${path}`))
        return ssh.openUnixSocket(path)
      },
      openTcp: (host, port) => {
        if (!has('ssh-tunnel'))
          return Promise.reject(new ModulePermissionError(id, 'open tunnels through SSH'))
        return ssh.openTcp(host, port)
      }
    }
  }

  private context(manifest: ModuleManifest, sink: ModuleSink): HostModuleContext {
    const id = manifest.id
    const home = this.deps.home ?? homedir()
    const paths = {
      home,
      env: this.deps.env ?? process.env,
      platform: process.platform,
      ...(this.deps.appData ? { appData: this.deps.appData } : {})
    }
    const pathAllowed = (kind: 'local-socket' | 'read-file', path: string): boolean =>
      localPathAllowed(manifest, kind, path, paths)
    return {
      emit: (event, data) => {
        sink.emit(event, data)
      },
      transfers: (list) => {
        sink.transfers(list)
      },
      spawn: this.limitedSpawn(manifest),
      connectLocalSocket: (path) => {
        const full = expandHome(path, home)
        if (!pathAllowed('local-socket', full))
          return Promise.reject(new ModulePermissionError(id, `connect to ${path}`))
        return new Promise<Duplex>((resolve, reject) => {
          const socket = netConnect(full)
          socket.once('connect', () => {
            socket.removeListener('error', reject)
            resolve(socket)
          })
          socket.once('error', reject)
        })
      },
      readFile: (path) => {
        const full = expandHome(path, home)
        if (!pathAllowed('read-file', full))
          return Promise.reject(new ModulePermissionError(id, `read ${path}`))
        return readFile(full, 'utf8')
      },
      log: (level, message) => {
        this.deps.log(level, `[${id}] ${message}`)
      },
      fromMain: (name, params) =>
        this.deps.requestMain
          ? this.deps.requestMain(id, name, params)
          : Promise.reject(new Error('Not available')),
      // Hỏi lỗi (main bận, module tắt…) = không cho phép.
      localPathGranted: async (path, access) =>
        this.deps.requestMain
          ? (await this.deps
              .requestMain(id, CORE_LOCAL_PATH, { path, access })
              .catch(() => false)) === true
          : false,
      ownsEditFile: async (path) =>
        this.deps.requestMain
          ? (await this.deps.requestMain(id, CORE_EDIT_FILE, path).catch(() => false)) === true
          : false
    }
  }

  private limitedSpawn(manifest: ModuleManifest): LimitedSpawn {
    const id = manifest.id
    const find = (name: string): string | null =>
      this.deps.findProgram ? this.deps.findProgram(name) : findProgram(name)
    const resolve = async (binary: ModuleBinary): Promise<string> => {
      const declared =
        manifest.binaries?.includes(binary) === true &&
        manifest.permissions.some((p) => p.kind === 'run-program' && p.binary === binary)
      if (!declared) throw new ModulePermissionError(id, `run ${binary}`)
      const path = find(binary)
      if (!path) throw new Error(`\`${binary}\` was not found on this computer`)
      const sha = await sha256File(path)
      const key = `${id}|${path}|${sha}`
      let grant = this.grants.get(key)
      if (!grant) {
        grant = this.deps.requestProgramGrant(id, binary, path, sha)
        this.grants.set(key, grant)
        // Từ chối / lỗi → lần sau hỏi lại (main có thể đã nhớ "không").
        void grant.then(
          (ok) => {
            if (!ok) this.grants.delete(key)
          },
          () => this.grants.delete(key)
        )
      }
      if (!(await grant)) throw new Error(`You did not allow ${manifest.name} to run ${binary}`)
      return path
    }
    return {
      available: (binary) => find(binary) !== null,
      exec: async (binary, args, options = {}) => {
        const path = await resolve(binary)
        const { program, stdin } = spawnProgram(path, args, options.signal, options.env)
        const result = collect(program, options, (input) => {
          stdin.end(input)
        })
        if (options.input === undefined) stdin.end()
        return result
      },
      spawn: async (binary, args, signal) => {
        const path = await resolve(binary)
        const { program, stdin } = spawnProgram(path, args, signal)
        stdin.end()
        return program
      },
      openPty: async (binary, args, size, cb) =>
        openProgramPty(await resolve(binary), args, size, cb)
    }
  }
}
