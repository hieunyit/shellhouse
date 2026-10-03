import { execFile, execFileSync, spawn } from 'node:child_process'
import {
  accessSync,
  constants,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import log from 'electron-log/main'
import { t } from '@shared/i18n'
import type { RdpStatusEvent } from '@shared/rdp'
import { showOpenDialog } from '../dialogs'
import { handle } from '../ipc/router'
import type { HostService } from '../hosts/service'
import { RdpController, rdpHostInput, scanRdpFiles, type RdpFileScan } from './controller'
import { detectRdpClient, type DetectedClient } from './detect'
import { RdpLauncher } from './launcher'
import { decodeRdpFile } from './rdp-file'

/** File .rdp thật chỉ vài KB. */
const MAX_RDP_FILE_BYTES = 1024 * 1024

export interface RdpIpcOptions {
  hosts: () => HostService
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean
  getWindow: () => BrowserWindow | null
  notifyChanged: () => void
  emit: (event: RdpStatusEvent) => void
  /** Thư mục tạm riêng (trong userData) cho file .rdp / .remmina. */
  tempDir: string
  home: string
  /**
   * Chỉ E2E (SHELLHOUSE_TEST_HOOKS): không chạy client thật — ghi kế hoạch chạy ra file này.
   * null = chạy thật.
   */
  stubRecordFile: string | null
}

const executable = (path: string): boolean => {
  try {
    accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return statSync(path).isFile() || path.endsWith('.app')
  } catch {
    return false
  }
}

/** Đăng ký IPC Remote Desktop; trả launcher để main dọn dẹp khi thoát. */
export function registerRdpIpc(options: RdpIpcOptions): RdpLauncher {
  const platform = process.platform
  mkdirSync(options.tempDir, { recursive: true, mode: 0o700 })
  // File của lần chạy trước (app bị tắt ngang) — không ai còn dùng.
  for (const name of safeReaddir(options.tempDir))
    rmSync(join(options.tempDir, name), { force: true, recursive: true })

  const launcher = new RdpLauncher({
    platform,
    tempDir: options.tempDir,
    home: options.home,
    spawn: (file, args, io) =>
      spawn(file, args, {
        shell: false,
        windowsHide: false,
        stdio: [io.stdin ? 'pipe' : 'ignore', 'ignore', io.stderr ? 'pipe' : 'ignore']
      }),
    run: (file, args) =>
      new Promise((resolve) => {
        // cmdkey: không ghi lệnh vào log (có /pass:).
        execFile(file, args, { windowsHide: true, timeout: 10_000 }, (error) => {
          resolve(error ? (typeof error.code === 'number' ? error.code : null) : 0)
        })
      }),
    runSync: (file, args) => {
      try {
        execFileSync(file, args, { windowsHide: true, timeout: 5_000, stdio: 'ignore' })
      } catch {
        log.warn('RDP: cmdkey cleanup failed')
      }
    },
    writePrivate: (path, data) => {
      writeFileSync(path, data, { mode: 0o600, flag: 'wx' })
    },
    remove: (path) => {
      rmSync(path, { force: true })
    },
    log: log.scope('rdp'),
    onStatus: options.emit,
    ...(options.stubRecordFile
      ? {
          recordStub: (summary: Record<string, unknown>) => {
            writeFileSync(options.stubRecordFile ?? '', JSON.stringify(summary, null, 2))
          }
        }
      : {})
  })

  let detected: DetectedClient | null = null
  const detect = async (): Promise<DetectedClient | null> => {
    if (options.stubRecordFile) return { kind: 'stub', name: 'test-rdp', path: '' }
    // Dò lại khi lần trước chưa có (người dùng vừa cài client).
    detected ??= await detectRdpClient({
      platform,
      env: process.env,
      home: options.home,
      exists: executable,
      output: (file, args) =>
        new Promise((resolve) => {
          execFile(file, args, { timeout: 3_000, windowsHide: true }, (error, stdout, stderr) => {
            resolve(error && !stdout && !stderr ? null : `${stdout}\n${stderr}`)
          })
        })
    })
    return detected
  }

  const controller = new RdpController({
    platform,
    detect,
    resolve: (hostId, touch) => options.hosts().resolveRdp(hostId, touch),
    launcher
  })

  handle('rdp:check', options.isTrustedSender, (hostId) => controller.check(hostId))
  handle('rdp:launch', options.isTrustedSender, async (request) => {
    const result = await controller.launch(request)
    options.notifyChanged() // "dùng gần nhất"
    return result
  })
  handle('rdp:stop', options.isTrustedSender, (launchId) => launcher.stop(launchId))

  // Import file .rdp: main giữ kết quả quét (renderer chỉ gửi lại tên đã chọn).
  let lastScan: RdpFileScan | null = null
  handle('rdp:scan', options.isTrustedSender, async () => {
    const picked = await showOpenDialog(options.getWindow(), {
      title: t('Choose Remote Desktop (.rdp) files'),
      filters: [
        { name: 'Remote Desktop', extensions: ['rdp'] },
        { name: t('All files'), extensions: ['*'] }
      ],
      properties: ['openFile', 'multiSelections']
    })
    const paths = picked.canceled ? [] : picked.filePaths.slice(0, 500)
    if (paths.length === 0) {
      lastScan = null
      return { file: null, candidates: [], ignored: {} }
    }
    const files = paths.map((path) => {
      try {
        if (statSync(path).size > MAX_RDP_FILE_BYTES) return { path, text: null }
        return { path, text: decodeRdpFile(readFileSync(path)) }
      } catch {
        return { path, text: null }
      }
    })
    lastScan = scanRdpFiles(
      files,
      options
        .hosts()
        .tree()
        .hosts.map((h) => h.label)
    )
    return {
      file: paths.length === 1 ? (paths[0] ?? null) : paths.join(', '),
      candidates: lastScan.candidates,
      ignored: {}
    }
  })
  handle('rdp:import', options.isTrustedSender, (aliases) => {
    const scan = lastScan
    if (!scan) throw new Error(t('Choose .rdp files first'))
    const service = options.hosts()
    let imported = 0
    const skipped: string[] = []
    service.batch(() => {
      for (const alias of aliases) {
        const file = scan.parsed.get(alias)
        if (!file) {
          skipped.push(alias)
          continue
        }
        try {
          service.saveHost(rdpHostInput(file))
          imported++
        } catch (error) {
          log.warn(`RDP import: skipping ${alias}: ${String(error)}`)
          skipped.push(alias)
        }
      }
    })
    options.notifyChanged()
    return { imported, skipped }
  })

  return launcher
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
