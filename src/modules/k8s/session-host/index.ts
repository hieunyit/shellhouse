import { connect as netConnect } from 'node:net'
import type { Duplex } from 'node:stream'
import type { HostModule, HostModuleContext } from '../../registry/host-types'
import { k8sManifest } from '../manifest'
import type { RawConnect } from './client'
import { K8sService, type ResolvedClusterConfig } from './service'

/**
 * Phần Session Host của Kubernetes (ADR-014 mục 7): phiên riêng (API server tới thẳng được) hoặc
 * gắn vào kết nối SSH (bastion — kênh direct-tcpip tới API server). Thông tin xác thực của context
 * lấy từ main (`fromMain('resolve')`), không qua renderer.
 */

function directConnect(host: string, port: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host, port, noDelay: true })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`Timed out connecting to ${host}:${port}`))
    }, 20_000)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.removeListener('error', reject)
      resolve(socket)
    })
    socket.once('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
}

function service(ctx: HostModuleContext, rawConnect: RawConnect): K8sService {
  return new K8sService({
    // Kiểm bằng schema trong K8sService.connect (ResolvedClusterSchema).
    resolve: async (ref) => (await ctx.fromMain('resolve', ref)) as ResolvedClusterConfig,
    rawConnect,
    checkEditFile: async (path) => (await ctx.fromMain('editFile', path)) === true,
    persistOidc: async (ref, tokens) => {
      await ctx.fromMain('persistOidc', { ref, ...tokens })
    },
    spawn: ctx.spawn,
    emit: (event, data) => {
      ctx.emit(event, data)
    },
    log: (level, message) => {
      ctx.log(level, message)
    }
  })
}

export const k8sHost: HostModule = {
  manifest: k8sManifest,
  createSession: (_kind, _config, ctx) => service(ctx, directConnect),
  attachToSsh: (ctx) => service(ctx, (host, port) => ctx.ssh.openTcp(host, port))
}
