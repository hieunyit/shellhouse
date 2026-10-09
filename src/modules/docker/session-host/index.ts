import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { t } from '@shared/i18n'
import type { HostModule, HostModuleContext, SshCapability } from '../../registry/host-types'
import { dockerManifest } from '../manifest'
import { ApiBackend } from './api-backend'
import type { DockerBackend, DockerCli } from './backend'
import { CliBackend } from './cli-backend'
import { EngineClient, type Connect } from './engine'
import { DockerService } from './service'
import { DockerSessionConfig, type RegistryAuth } from '../shared/ops'
import { DockerIpc, wslSource } from '../shared/ipc'

/**
 * Phần Session Host của Docker (ADR-014 mục 6.2): nói chuyện với Engine API qua socket (máy này)
 * hoặc streamlocal qua kết nối SSH; không được thì dùng `docker` CLI.
 */

export const WINDOWS_PIPE = '\\\\.\\pipe\\docker_engine'

/** Socket thử lần lượt trên máy này (DOCKER_HOST, Docker Desktop, Colima, OrbStack, Podman…). */
export function localSocketCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  uid: number | null = typeof process.getuid === 'function' ? process.getuid() : null
): string[] {
  const out: string[] = []
  const host = env['DOCKER_HOST']
  if (host?.startsWith('unix://')) out.push(host.slice('unix://'.length))
  if (host?.startsWith('npipe://')) out.push(host.slice('npipe://'.length).replace(/\//g, '\\'))
  if (platform === 'win32') return [...out, WINDOWS_PIPE]
  out.push('/var/run/docker.sock', '~/.docker/run/docker.sock')
  if (platform === 'darwin')
    out.push('~/.colima/default/docker.sock', '~/.orbstack/run/docker.sock')
  if (uid !== null) out.push(`/run/user/${uid}/docker.sock`, `/run/user/${uid}/podman/podman.sock`)
  return [...new Set(out)]
}

/** Thử từng socket: kết nối được + `/_ping` trả lời → dùng Engine API qua socket đó. */
async function firstWorking(
  candidates: readonly string[],
  open: (path: string) => Connect,
  signal: AbortSignal
): Promise<{ engine: EngineClient; path: string } | { error: string }> {
  let error = 'No Docker socket found'
  for (const path of candidates) {
    const engine = new EngineClient(open(path))
    try {
      await engine.ping(signal)
      return { engine, path }
    } catch (e) {
      if (signal.aborted) throw e
      error = e instanceof Error ? e.message : String(e)
    }
  }
  return { error }
}

/**
 * Cờ chỉ đọc đã lưu ở main (bảng docker_endpoints) — Session Host không chỉ tin cờ renderer gửi.
 * `source` = hostId của nguồn (null = máy này, "wsl:<distro>", id host SSH).
 */
async function storedReadOnly(ctx: HostModuleContext, source: string | null): Promise<boolean> {
  return (await ctx.fromMain('readOnly', source)) === true
}

/** Thông tin đăng nhập registry đã lưu — main giải mã từ vault, chỉ tới Session Host. */
async function registryAuth(ctx: HostModuleContext, id: string): Promise<RegistryAuth> {
  const r = (await ctx.fromMain(
    'registryAuth',
    DockerIpc.registryAuthQuery.parse(id)
  )) as Partial<RegistryAuth> | null
  if (
    !r ||
    typeof r.server !== 'string' ||
    typeof r.username !== 'string' ||
    typeof r.password !== 'string'
  )
    throw new Error('Invalid registry credentials')
  return { server: r.server, username: r.username, password: r.password }
}

/** `mktemp -d` trên server / trong WSL → thư mục tạm cho `docker --config`. */
async function remoteTempDir(
  exec: (argv: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>
): Promise<{ path: string; remove(): Promise<void> }> {
  const r = await exec(['mktemp', '-d'])
  const path = r.stdout.trim()
  if (r.code !== 0 || !/^\/[\w./-]+$/.test(path))
    throw new Error(`mktemp failed: ${r.stderr.trim() || path}`)
  return {
    path,
    remove: async () => {
      await exec(['rm', '-rf', '--', path])
    }
  }
}

function localCli(ctx: HostModuleContext): DockerCli {
  return {
    exec: (args, options) => ctx.spawn.exec('docker', args, options),
    spawn: (args, signal) => ctx.spawn.spawn('docker', args, signal),
    tempDir: async () => {
      const path = await mkdtemp(join(tmpdir(), 'shellhouse-docker-'))
      return {
        path,
        remove: () => rm(path, { recursive: true, force: true })
      }
    }
  }
}

function sshCli(ssh: SshCapability): DockerCli {
  return {
    exec: (args, options) => ssh.exec(['docker', ...args], options),
    spawn: (args, signal) => ssh.spawn(['docker', ...args], signal),
    tempDir: () => remoteTempDir((argv) => ssh.exec(argv, { timeoutMs: 15_000 }))
  }
}

function localService(ctx: HostModuleContext): DockerService {
  const cli = localCli(ctx)
  /** Socket của Engine đang dùng — Trivy phải đọc image từ đúng Engine này (Colima, OrbStack…). */
  let socket: string | null = null
  return new DockerService({
    cli,
    scanner: (args, options) =>
      ctx.spawn.exec('trivy', args, {
        ...options,
        ...(socket ? { env: { DOCKER_HOST: `unix://${socket}` } } : {})
      }),
    connect: async (signal): Promise<DockerBackend> => {
      const home = homedir()
      const candidates = localSocketCandidates().map((p) =>
        p.startsWith('~/') ? `${home}${p.slice(1)}` : p
      )
      const found = await firstWorking(
        candidates,
        (path) => () => ctx.connectLocalSocket(path),
        signal
      )
      if ('engine' in found) {
        ctx.log('info', `local engine at ${found.path}`)
        socket = found.path.startsWith('/') ? found.path : null
        return new ApiBackend(found.engine)
      }
      if (!ctx.spawn.available('docker'))
        throw new Error(
          t(
            'Docker is not running on this computer (no Docker socket and no `docker` command found).'
          )
        )
      ctx.log('info', `no local socket (${found.error}) — using the docker CLI`)
      return new CliBackend(cli)
    },
    openPty: (args, size, cb) => ctx.spawn.openPty('docker', args, size, cb),
    storedReadOnly: () => storedReadOnly(ctx, null),
    registryAuth: (id) => registryAuth(ctx, id),
    emit: (event, data) => {
      ctx.emit(event, data)
    },
    log: (level, message) => {
      ctx.log(level, message)
    }
  })
}

/** `wsl.exe -d <distro> -e docker …` — Docker trong một bản phân phối WSL (Windows). */
function wslCli(ctx: HostModuleContext, distro: string): DockerCli {
  const wrap = (args: readonly string[]): string[] => ['-d', distro, '-e', 'docker', ...args]
  return {
    exec: (args, options) => ctx.spawn.exec('wsl', wrap(args), options),
    spawn: (args, signal) => ctx.spawn.spawn('wsl', wrap(args), signal),
    tempDir: () =>
      remoteTempDir((argv) =>
        ctx.spawn.exec('wsl', ['-d', distro, '-e', ...argv], { timeoutMs: 15_000 })
      )
  }
}

/**
 * Docker trong WSL: socket của Engine nằm trong máy ảo WSL, Windows không mở được — dùng `docker`
 * CLI trong distro (mỗi lệnh ~0,25 giây; CPU / RAM của mọi container là một lệnh `docker stats`).
 */
function wslService(ctx: HostModuleContext, distro: string): DockerService {
  const cli = wslCli(ctx, distro)
  return new DockerService({
    cli,
    scanner: (args, options) =>
      ctx.spawn.exec('wsl', ['-d', distro, '-e', 'trivy', ...args], options),
    connect: async (signal): Promise<DockerBackend> => {
      if (!ctx.spawn.available('wsl')) throw new Error(t('WSL is not installed on this computer.'))
      const backend = new CliBackend(cli)
      await backend.info(signal).catch((error: unknown) => {
        const text = error instanceof Error ? error.message : String(error)
        throw new Error(
          /not installed|not found/i.test(text)
            ? t('Docker is not installed in {distro} (WSL).', { distro })
            : /not running|cannot connect/i.test(text)
              ? t(
                  'Docker is installed in {distro} (WSL) but not running — start it with `sudo service docker start`.',
                  { distro }
                )
              : text,
          { cause: error }
        )
      })
      ctx.log('info', `docker in WSL distro ${distro}`)
      return backend
    },
    openPty: (args, size, cb) =>
      ctx.spawn.openPty('wsl', ['-d', distro, '-e', 'docker', ...args], size, cb),
    storedReadOnly: () => storedReadOnly(ctx, wslSource(distro)),
    registryAuth: (id) => registryAuth(ctx, id),
    reprobeCli: false,
    emit: (event, data) => {
      ctx.emit(event, data)
    },
    log: (level, message) => {
      ctx.log(level, message)
    }
  })
}

function remoteService(ctx: HostModuleContext, ssh: SshCapability): DockerService {
  const cli = sshCli(ssh)
  return new DockerService({
    cli,
    scanner: (args, options) => ssh.exec(['trivy', ...args], options),
    connect: async (signal): Promise<DockerBackend> => {
      const candidates = ['/var/run/docker.sock', '/run/docker.sock']
      let found = await firstWorking(candidates, (path) => () => ssh.openUnixSocket(path), signal)
      if (!('engine' in found)) {
        // Docker rootless / Podman của user: socket nằm theo uid.
        const uid = (
          await ssh.exec(['id', '-u'], { timeoutMs: 10_000, signal }).catch(() => null)
        )?.stdout.trim()
        if (uid && /^\d+$/.test(uid))
          found = await firstWorking(
            [`/run/user/${uid}/docker.sock`, `/run/user/${uid}/podman/podman.sock`],
            (path) => () => ssh.openUnixSocket(path),
            signal
          )
      }
      if ('engine' in found) {
        ctx.log('info', `engine on ${ssh.label} at ${found.path}`)
        return new ApiBackend(found.engine)
      }
      // Server tắt AllowStreamLocalForwarding / user không vào được socket → thử CLI (báo lỗi
      // quyền dễ hiểu nếu cũng không được).
      ctx.log(
        'info',
        `socket not reachable on ${ssh.label} (${found.error}) — trying the docker CLI`
      )
      const backend = new CliBackend(cli)
      await backend.info(signal)
      return backend
    },
    openPty: (args, size, cb) => ssh.openPty(['docker', ...args], size, cb),
    // Phiên SSH không biết mình là host đã lưu nào → hostId do tab / terminal báo.
    storedReadOnly: (hostId) => (hostId ? storedReadOnly(ctx, hostId) : Promise.resolve(false)),
    registryAuth: (id) => registryAuth(ctx, id),
    emit: (event, data) => {
      ctx.emit(event, data)
    },
    log: (level, message) => {
      ctx.log(level, message)
    }
  })
}

export const dockerHost: HostModule = {
  manifest: dockerManifest,
  createSession: (_kind, raw, ctx) => {
    const config = DockerSessionConfig.parse(raw ?? {})
    return config.wsl ? wslService(ctx, config.wsl) : localService(ctx)
  },
  attachToSsh: (ctx) => remoteService(ctx, ctx.ssh)
}
