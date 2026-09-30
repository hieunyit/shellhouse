import { homedir } from 'node:os'
import type { HostModule, HostModuleContext, SshCapability } from '../../registry/host-types'
import { dockerManifest } from '../manifest'
import { ApiBackend } from './api-backend'
import type { DockerBackend, DockerCli } from './backend'
import { CliBackend } from './cli-backend'
import { EngineClient, type Connect } from './engine'
import { DockerService } from './service'

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

function localCli(ctx: HostModuleContext): DockerCli {
  return {
    exec: (args, options) => ctx.spawn.exec('docker', args, options),
    spawn: (args, signal) => ctx.spawn.spawn('docker', args, signal)
  }
}

function sshCli(ssh: SshCapability): DockerCli {
  return {
    exec: (args, options) => ssh.exec(['docker', ...args], options),
    spawn: (args, signal) => ssh.spawn(['docker', ...args], signal)
  }
}

function localService(ctx: HostModuleContext): DockerService {
  const cli = localCli(ctx)
  return new DockerService({
    cli,
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
        return new ApiBackend(found.engine)
      }
      if (!ctx.spawn.available('docker'))
        throw new Error(
          'Docker is not running on this computer (no Docker socket and no `docker` command found).'
        )
      ctx.log('info', `no local socket (${found.error}) — using the docker CLI`)
      return new CliBackend(cli)
    },
    openPty: (args, size, cb) => ctx.spawn.openPty('docker', args, size, cb),
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
  createSession: (_kind, _config, ctx) => localService(ctx),
  attachToSsh: (ctx) => remoteService(ctx, ctx.ssh)
}
